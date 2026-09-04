<?php

if (!defined('GOOGLE_CLIENT_ID')) {

    define('GOOGLE_CLIENT_ID', getenv('GOOGLE_CLIENT_ID') ?: '906827182414-400113smr26c09nord2dkb08e7q75qu5.apps.googleusercontent.com');
}

define('GOOGLE_TOKENINFO_URL', 'https://oauth2.googleapis.com/tokeninfo?id_token=');

function google_verify_id_token(string $idToken): ?array {
    $url = GOOGLE_TOKENINFO_URL . urlencode($idToken);

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
    if (!is_array($data) || empty($data['email'])) {
        return null;
    }

    if (GOOGLE_CLIENT_ID !== '' && ($data['aud'] ?? '') !== GOOGLE_CLIENT_ID) {
        return null;
    }

    return $data;
}
