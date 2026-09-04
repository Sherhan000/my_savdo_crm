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
$code = trim((string)($body['code'] ?? ''));

if (!filter_var($email, FILTER_VALIDATE_EMAIL) || !preg_match('/^\d{6}$/', $code)) {
    json_out(['error' => 'Неверный код подтверждения'], 422);
}

$verification = otp_find_for_email($email);
if (!$verification) {
    json_out(['error' => 'Неверный код подтверждения'], 422);
}

$expiresAt = strtotime((string)$verification['expires_at'] . ' UTC');
if ($expiresAt === false || $expiresAt < time()) {
    otp_delete_for_email($email);
    json_out(['error' => 'Код устарел — запросите новый'], 422);
}

if ((int)$verification['attempts'] >= 5) {
    otp_delete_for_email($email);
    json_out(['error' => 'Слишком много неверных попыток — запросите новый код'], 422);
}

if (!password_verify($code, (string)$verification['code_hash'])) {
    if (otp_bump_attempts((int)$verification['id']) >= 5) {
        otp_delete_for_email($email);
    }
    json_out(['error' => 'Неверный код подтверждения'], 422);
}

otp_delete_for_email($email);

$user = store_find_user_by_email($email);
if ($user) {
    store_mark_user_verified((int)$user['id']);
}

json_out(['ok' => true]);
