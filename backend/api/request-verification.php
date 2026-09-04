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

rate_limit_guard('request_verification', 'global', 30, 15);
// guard() сам по себе ничего не считает — только fail() двигает счётчик
// попыток, без него лимит выше был мёртвым кодом (единственной защитой
// оставался per-email кулдаун в 60 секунд ниже, который не мешает
// перебирать разные адреса и заваливать их письмами).
rate_limit_fail('request_verification', 'global', 30, 15);

$existing = otp_find_for_email($email);
if ($existing) {
    $lastSentAt = strtotime((string)$existing['created_at'] . ' UTC');
    if ($lastSentAt !== false && (time() - $lastSentAt) < 60) {
        json_out(['ok' => true]);
    }
}

$user = store_find_user_by_email($email);
if ($user) {
    $code = otp_generate_code();
    otp_create_for_email($email, $code, 10);
    if (!otp_send_verification_email($email, $code)) {
        error_log('[MySavdo] Не удалось отправить код подтверждения на ' . $email);
    }
}

json_out(['ok' => true]);
