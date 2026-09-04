<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/instagram-private.php';
require_once __DIR__ . '/../config/instagram-meta.php';
start_session();

if (empty($_SESSION['user_id'])) {
    json_fail('Не авторизован', 401);
}
$userId = (int)$_SESSION['user_id'];

$pdo = db();
if (!$pdo) {
    json_fail('Хранилище недоступно на этом сервере (нет PDO SQLite)', 503);
}
csrf_verify();

$body     = json_body();
$clientId = (int)($body['client_id'] ?? 0);
$text     = trim((string)($body['text'] ?? ''));

if ($clientId <= 0 || $text === '') {
    json_fail('Не указан client_id или text', 422);
}

$stmt = $pdo->prepare("SELECT * FROM clients WHERE id = :id AND user_id = :uid AND channel = 'Instagram'");
$stmt->execute([':id' => $clientId, ':uid' => $userId]);
$client = $stmt->fetch();
if (!$client) {
    json_fail('Заявка не найдена или это не клиент Instagram Direct', 404);
}
if (empty($client['channel_id'])) {
    json_fail('У этой заявки нет привязки к переписке в Instagram', 422);
}

$metaStmt = $pdo->prepare('SELECT * FROM instagram_accounts WHERE user_id = :uid');
$metaStmt->execute([':uid' => $userId]);
$metaAccount = $metaStmt->fetch();

if ($metaAccount) {
    $accessToken = (string)$metaAccount['access_token'];

    $expiresAt = strtotime((string)$metaAccount['token_expires']) ?: 0;
    if ($expiresAt > 0 && $expiresAt - time() < 5 * 86400) {
        $refreshed = instagram_meta_refresh_token($accessToken);
        if ($refreshed) {
            $accessToken = (string)$refreshed['access_token'];
            $newExpires = date('Y-m-d H:i:s', time() + (int)($refreshed['expires_in'] ?? 5184000));
            $pdo->prepare('UPDATE instagram_accounts SET access_token = :tok, token_expires = :exp WHERE user_id = :uid')
                ->execute([':tok' => $accessToken, ':exp' => $newExpires, ':uid' => $userId]);
        }
    }

    $res = instagram_meta_send_message($accessToken, (string)$metaAccount['ig_user_id'], (string)$client['channel_id'], mb_substr($text, 0, 990));
    if (empty($res['ok'])) {
        json_fail('Не удалось отправить сообщение: ' . ($res['error'] ?? 'неизвестная ошибка'), 502);
    }
} else {
    [$res, $code] = ig_private_call('POST', '/api/instagram/send-message', [
        'account_id' => $userId,
        'thread_id'  => (string)$client['channel_id'],
        'text'       => mb_substr($text, 0, 990),
    ]);

    if ($code >= 400 || empty($res['ok'])) {
        json_fail('Не удалось отправить сообщение: ' . ($res['error'] ?? 'неизвестная ошибка'), 502);
    }
}

$pdo->prepare("INSERT INTO messages (client_id, direction, text) VALUES (:cid, 'out', :text)")
    ->execute([':cid' => $clientId, ':text' => $text]);
$pdo->prepare("UPDATE clients SET updated_at = datetime('now') WHERE id = :id")
    ->execute([':id' => $clientId]);

json_out(['ok' => true]);

