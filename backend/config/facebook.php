<?php

if (!defined('FACEBOOK_APP_ID')) {
    define('FACEBOOK_APP_ID', getenv('FACEBOOK_APP_ID') ?: 'ВСТАВЬ_СЮДА_СВОЙ_APP_ID');
}
if (!defined('FACEBOOK_APP_SECRET')) {
    define('FACEBOOK_APP_SECRET', getenv('FACEBOOK_APP_SECRET') ?: 'ВСТАВЬ_СЮДА_СВОЙ_APP_SECRET');
}

define('FACEBOOK_GRAPH_URL', 'https://graph.facebook.com/v19.0/');

function facebook_http_get(string $url): ?array {
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 15,
        ]);
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    } else {
        $context = stream_context_create(['http' => ['timeout' => 15, 'ignore_errors' => true]]);
        $response = @file_get_contents($url, false, $context);
        $httpCode = 0;
        if (function_exists('http_get_last_response_headers')) {
            foreach (http_get_last_response_headers() ?? [] as $line) {
                if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) { $httpCode = (int)$m[1]; }
            }
        }
    }

    if ($response === false || $httpCode !== 200) {
        return null;
    }

    $data = json_decode($response, true);
    return is_array($data) ? $data : null;
}

function facebook_verify_token(string $accessToken): ?array {
    if (FACEBOOK_APP_ID === '' || FACEBOOK_APP_SECRET === '') {
        return null;
    }

    $appToken = FACEBOOK_APP_ID . '|' . FACEBOOK_APP_SECRET;
    $debugUrl = FACEBOOK_GRAPH_URL . 'debug_token?input_token=' . urlencode($accessToken) . '&access_token=' . urlencode($appToken);
    $debug = facebook_http_get($debugUrl);

    $info = $debug['data'] ?? null;
    if (!is_array($info) || empty($info['is_valid']) || (string)($info['app_id'] ?? '') !== FACEBOOK_APP_ID) {
        return null;
    }

    $meUrl = FACEBOOK_GRAPH_URL . 'me?fields=id,name,email,picture.type(large)&access_token=' . urlencode($accessToken);
    $me = facebook_http_get($meUrl);

    if (!is_array($me) || empty($me['id'])) {
        return null;
    }

    return [
        'id' => (string)$me['id'],
        'name' => $me['name'] ?? null,
        'email' => $me['email'] ?? null,
        'picture' => $me['picture']['data']['url'] ?? null,
    ];
}
