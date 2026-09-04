<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/shop.php';
start_session();

if (empty($_SESSION['user_id'])) {
    json_fail('Не авторизован', 401);
}
$userId = (int)$_SESSION['user_id'];
$isEmployee = !empty($_SESSION['employee_id']);

$pdo = db();
if (!$pdo) {
    json_fail('Магазины недоступны на этом сервере (нет PDO SQLite)', 503);
}

$method = $_SERVER['REQUEST_METHOD'];
if ($method !== 'GET') {
    csrf_verify();
}

if ($method === 'GET') {
    if (isset($_GET['search'])) {
        $q = strtolower(trim((string)$_GET['search']));
        if ($q === '' || !shop_username_valid($q)) {
            json_out(['shop' => null]);
        }
        $shop = store_find_user_by_shop_username($q);
        if (!$shop || empty($shop['is_shop'])) {
            json_out(['shop' => null]);
        }
        json_out(['shop' => [
            'shop_username' => $shop['shop_username'],
            'shop_name' => $shop['shop_name'],
            'avatar' => $shop['avatar'] ?? null,
        ]]);
    }

    if (isset($_GET['mine']) && $_GET['mine'] === 'applications') {
        $stmt = $pdo->prepare(
            'SELECT se.*, u.shop_name AS shop_display_name, u.shop_username AS shop_username_val
               FROM shop_employees se
               JOIN users u ON u.id = se.shop_user_id
              WHERE se.applicant_user_id = :uid
              ORDER BY se.id DESC'
        );
        $stmt->execute([':uid' => $userId]);
        $rows = $stmt->fetchAll();
        $out = array_map(function (array $r): array {
            $item = [
                'id' => (int)$r['id'],
                'shop_username' => $r['shop_username_val'],
                'shop_name' => $r['shop_display_name'],
                'status' => $r['status'],
                'created_at' => $r['created_at'],
            ];
            if ($r['status'] === 'active') {
                $item['login_id'] = $r['login_id'];
            }
            return $item;
        }, $rows);
        json_out(['applications' => $out]);
    }

    $user = store_find_user_by_id($userId);
    $state = [
        'is_shop' => !empty($user['is_shop']),
        'shop_username' => $user['shop_username'] ?? null,
        'slots_total' => shop_slot_total($user),
        'slots_used' => shop_active_employee_count($pdo, $userId),
        'is_employee_session' => $isEmployee,
    ];
    if (!$isEmployee && !empty($user['is_shop'])) {
        $activeStmt = $pdo->prepare("SELECT * FROM shop_employees WHERE shop_user_id = :sid AND status = 'active' ORDER BY id DESC");
        $activeStmt->execute([':sid' => $userId]);
        $state['employees'] = array_map('shop_employee_row_out', $activeStmt->fetchAll());

        $pendingStmt = $pdo->prepare("SELECT * FROM shop_employees WHERE shop_user_id = :sid AND status = 'pending' ORDER BY id DESC");
        $pendingStmt->execute([':sid' => $userId]);
        $state['pending_applications'] = array_map('shop_employee_row_out', $pendingStmt->fetchAll());
    }
    json_out(['shop' => $state]);
}

if ($method === 'POST') {
    $body = json_body();
    $action = (string)($body['action'] ?? '');

    switch ($action) {
        case 'create': {
            require_owner_session();
            $user = store_find_user_by_id($userId);
            if (!empty($user['is_shop'])) {
                json_fail('У вас уже есть магазин', 409);
            }
            if (!empty($user['is_guest'])) {
                json_fail('Сначала завершите регистрацию (укажите почту и пароль) — гостям создавать магазин нельзя', 403);
            }
            if (empty($user['is_verified'])) {
                json_fail('Сначала подтвердите почту — без этого нельзя создать магазин', 403);
            }
            $username = strtolower(trim((string)($body['username'] ?? '')));
            if (!shop_username_valid($username)) {
                json_fail('Юзернейм: 3–24 символа, латиница/цифры/подчёркивание', 422);
            }
            if (store_find_user_by_shop_username($username)) {
                json_fail('Этот юзернейм уже занят', 409);
            }
            $pdo->prepare('UPDATE users SET is_shop = 1, shop_username = :su WHERE id = :id')
                ->execute([':su' => $username, ':id' => $userId]);

            if (strtolower((string)($user['username'] ?? '')) !== $username && !store_find_user_by_username($username)) {
                $pdo->prepare('UPDATE users SET username = :u WHERE id = :id')
                    ->execute([':u' => $username, ':id' => $userId]);
            }
            json_out(['ok' => true, 'shop_username' => $username]);
            break;
        }

        case 'add_employee': {
            require_owner_session();
            $user = store_find_user_by_id($userId);
            if (empty($user['is_shop'])) {
                json_fail('Сначала создайте магазин', 422);
            }
            $displayName = trim((string)($body['display_name'] ?? ''));
            // BEGIN IMMEDIATE берёт блокировку на запись сразу, до чтения счётчика
            // мест — иначе два параллельных запроса (двойной клик, две вкладки)
            // оба проходят проверку лимита по одному и тому же старому счётчику
            // и оба вставляют строку, превышая купленные слоты (см. тот же приём
            // в db_migrate() в db.php).
            $pdo->exec('BEGIN IMMEDIATE');
            try {
                $total = shop_slot_total($user);
                $used = shop_active_employee_count($pdo, $userId);
                if ($used >= $total) {
                    $pdo->exec('ROLLBACK');
                    json_fail('Достигнут лимит мест (' . $total . '). Купите ещё +' . SHOP_SLOTS_PER_BLOCK . ' за ' . SHOP_SLOT_BLOCK_PRICE . ' сомони.', 403);
                }
                if ($displayName === '') {
                    $displayName = 'Сотрудник ' . ($used + 1);
                }
                $loginId = shop_generate_login_id($pdo);
                $password = shop_generate_password();
                $hash = password_hash($password, PASSWORD_BCRYPT);
                $pdo->prepare("INSERT INTO shop_employees (shop_user_id, display_name, login_id, password_hash, status) VALUES (:sid, :name, :lid, :hash, 'active')")
                    ->execute([':sid' => $userId, ':name' => $displayName, ':lid' => $loginId, ':hash' => $hash]);
                $pdo->exec('COMMIT');
            } catch (Throwable $e) {
                $pdo->exec('ROLLBACK');
                throw $e;
            }
            json_out(['login_id' => $loginId, 'password' => $password, 'display_name' => $displayName], 201);
            break;
        }

        case 'revoke': {
            require_owner_session();
            $id = (int)($body['id'] ?? 0);
            $stmt = $pdo->prepare("UPDATE shop_employees SET status = 'revoked', decided_at = datetime('now') WHERE id = :id AND shop_user_id = :sid AND status = 'active'");
            $stmt->execute([':id' => $id, ':sid' => $userId]);
            if ($stmt->rowCount() === 0) {
                json_fail('Сотрудник не найден', 404);
            }
            json_out(['ok' => true]);
            break;
        }

        case 'reset_password': {
            require_owner_session();
            $id = (int)($body['id'] ?? 0);
            $check = $pdo->prepare("SELECT id FROM shop_employees WHERE id = :id AND shop_user_id = :sid AND status = 'active'");
            $check->execute([':id' => $id, ':sid' => $userId]);
            if (!$check->fetch()) {
                json_fail('Сотрудник не найден', 404);
            }
            $password = shop_generate_password();
            $hash = password_hash($password, PASSWORD_BCRYPT);
            $pdo->prepare('UPDATE shop_employees SET password_hash = :hash WHERE id = :id')
                ->execute([':hash' => $hash, ':id' => $id]);
            json_out(['password' => $password]);
            break;
        }

        case 'apply': {
            if ($isEmployee) {
                json_fail('Недоступно в режиме сотрудника', 403);
            }
            $user = store_find_user_by_id($userId);
            if (!empty($user['is_shop'])) {
                json_fail('У владельцев магазинов нельзя подавать заявки', 422);
            }
            $username = strtolower(trim((string)($body['shop_username'] ?? '')));
            $shop = store_find_user_by_shop_username($username);
            if (!$shop || empty($shop['is_shop'])) {
                json_fail('Магазин с таким юзернеймом не найден', 404);
            }
            if ((int)$shop['id'] === $userId) {
                json_fail('Нельзя подать заявку в свой же магазин', 422);
            }
            $dupStmt = $pdo->prepare("SELECT id FROM shop_employees WHERE shop_user_id = :sid AND applicant_user_id = :uid AND status IN ('pending','active')");
            $dupStmt->execute([':sid' => $shop['id'], ':uid' => $userId]);
            if ($dupStmt->fetch()) {
                json_fail('У вас уже есть заявка или место в этом магазине', 409);
            }
            $cooldownStmt = $pdo->prepare("SELECT id FROM shop_employees WHERE shop_user_id = :sid AND applicant_user_id = :uid
                                            AND status IN ('rejected','revoked') AND decided_at > datetime('now', '-24 hours')");
            $cooldownStmt->execute([':sid' => $shop['id'], ':uid' => $userId]);
            if ($cooldownStmt->fetch()) {
                json_fail('Заявка недавно отклонена — попробуйте снова через 24 часа', 429);
            }
            $pdo->prepare("INSERT INTO shop_employees (shop_user_id, applicant_user_id, display_name, status) VALUES (:sid, :uid, :name, 'pending')")
                ->execute([':sid' => $shop['id'], ':uid' => $userId, ':name' => $user['shop_name']]);
            json_out(['ok' => true], 201);
            break;
        }

        case 'approve': {
            require_owner_session();
            $id = (int)($body['id'] ?? 0);
            // BEGIN IMMEDIATE — та же защита, что и в add_employee выше: без неё
            // два параллельных approve (в т.ч. на разные заявки одновременно)
            // могут оба пройти проверку лимита мест по устаревшему счётчику.
            $pdo->exec('BEGIN IMMEDIATE');
            try {
                $stmt = $pdo->prepare("SELECT * FROM shop_employees WHERE id = :id AND shop_user_id = :sid AND status = 'pending'");
                $stmt->execute([':id' => $id, ':sid' => $userId]);
                $application = $stmt->fetch();
                if (!$application) {
                    $pdo->exec('ROLLBACK');
                    json_fail('Заявка не найдена', 404);
                }
                $user = store_find_user_by_id($userId);
                $total = shop_slot_total($user);
                $used = shop_active_employee_count($pdo, $userId);
                if ($used >= $total) {
                    $pdo->exec('ROLLBACK');
                    json_fail('Нет свободных мест — купите ещё или освободите место', 403);
                }
                $loginId = shop_generate_login_id($pdo);
                $password = shop_generate_password();
                $hash = password_hash($password, PASSWORD_BCRYPT);
                $upd = $pdo->prepare("UPDATE shop_employees SET status = 'active', login_id = :lid, password_hash = :hash, decided_at = datetime('now') WHERE id = :id AND status = 'pending'");
                $upd->execute([':lid' => $loginId, ':hash' => $hash, ':id' => $id]);
                if ($upd->rowCount() === 0) {
                    $pdo->exec('ROLLBACK');
                    json_fail('Заявка не найдена', 404);
                }
                $pdo->exec('COMMIT');
            } catch (Throwable $e) {
                $pdo->exec('ROLLBACK');
                throw $e;
            }
            json_out(['login_id' => $loginId, 'password' => $password]);
            break;
        }

        case 'reject': {
            require_owner_session();
            $id = (int)($body['id'] ?? 0);
            $stmt = $pdo->prepare("UPDATE shop_employees SET status = 'rejected', decided_at = datetime('now') WHERE id = :id AND shop_user_id = :sid AND status = 'pending'");
            $stmt->execute([':id' => $id, ':sid' => $userId]);
            if ($stmt->rowCount() === 0) {
                json_fail('Заявка не найдена', 404);
            }
            json_out(['ok' => true]);
            break;
        }

        case 'purchase_slots': {
            require_owner_session();
            $user = store_find_user_by_id($userId);
            if (empty($user['is_shop'])) {
                json_fail('Сначала создайте магазин', 422);
            }
            $payerName = trim((string)($body['payer_name'] ?? ''));
            $payerDigits = trim((string)($body['payer_digits'] ?? ''));
            if ($payerName === '' || $payerDigits === '') {
                json_fail('Укажите имя плательщика и последние цифры карты', 422);
            }
            $dup = $pdo->prepare("SELECT id FROM payments WHERE user_id = :uid AND plan = 'employee_slots' AND status = 'pending'");
            $dup->execute([':uid' => $userId]);
            if ($dup->fetch()) {
                json_fail('У вас уже есть заявка на покупку мест — дождитесь подтверждения', 409);
            }
            $pdo->prepare("INSERT INTO payments (user_id, plan, amount, payer_name, payer_digits) VALUES (:uid, 'employee_slots', :amount, :name, :digits)")
                ->execute([':uid' => $userId, ':amount' => SHOP_SLOT_BLOCK_PRICE, ':name' => $payerName, ':digits' => $payerDigits]);
            json_out(['ok' => true], 201);
            break;
        }

        default:
            json_fail('Неизвестное действие', 400);
    }
}

json_fail('Метод не поддерживается', 405);
