<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
start_session();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(['error' => 'Метод не поддерживается'], 405);
}
csrf_verify();

$body = json_body();
$email = trim(strtolower((string)($body['email'] ?? '')));
$password = (string)($body['password'] ?? '');

rate_limit_guard('login', $email);

$user = store_find_user_by_email($email);

if ($user && empty($user['password_hash'])) {
    json_out(['error' => 'У этого аккаунта нет пароля — войдите через Google или Telegram'], 401);
}

if (!$user || !password_verify($password, $user['password_hash'])) {
    rate_limit_fail('login', $email);
    json_out(['error' => 'Неверный email или пароль'], 401);
}
rate_limit_clear('login', $email);

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
    'is_verified' => !empty($user['is_verified']),
    'created_at' => $user['created_at'] ?? null,
]]);
