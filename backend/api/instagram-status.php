<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/instagram-private.php';
start_session();

if (empty($_SESSION['user_id'])) {
    json_fail('Не авторизован', 401);
}
$userId = (int)$_SESSION['user_id'];

$pdo = db();
if (!$pdo) {
    json_fail('Хранилище недоступно на этом сервере (нет PDO SQLite)', 503);
}

$method = $_SERVER['REQUEST_METHOD'];
if ($method !== 'GET') {
    csrf_verify();
}

if ($method === 'GET') {
    $meta = $pdo->prepare('SELECT username FROM instagram_accounts WHERE user_id = :uid');
    $meta->execute([':uid' => $userId]);
    $metaRow = $meta->fetch();
    if ($metaRow) {
        json_out(['connected' => true, 'method' => 'meta', 'username' => $metaRow['username']]);
    }

    $private = $pdo->prepare('SELECT ig_username FROM instagram_private_accounts WHERE user_id = :uid');
    $private->execute([':uid' => $userId]);
    $privateRow = $private->fetch();
    if ($privateRow) {
        json_out(['connected' => true, 'method' => 'private', 'username' => $privateRow['ig_username']]);
    }

    json_out(['connected' => false, 'method' => null, 'username' => null]);
}

if ($method === 'DELETE') {
    $meta = $pdo->prepare('SELECT 1 FROM instagram_accounts WHERE user_id = :uid');
    $meta->execute([':uid' => $userId]);
    if ($meta->fetchColumn()) {
        $pdo->prepare('DELETE FROM instagram_accounts WHERE user_id = :uid')->execute([':uid' => $userId]);
        json_out(['ok' => true]);
    }

    $private = $pdo->prepare('SELECT 1 FROM instagram_private_accounts WHERE user_id = :uid');
    $private->execute([':uid' => $userId]);
    if ($private->fetchColumn()) {
        ig_private_call('DELETE', "/api/instagram/accounts/{$userId}");
        $pdo->prepare('DELETE FROM instagram_private_accounts WHERE user_id = :uid')->execute([':uid' => $userId]);
        json_out(['ok' => true]);
    }

    json_out(['ok' => true]);
}

json_fail('Метод не поддерживается', 405);
