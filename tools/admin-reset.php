<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("Этот скрипт запускается только из консоли: php tools/admin-reset.php\n");
}

require_once __DIR__ . '/../backend/config/bootstrap.php';
require_once __DIR__ . '/../backend/config/db.php';

$pdo = db();
if (!$pdo) {
    exit("Не удалось открыть базу данных.\n");
}

$username = trim((string)(getenv('ADMIN_BOOTSTRAP_USERNAME') ?: ''));
$password = (string)(getenv('ADMIN_BOOTSTRAP_PASSWORD') ?: '');

if ($username === '' || strlen($password) < 8) {
    exit("В .env нет корректных ADMIN_BOOTSTRAP_USERNAME/ADMIN_BOOTSTRAP_PASSWORD (пароль короче 8 символов?).\n");
}

$deleted = $pdo->exec('DELETE FROM login_attempts');
echo "Снята блокировка по IP (удалено записей: {$deleted}).\n";

$hash = password_hash($password, PASSWORD_BCRYPT);
$stmt = $pdo->prepare('SELECT id FROM admin_accounts WHERE username = :u');
$stmt->execute([':u' => $username]);
$row = $stmt->fetch();

if ($row) {
    $pdo->prepare('UPDATE admin_accounts SET password_hash = :p WHERE id = :id')
        ->execute([':p' => $hash, ':id' => $row['id']]);
    echo "Пароль для '{$username}' обновлён на значение из .env.\n";
} else {
    $pdo->prepare('INSERT INTO admin_accounts (username, password_hash) VALUES (:u, :p)')
        ->execute([':u' => $username, ':p' => $hash]);
    echo "Создан аккаунт '{$username}' с паролем из .env.\n";
}

echo "\nГотово. Теперь зайди на /admin.html с этим логином/паролем.\n";
