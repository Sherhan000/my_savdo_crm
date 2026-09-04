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

if (IG_PRIVATE_API_KEY === '' || IG_PRIVATE_SHARED_SECRET === '') {
    json_fail('Вход через Instagram не настроен на сервере (не задан IG_PRIVATE_API_KEY/IG_PRIVATE_SHARED_SECRET)', 500);
}

$method = $_SERVER['REQUEST_METHOD'];
if ($method !== 'GET') {
    csrf_verify();
}

if ($method === 'GET') {
    $stmt = $pdo->prepare('SELECT ig_username FROM instagram_private_accounts WHERE user_id = :uid');
    $stmt->execute([':uid' => $userId]);
    $row = $stmt->fetch();
    json_out(['connected' => (bool)$row, 'username' => $row['ig_username'] ?? null]);
}

if ($method === 'POST') {
    $body = json_body();
    $action = (string)($body['action'] ?? 'connect');

    if ($action === 'verify_2fa') {
        $code = trim((string)($body['code'] ?? ''));
        if ($code === '') {
            json_fail('Введите код подтверждения', 422);
        }
        [$res, $code_] = ig_private_call('POST', "/api/instagram/accounts/{$userId}/2fa", ['code' => $code]);
        if ($code_ >= 400 || empty($res['ok'])) {
            json_fail($res['error'] ?? 'Не удалось подтвердить код', 422);
        }
        $username = $res['username'] ?? null;
        $pdo->prepare('INSERT INTO instagram_private_accounts (user_id, ig_username) VALUES (:uid, :un)
                        ON CONFLICT(user_id) DO UPDATE SET ig_username = excluded.ig_username')
            ->execute([':uid' => $userId, ':un' => $username]);
        json_out(['connected' => true, 'username' => $username]);
    }

    $username = trim((string)($body['username'] ?? ''));
    $password = (string)($body['password'] ?? '');
    if ($username === '' || $password === '') {
        json_fail('Укажите логин и пароль от Instagram', 422);
    }

    [$res, $code] = ig_private_call('POST', '/api/instagram/accounts', [
        'account_id' => $userId,
        'username' => $username,
        'password' => $password,
    ]);

    if ($code === 0 || $code >= 500) {
        json_fail('Сервис подключения Instagram сейчас недоступен, попробуйте позже', 502);
    }
    if (!empty($res['status']) && $res['status'] === 'needs_2fa') {
        json_out(['needs_2fa' => true, 'method' => $res['method'] ?? 'sms']);
    }
    if (!empty($res['status']) && $res['status'] === 'checkpoint') {
        json_fail($res['error'] ?? 'Instagram запросил дополнительное подтверждение входа', 422);
    }
    if ($code >= 400 || empty($res['ok'])) {
        json_fail($res['error'] ?? 'Не удалось подключить Instagram', 422);
    }

    $ig_username = $res['username'] ?? $username;
    $pdo->prepare('INSERT INTO instagram_private_accounts (user_id, ig_username) VALUES (:uid, :un)
                    ON CONFLICT(user_id) DO UPDATE SET ig_username = excluded.ig_username')
        ->execute([':uid' => $userId, ':un' => $ig_username]);

    json_out(['connected' => true, 'username' => $ig_username]);
}

if ($method === 'DELETE') {
    ig_private_call('DELETE', "/api/instagram/accounts/{$userId}");
    $pdo->prepare('DELETE FROM instagram_private_accounts WHERE user_id = :uid')->execute([':uid' => $userId]);
    json_out(['ok' => true]);
}

json_fail('Метод не поддерживается', 405);
