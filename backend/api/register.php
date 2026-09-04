<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
start_session();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(['error' => 'Метод не поддерживается'], 405);
}
csrf_verify();

$body = json_body();
$shopName = trim((string)($body['shop_name'] ?? ''));
$email = trim(strtolower((string)($body['email'] ?? '')));
$password = (string)($body['password'] ?? '');
$phone = trim((string)($body['phone'] ?? ''));

rate_limit_guard('register', 'global', 15, 30);

if ($shopName === '') $shopName = 'Мой магазин';
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    json_out(['error' => 'Некорректный email'], 422);
}
if ($phone !== '') {
    $digits = preg_replace('/[^0-9]/', '', $phone);
    if (mb_strlen($phone) > 32 || strlen($digits) < 7) {
        json_out(['error' => 'Некорректный номер телефона'], 422);
    }
}
if (preg_match('/^tg\d+(\.[a-f0-9]+)?@telegram\.mysavdo\.local$/i', $email)) {
    json_out(['error' => 'Этот адрес зарезервирован для входа через Telegram'], 422);
}
if (preg_match('/^guest[a-f0-9]+@guest\.mysavdo\.local$/i', $email)) {
    json_out(['error' => 'Этот адрес зарезервирован для гостевого доступа'], 422);
}
if (strlen($password) < 6) {
    json_out(['error' => 'Пароль должен быть не короче 6 символов'], 422);
}

if (store_find_user_by_email($email)) {
    rate_limit_fail('register', 'global', 15, 30);
    json_out(['error' => 'Аккаунт с таким email уже существует'], 409);
}

$hash = password_hash($password, PASSWORD_BCRYPT);
$user = store_create_user($shopName, $email, $hash, ['phone' => $phone !== '' ? $phone : null]);

session_regenerate_id(true);
$_SESSION['user_id'] = $user['id'];

json_out(['user' => [
    'id' => $user['id'],
    'shop_name' => $user['shop_name'],
    'email' => $user['email'],
    'plan' => $user['plan'],
    'avatar' => $user['avatar'] ?? null,
    'username' => $user['username'] ?? null,
    'phone' => $user['phone'] ?? null,
    'is_guest' => !empty($user['is_guest']),
    'is_verified' => !empty($user['is_verified']),
    'created_at' => $user['created_at'] ?? null,
]], 201);
