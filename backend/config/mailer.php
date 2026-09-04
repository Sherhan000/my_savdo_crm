<?php

use PHPMailer\PHPMailer\PHPMailer;

require_once __DIR__ . '/../lib/PHPMailer/Exception.php';
require_once __DIR__ . '/../lib/PHPMailer/SMTP.php';
require_once __DIR__ . '/../lib/PHPMailer/PHPMailer.php';

if (!defined('RESEND_API_KEY')) {
    define('RESEND_API_KEY', getenv('RESEND_API_KEY') ?: '');
}
if (!defined('MAIL_FROM')) {
    define('MAIL_FROM', getenv('MAIL_FROM') ?: 'MySavdo <onboarding@resend.dev>');
}
if (!defined('SITE_URL')) {
    define('SITE_URL', rtrim(getenv('SITE_URL') ?: 'http://localhost', '/'));
}

define('RESEND_API_URL', 'https://api.resend.com/emails');

function resend_send_email(string $to, string $subject, string $html): bool {
    if (RESEND_API_KEY === '') {
        error_log('[MySavdo Mail] RESEND_API_KEY не задан — письмо не отправлено');
        return false;
    }

    $payload = json_encode([
        'from' => MAIL_FROM,
        'to' => [$to],
        'subject' => $subject,
        'html' => $html,
    ], JSON_UNESCAPED_UNICODE);

    if (function_exists('curl_init')) {
        $ch = curl_init(RESEND_API_URL);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_TIMEOUT => 15,
            CURLOPT_HTTPHEADER => [
                'Authorization: Bearer ' . RESEND_API_KEY,
                'Content-Type: application/json',
            ],
        ]);
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = curl_error($ch);
    } else {
        $context = stream_context_create(['http' => [
            'method' => 'POST',
            'header' => "Authorization: Bearer " . RESEND_API_KEY . "\r\nContent-Type: application/json\r\n",
            'content' => $payload,
            'timeout' => 15,
            'ignore_errors' => true,
        ]]);
        $response = @file_get_contents(RESEND_API_URL, false, $context);
        $httpCode = 0;
        $curlError = '';
        // Без curl (редкий случай) и на PHP < 8.4 (без http_get_last_response_headers())
        // код заголовков просто останется 0 — file_get_contents() не даёт другого
        // способа узнать его, не читая устаревшую магическую $http_response_header.
        if (function_exists('http_get_last_response_headers')) {
            foreach (http_get_last_response_headers() ?? [] as $line) {
                if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) { $httpCode = (int)$m[1]; }
            }
        }
    }

    if ($response === false || $httpCode < 200 || $httpCode >= 300) {
        error_log('[MySavdo Mail] Resend ошибка: HTTP ' . $httpCode . ' ' . $curlError . ' ' . (string)$response);
        return false;
    }

    return true;
}

if (!defined('SMTP_HOST')) {
    define('SMTP_HOST', getenv('SMTP_HOST') ?: 'smtp.gmail.com');
}
if (!defined('SMTP_PORT')) {
    define('SMTP_PORT', (int)(getenv('SMTP_PORT') ?: 465));
}
if (!defined('SMTP_USER')) {
    define('SMTP_USER', getenv('SMTP_USER') ?: '');
}
if (!defined('SMTP_PASS')) {
    define('SMTP_PASS', getenv('SMTP_PASS') ?: '');
}
if (!defined('SMTP_SECURE')) {
    define('SMTP_SECURE', getenv('SMTP_SECURE') ?: 'true');
}

function otp_send_verification_email(string $to, string $code): bool {
    if (SMTP_USER === '' || SMTP_PASS === '') {
        error_log('[MySavdo Mail] SMTP_USER/SMTP_PASS не заданы — код подтверждения не отправлен');
        return false;
    }

    $mail = new PHPMailer(true);
    try {
        $mail->isSMTP();
        $mail->Host = SMTP_HOST;
        $mail->Port = (int)SMTP_PORT;
        $mail->SMTPAuth = true;
        $mail->Username = SMTP_USER;
        $mail->Password = SMTP_PASS;
        $mail->SMTPSecure = ((int)SMTP_PORT === 587)
            ? PHPMailer::ENCRYPTION_STARTTLS
            : PHPMailer::ENCRYPTION_SMTPS;
        $mail->Timeout = 15;
        $mail->CharSet = 'UTF-8';

        $mail->setFrom(SMTP_USER, 'MySavdo');
        $mail->addAddress($to);
        $mail->isHTML(true);
        $mail->Subject = 'Код подтверждения';
        $mail->Body = otp_verification_email_html($code);
        $mail->AltBody = "Ваш код подтверждения: {$code}\nОн действителен 10 минут. Если вы не запрашивали код — просто проигнорируйте это письмо.";

        $mail->send();
        return true;
    } catch (Throwable $e) {
        error_log('[MySavdo Mail] Не удалось отправить код подтверждения через SMTP: ' . $e->getMessage());
        return false;
    }
}

function otp_verification_email_html(string $code): string {
    $safeCode = htmlspecialchars($code, ENT_QUOTES, 'UTF-8');
    return <<<HTML
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#faf9f5;">
      <h2 style="color:#0d2a20;margin:0 0 12px;">Код подтверждения</h2>
      <p style="color:#444;font-size:14px;line-height:1.6;">Введите этот код на сайте, чтобы подтвердить почту:</p>
      <div style="font-family:monospace;font-size:36px;font-weight:700;letter-spacing:8px;background:#fff;border:1px solid #e4e2da;border-radius:12px;padding:18px 20px;text-align:center;color:#0d2a20;margin:20px 0;">{$safeCode}</div>
      <p style="color:#888;font-size:12px;line-height:1.6;">Код действителен 10 минут. Если вы не запрашивали подтверждение почты — просто проигнорируйте это письмо.</p>
    </div>
    HTML;
}

function otp_send_password_reset_email(string $to, string $resetLink): bool {
    if (SMTP_USER === '' || SMTP_PASS === '') {
        error_log('[MySavdo Mail] SMTP_USER/SMTP_PASS не заданы — письмо восстановления пароля не отправлено');
        return false;
    }

    $mail = new PHPMailer(true);
    try {
        $mail->isSMTP();
        $mail->Host = SMTP_HOST;
        $mail->Port = (int)SMTP_PORT;
        $mail->SMTPAuth = true;
        $mail->Username = SMTP_USER;
        $mail->Password = SMTP_PASS;
        $mail->SMTPSecure = ((int)SMTP_PORT === 587)
            ? PHPMailer::ENCRYPTION_STARTTLS
            : PHPMailer::ENCRYPTION_SMTPS;
        $mail->Timeout = 15;
        $mail->CharSet = 'UTF-8';

        $mail->setFrom(SMTP_USER, 'MySavdo');
        $mail->addAddress($to);
        $mail->isHTML(true);
        $mail->Subject = 'Восстановление пароля';
        $mail->Body = otp_password_reset_email_html($resetLink);
        $mail->AltBody = "Чтобы сбросить пароль, перейдите по ссылке: {$resetLink}\nСсылка действительна 30 минут. Если вы не запрашивали сброс пароля — просто проигнорируйте это письмо.";

        $mail->send();
        return true;
    } catch (Throwable $e) {
        error_log('[MySavdo Mail] Не удалось отправить письмо восстановления пароля через SMTP: ' . $e->getMessage());
        return false;
    }
}

function otp_password_reset_email_html(string $resetLink): string {
    $safeLink = htmlspecialchars($resetLink, ENT_QUOTES, 'UTF-8');
    return <<<HTML
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#faf9f5;">
      <h2 style="color:#0d2a20;margin:0 0 12px;">Восстановление пароля</h2>
      <p style="color:#444;font-size:14px;line-height:1.6;">Перейдите по ссылке, чтобы задать новый пароль:</p>
      <p style="margin:20px 0;"><a href="{$safeLink}" style="display:inline-block;background:#0d2a20;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">Сбросить пароль</a></p>
      <p style="color:#888;font-size:12px;line-height:1.6;">Ссылка действительна 30 минут. Если вы не запрашивали сброс пароля — просто проигнорируйте это письмо.</p>
    </div>
    HTML;
}
