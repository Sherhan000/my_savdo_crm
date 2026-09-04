<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/bootstrap.php';
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

function user_out(array $u): array {
    return [
        'id' => (int)$u['id'],
        'shop_name' => $u['shop_name'],
        'email' => $u['email'],
        'plan' => $u['plan'],
        'avatar' => $u['avatar'] ?? null,
        'has_password' => !empty($u['password_hash']) && !empty($u['password_set']),
        'username' => $u['username'] ?? null,
        'phone' => $u['phone'] ?? null,
        'is_guest' => !empty($u['is_guest']),
        'sales_goal' => isset($u['sales_goal']) ? (int)$u['sales_goal'] : 0,
    ];
}

$stmt = $pdo->prepare('SELECT * FROM users WHERE id = :id');
$stmt->execute([':id' => $userId]);
$user = $stmt->fetch();
if (!$user) {
    json_fail('Пользователь не найден', 404);
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    json_out(['user' => user_out($user)]);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_fail('Метод не поддерживается', 405);
}
csrf_verify();

require_owner_session();

$body = json_body();
$fields = [];
$params = [':id' => $userId];

if (isset($body['shop_name'])) {
    $shopName = trim((string)$body['shop_name']);
    if ($shopName === '') {
        json_fail('Название магазина не может быть пустым', 422);
    }
    if (mb_strlen($shopName) > 80) {
        json_fail('Слишком длинное название магазина', 422);
    }
    $fields[] = 'shop_name = :shop_name';
    $params[':shop_name'] = $shopName;
}

if (isset($body['phone'])) {
    $phone = trim((string)$body['phone']);
    if ($phone !== '') {
        $digits = preg_replace('/[^0-9]/', '', $phone);
        if (mb_strlen($phone) > 32 || strlen($digits) < 7) {
            json_fail('Некорректный номер телефона', 422);
        }
        $fields[] = 'phone = :phone';
        $params[':phone'] = $phone;
    } else {
        $fields[] = 'phone = NULL';
    }
}

if (isset($body['sales_goal'])) {
    $rawGoal = trim((string)$body['sales_goal']);
    if ($rawGoal === '') {
        $fields[] = 'sales_goal = NULL';
    } else {
        if (!ctype_digit($rawGoal)) {
            json_fail('Цель продаж должна быть числом', 422);
        }
        $goal = (int)$rawGoal;
        if ($goal > 1000000000) {
            json_fail('Слишком большое число', 422);
        }
        $fields[] = 'sales_goal = :sales_goal';
        $params[':sales_goal'] = $goal;
    }
}

if (isset($body['avatar_url'])) {
    $avatar = trim((string)$body['avatar_url']);
    if ($avatar !== '') {
        $clean = ltrim($avatar, '/');
        $isUploaded = str_starts_with($clean, 'assets/img/uploads/') && basename($clean) === substr($clean, strlen('assets/img/uploads/'));
        $isGoogle = str_starts_with($avatar, 'https://lh3.googleusercontent.com/');
        if (!$isUploaded && !$isGoogle) {
            json_fail('Недопустимый адрес фото профиля', 422);
        }
        $fields[] = 'avatar = :avatar';
        $params[':avatar'] = $isUploaded ? $clean : $avatar;
    } else {
        $fields[] = 'avatar = NULL';
    }
}

if (isset($body['username'])) {
    $newUsername = strtolower(trim((string)$body['username']));
    if (!store_username_valid($newUsername)) {
        json_fail('Юзернейм: 3–24 символа, латиница/цифры/подчёркивание', 422);
    }
    if ($newUsername !== strtolower((string)($user['username'] ?? ''))) {
        $existing = store_find_user_by_username($newUsername);
        if ($existing && (int)$existing['id'] !== $userId) {
            json_fail('Этот юзернейм уже занят', 409);
        }
        $fields[] = 'username = :username';
        $params[':username'] = $newUsername;
    }
}

$newEmail = isset($body['email']) ? strtolower(trim((string)$body['email'])) : null;
$newPassword = isset($body['new_password']) ? (string)$body['new_password'] : null;
$currentPassword = (string)($body['current_password'] ?? '');

$wantsSensitive = ($newEmail !== null && $newEmail !== strtolower((string)$user['email']))
    || ($newPassword !== null && $newPassword !== '');

if ($wantsSensitive) {
    $hasPassword = !empty($user['password_hash']) && !empty($user['password_set']);
    if ($hasPassword) {
        if ($currentPassword === '' || !password_verify($currentPassword, (string)$user['password_hash'])) {
            json_fail('Текущий пароль указан неверно', 403);
        }
    }

    if ($newEmail !== null && $newEmail !== strtolower((string)$user['email'])) {
        if (!filter_var($newEmail, FILTER_VALIDATE_EMAIL)) {
            json_fail('Некорректный email', 422);
        }
        if (preg_match('/^(tg\d+(\.[a-f0-9]+)?@telegram|guest[a-f0-9]+@guest)\.mysavdo\.local$/i', $newEmail)) {
            json_fail('Этот адрес зарезервирован системой', 422);
        }
        $check = $pdo->prepare('SELECT id FROM users WHERE email = :e AND id != :id');
        $check->execute([':e' => $newEmail, ':id' => $userId]);
        if ($check->fetch()) {
            json_fail('Этот email уже занят другим аккаунтом', 422);
        }
        $fields[] = 'email = :email';
        $params[':email'] = $newEmail;
        if (!empty($user['is_guest'])) {
            $fields[] = 'is_guest = 0';
        }
    }

    if ($newPassword !== null && $newPassword !== '') {
        if (mb_strlen($newPassword) < 6) {
            json_fail('Новый пароль должен быть не короче 6 символов', 422);
        }
        $fields[] = 'password_hash = :ph';
        $params[':ph'] = password_hash($newPassword, PASSWORD_BCRYPT);
        $fields[] = 'password_set = 1';
    }
}

if (!$fields) {
    json_fail('Нечего обновлять', 422);
}

$sql = 'UPDATE users SET ' . implode(', ', $fields) . ' WHERE id = :id';
$pdo->prepare($sql)->execute($params);

$stmt = $pdo->prepare('SELECT * FROM users WHERE id = :id');
$stmt->execute([':id' => $userId]);
json_out(['user' => user_out($stmt->fetch())]);
