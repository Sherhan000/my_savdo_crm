<?php

if (!defined('GROQ_API_KEY')) {

    define('GROQ_API_KEY', getenv('GROQ_API_KEY') ?: '');
}

// Прокси нужен, когда хостинг сам достучаться до Groq не может (наблюдалось:
// на некоторых хостингах Groq отдаёт "пустой" 403 без details ещё до входа в
// свой API — похоже на блокировку по региону/IP на уровне сети, ключ тут ни
// при чём). Если задан GROQ_PROXY_URL — ходим через него (см. groq-proxy.js в
// этой же папке, деплоится как бесплатный Cloudflare Worker) и подставляем
// секрет в заголовок, чтобы прокси не мог использовать кто попало. Если не
// задан — ходим в Groq напрямую, как раньше.
if (!defined('GROQ_PROXY_URL')) {
    define('GROQ_PROXY_URL', trim((string)(getenv('GROQ_PROXY_URL') ?: '')));
}
if (!defined('GROQ_PROXY_SECRET')) {
    define('GROQ_PROXY_SECRET', (string)(getenv('GROQ_PROXY_SECRET') ?: ''));
}

define('GROQ_API_URL', GROQ_PROXY_URL !== '' ? rtrim(GROQ_PROXY_URL, '/') . '/openai/v1/chat/completions' : 'https://api.groq.com/openai/v1/chat/completions');

// llama-3.3-70b-versatile больше не существует в каталоге Groq (проверено
// живым запросом к /v1/models — в списке его нет, только llama-prompt-guard,
// whisper и т.п.) — вот почему ИИ переставал отвечать даже с рабочим ключом.
// openai/gpt-oss-120b — актуальная топовая модель на Groq на замену:
// быстрая (LPU), сильная многоязычность, живым тестом проверено, что она
// адекватно отвечает и на таджикском. НЕ поддерживает response_format:
// json_object (Groq отдаёт 400 json_validate_failed на всех новых моделях
// каталога) — везде, где раньше был этот флаг, JSON теперь просто просится
// текстом в системном промпте и разбирается тем же fallback-парсером
// (снятие ```json ``` при необходимости), что уже был в коде.
define('GROQ_MODEL', 'openai/gpt-oss-120b');

function groq_request(array $payload): array {
    $json = json_encode($payload, JSON_UNESCAPED_UNICODE);

    $headers = [
        'Content-Type: application/json',
        'Authorization: Bearer ' . GROQ_API_KEY,
        // Без этого cURL сам добавляет "Expect: 100-continue" на POST-теле
        // больше ~1024 байт — лишнее рукопожатие, которое некоторые
        // прокси/шлюзы по пути не поддерживают. Пустое значение отключает его.
        'Expect:',
    ];
    if (GROQ_PROXY_URL !== '' && GROQ_PROXY_SECRET !== '') {
        $headers[] = 'X-Proxy-Secret: ' . GROQ_PROXY_SECRET;
    }

    if (function_exists('curl_init')) {
        $ch = curl_init(GROQ_API_URL);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_POSTFIELDS => $json,
            CURLOPT_TIMEOUT => 20,
        ]);
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        return [$response === false ? null : $response, (int)$httpCode, $error ?: null];
    }

    if (!in_array('https', stream_get_wrappers(), true)) {
        return [null, 0, 'В PHP не включено расширение openssl — обёртка https:// недоступна. Включите ;extension=openssl в php.ini и перезапустите сервер.'];
    }

    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => implode("\r\n", $headers) . "\r\n",
            'content' => $json,
            'timeout' => 20,
            'ignore_errors' => true,
        ],
        'ssl' => [
            'verify_peer' => true,
            'verify_peer_name' => true,
        ],
    ]);

    $response = @file_get_contents(GROQ_API_URL, false, $context);

    $httpCode = 0;
    if (function_exists('http_get_last_response_headers')) {
        foreach (http_get_last_response_headers() ?? [] as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) { $httpCode = (int)$m[1]; }
        }
    }

    if ($response === false) {
        $err = error_get_last();
        $msg = $err['message'] ?? 'file_get_contents вернул false';
        return [null, 0, $msg . ' (часто это проблема с SSL-сертификатами на Windows: в php.ini нужен указатель openssl.cafile на актуальный cacert.pem)'];
    }
    return [$response, $httpCode, null];
}

// Раньше при ошибке пользователь/админ видел только голый "HTTP 403" без
// единого слова о причине — приходилось гадать (ключ? регион? модель?).
// Достаём message из тела ответа Groq (обычно {"error":{"message":"...",
// "type":"...","code":"..."}}) и всегда пишем сырой ответ в php-error.log —
// там же, где остальные ошибки сервера.
function groq_error_detail(?string $response, int $httpCode, ?string $curlError): string {
    if ($response === null) {
        return $curlError ?: "HTTP $httpCode";
    }
    error_log("[MySavdo Groq] HTTP $httpCode: " . mb_substr($response, 0, 2000));
    $data = json_decode($response, true);
    $err = is_array($data) ? ($data['error'] ?? null) : null;
    $msg = is_array($err) ? (string)($err['message'] ?? '') : '';
    $code = is_array($err) ? (string)($err['code'] ?? $err['type'] ?? '') : '';
    if ($msg === '') {
        return "HTTP $httpCode";
    }
    return $code !== '' ? "HTTP $httpCode — $msg ($code)" : "HTTP $httpCode — $msg";
}
