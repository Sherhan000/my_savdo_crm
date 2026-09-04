<?php

declare(strict_types=1);

function load_env_file(string $path): void {
    if (!is_file($path)) {
        return;
    }
    $lines = @file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (!$lines) {
        return;
    }
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#') {
            continue;
        }
        $eq = strpos($line, '=');
        if ($eq === false) {
            continue;
        }
        $key = trim(substr($line, 0, $eq));
        $value = trim(substr($line, $eq + 1));
        if (strlen($value) >= 2) {
            $first = $value[0];
            $last = $value[strlen($value) - 1];
            if (($first === '"' && $last === '"') || ($first === "'" && $last === "'")) {
                $value = substr($value, 1, -1);
            }
        }
        if ($key === '' || getenv($key) !== false) {
            continue;
        }
        putenv($key . '=' . $value);
        $_ENV[$key] = $value;
    }
}
load_env_file(__DIR__ . '/../../.env');

ini_set('display_errors', '0');
ini_set('display_startup_errors', '0');
error_reporting(E_ALL);

$__logDir = __DIR__ . '/../../database';
if (!is_dir($__logDir)) {
    @mkdir($__logDir, 0775, true);
}
ini_set('log_errors', '1');
ini_set('error_log', $__logDir . '/php-error.log');

ob_start();

function json_out(array $data, int $status = 200): void {
    if (ob_get_level() > 0) {
        ob_clean();
    }
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    // Never let a proxy/CDN/browser cache API responses — this endpoint's
    // output is session-specific (e.g. the CSRF token), and a cached copy
    // served to a later request/visitor would cause bogus "session expired"
    // failures or leak data across sessions.
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function json_fail(string $message, int $status = 500, ?string $debug = null): void {
    $payload = ['error' => $message];
    if ($debug !== null && getenv('MYSAVDO_DEBUG') === '1') {
        $payload['debug'] = $debug;
    }
    json_out($payload, $status);
}

set_error_handler(function (int $severity, string $message, string $file = '', int $line = 0): bool {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    error_log("PHP error [$severity]: $message in $file:$line");

    if (in_array($severity, [E_WARNING, E_NOTICE, E_DEPRECATED, E_USER_WARNING, E_USER_NOTICE, E_USER_DEPRECATED], true)) {
        return true;
    }
    json_fail('Внутренняя ошибка сервера', 500, "$message in $file:$line");
    return true;
});

set_exception_handler(function (Throwable $e): void {
    error_log('Uncaught exception: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    json_fail('Внутренняя ошибка сервера', 500, $e->getMessage());
});

register_shutdown_function(function (): void {
    $err = error_get_last();
    if ($err && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        error_log('Fatal error: ' . $err['message'] . ' in ' . $err['file'] . ':' . $err['line']);
        if (ob_get_level() > 0) {
            ob_clean();
        }
        if (!headers_sent()) {
            http_response_code(500);
            header('Content-Type: application/json; charset=utf-8');
        }
        echo json_encode(['error' => 'Внутренняя ошибка сервера']);
    }
});

if (!headers_sent()) {
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: SAMEORIGIN');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('X-Permitted-Cross-Domain-Policies: none');
}

require_once __DIR__ . '/store.php';
require_once __DIR__ . '/security.php';
