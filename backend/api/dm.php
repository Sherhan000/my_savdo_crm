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
    json_fail('Сообщения недоступны на этом сервере (нет PDO SQLite)', 503);
}

function dm_user_out(array $u): array {
    return [
        'id' => (int)$u['id'],
        'username' => $u['username'],
        'display_name' => $u['shop_name'] ?: $u['username'],
        'avatar' => $u['avatar'] ?: null,
        'is_shop' => !empty($u['is_shop']),
        'last_active_at' => $u['last_active_at'] ?? null,
    ];
}

function dm_message_out(array $m, int $myId, array $byId = [], array $reactions = []): array {
    $id = (int)$m['id'];
    $replyToId = isset($m['reply_to_id']) ? (int)$m['reply_to_id'] : 0;
    $replySnippet = null;
    if ($replyToId > 0 && isset($byId[$replyToId])) {
        $replySnippet = mb_substr(trim((string)($byId[$replyToId]['text'] ?? '')), 0, 120) ?: null;
    }
    return [
        'id' => $id,
        'text' => $m['text'],
        'created_at' => $m['created_at'],
        'mine' => (int)$m['sender_id'] === $myId,
        'read' => $m['read_at'] !== null,
        'reply_to_id' => $replyToId ?: null,
        'reply_to_snippet' => $replySnippet,
        'reactions' => $reactions[$id] ?? null,
    ];
}

function dm_find_or_create_conversation(PDO $pdo, int $a, int $b): int {
    $lo = min($a, $b);
    $hi = max($a, $b);
    $stmt = $pdo->prepare('SELECT id FROM conversations WHERE user_a_id = :lo AND user_b_id = :hi');
    $stmt->execute([':lo' => $lo, ':hi' => $hi]);
    $id = $stmt->fetchColumn();
    if ($id) {
        return (int)$id;
    }
    $ins = $pdo->prepare('INSERT INTO conversations (user_a_id, user_b_id) VALUES (:lo, :hi)');
    $ins->execute([':lo' => $lo, ':hi' => $hi]);
    return (int)$pdo->lastInsertId();
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $with = trim((string)($_GET['with'] ?? ''));

    if ($with === '') {

        $stmt = $pdo->prepare(
            "SELECT c.id AS conv_id, c.last_message_at,
                    u.id, u.username, u.shop_name, u.avatar, u.is_shop,
                    (SELECT text FROM dm_messages m2 WHERE m2.conversation_id = c.id ORDER BY m2.id DESC LIMIT 1) AS last_text,
                    (SELECT sender_id FROM dm_messages m2 WHERE m2.conversation_id = c.id ORDER BY m2.id DESC LIMIT 1) AS last_sender_id,
                    (SELECT COUNT(*) FROM dm_messages m3 WHERE m3.conversation_id = c.id AND m3.sender_id != :uid2 AND m3.read_at IS NULL) AS unread
               FROM conversations c
               JOIN users u ON u.id = (CASE WHEN c.user_a_id = :uid THEN c.user_b_id ELSE c.user_a_id END)
              WHERE c.user_a_id = :uid OR c.user_b_id = :uid
              ORDER BY c.last_message_at DESC
              LIMIT 100"
        );
        $stmt->execute([':uid' => $userId, ':uid2' => $userId]);
        $rows = $stmt->fetchAll();
        $out = array_map(function (array $r) use ($userId): array {
            $item = dm_user_out($r);
            $item['conversation_id'] = (int)$r['conv_id'];
            $item['last_text'] = $r['last_text'];
            $item['last_mine'] = $r['last_sender_id'] !== null && (int)$r['last_sender_id'] === $userId;
            $item['last_at'] = $r['last_message_at'];
            $item['unread'] = (int)$r['unread'];
            return $item;
        }, $rows);
        json_out(['conversations' => $out]);
    }

    $otherId = ctype_digit($with) ? (int)$with : null;
    if ($otherId === null) {
        $other = store_find_user_by_username(strtolower($with));
    } else {
        $other = store_find_user_by_id($otherId);
    }
    if (!$other || (int)$other['id'] === $userId) {
        json_fail('Пользователь не найден', 404);
    }

    $convId = dm_find_or_create_conversation($pdo, $userId, (int)$other['id']);
    // DESC + LIMIT берёт САМЫЕ СВЕЖИЕ 300 сообщений, а не первые 300 — старым
    // вариантом (ASC LIMIT 300) переписка, перевалившая за 300 сообщений,
    // навсегда переставала показывать всё новое.
    $stmt = $pdo->prepare('SELECT * FROM dm_messages WHERE conversation_id = :cid ORDER BY id DESC LIMIT 300');
    $stmt->execute([':cid' => $convId]);
    $rows = array_reverse($stmt->fetchAll());
    $byId = [];
    foreach ($rows as $r) {
        $byId[(int)$r['id']] = $r;
    }
    $reactions = reactions_batch($pdo, 'dm', array_keys($byId), $userId);
    $messages = array_map(fn(array $m) => dm_message_out($m, $userId, $byId, $reactions), $rows);

    $pdo->prepare("UPDATE dm_messages SET read_at = datetime('now') WHERE conversation_id = :cid AND sender_id != :uid AND read_at IS NULL")
        ->execute([':cid' => $convId, ':uid' => $userId]);

    $typingStmt = $pdo->prepare("SELECT 1 FROM dm_typing WHERE conversation_id = :cid AND user_id = :oid AND until > datetime('now')");
    $typingStmt->execute([':cid' => $convId, ':oid' => (int)$other['id']]);
    $typing = (bool)$typingStmt->fetchColumn();

    json_out(['conversation_id' => $convId, 'user' => dm_user_out($other), 'messages' => $messages, 'typing' => $typing]);
}

if ($method !== 'POST') {
    json_fail('Метод не поддерживается', 405);
}
csrf_verify();

$body = json_body();
$action = (string)($body['action'] ?? 'send');

if ($action === 'send') {

    $flood = $pdo->prepare("SELECT COUNT(*) FROM dm_messages WHERE sender_id = :uid AND created_at > datetime('now', '-10 minutes')");
    $flood->execute([':uid' => $userId]);
    if ((int)$flood->fetchColumn() >= 60) {
        json_fail('Слишком много сообщений подряд — подождите немного', 429);
    }

    $to = (string)($body['to'] ?? '');
    $text = mb_substr(trim((string)($body['text'] ?? '')), 0, 4000);
    if ($text === '') {
        json_fail('Введите текст сообщения', 422);
    }
    $otherId = ctype_digit($to) ? (int)$to : null;
    $other = $otherId !== null ? store_find_user_by_id($otherId) : store_find_user_by_username(strtolower($to));
    if (!$other || (int)$other['id'] === $userId) {
        json_fail('Получатель не найден', 404);
    }

    $convId = dm_find_or_create_conversation($pdo, $userId, (int)$other['id']);

    $replyToId = (int)($body['reply_to_id'] ?? 0);
    if ($replyToId > 0) {
        $chk = $pdo->prepare('SELECT 1 FROM dm_messages WHERE id = :id AND conversation_id = :cid');
        $chk->execute([':id' => $replyToId, ':cid' => $convId]);
        if (!$chk->fetch()) {
            $replyToId = 0;
        }
    }

    $pdo->prepare('INSERT INTO dm_messages (conversation_id, sender_id, text, reply_to_id) VALUES (:cid, :sid, :text, :reply)')
        ->execute([':cid' => $convId, ':sid' => $userId, ':text' => $text, ':reply' => $replyToId ?: null]);
    $pdo->prepare("UPDATE conversations SET last_message_at = datetime('now') WHERE id = :cid")
        ->execute([':cid' => $convId]);

    $id = (int)$pdo->lastInsertId();
    $stmt = $pdo->prepare('SELECT * FROM dm_messages WHERE id = :id');
    $stmt->execute([':id' => $id]);
    json_out(['ok' => true, 'conversation_id' => $convId, 'message' => dm_message_out($stmt->fetch(), $userId)], 201);
}

if ($action === 'typing') {
    // Не считаем это ошибкой, если получатель не найден или собеседник —
    // короткий пинг, без него функция просто молча не покажет индикатор.
    $to = (string)($body['to'] ?? '');
    $otherId = ctype_digit($to) ? (int)$to : null;
    $other = $otherId !== null ? store_find_user_by_id($otherId) : store_find_user_by_username(strtolower($to));
    if ($other && (int)$other['id'] !== $userId) {
        $convId = dm_find_or_create_conversation($pdo, $userId, (int)$other['id']);
        $pdo->prepare(
            "INSERT INTO dm_typing (conversation_id, user_id, until) VALUES (:cid, :uid, datetime('now', '+8 seconds'))
             ON CONFLICT(conversation_id, user_id) DO UPDATE SET until = excluded.until"
        )->execute([':cid' => $convId, ':uid' => $userId]);
    }
    json_out(['ok' => true]);
}

if ($action === 'mark_all_read') {
    $pdo->prepare(
        "UPDATE dm_messages SET read_at = datetime('now')
          WHERE read_at IS NULL AND sender_id != :uid
            AND conversation_id IN (SELECT id FROM conversations WHERE user_a_id = :uid2 OR user_b_id = :uid3)"
    )->execute([':uid' => $userId, ':uid2' => $userId, ':uid3' => $userId]);
    json_out(['ok' => true]);
}

if ($action === 'delete') {
    $id = (int)($body['id'] ?? 0);
    if ($id <= 0) {
        json_fail('Не указан id сообщения', 422);
    }
    $stmt = $pdo->prepare('SELECT id FROM dm_messages WHERE id = :id AND sender_id = :uid');
    $stmt->execute([':id' => $id, ':uid' => $userId]);
    if (!$stmt->fetch()) {
        json_fail('Сообщение не найдено', 404);
    }
    $pdo->prepare('DELETE FROM dm_messages WHERE id = :id')->execute([':id' => $id]);
    $pdo->prepare('DELETE FROM message_reactions WHERE scope = \'dm\' AND message_id = :id')->execute([':id' => $id]);
    json_out(['ok' => true]);
}

json_fail('Неизвестное действие', 422);
