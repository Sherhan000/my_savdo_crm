<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/features.php';
require_once __DIR__ . '/../config/payment.php';
require_once __DIR__ . '/../config/shop.php';
start_session();

if (empty($_SESSION['user_id'])) {
    json_fail('Не авторизован', 401);
}
$userId = (int)$_SESSION['user_id'];

$pdo = db();
if (!$pdo) {
    json_fail('Хранилище недоступно на этом сервере (нет PDO SQLite)', 503);
}

require_once __DIR__ . '/plan-lib.php';

// Реквизиты/QR редактируются в админке (settings-таблица) — если админ там
// ничего не задал, используем дефолт из payment.php (env-переменные).
function payment_requisites_read(int $userId): array {
    $settings = settings_read();
    return [
        'card' => (string)($settings['payment_card'] ?? '') !== '' ? $settings['payment_card'] : PAYMENT_CARD_NUMBER,
        'holder' => (string)($settings['payment_holder'] ?? '') !== '' ? $settings['payment_holder'] : PAYMENT_CARD_HOLDER,
        'bank' => (string)($settings['payment_bank'] ?? '') !== '' ? $settings['payment_bank'] : PAYMENT_BANK_NAME,
        'comment' => ((string)($settings['payment_comment'] ?? '') !== '' ? $settings['payment_comment'] : PAYMENT_COMMENT_PREFIX) . '-' . $userId,
        'qr' => (string)($settings['payment_qr'] ?? '') !== '' ? $settings['payment_qr'] : null,
    ];
}

function plan_out(?array $row): ?array {
    if (!$row) return null;
    $meta = PLANS_META[$row['plan']] ?? ['title' => $row['plan'], 'price' => 0];
    return [
        'id' => (int)$row['id'],
        'plan' => $row['plan'],
        'title' => $meta['title'],
        'price' => $meta['price'],
        'status' => $row['status'],
        'starts_at' => $row['starts_at'],
        'ends_at' => $row['ends_at'],
        'remaining_seconds' => $row['remaining_seconds'] !== null ? (int)$row['remaining_seconds'] : null,
    ];
}

planlib_ensure($pdo, $userId);

function plan_state(PDO $pdo, int $userId): array {
    $act = planlib_get_active($pdo, $userId);
    $pen = $pdo->prepare("SELECT * FROM user_plans WHERE user_id = :uid AND status = 'paused' ORDER BY (plan='demo') ASC, id ASC");
    $pen->execute([':uid' => $userId]);
    $demoUsed = $pdo->prepare("SELECT COUNT(*) FROM user_plans WHERE user_id = :uid AND plan = 'demo'");
    $demoUsed->execute([':uid' => $userId]);
    $pays = $pdo->prepare("SELECT id, plan, amount, status, created_at FROM payments WHERE user_id = :uid ORDER BY id DESC LIMIT 10");
    $pays->execute([':uid' => $userId]);

    $features = user_features($pdo, $userId);
    $limit = $features['ai_daily_limit'];
    $bonusStmt = $pdo->prepare('SELECT ai_bonus, insta_bonus_at FROM users WHERE id = :id');
    $bonusStmt->execute([':id' => $userId]);
    $bonusRow = $bonusStmt->fetch() ?: ['ai_bonus' => 0, 'insta_bonus_at' => null];
    return [
        'active' => plan_out($act),
        'paused' => array_map('plan_out', $pen->fetchAll()),
        'demo_used' => (int)$demoUsed->fetchColumn() > 0,
        'payments' => $pays->fetchAll(),
        'features' => $features,
        'ai_usage' => ['used' => ai_used_today($pdo, $userId), 'limit' => $limit, 'bonus' => (int)$bonusRow['ai_bonus']],
        'insta_bonus_claimed' => $bonusRow['insta_bonus_at'] !== null,
        'payment_requisites' => payment_requisites_read($userId),
    ];
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    json_out(plan_state($pdo, $userId));
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_fail('Метод не поддерживается', 405);
}
csrf_verify();

require_owner_session();

$body = json_body();
$action = (string)($body['action'] ?? 'purchase');

if ($action === 'switch') {

    $planId = (int)($body['plan_id'] ?? 0);
    $stmt = $pdo->prepare("SELECT * FROM user_plans WHERE id = :id AND user_id = :uid AND status = 'paused'");
    $stmt->execute([':id' => $planId, ':uid' => $userId]);
    $target = $stmt->fetch();
    if (!$target) {
        json_fail('Тариф на паузе не найден', 404);
    }
    $active = planlib_get_active($pdo, $userId);
    if ($active) {
        planlib_pause_active($pdo, $active);
    }
    planlib_activate_row($pdo, $target, $userId);
    json_out(plan_state($pdo, $userId));
}

if ($action === 'purchase') {
    $plan = (string)($body['plan'] ?? '');
    if (!isset(PLANS_META[$plan])) {
        json_fail('Неизвестный тариф', 422);
    }
    $user = store_find_user_by_id($userId);
    if (empty($user['is_verified'])) {
        json_fail('Сначала подтвердите почту — без этого нельзя купить тариф', 403);
    }
    $state = plan_state($pdo, $userId);

    if ($plan === 'demo') {
        if ($state['demo_used']) {
            json_fail('Тариф «Демо» доступен только один раз для каждого аккаунта', 422);
        }
        planlib_grant($pdo, $userId, 'demo');
        json_out(plan_state($pdo, $userId));
    }

    if ($state['active'] && $state['active']['plan'] === $plan) {
        json_fail('Этот тариф уже подключён', 422);
    }
    foreach ($state['paused'] as $p) {
        if ($p['plan'] === $plan) {
            json_fail('Этот тариф уже подключён и ждёт на паузе', 422);
        }
    }

    foreach ($state['payments'] as $p) {
        if ($p['plan'] === $plan && $p['status'] === 'pending') {
            json_fail('Заявка на оплату этого тарифа уже отправлена и ждёт подтверждения', 422);
        }
    }

    $payerName = mb_substr(trim((string)($body['payer_name'] ?? '')), 0, 80);
    $payerDigits = preg_replace('/\D/', '', (string)($body['payer_digits'] ?? ''));
    $payerDigits = substr($payerDigits, -4);
    if ($payerName === '' || strlen($payerDigits) !== 4) {
        json_fail('Укажите имя отправителя и последние 4 цифры карты, с которой был перевод', 422);
    }

    $pdo->prepare('INSERT INTO payments (user_id, plan, amount, payer_name, payer_digits) VALUES (:uid, :plan, :amount, :name, :digits)')
        ->execute([
            ':uid' => $userId, ':plan' => $plan,
            ':amount' => (int)PLANS_META[$plan]['price'],
            ':name' => $payerName, ':digits' => $payerDigits,
        ]);

    json_out(plan_state($pdo, $userId));
}

json_fail('Неизвестное действие', 422);
