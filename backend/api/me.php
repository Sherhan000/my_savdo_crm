<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
start_session();

if (empty($_SESSION['user_id'])) {
    json_out(['error' => 'Не авторизован'], 401);
}

$user = store_find_user_by_id((int)$_SESSION['user_id']);

if (!$user) {
    json_out(['error' => 'Не авторизован'], 401);
}

$employee = null;
if (!empty($_SESSION['employee_id']) && ($pdo = db())) {
    $stmt = $pdo->prepare('SELECT id, display_name FROM shop_employees WHERE id = :id AND status = \'active\'');
    $stmt->execute([':id' => (int)$_SESSION['employee_id']]);
    $row = $stmt->fetch();
    if ($row) {
        $employee = ['id' => (int)$row['id'], 'display_name' => $row['display_name']];
    }
}

json_out(['user' => [
    'id' => $user['id'],
    'shop_name' => $user['shop_name'],
    'email' => $user['email'],
    'plan' => $user['plan'],
    'avatar' => $user['avatar'] ?? null,
    'is_shop' => !empty($user['is_shop']),
    'shop_username' => $user['shop_username'] ?? null,
    'username' => $user['username'] ?? null,
    'phone' => $user['phone'] ?? null,
    'is_guest' => !empty($user['is_guest']),
    'is_verified' => !empty($user['is_verified']),
    'created_at' => $user['created_at'] ?? null,
], 'employee' => $employee]);
