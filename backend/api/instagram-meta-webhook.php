<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/instagram-meta.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    $mode = (string)($_GET['hub_mode'] ?? '');
    $token = (string)($_GET['hub_verify_token'] ?? '');
    $challenge = (string)($_GET['hub_challenge'] ?? '');

    if ($mode === 'subscribe' && INSTAGRAM_WEBHOOK_VERIFY_TOKEN !== '' && hash_equals(INSTAGRAM_WEBHOOK_VERIFY_TOKEN, $token)) {
        header('Content-Type: text/plain');
        echo $challenge;
        exit;
    }
    http_response_code(403);
    exit;
}

$raw = file_get_contents('php://input') ?: '';
error_log('[MySavdo IG Meta] Входящий вебхук, ' . strlen($raw) . ' байт: ' . mb_substr($raw, 0, 500));

if (INSTAGRAM_APP_SECRET === '') {
    error_log('[MySavdo IG Meta] INSTAGRAM_APP_SECRET пуст в .env — подпись не проверить');
    json_out(['ok' => false], 200);
}
$signature = (string)($_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '');
$expected = 'sha256=' . hash_hmac('sha256', $raw, INSTAGRAM_APP_SECRET);
if ($signature === '' || !hash_equals($expected, $signature)) {
    error_log("[MySavdo IG Meta] Отклонён вебхук с неверной подписью: получено='{$signature}' ожидалось='{$expected}' — проверьте, что INSTAGRAM_APP_SECRET в .env совпадает с секретом ИМЕННО Instagram-приложения в Meta Dashboard, а не основного приложения");
    http_response_code(403);
    exit;
}

$data = json_decode($raw, true);
if (!is_array($data) || empty($data['entry']) || !is_array($data['entry'])) {
    error_log('[MySavdo IG Meta] Пустой или некорректный payload (нет entry)');
    json_out(['ok' => true]);
}

$pdo = db();
if (!$pdo) {
    error_log('[MySavdo IG Meta] БД недоступна при обработке вебхука');
    json_out(['ok' => true]);
}

foreach ($data['entry'] as $entry) {
    $igUserId = (string)($entry['id'] ?? '');
    $messaging = $entry['messaging'] ?? [];
    if ($igUserId === '' || !is_array($messaging)) {
        error_log('[MySavdo IG Meta] entry без id или messaging: ' . json_encode($entry, JSON_UNESCAPED_UNICODE));
        continue;
    }

    $acc = $pdo->prepare('SELECT user_id FROM instagram_accounts WHERE ig_user_id = :igid');
    $acc->execute([':igid' => $igUserId]);
    $accountUserId = $acc->fetchColumn();
    if ($accountUserId === false) {
        error_log("[MySavdo IG Meta] Нет в instagram_accounts аккаунта с ig_user_id={$igUserId} — вебхук пришёл для неизвестного/несвязанного аккаунта");
        continue;
    }
    $userId = (int)$accountUserId;

    foreach ($messaging as $event) {
        if (!is_array($event)) {
            error_log('[MySavdo IG Meta] messaging-событие не массив');
            continue;
        }
        if (!empty($event['message']['is_echo'])) {
            error_log('[MySavdo IG Meta] Пропущено эхо-событие (собственное исходящее сообщение)');
            continue;
        }
        $senderId = (string)($event['sender']['id'] ?? '');
        $message = $event['message'] ?? null;
        if ($senderId === '' || !is_array($message)) {
            error_log('[MySavdo IG Meta] Нет sender.id или message в событии: ' . json_encode($event, JSON_UNESCAPED_UNICODE));
            continue;
        }
        $text = trim((string)($message['text'] ?? ''));
        $mid = trim((string)($message['mid'] ?? ''));
        if ($text === '' || $mid === '') {
            error_log('[MySavdo IG Meta] Пустой text или mid (не текстовое сообщение?): ' . json_encode($message, JSON_UNESCAPED_UNICODE));
            continue;
        }

        $seenKey = 'meta_' . $mid;
        $seenStmt = $pdo->prepare('SELECT 1 FROM instagram_seen WHERE mid = :m');
        $seenStmt->execute([':m' => $seenKey]);
        if ($seenStmt->fetchColumn()) {
            error_log("[MySavdo IG Meta] mid={$mid} уже обработан ранее (дедуп)");
            continue;
        }
        $pdo->prepare('INSERT OR IGNORE INTO instagram_seen (mid) VALUES (:m)')->execute([':m' => $seenKey]);
        error_log("[MySavdo IG Meta] Создаю/обновляю заявку: user_id={$userId} sender={$senderId} text=" . mb_substr($text, 0, 100));

        $find = $pdo->prepare("SELECT * FROM clients WHERE user_id = :uid AND channel = 'Instagram' AND channel_id = :cid");
        $find->execute([':uid' => $userId, ':cid' => $senderId]);
        $client = $find->fetch();

        if ($client) {
            $clientId = (int)$client['id'];
            $pdo->prepare("UPDATE clients SET updated_at = datetime('now') WHERE id = :id")->execute([':id' => $clientId]);
        } else {
            $pdo->prepare("INSERT INTO clients (user_id, name, channel, channel_id, stage, value, sentiment)
                            VALUES (:uid, 'Клиент Instagram', 'Instagram', :cid, 'new', 0, 'neu')")
                ->execute([':uid' => $userId, ':cid' => $senderId]);
            $clientId = (int)$pdo->lastInsertId();
        }

        $pdo->prepare("INSERT INTO messages (client_id, direction, text) VALUES (:cid, 'in', :text)")
            ->execute([':cid' => $clientId, ':text' => $text]);
    }
}

json_out(['ok' => true]);
