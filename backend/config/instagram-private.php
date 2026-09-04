<?php
declare(strict_types=1);

if (!defined('IG_PRIVATE_SHARED_SECRET')) {

    define('IG_PRIVATE_SHARED_SECRET', getenv('IG_PRIVATE_SHARED_SECRET') ?: '');
}
if (!defined('IG_PRIVATE_SERVICE_URL')) {

    define('IG_PRIVATE_SERVICE_URL', rtrim(getenv('IG_PRIVATE_SERVICE_URL') ?: 'http://127.0.0.1:4000', '/'));
}
if (!defined('IG_PRIVATE_API_KEY')) {
    define('IG_PRIVATE_API_KEY', getenv('IG_PRIVATE_API_KEY') ?: '');
}

function ig_private_call(string $method, string $path, array $body = []): array {
    if (!function_exists('curl_init')) {
        json_fail('Instagram-интеграция недоступна на этом сервере (нет расширения PHP curl)', 500);
    }
    $url = IG_PRIVATE_SERVICE_URL . '/' . ltrim($path, '/');

    $ch = curl_init($url);
    $headers = ['X-Api-Key: ' . IG_PRIVATE_API_KEY, 'Content-Type: application/json'];
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_HTTPHEADER     => $headers,
    ];
    $method = strtoupper($method);
    if ($method === 'POST') {
        $opts[CURLOPT_POST] = true;
        $opts[CURLOPT_POSTFIELDS] = json_encode($body, JSON_UNESCAPED_UNICODE);
    } elseif ($method !== 'GET') {
        $opts[CURLOPT_CUSTOMREQUEST] = $method;
        if ($body) {
            $opts[CURLOPT_POSTFIELDS] = json_encode($body, JSON_UNESCAPED_UNICODE);
        }
    }
    curl_setopt_array($ch, $opts);

    $raw  = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);

    if ($raw === false) {
        return [['ok' => false, 'error' => $err ?: 'нет ответа от ig-private-service'], 0];
    }
    $data = json_decode((string)$raw, true);
    return [is_array($data) ? $data : ['ok' => false, 'error' => 'некорректный ответ ig-private-service'], $code];
}
