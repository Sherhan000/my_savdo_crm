<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
start_session();
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(['error' => 'Метод не поддерживается'], 405);
}
csrf_verify();
$_SESSION = [];
// Обнуляем и сам куки сессии, а не только данные на сервере — иначе браузер
// продолжает слать тот же session id, и session_start() на следующем запросе
// молча заводит под ним новую пустую сессию вместо выдачи свежего id.
if (ini_get('session.use_cookies')) {
    $params = session_get_cookie_params();
    setcookie(session_name(), '', time() - 42000, $params['path'], $params['domain'], $params['secure'], $params['httponly']);
}
session_destroy();
json_out(['ok' => true]);
