<?php
// Роутер для встроенного PHP-сервера (php -S), только для локальной разработки.
// Эмулирует то, что на проде делает .htaccess:
//  1) блокирует отдачу .env/.log/.sqlite3/.md/cookies.txt/admin-reset-once.php "как есть";
//  2) редиректит красивый URL telegram-webhook на реальный php-файл.
// В проде (Apache) этот файл не используется — там работает .htaccess.

$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$path = urldecode($uri);

// --- 1) запрещённые к прямой отдаче файлы ---
if (preg_match('/(\.env$|\.log$|\.sqlite3($|-)|\.md$|^\/cookies\.txt$|admin-reset-once\.php$)/i', $path)) {
    http_response_code(403);
    echo 'Forbidden';
    return true;
}

// не пускаем наружу служебные папки .claude/.git и сам router.php
if (preg_match('#^/\.(claude|git)(/|$)#', $path) || $path === '/router.php') {
    http_response_code(403);
    echo 'Forbidden';
    return true;
}

// --- 2) telegram webhook: /api/telegram/webhook/{token} -> backend/api/telegram-webhook.php?bot_token=... ---
if (preg_match('#^/api/telegram/webhook/([^/]+)/?$#', $path, $m)) {
    $_GET['bot_token'] = $m[1];
    require __DIR__ . '/backend/api/telegram-webhook.php';
    return true;
}

// --- корень сайта -> index.html ---
if ($path === '/' || $path === '') {
    header('Content-Type: text/html; charset=utf-8');
    readfile(__DIR__ . '/index.html');
    return true;
}

// --- иначе: если это реальный файл (статика или .php) — отдаём как обычно ---
$file = __DIR__ . $path;
if (file_exists($file) && !is_dir($file)) {
    return false; // встроенный сервер сам отдаст статику или выполнит .php
}

http_response_code(404);
echo 'Not Found';
