<?php

if (!defined('TELEGRAM_BOT_TOKEN')) {
    define('TELEGRAM_BOT_TOKEN', getenv('TELEGRAM_BOT_TOKEN') ?: '');
}

/**
 * Проверка данных от Telegram Login Widget.
 * https://core.telegram.org/widgets/login#checking-authorization
 */
function telegram_verify_auth(array $data): bool {
    if (TELEGRAM_BOT_TOKEN === '' || empty($data['hash']) || empty($data['id'])) {
        return false;
    }

    $hash = (string)$data['hash'];
    unset($data['hash']);
    ksort($data);

    $pairs = [];
    foreach ($data as $key => $value) {
        $pairs[] = $key . '=' . $value;
    }
    $checkString = implode("\n", $pairs);

    $secretKey = hash('sha256', TELEGRAM_BOT_TOKEN, true);
    $computedHash = hash_hmac('sha256', $checkString, $secretKey);

    if (!hash_equals($computedHash, $hash)) {
        return false;
    }

    $authDate = (int)($data['auth_date'] ?? 0);
    if ($authDate <= 0 || (time() - $authDate) > 86400) {
        return false;
    }

    return true;
}
