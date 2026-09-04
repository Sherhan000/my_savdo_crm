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
    json_fail('Хранилище сообщений недоступно на этом сервере (нет PDO SQLite)', 503);
}

function assert_owns_client(PDO $pdo, int $clientId, int $userId): void {
    $stmt = $pdo->prepare('SELECT id FROM clients WHERE id = :id AND user_id = :uid');
    $stmt->execute([':id' => $clientId, ':uid' => $userId]);
    if (!$stmt->fetch()) {
        json_fail('Заявка не найдена', 404);
    }
}

$method = $_SERVER['REQUEST_METHOD'];
if ($method !== 'GET') {
    csrf_verify();
}

if ($method === 'GET') {
    $clientId = (int)($_GET['client_id'] ?? 0);
    if ($clientId <= 0) {
        json_fail('Не указан client_id', 422);
    }
    assert_owns_client($pdo, $clientId, $userId);

    // LIMIT + DESC/array_reverse, как в dm.php/telegram-groups.php — без лимита
    // долгая переписка с одним клиентом отдавалась бы целиком на каждый опрос
    // (эта ручка поллится), без ограничения на размер ответа.
    $stmt = $pdo->prepare('SELECT * FROM messages WHERE client_id = :cid ORDER BY id DESC LIMIT 300');
    $stmt->execute([':cid' => $clientId]);
    $rows = array_reverse($stmt->fetchAll());

    $byId = [];
    foreach ($rows as $r) {
        $byId[(int)$r['id']] = $r;
    }
    $reactions = reactions_batch($pdo, 'client', array_keys($byId), $userId);

    json_out(['messages' => array_map(static function ($r) use ($byId, $reactions): array {
        $id = (int)$r['id'];
        $replyToId = isset($r['reply_to_id']) ? (int)$r['reply_to_id'] : 0;
        $replySnippet = null;
        if ($replyToId > 0 && isset($byId[$replyToId])) {
            $replySnippet = mb_substr(trim((string)($byId[$replyToId]['text'] ?? '')), 0, 120) ?: null;
        }
        return [
            'id' => $id,
            'direction' => $r['direction'],
            'text' => $r['text'],
            'photo_url' => $r['photo_url'],
            'audio_url' => $r['audio_url'] ?? null,
            'created_at' => $r['created_at'],
            'reply_to_id' => $replyToId ?: null,
            'reply_to_snippet' => $replySnippet,
            'reactions' => $reactions[$id] ?? null,
        ];
    }, $rows)]);
}

if ($method === 'POST') {
    $body = json_body();
    $clientId = (int)($body['client_id'] ?? 0);
    if ($clientId <= 0) {
        json_fail('Не указан client_id', 422);
    }
    assert_owns_client($pdo, $clientId, $userId);

    $direction = ($body['direction'] ?? 'out') === 'in' ? 'in' : 'out';
    $text = isset($body['text']) ? trim((string)$body['text']) : null;
    $photoUrl = isset($body['photo_url']) ? trim((string)$body['photo_url']) : null;
    $audioUrl = isset($body['audio_url']) ? trim((string)$body['audio_url']) : null;
    if ($photoUrl !== null && $photoUrl !== '' && !upload_url_valid($photoUrl)) {
        json_fail('Некорректная ссылка на фото', 422);
    }
    if ($audioUrl !== null && $audioUrl !== '' && !upload_url_valid($audioUrl)) {
        json_fail('Некорректная ссылка на аудио', 422);
    }
    if (($text === null || $text === '') && $photoUrl === null && $audioUrl === null) {
        json_fail('Пустое сообщение', 422);
    }

    $replyToId = (int)($body['reply_to_id'] ?? 0);
    if ($replyToId > 0) {
        $chk = $pdo->prepare('SELECT 1 FROM messages WHERE id = :id AND client_id = :cid');
        $chk->execute([':id' => $replyToId, ':cid' => $clientId]);
        if (!$chk->fetch()) {
            $replyToId = 0;
        }
    }

    $stmt = $pdo->prepare('INSERT INTO messages (client_id, direction, text, photo_url, audio_url, reply_to_id) VALUES (:cid, :dir, :text, :photo, :audio, :reply)');
    $stmt->execute([':cid' => $clientId, ':dir' => $direction, ':text' => $text, ':photo' => $photoUrl, ':audio' => $audioUrl, ':reply' => $replyToId ?: null]);

    $pdo->prepare("UPDATE clients SET updated_at = datetime('now') WHERE id = :id")
        ->execute([':id' => $clientId]);

    json_out(['ok' => true, 'id' => (int)$pdo->lastInsertId()], 201);
}

if ($method === 'DELETE') {
    $body = json_body();
    $id = (int)($body['id'] ?? ($_GET['id'] ?? 0));
    if ($id <= 0) {
        json_fail('Не указан id сообщения', 422);
    }
    $stmt = $pdo->prepare(
        'SELECT m.id FROM messages m JOIN clients c ON c.id = m.client_id
          WHERE m.id = :id AND c.user_id = :uid'
    );
    $stmt->execute([':id' => $id, ':uid' => $userId]);
    if (!$stmt->fetch()) {
        json_fail('Сообщение не найдено', 404);
    }
    $pdo->prepare('DELETE FROM messages WHERE id = :id')->execute([':id' => $id]);
    $pdo->prepare('DELETE FROM message_reactions WHERE scope = \'client\' AND message_id = :id')->execute([':id' => $id]);
    json_out(['ok' => true]);
}

json_fail('Метод не поддерживается', 405);
