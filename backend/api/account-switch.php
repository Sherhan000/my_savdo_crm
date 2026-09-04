<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/account_switch.php';
start_session();

if (empty($_SESSION['user_id'])) {
    json_fail('Не авторизован', 401);
}
$userId = (int)$_SESSION['user_id'];

$pdo = db();
if (!$pdo) {
    json_fail('Хранилище недоступно на этом сервере (нет PDO SQLite)', 503);
}

function acs_account_out(array $u, ?string $token = null): array {
    $out = [
        'user_id' => (int)$u['id'],
        'shop_name' => $u['shop_name'],
        'email' => $u['email'],
        'avatar' => $u['avatar'] ?? null,
        'username' => $u['username'] ?? null,
    ];
    if ($token !== null) {
        $out['token'] = $token;
    }
    return $out;
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    // Список привязанных аккаунтов (чужие email/аватары/юзернеймы) — личные
    // данные владельца магазина, сотруднику их видеть нельзя, как и все
    // POST-действия этого файла ниже.
    require_owner_session();
    $stmt = $pdo->prepare(
        "SELECT la.linked_user_id, la.counts_toward_quota, u.id, u.shop_name, u.email, u.avatar, u.username
           FROM linked_accounts la JOIN users u ON u.id = la.linked_user_id
          WHERE la.user_id = :uid
          ORDER BY la.created_at ASC"
    );
    $stmt->execute([':uid' => $userId]);
    $rows = $stmt->fetchAll();

    $used = 0;
    foreach ($rows as $r) {
        if (!empty($r['counts_toward_quota'])) {
            $used++;
        }
    }

    $user = store_find_user_by_id($userId);
    json_out([
        'linked' => array_map(static fn(array $r): array => acs_account_out($r), $rows),
        'slots_used' => $used,
        'slots_total' => account_switch_slot_total($user ?? []),
        'slot_price' => ACCOUNT_SWITCH_SLOT_PRICE,
    ]);
}

if ($method !== 'POST') {
    json_fail('Метод не поддерживается', 405);
}
csrf_verify();
require_owner_session();

$body = json_body();
$action = (string)($body['action'] ?? '');

if ($action === 'link') {
    $email = trim(strtolower((string)($body['email'] ?? '')));
    $password = (string)($body['password'] ?? '');
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        json_fail('Некорректный email', 422);
    }

    rate_limit_guard('account_link', $email);

    $target = store_find_user_by_email($email);
    if (!$target || empty($target['password_hash']) || empty($target['password_set'])
        || !password_verify($password, (string)$target['password_hash'])) {
        rate_limit_fail('account_link', $email);
        json_fail('Неверный email или пароль', 403);
    }
    rate_limit_clear('account_link', $email);

    $targetId = (int)$target['id'];
    if ($targetId === $userId) {
        json_fail('Это и есть текущий аккаунт', 422);
    }
    if (!empty($target['is_guest'])) {
        json_fail('Гостевой доступ нельзя подключить к переключателю', 422);
    }

    $existing = $pdo->prepare('SELECT id FROM linked_accounts WHERE user_id = :uid AND linked_user_id = :tid');
    $existing->execute([':uid' => $userId, ':tid' => $targetId]);
    $row = $existing->fetch();

    $tokenForCurrent = bin2hex(random_bytes(32));

    if ($row) {
        // Уже связаны — просто перевыпускаем токен нашей стороны (например,
        // если на этом устройстве очистили хранилище). Токен на стороне
        // target не трогаем, чтобы не сломать его уже работающий переключатель.
        $pdo->prepare('UPDATE linked_accounts SET token_hash = :h WHERE id = :id')
            ->execute([':h' => hash('sha256', $tokenForCurrent), ':id' => $row['id']]);
    } else {
        $user = store_find_user_by_id($userId);
        $used = account_switch_used_slots($pdo, $userId);
        $total = account_switch_slot_total($user ?? []);
        if ($used >= $total) {
            json_fail('Достигнут лимит подключённых аккаунтов — купите ещё слот', 409);
        }

        $pdo->prepare('INSERT INTO linked_accounts (user_id, linked_user_id, token_hash, counts_toward_quota) VALUES (:uid, :tid, :h, 1)')
            ->execute([':uid' => $userId, ':tid' => $targetId, ':h' => hash('sha256', $tokenForCurrent)]);

        // Взаимная запись на стороне target — создаётся только один раз, при
        // первом связывании, свой слот у target не расходует.
        $tokenForTarget = bin2hex(random_bytes(32));
        $pdo->prepare('INSERT INTO linked_accounts (user_id, linked_user_id, token_hash, counts_toward_quota) VALUES (:uid, :tid, :h, 0)')
            ->execute([':uid' => $targetId, ':tid' => $userId, ':h' => hash('sha256', $tokenForTarget)]);
    }

    json_out(['ok' => true, 'account' => acs_account_out($target, $tokenForCurrent)], 201);
}

if ($action === 'switch') {
    $targetId = (int)($body['user_id'] ?? 0);
    $token = (string)($body['token'] ?? '');
    if ($targetId <= 0 || $token === '') {
        json_fail('Некорректный запрос', 422);
    }
    $row = $pdo->prepare('SELECT token_hash FROM linked_accounts WHERE user_id = :uid AND linked_user_id = :tid');
    $row->execute([':uid' => $userId, ':tid' => $targetId]);
    $r = $row->fetch();
    if (!$r || !hash_equals((string)$r['token_hash'], hash('sha256', $token))) {
        json_fail('Не удалось переключиться — попробуйте добавить этот аккаунт заново', 403);
    }
    $target = store_find_user_by_id($targetId);
    if (!$target) {
        json_fail('Аккаунт не найден', 404);
    }

    $pdo->prepare("UPDATE linked_accounts SET last_switched_at = datetime('now') WHERE user_id = :uid AND linked_user_id = :tid")
        ->execute([':uid' => $userId, ':tid' => $targetId]);

    session_regenerate_id(true);
    $_SESSION['user_id'] = $targetId;

    json_out(['user' => [
        'id' => $target['id'],
        'shop_name' => $target['shop_name'],
        'email' => $target['email'],
        'plan' => $target['plan'],
        'avatar' => $target['avatar'] ?? null,
        'username' => $target['username'] ?? null,
        'is_guest' => !empty($target['is_guest']),
        'is_verified' => !empty($target['is_verified']),
        'created_at' => $target['created_at'] ?? null,
    ]]);
}

if ($action === 'claim') {
    // Для взаимной стороны связи (нас кто-то добавил к себе) или когда на
    // этом устройстве потеряли токен — перевыпускаем токен своей же строки,
    // пароль второй раз вводить не нужно, сессия уже подтверждает право.
    $targetId = (int)($body['user_id'] ?? 0);
    $row = $pdo->prepare('SELECT id FROM linked_accounts WHERE user_id = :uid AND linked_user_id = :tid');
    $row->execute([':uid' => $userId, ':tid' => $targetId]);
    $r = $row->fetch();
    if (!$r) {
        json_fail('Аккаунт не связан с текущим', 404);
    }
    $target = store_find_user_by_id($targetId);
    if (!$target) {
        json_fail('Аккаунт не найден', 404);
    }
    $token = bin2hex(random_bytes(32));
    $pdo->prepare('UPDATE linked_accounts SET token_hash = :h WHERE id = :id')
        ->execute([':h' => hash('sha256', $token), ':id' => $r['id']]);
    json_out(['ok' => true, 'account' => acs_account_out($target, $token)]);
}

if ($action === 'unlink') {
    $targetId = (int)($body['user_id'] ?? 0);
    // Удаляем связь в обе стороны — иначе тот, кого отключили, всё ещё
    // сможет переключиться на нас своим (ещё живым) токеном.
    $pdo->prepare('DELETE FROM linked_accounts WHERE (user_id = :uid AND linked_user_id = :tid) OR (user_id = :tid2 AND linked_user_id = :uid2)')
        ->execute([':uid' => $userId, ':tid' => $targetId, ':tid2' => $targetId, ':uid2' => $userId]);
    json_out(['ok' => true]);
}

if ($action === 'purchase_slot') {
    $payerName = trim((string)($body['payer_name'] ?? ''));
    $payerDigits = trim((string)($body['payer_digits'] ?? ''));
    if ($payerName === '' || $payerDigits === '') {
        json_fail('Укажите имя плательщика и последние цифры карты', 422);
    }
    $dup = $pdo->prepare("SELECT id FROM payments WHERE user_id = :uid AND plan = 'account_slots' AND status = 'pending'");
    $dup->execute([':uid' => $userId]);
    if ($dup->fetch()) {
        json_fail('У вас уже есть заявка на покупку слота — дождитесь подтверждения', 409);
    }
    $pdo->prepare("INSERT INTO payments (user_id, plan, amount, payer_name, payer_digits) VALUES (:uid, 'account_slots', :amount, :name, :digits)")
        ->execute([':uid' => $userId, ':amount' => ACCOUNT_SWITCH_SLOT_PRICE, ':name' => $payerName, ':digits' => $payerDigits]);
    json_out(['ok' => true], 201);
}

json_fail('Неизвестное действие', 422);
