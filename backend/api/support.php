<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/bootstrap.php';
start_session();

if (empty($_SESSION['user_id'])) {
    json_fail('Не авторизован', 401);
}
$userId = (int)$_SESSION['user_id'];

$pdo = db();
if (!$pdo) {
    json_fail('Хранилище недоступно на этом сервере (нет PDO SQLite)', 503);
}

function support_msg_out(array $r, array $byId = [], array $reactions = [], array $storiesById = []): array {
    $id = (int)$r['id'];
    $replyToId = isset($r['reply_to_id']) ? (int)$r['reply_to_id'] : 0;
    $replySnippet = null;
    if ($replyToId > 0 && isset($byId[$replyToId])) {
        $replySnippet = mb_substr(trim((string)($byId[$replyToId]['text'] ?? '')), 0, 120) ?: null;
    }
    $storyId = isset($r['story_id']) ? (int)$r['story_id'] : 0;
    return [
        'id' => $id,
        'direction' => $r['direction'],
        'text' => $r['text'],
        'via' => $r['via'],
        'created_at' => $r['created_at'],
        'reply_to_id' => $replyToId ?: null,
        'reply_to_snippet' => $replySnippet,
        // Если историю уже удалили — просто отдаём null, фронт покажет
        // «история удалена» вместо цитаты.
        'story' => $storyId > 0 ? ($storiesById[$storyId] ?? null) : null,
        'reactions' => $reactions[$id] ?? null,
    ];
}

// Пачкой подтягивает истории для набора id, чтобы приложить их короткой
// цитатой к сообщениям, которые на них отвечают (см. story_id).
function support_stories_batch(PDO $pdo, array $rows): array {
    $ids = array_values(array_unique(array_filter(array_map(
        static fn($r) => isset($r['story_id']) ? (int)$r['story_id'] : 0,
        $rows
    ))));
    if (!$ids) {
        return [];
    }
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $stmt = $pdo->prepare("SELECT id, video_url, caption FROM stories WHERE id IN ($placeholders)");
    $stmt->execute($ids);
    $out = [];
    foreach ($stmt->fetchAll() as $s) {
        $out[(int)$s['id']] = ['id' => (int)$s['id'], 'video_url' => $s['video_url'], 'caption' => $s['caption']];
    }
    return $out;
}

function support_unread_for_user(PDO $pdo, int $userId): int {
    $s = $pdo->prepare("SELECT COUNT(*) FROM support_messages WHERE user_id = :uid AND direction = 'admin' AND read_by_user = 0");
    $s->execute([':uid' => $userId]);
    return (int)$s->fetchColumn();
}

function support_notify_admin_tg(PDO $pdo, int $userId, string $text): void {
    $settings = settings_read();
    $token = trim((string)($settings['support_bot_token'] ?? ''));
    $chatId = trim((string)($settings['support_chat_id'] ?? ''));
    if ($token === '' || $chatId === '' || !function_exists('curl_init')) {
        return;
    }
    $u = $pdo->prepare('SELECT shop_name, email FROM users WHERE id = :id');
    $u->execute([':id' => $userId]);
    $row = $u->fetch() ?: ['shop_name' => '—', 'email' => ''];

    $msg = "💬 " . ($row['shop_name'] ?: $row['email']) . " · #U{$userId}\n"
         . ($row['email'] ? "✉️ {$row['email']}\n" : '')
         . "\n{$text}\n\n"
         . "↩️ Свайпните это сообщение и напишите ответ — он придёт пользователю в чат.";
    $ch = curl_init("https://api.telegram.org/bot{$token}/sendMessage");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => ['chat_id' => $chatId, 'text' => $msg],
        CURLOPT_TIMEOUT => 8,
    ]);
    curl_exec($ch);
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $sinceId = (int)($_GET['since_id'] ?? 0);
    if ($sinceId > 0) {
        $stmt = $pdo->prepare('SELECT * FROM support_messages WHERE user_id = :uid AND id > :sid ORDER BY id ASC LIMIT 200');
        $stmt->execute([':uid' => $userId, ':sid' => $sinceId]);
    } else {

        $stmt = $pdo->prepare('SELECT * FROM (SELECT * FROM support_messages WHERE user_id = :uid ORDER BY id DESC LIMIT 200) ORDER BY id ASC');
        $stmt->execute([':uid' => $userId]);
    }
    $rows = $stmt->fetchAll();
    $byId = [];
    foreach ($rows as $r) {
        $byId[(int)$r['id']] = $r;
    }
    $reactions = reactions_batch($pdo, 'support', array_keys($byId), $userId);
    $storiesById = support_stories_batch($pdo, $rows);
    json_out([
        'messages' => array_map(static fn($r) => support_msg_out($r, $byId, $reactions, $storiesById), $rows),
        'unread' => support_unread_for_user($pdo, $userId),
    ]);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_fail('Метод не поддерживается', 405);
}
csrf_verify();

$body = json_body();
$action = (string)($body['action'] ?? 'send');

if ($action === 'read') {
    $pdo->prepare("UPDATE support_messages SET read_by_user = 1 WHERE user_id = :uid AND direction = 'admin'")
        ->execute([':uid' => $userId]);
    json_out(['ok' => true]);
}

if ($action === 'send') {

    $flood = $pdo->prepare("SELECT COUNT(*) FROM support_messages
                             WHERE user_id = :uid AND direction = 'user'
                               AND created_at > datetime('now', '-10 minutes')");
    $flood->execute([':uid' => $userId]);
    if ((int)$flood->fetchColumn() >= 20) {
        json_fail('Слишком много сообщений подряд — подождите немного, админ обязательно ответит', 429);
    }

    $text = trim((string)($body['text'] ?? ''));
    $text = mb_substr($text, 0, 2000);
    if ($text === '') {
        json_fail('Введите текст сообщения', 422);
    }

    $replyToId = (int)($body['reply_to_id'] ?? 0);
    if ($replyToId > 0) {
        $chk = $pdo->prepare('SELECT 1 FROM support_messages WHERE id = :id AND user_id = :uid');
        $chk->execute([':id' => $replyToId, ':uid' => $userId]);
        if (!$chk->fetch()) {
            $replyToId = 0;
        }
    }

    // Личный ответ на историю (в отличие от мини-коммента-реакции) — обычное
    // сообщение в поддержку, просто с привязкой к истории для цитаты.
    $storyId = (int)($body['story_id'] ?? 0);
    if ($storyId > 0) {
        $chk = $pdo->prepare('SELECT 1 FROM stories WHERE id = :id');
        $chk->execute([':id' => $storyId]);
        if (!$chk->fetch()) {
            $storyId = 0;
        }
    }

    $pdo->prepare("INSERT INTO support_messages (user_id, direction, text, via, read_by_user, reply_to_id, story_id) VALUES (:uid, 'user', :t, 'web', 1, :reply, :story)")
        ->execute([':uid' => $userId, ':t' => $text, ':reply' => $replyToId ?: null, ':story' => $storyId ?: null]);
    $id = (int)$pdo->lastInsertId();

    support_notify_admin_tg($pdo, $userId, $text);

    $stmt = $pdo->prepare('SELECT * FROM support_messages WHERE id = :id');
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch();
    $storiesById = $storyId > 0 ? support_stories_batch($pdo, [$row]) : [];
    json_out(['ok' => true, 'message' => support_msg_out($row, [], [], $storiesById)], 201);
}

if ($action === 'delete') {
    $id = (int)($body['id'] ?? 0);
    if ($id <= 0) {
        json_fail('Не указан id сообщения', 422);
    }
    $stmt = $pdo->prepare("SELECT id FROM support_messages WHERE id = :id AND user_id = :uid AND direction = 'user'");
    $stmt->execute([':id' => $id, ':uid' => $userId]);
    if (!$stmt->fetch()) {
        json_fail('Сообщение не найдено', 404);
    }
    $pdo->prepare('DELETE FROM support_messages WHERE id = :id')->execute([':id' => $id]);
    $pdo->prepare('DELETE FROM message_reactions WHERE scope = \'support\' AND message_id = :id')->execute([':id' => $id]);
    json_out(['ok' => true]);
}

json_fail('Неизвестное действие', 422);
