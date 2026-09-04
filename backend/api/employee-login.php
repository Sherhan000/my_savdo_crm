<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/shop.php';
start_session();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(['error' => 'Метод не поддерживается'], 405);
}
csrf_verify();

$pdo = db();
if (!$pdo) {
    json_fail('Вход сотрудников недоступен на этом сервере (нет PDO SQLite)', 503);
}

$body = json_body();
$loginId = trim((string)($body['login_id'] ?? ''));
$password = (string)($body['password'] ?? '');

if ($loginId === '' || $password === '') {
    json_out(['error' => 'Укажите ID и пароль сотрудника'], 422);
}

rate_limit_guard('employee_login', $loginId, 5, 15);

$stmt = $pdo->prepare("SELECT * FROM shop_employees WHERE login_id = :lid AND status = 'active'");
$stmt->execute([':lid' => $loginId]);
$employee = $stmt->fetch();

if (!$employee || !password_verify($password, (string)$employee['password_hash'])) {
    rate_limit_fail('employee_login', $loginId, 5, 15);
    json_out(['error' => 'Неверный ID или пароль сотрудника'], 401);
}

rate_limit_clear('employee_login', $loginId);

$owner = store_find_user_by_id((int)$employee['shop_user_id']);
if (!$owner) {
    json_out(['error' => 'Магазин не найден'], 404);
}

session_regenerate_id(true);
$_SESSION['user_id'] = $owner['id'];
$_SESSION['employee_id'] = $employee['id'];

json_out([
    'user' => [
        'id' => $owner['id'],
        'shop_name' => $owner['shop_name'],
        'email' => $owner['email'],
        'plan' => $owner['plan'],
        'avatar' => $owner['avatar'] ?? null,
        'username' => $owner['username'] ?? null,
        'is_guest' => !empty($owner['is_guest']),
    ],
    'employee' => [
        'id' => (int)$employee['id'],
        'display_name' => $employee['display_name'],
    ],
]);
