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
    json_fail('Истории недоступны на этом сервере (нет PDO SQLite)', 503);
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_fail('Метод не поддерживается', 405);
}

// Отдаём только активные и ещё не истёкшие истории — админ выбирает срок
// жизни (24ч/48ч) при публикации, дальше это просто перестаёт возвращаться
// сюда, ничего чистить по крону не нужно.
$stmt = $pdo->prepare(
    "SELECT id, video_url, caption, created_at, expires_at
       FROM stories
      WHERE active = 1 AND expires_at > datetime('now')
      ORDER BY created_at ASC"
);
$stmt->execute();
$rows = $stmt->fetchAll();

$ids = array_map(static fn($r) => (int)$r['id'], $rows);
$reactions = reactions_batch($pdo, 'story', $ids, $userId);

json_out(['stories' => array_map(static function ($r) use ($reactions): array {
    $id = (int)$r['id'];
    return [
        'id' => $id,
        'video_url' => $r['video_url'],
        'caption' => $r['caption'],
        'created_at' => $r['created_at'],
        'expires_at' => $r['expires_at'],
        'reactions' => $reactions[$id] ?? null,
    ];
}, $rows)]);
