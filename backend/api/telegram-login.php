<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/telegram.php';
start_session();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(['error' => 'Метод не поддерживается'], 405);
}
csrf_verify();

if (TELEGRAM_BOT_TOKEN === '' || TELEGRAM_BOT_TOKEN === 'ВСТАВЬ_СЮДА_ТОКЕН_БОТА') {
    json_out(['error' => 'Вход через Telegram не настроен: не задан TELEGRAM_BOT_TOKEN в backend/config/telegram.php'], 500);
}

$body = json_body();

rate_limit_guard('oauth_telegram', 'global', 20, 15);

if (!telegram_verify_auth($body)) {
    rate_limit_fail('oauth_telegram', 'global', 20, 15);
    json_out(['error' => 'Не удалось проверить данные Telegram — подпись неверна или устарела'], 401);
}

$telegramId = (string)$body['id'];
$firstName = trim((string)($body['first_name'] ?? ''));
$lastName = trim((string)($body['last_name'] ?? ''));
$username = trim((string)($body['username'] ?? ''));
$avatar = $body['photo_url'] ?? null;

$name = trim($firstName . ' ' . $lastName);
if ($name === '') {
    $name = $username !== '' ? '@' . $username : 'Мой магазин';
}

$user = store_find_user_by_telegram_id($telegramId);

if (!$user) {
    $email = 'tg' . $telegramId . '@telegram.mysavdo.local';
    $hash = password_hash(bin2hex(random_bytes(16)), PASSWORD_BCRYPT);
    try {
        $user = store_create_user($name, $email, $hash, [
            'telegram_id' => $telegramId,
            'avatar' => $avatar,
            'password_set' => false,
        ]);
    } catch (Throwable $e) {

        $user = store_find_user_by_telegram_id($telegramId);
        if (!$user) {

            $email = 'tg' . $telegramId . '.' . bin2hex(random_bytes(3)) . '@telegram.mysavdo.local';
            $user = store_create_user($name, $email, $hash, [
                'telegram_id' => $telegramId,
                'avatar' => $avatar,
                'password_set' => false,
            ]);
        }
    }
    store_mark_user_verified((int)$user['id']);
    $user = store_find_user_by_id((int)$user['id']);
}

session_regenerate_id(true);
$_SESSION['user_id'] = $user['id'];

json_out(['user' => [
    'id' => $user['id'],
    'shop_name' => $user['shop_name'],
    'email' => $user['email'],
    'plan' => $user['plan'],
    'avatar' => $user['avatar'] ?? null,
    'username' => $user['username'] ?? null,
    'is_guest' => !empty($user['is_guest']),
]]);
