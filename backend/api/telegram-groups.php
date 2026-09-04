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

function tgg_api(string $token, string $method, array $params = []): array {
    if (!function_exists('curl_init')) {
        return ['ok' => false, 'description' => 'нет расширения PHP curl'];
    }
    $ch = curl_init("https://api.telegram.org/bot{$token}/{$method}");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $params,
        CURLOPT_TIMEOUT => 15,
    ]);
    $raw = curl_exec($ch);
    $err = curl_error($ch);
    if ($raw === false) {
        return ['ok' => false, 'description' => $err];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : ['ok' => false, 'description' => 'bad response'];
}

// Абсолютный URL до уже загруженного файла (assets/img/uploads/...) — нужен,
// потому что Telegram сам скачивает медиа по ссылке, локальный путь ему не
// передать без отдельной multipart-загрузки.
function tgg_media_url(string $relativeUrl): string {
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $scheme = 'http';
    if (!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && strtolower($_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https') {
        $scheme = 'https';
    } elseif (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
        $scheme = 'https';
    } elseif ((int)($_SERVER['SERVER_PORT'] ?? 0) === 443) {
        $scheme = 'https';
    }
    $scriptDir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/backend/api/x.php')), '/');
    $root = preg_replace('#/backend/api$#', '', $scriptDir) ?: '';
    return $scheme . '://' . $host . $root . '/' . ltrim($relativeUrl, '/');
}

function tgg_bot_token(PDO $pdo, int $userId): ?string {
    $stmt = $pdo->prepare('SELECT bot_token FROM telegram_bots WHERE user_id = :uid');
    $stmt->execute([':uid' => $userId]);
    $token = $stmt->fetchColumn();
    return $token !== false ? (string)$token : null;
}

function tgg_assert_owns_group(PDO $pdo, int $groupId, int $userId): array {
    $stmt = $pdo->prepare('SELECT * FROM telegram_groups WHERE id = :id AND user_id = :uid');
    $stmt->execute([':id' => $groupId, ':uid' => $userId]);
    $row = $stmt->fetch();
    if (!$row) {
        json_fail('Группа не найдена', 404);
    }
    return $row;
}

function tgg_list_out(array $g): array {
    return [
        'id' => (int)$g['id'],
        'title' => $g['title'],
        'photo_url' => $g['photo_url'] ?? null,
        'member_count' => (int)($g['member_count'] ?? 0),
        'last_text' => $g['last_text'] ?? null,
        'last_has_media' => !empty($g['last_has_media']),
        'last_sender' => $g['last_sender'] ?? null,
        'last_mine' => ($g['last_dir'] ?? null) === 'out',
        'last_at' => $g['last_message_at'] ?? null,
        'unread' => (int)($g['unread'] ?? 0),
    ];
}

function tgg_detail_out(array $g): array {
    return [
        'id' => (int)$g['id'],
        'title' => $g['title'],
        'photo_url' => $g['photo_url'] ?? null,
        'member_count' => (int)$g['member_count'],
        'type' => $g['type'],
    ];
}

function tgg_message_out(array $m, array $byId): array {
    $id = (int)$m['id'];
    $replyToId = isset($m['reply_to_id']) ? (int)$m['reply_to_id'] : 0;
    $replySnippet = null;
    $replySender = null;
    if ($replyToId > 0 && isset($byId[$replyToId])) {
        $replySnippet = mb_substr(trim((string)($byId[$replyToId]['text'] ?? '')), 0, 120) ?: null;
        $replySender = $byId[$replyToId]['sender_name'] ?? null;
    }
    return [
        'id' => $id,
        'direction' => $m['direction'],
        'sender_name' => $m['sender_name'] ?? null,
        'sender_username' => $m['sender_username'] ?? null,
        'sender_tg_id' => $m['sender_tg_id'] ?? null,
        'text' => $m['text'],
        'photo_url' => $m['photo_url'] ?? null,
        'video_url' => $m['video_url'] ?? null,
        'audio_url' => $m['audio_url'] ?? null,
        'created_at' => $m['created_at'],
        'reply_to_id' => $replyToId ?: null,
        'reply_to_snippet' => $replySnippet,
        'reply_to_sender' => $replySender,
    ];
}

function tgg_member_out(array $m): array {
    return [
        'tg_user_id' => $m['tg_user_id'],
        'name' => $m['name'],
        'username' => $m['username'],
        'role' => $m['role'],
        'last_seen_at' => $m['last_seen_at'],
    ];
}

$method = $_SERVER['REQUEST_METHOD'];
if ($method !== 'GET') {
    csrf_verify();
}

if ($method === 'GET') {
    $action = (string)($_GET['action'] ?? 'list');

    if ($action === 'list') {
        $stmt = $pdo->prepare(
            "SELECT g.*,
                    (SELECT COUNT(*) FROM telegram_group_messages m WHERE m.group_id = g.id
                       AND m.direction = 'in' AND (g.last_read_at IS NULL OR m.created_at > g.last_read_at)) AS unread,
                    (SELECT text FROM telegram_group_messages m2 WHERE m2.group_id = g.id ORDER BY m2.id DESC LIMIT 1) AS last_text,
                    (SELECT (photo_url IS NOT NULL OR video_url IS NOT NULL OR audio_url IS NOT NULL)
                       FROM telegram_group_messages m5 WHERE m5.group_id = g.id ORDER BY m5.id DESC LIMIT 1) AS last_has_media,
                    (SELECT sender_name FROM telegram_group_messages m3 WHERE m3.group_id = g.id ORDER BY m3.id DESC LIMIT 1) AS last_sender,
                    (SELECT direction FROM telegram_group_messages m4 WHERE m4.group_id = g.id ORDER BY m4.id DESC LIMIT 1) AS last_dir
               FROM telegram_groups g
              WHERE g.user_id = :uid AND g.active = 1
              ORDER BY (g.last_message_at IS NULL) ASC, g.last_message_at DESC, g.created_at DESC"
        );
        $stmt->execute([':uid' => $userId]);
        json_out(['groups' => array_map('tgg_list_out', $stmt->fetchAll())]);
    }

    $groupId = (int)($_GET['group_id'] ?? 0);
    if ($groupId <= 0) {
        json_fail('Не указан group_id', 422);
    }
    $group = tgg_assert_owns_group($pdo, $groupId, $userId);

    if ($action === 'thread') {
        // Заодно обновляем число участников — Bot API не отдаёт полный
        // список сразу, но общее количество можно спросить отдельным вызовом.
        $token = tgg_bot_token($pdo, $userId);
        if ($token) {
            $cnt = tgg_api($token, 'getChatMemberCount', ['chat_id' => $group['chat_id']]);
            if (!empty($cnt['ok']) && isset($cnt['result'])) {
                $pdo->prepare('UPDATE telegram_groups SET member_count = :c WHERE id = :id')
                    ->execute([':c' => (int)$cnt['result'], ':id' => $groupId]);
                $group['member_count'] = (int)$cnt['result'];
            }
        }

        // DESC + LIMIT берёт САМЫЕ СВЕЖИЕ 300 сообщений, а не первые 300 — старым
        // вариантом (ASC LIMIT 300) переписка, перевалившая за 300 сообщений,
        // навсегда переставала показывать всё новое (см. тот же приём в dm.php).
        $stmt = $pdo->prepare('SELECT * FROM telegram_group_messages WHERE group_id = :gid ORDER BY id DESC LIMIT 300');
        $stmt->execute([':gid' => $groupId]);
        $rows = array_reverse($stmt->fetchAll());
        $byId = [];
        foreach ($rows as $r) {
            $byId[(int)$r['id']] = $r;
        }

        $pdo->prepare("UPDATE telegram_groups SET last_read_at = datetime('now') WHERE id = :id")->execute([':id' => $groupId]);

        $pinned = null;
        if (!empty($group['pinned_message_id']) && isset($byId[(int)$group['pinned_message_id']])) {
            $pinned = tgg_message_out($byId[(int)$group['pinned_message_id']], $byId);
        }

        json_out([
            'group' => tgg_detail_out($group),
            'messages' => array_map(fn(array $m) => tgg_message_out($m, $byId), $rows),
            'pinned' => $pinned,
        ]);
    }

    if ($action === 'members') {
        $stmt = $pdo->prepare(
            "SELECT * FROM telegram_group_members WHERE group_id = :gid
              ORDER BY CASE role WHEN 'creator' THEN 0 WHEN 'administrator' THEN 1 ELSE 2 END, name COLLATE NOCASE ASC"
        );
        $stmt->execute([':gid' => $groupId]);
        json_out(['members' => array_map('tgg_member_out', $stmt->fetchAll())]);
    }

    if ($action === 'media') {
        $stmt = $pdo->prepare(
            "SELECT id, photo_url, video_url, created_at FROM telegram_group_messages
              WHERE group_id = :gid AND (photo_url IS NOT NULL OR video_url IS NOT NULL)
              ORDER BY id DESC LIMIT 60"
        );
        $stmt->execute([':gid' => $groupId]);
        json_out(['media' => $stmt->fetchAll()]);
    }

    json_fail('Неизвестное действие', 422);
}

if ($method !== 'POST') {
    json_fail('Метод не поддерживается', 405);
}

$body = json_body();
$action = (string)($body['action'] ?? '');

if ($action === 'send') {
    $groupId = (int)($body['group_id'] ?? 0);
    $group = tgg_assert_owns_group($pdo, $groupId, $userId);
    $token = tgg_bot_token($pdo, $userId);
    if (!$token) {
        json_fail('Бот не подключён', 422);
    }

    $flood = $pdo->prepare("SELECT COUNT(*) FROM telegram_group_messages WHERE group_id = :gid AND direction = 'out' AND created_at > datetime('now', '-10 minutes')");
    $flood->execute([':gid' => $groupId]);
    if ((int)$flood->fetchColumn() >= 60) {
        json_fail('Слишком много сообщений подряд — подождите немного', 429);
    }

    $text = mb_substr(trim((string)($body['text'] ?? '')), 0, 4000);
    if ($text === '') {
        json_fail('Введите текст сообщения', 422);
    }

    $replyToId = (int)($body['reply_to_id'] ?? 0);
    $replyTgId = null;
    if ($replyToId > 0) {
        $chk = $pdo->prepare('SELECT tg_message_id FROM telegram_group_messages WHERE id = :id AND group_id = :gid');
        $chk->execute([':id' => $replyToId, ':gid' => $groupId]);
        $tgId = $chk->fetchColumn();
        if ($tgId) {
            $replyTgId = $tgId;
        } else {
            $replyToId = 0;
        }
    }

    $params = ['chat_id' => $group['chat_id'], 'text' => $text];
    if ($replyTgId) {
        $params['reply_to_message_id'] = $replyTgId;
    }
    $resp = tgg_api($token, 'sendMessage', $params);
    if (empty($resp['ok'])) {
        json_fail('Telegram отклонил отправку: ' . ($resp['description'] ?? 'неизвестная ошибка'), 502);
    }

    $tgMsgId = (string)($resp['result']['message_id'] ?? '');
    $pdo->prepare(
        "INSERT INTO telegram_group_messages (group_id, tg_message_id, direction, text, reply_to_id) VALUES (:gid, :tid, 'out', :text, :reply)"
    )->execute([':gid' => $groupId, ':tid' => $tgMsgId ?: null, ':text' => $text, ':reply' => $replyToId ?: null]);
    $pdo->prepare("UPDATE telegram_groups SET last_message_at = datetime('now'), last_read_at = datetime('now') WHERE id = :id")
        ->execute([':id' => $groupId]);

    $id = (int)$pdo->lastInsertId();
    $stmt = $pdo->prepare('SELECT * FROM telegram_group_messages WHERE id = :id');
    $stmt->execute([':id' => $id]);
    json_out(['ok' => true, 'message' => tgg_message_out($stmt->fetch(), [])], 201);
}

if ($action === 'post_story') {
    $groupIds = $body['group_ids'] ?? [];
    if (!is_array($groupIds) || !$groupIds) {
        json_fail('Выберите хотя бы одну группу', 422);
    }

    $caption = mb_substr(trim((string)($body['caption'] ?? '')), 0, 1024);
    $mediaUrl = trim((string)($body['media_url'] ?? ''));
    $mediaType = (string)($body['media_type'] ?? '');
    if ($mediaUrl !== '' && !upload_url_valid($mediaUrl)) {
        json_fail('Некорректная ссылка на файл', 422);
    }
    if ($mediaUrl === '' && $caption === '') {
        json_fail('Добавьте текст или фото/видео', 422);
    }
    if ($mediaUrl !== '' && !in_array($mediaType, ['photo', 'video'], true)) {
        json_fail('Некорректный тип файла', 422);
    }

    $token = tgg_bot_token($pdo, $userId);
    if (!$token) {
        json_fail('Бот не подключён', 422);
    }

    $absoluteUrl = $mediaUrl !== '' ? tgg_media_url($mediaUrl) : null;

    $results = [];
    foreach ($groupIds as $gid) {
        $gid = (int)$gid;
        $stmt = $pdo->prepare('SELECT * FROM telegram_groups WHERE id = :id AND user_id = :uid AND active = 1');
        $stmt->execute([':id' => $gid, ':uid' => $userId]);
        $group = $stmt->fetch();
        if (!$group) {
            $results[$gid] = 'not_found';
            continue;
        }

        if ($absoluteUrl && $mediaType === 'photo') {
            $resp = tgg_api($token, 'sendPhoto', ['chat_id' => $group['chat_id'], 'photo' => $absoluteUrl, 'caption' => $caption]);
        } elseif ($absoluteUrl && $mediaType === 'video') {
            $resp = tgg_api($token, 'sendVideo', ['chat_id' => $group['chat_id'], 'video' => $absoluteUrl, 'caption' => $caption]);
        } else {
            $resp = tgg_api($token, 'sendMessage', ['chat_id' => $group['chat_id'], 'text' => $caption]);
        }

        if (empty($resp['ok'])) {
            $results[$gid] = 'error';
            continue;
        }

        $tgMsgId = (string)($resp['result']['message_id'] ?? '');
        $pdo->prepare(
            "INSERT INTO telegram_group_messages (group_id, tg_message_id, direction, text, photo_url, video_url)
             VALUES (:gid, :tid, 'out', :text, :photo, :video)"
        )->execute([
            ':gid' => $gid, ':tid' => $tgMsgId ?: null, ':text' => $caption !== '' ? $caption : null,
            ':photo' => $mediaType === 'photo' ? $mediaUrl : null,
            ':video' => $mediaType === 'video' ? $mediaUrl : null,
        ]);
        $pdo->prepare("UPDATE telegram_groups SET last_message_at = datetime('now') WHERE id = :id")->execute([':id' => $gid]);
        $results[$gid] = 'ok';
    }

    json_out(['ok' => true, 'results' => $results]);
}

if ($action === 'pin') {
    $groupId = (int)($body['group_id'] ?? 0);
    $messageId = (int)($body['message_id'] ?? 0);
    $group = tgg_assert_owns_group($pdo, $groupId, $userId);
    $token = tgg_bot_token($pdo, $userId);
    if (!$token) {
        json_fail('Бот не подключён', 422);
    }

    $chk = $pdo->prepare('SELECT tg_message_id FROM telegram_group_messages WHERE id = :id AND group_id = :gid');
    $chk->execute([':id' => $messageId, ':gid' => $groupId]);
    $tgMsgId = $chk->fetchColumn();
    if (!$tgMsgId) {
        json_fail('Сообщение не найдено', 404);
    }

    $resp = tgg_api($token, 'pinChatMessage', ['chat_id' => $group['chat_id'], 'message_id' => $tgMsgId, 'disable_notification' => true]);
    if (empty($resp['ok'])) {
        json_fail('Не удалось закрепить: ' . ($resp['description'] ?? 'нужны права администратора у бота в этой группе'), 422);
    }
    $pdo->prepare('UPDATE telegram_groups SET pinned_message_id = :mid WHERE id = :id')->execute([':mid' => $messageId, ':id' => $groupId]);
    json_out(['ok' => true]);
}

if ($action === 'unpin') {
    $groupId = (int)($body['group_id'] ?? 0);
    $group = tgg_assert_owns_group($pdo, $groupId, $userId);
    $token = tgg_bot_token($pdo, $userId);
    if ($token) {
        tgg_api($token, 'unpinChatMessage', ['chat_id' => $group['chat_id']]);
    }
    $pdo->prepare('UPDATE telegram_groups SET pinned_message_id = NULL WHERE id = :id')->execute([':id' => $groupId]);
    json_out(['ok' => true]);
}

if ($action === 'delete') {
    $groupId = (int)($body['group_id'] ?? 0);
    $messageId = (int)($body['message_id'] ?? 0);
    $group = tgg_assert_owns_group($pdo, $groupId, $userId);

    $chk = $pdo->prepare("SELECT tg_message_id FROM telegram_group_messages WHERE id = :id AND group_id = :gid AND direction = 'out'");
    $chk->execute([':id' => $messageId, ':gid' => $groupId]);
    $tgMsgId = $chk->fetchColumn();
    if ($tgMsgId === false) {
        json_fail('Можно удалить только собственные сообщения', 404);
    }

    $token = tgg_bot_token($pdo, $userId);
    if ($token && $tgMsgId) {
        tgg_api($token, 'deleteMessage', ['chat_id' => $group['chat_id'], 'message_id' => $tgMsgId]);
    }
    $pdo->prepare('DELETE FROM telegram_group_messages WHERE id = :id')->execute([':id' => $messageId]);
    json_out(['ok' => true]);
}

json_fail('Неизвестное действие', 422);
