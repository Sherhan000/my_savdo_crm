<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/mailer.php';
start_session();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(['error' => 'Метод не поддерживается'], 405);
}
csrf_verify();

$body = json_body();
$email = trim(strtolower((string)($body['email'] ?? '')));

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    json_out(['error' => 'Некорректный email'], 422);
}

rate_limit_guard('password_reset', $email, 5, 30);
rate_limit_fail('password_reset', $email, 5, 30);

$pdo = db();
$user = $pdo ? store_find_user_by_email($email) : null;

if ($user && $pdo) {
    $token = bin2hex(random_bytes(32));
    $pdo->prepare('DELETE FROM password_resets WHERE user_id = :uid')->execute([':uid' => $user['id']]);
    $pdo->prepare("INSERT INTO password_resets (token, user_id, expires_at) VALUES (:token, :uid, datetime('now', '+30 minutes'))")
        ->execute([':token' => $token, ':uid' => $user['id']]);

    $resetLink = SITE_URL . '/?reset=' . $token;
    if (!otp_send_password_reset_email($email, $resetLink)) {
        error_log('[MySavdo] Не удалось отправить письмо восстановления пароля на ' . $email);
    }
}

json_out(['ok' => true]);
