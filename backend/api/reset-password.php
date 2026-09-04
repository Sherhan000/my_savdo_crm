<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
start_session();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(['error' => 'Метод не поддерживается'], 405);
}
csrf_verify();

$body = json_body();
$token = trim((string)($body['token'] ?? ''));
$password = (string)($body['password'] ?? '');

if ($token === '' || !preg_match('/^[a-f0-9]{64}$/', $token)) {
    json_out(['error' => 'Ссылка недействительна — запросите восстановление пароля заново'], 422);
}
if (strlen($password) < 6) {
    json_out(['error' => 'Пароль должен быть не короче 6 символов'], 422);
}

$pdo = db();
if (!$pdo) {
    json_fail('Восстановление пароля недоступно на этом сервере (нет PDO SQLite)', 503);
}

$stmt = $pdo->prepare('SELECT * FROM password_resets WHERE token = :token');
$stmt->execute([':token' => $token]);
$reset = $stmt->fetch();

if (!$reset) {
    json_out(['error' => 'Ссылка недействительна — запросите восстановление пароля заново'], 422);
}

$expiresAt = strtotime((string)$reset['expires_at'] . ' UTC');
if ($expiresAt === false || $expiresAt < time()) {
    $pdo->prepare('DELETE FROM password_resets WHERE token = :token')->execute([':token' => $token]);
    json_out(['error' => 'Ссылка устарела — запросите восстановление пароля заново'], 422);
}

$hash = password_hash($password, PASSWORD_BCRYPT);
$pdo->prepare('UPDATE users SET password_hash = :hash, password_set = 1 WHERE id = :id')
    ->execute([':hash' => $hash, ':id' => (int)$reset['user_id']]);
$pdo->prepare('DELETE FROM password_resets WHERE token = :token')->execute([':token' => $token]);

json_out(['ok' => true]);
