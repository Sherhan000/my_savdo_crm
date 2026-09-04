<?php
declare(strict_types=1);

if (!defined('INSTAGRAM_APP_ID')) {
    define('INSTAGRAM_APP_ID', getenv('INSTAGRAM_APP_ID') ?: '');
}
if (!defined('INSTAGRAM_APP_SECRET')) {
    define('INSTAGRAM_APP_SECRET', getenv('INSTAGRAM_APP_SECRET') ?: '');
}
if (!defined('INSTAGRAM_WEBHOOK_VERIFY_TOKEN')) {
    define('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', getenv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN') ?: '');
}

define('INSTAGRAM_OAUTH_AUTHORIZE_URL', 'https://www.instagram.com/oauth/authorize');
define('INSTAGRAM_OAUTH_TOKEN_URL', 'https://api.instagram.com/oauth/access_token');
define('INSTAGRAM_GRAPH_URL', 'https://graph.instagram.com/v21.0/');
define('INSTAGRAM_OAUTH_SCOPE', 'instagram_business_basic,instagram_business_manage_messages');

function instagram_meta_request_scheme(): string {
    if (!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && strtolower($_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https') {
        return 'https';
    }
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
        return 'https';
    }
    if ((int)($_SERVER['SERVER_PORT'] ?? 0) === 443) {
        return 'https';
    }
    return 'http';
}

function instagram_meta_redirect_uri(): string {
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $scriptDir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/backend/api/x.php')), '/');
    return instagram_meta_request_scheme() . '://' . $host . $scriptDir . '/instagram-oauth-callback.php';
}

function instagram_meta_site_root(): string {
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $scriptDir = str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/backend/api/x.php'));
    $root = rtrim(dirname(dirname($scriptDir)), '/');
    if ($root === '.' || $root === '/') {
        $root = '';
    }
    return instagram_meta_request_scheme() . '://' . $host . $root;
}

function instagram_meta_http(string $method, string $url, array $params = []): ?array {
    $ch = null;
    if (strtoupper($method) === 'GET') {
        $sep = str_contains($url, '?') ? '&' : '?';
        $ch = curl_init($url . ($params ? $sep . http_build_query($params) : ''));
    } else {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($params));
    }
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 20,
    ]);
    $raw = curl_exec($ch);
    $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);

    if ($raw === false) {
        return null;
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return null;
    }
    $data['_http_code'] = $httpCode;
    return $data;
}

function instagram_meta_exchange_code(string $code): ?array {
    $res = instagram_meta_http('POST', INSTAGRAM_OAUTH_TOKEN_URL, [
        'client_id' => INSTAGRAM_APP_ID,
        'client_secret' => INSTAGRAM_APP_SECRET,
        'grant_type' => 'authorization_code',
        'redirect_uri' => instagram_meta_redirect_uri(),
        'code' => $code,
    ]);
    if (!$res || empty($res['access_token'])) {
        return null;
    }
    return $res;
}

function instagram_meta_long_lived_token(string $shortToken): ?array {
    $res = instagram_meta_http('GET', INSTAGRAM_GRAPH_URL . 'access_token', [
        'grant_type' => 'ig_exchange_token',
        'client_secret' => INSTAGRAM_APP_SECRET,
        'access_token' => $shortToken,
    ]);
    if (!$res || empty($res['access_token'])) {
        return null;
    }
    return $res;
}

function instagram_meta_refresh_token(string $longToken): ?array {
    $res = instagram_meta_http('GET', INSTAGRAM_GRAPH_URL . 'refresh_access_token', [
        'grant_type' => 'ig_refresh_token',
        'access_token' => $longToken,
    ]);
    if (!$res || empty($res['access_token'])) {
        return null;
    }
    return $res;
}

function instagram_meta_profile(string $accessToken, string $igUserId): ?array {
    $res = instagram_meta_http('GET', INSTAGRAM_GRAPH_URL . $igUserId, [
        'fields' => 'user_id,username',
        'access_token' => $accessToken,
    ]);
    if (!$res || empty($res['user_id'])) {
        return null;
    }
    return $res;
}

function instagram_meta_subscribe(string $accessToken, string $igUserId): bool {
    $res = instagram_meta_http('POST', INSTAGRAM_GRAPH_URL . $igUserId . '/subscribed_apps', [
        'subscribed_fields' => 'messages',
        'access_token' => $accessToken,
    ]);
    return !empty($res['success']);
}

function instagram_meta_send_message(string $accessToken, string $igUserId, string $recipientId, string $text): array {
    $url = INSTAGRAM_GRAPH_URL . $igUserId . '/messages?access_token=' . urlencode($accessToken);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode([
            'recipient' => ['id' => $recipientId],
            'message' => ['text' => $text],
        ], JSON_UNESCAPED_UNICODE),
    ]);
    $raw = curl_exec($ch);

    if ($raw === false) {
        return ['ok' => false, 'error' => 'нет ответа от Instagram'];
    }
    $res = json_decode($raw, true);
    if (!is_array($res)) {
        return ['ok' => false, 'error' => 'некорректный ответ Instagram API'];
    }
    if (!empty($res['error'])) {
        return ['ok' => false, 'error' => $res['error']['message'] ?? 'ошибка Instagram API'];
    }
    return ['ok' => true];
}
