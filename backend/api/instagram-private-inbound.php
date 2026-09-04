<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/instagram-private.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    json_fail('Метод не поддерживается', 405);
}

$raw = file_get_contents('php://input') ?: '';

if (IG_PRIVATE_SHARED_SECRET === '') {
    json_fail('IG_PRIVATE_SHARED_SECRET не настроен на сервере', 500);
}
// Два способа подтвердить, что запрос свой: подпись HMAC (X-Signature, как
// раньше — для ig-private-service) ИЛИ просто тот же секрет напрямую в
// заголовке (X-Api-Key — проще настроить в конструкторах вроде n8n, без
// узла для подсчёта HMAC).
$apiKey = (string)($_SERVER['HTTP_X_API_KEY'] ?? '');
if ($apiKey !== '' && hash_equals(IG_PRIVATE_SHARED_SECRET, $apiKey)) {
    // ок, прошли по прямому ключу
} else {
    $signature = (string)($_SERVER['HTTP_X_SIGNATURE'] ?? '');
    $expected  = 'sha256=' . hash_hmac('sha256', $raw, IG_PRIVATE_SHARED_SECRET);
    if ($signature === '' || !hash_equals($expected, $signature)) {
        error_log('[MySavdo IG Private] Отклонён запрос с неверной подписью/ключом');
        json_fail('Неверная подпись или ключ', 403);
    }
}

$data = json_decode($raw, true);
if (!is_array($data)) {
    json_fail('Некорректный JSON', 422);
}

$accountId = (int)($data['account_id'] ?? 0);
$threadId  = trim((string)($data['thread_id'] ?? ''));
$userId    = trim((string)($data['user_id'] ?? ''));
$text      = trim((string)($data['text'] ?? ''));
$itemId    = trim((string)($data['item_id'] ?? ''));
$username  = $data['username'] ?? null;
$fullName  = $data['full_name'] ?? null;

if ($accountId <= 0 || $threadId === '' || $userId === '' || $text === '' || $itemId === '') {
    json_fail('Не хватает полей account_id/thread_id/user_id/text/item_id', 422);
}

$pdo = db();
if (!$pdo) {
    json_fail('Хранилище недоступно', 503);
}

// Принимаем и от старого private-API моста, и от официально подключённого
// через OAuth аккаунта (instagram_accounts) — так этот эндпоинт годится и как
// временный приёмник для внешнего сервиса (например, n8n) для уже
// подключённого через сайт аккаунта, без отдельного шага регистрации.
$acc = $pdo->prepare(
    'SELECT 1 FROM instagram_private_accounts WHERE user_id = :uid
     UNION SELECT 1 FROM instagram_accounts WHERE user_id = :uid'
);
$acc->execute([':uid' => $accountId]);
if (!$acc->fetchColumn()) {
    json_fail('Этот аккаунт не подключён ни к одному пользователю MySavdo', 404);
}

$mid = 'priv_' . $itemId;
$seenStmt = $pdo->prepare('SELECT 1 FROM instagram_seen WHERE mid = :m');
$seenStmt->execute([':m' => $mid]);
if ($seenStmt->fetchColumn()) {
    json_out(['ok' => true, 'duplicate' => true]);
}
$pdo->prepare('INSERT OR IGNORE INTO instagram_seen (mid) VALUES (:m)')->execute([':m' => $mid]);

$find = $pdo->prepare("SELECT * FROM clients WHERE user_id = :uid AND channel = 'Instagram' AND channel_id = :cid");
$find->execute([':uid' => $accountId, ':cid' => $threadId]);
$client = $find->fetch();

if ($client) {
    $clientId = (int)$client['id'];
    $pdo->prepare("UPDATE clients SET updated_at = datetime('now') WHERE id = :id")->execute([':id' => $clientId]);
} else {
    $name = $username ? '@' . $username : ($fullName ?: 'Клиент Instagram');
    $pdo->prepare("INSERT INTO clients (user_id, name, channel, channel_id, stage, value, sentiment)
                    VALUES (:uid, :name, 'Instagram', :cid, 'new', 0, 'neu')")
        ->execute([':uid' => $accountId, ':name' => $name, ':cid' => $threadId]);
    $clientId = (int)$pdo->lastInsertId();
}

$pdo->prepare("INSERT INTO messages (client_id, direction, text) VALUES (:cid, 'in', :text)")
    ->execute([':cid' => $clientId, ':text' => $text]);

json_out(['ok' => true, 'client_id' => $clientId]);
