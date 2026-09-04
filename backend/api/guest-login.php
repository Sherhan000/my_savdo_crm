<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
start_session();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(['error' => 'Метод не поддерживается'], 405);
}
csrf_verify();

rate_limit_guard('guest_login', 'global', 30, 15);
// guard() сам по себе ничего не считает — только fail() двигает счётчик
// попыток, без него лимит выше был мёртвым кодом и гостевые аккаунты
// создавались без всякого ограничения.
rate_limit_fail('guest_login', 'global', 30, 15);

$email = 'guest' . bin2hex(random_bytes(6)) . '@guest.mysavdo.local';
$hash = password_hash(bin2hex(random_bytes(16)), PASSWORD_BCRYPT);

$pdo = db();
if (!$pdo) {
    json_out(['error' => 'Гостевой доступ недоступен на этом сервере'], 503);
}

$user = store_create_user('Гость', $email, $hash, [
    'password_set' => false,
    'is_guest' => true,
    'username' => db_generate_username($pdo, 'guest'),
]);
store_mark_user_verified((int)$user['id']);
$user = store_find_user_by_id((int)$user['id']);

session_regenerate_id(true);
$_SESSION['user_id'] = $user['id'];

json_out(['user' => [
    'id' => $user['id'],
    'shop_name' => $user['shop_name'],
    'email' => $user['email'],
    'plan' => $user['plan'],
    'avatar' => $user['avatar'] ?? null,
    'username' => $user['username'] ?? null,
    'is_guest' => true,
]], 201);
