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
    json_fail('Оценки недоступны на этом сервере (нет PDO SQLite)', 503);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_fail('Метод не поддерживается', 405);
}
csrf_verify();

$body = json_body();
$messageId = (int)($body['message_id'] ?? 0);
$rating = $body['rating'] ?? null;
$comment = trim((string)($body['comment'] ?? ''));
if (mb_strlen($comment) > 500) {
    $comment = mb_substr($comment, 0, 500);
}

if ($messageId <= 0) {
    json_fail('Не указано сообщение', 422);
}
// null снимает ранее поставленную оценку (передумал/убрал реакцию)
if ($rating !== null && $rating !== 1 && $rating !== -1) {
    json_fail('Оценка должна быть 1 (👍), -1 (👎) или null', 422);
}

$stmt = $pdo->prepare("SELECT id FROM ai_chat_messages WHERE id = :id AND user_id = :uid AND role = 'assistant'");
$stmt->execute([':id' => $messageId, ':uid' => $userId]);
if (!$stmt->fetch()) {
    json_fail('Сообщение не найдено', 404);
}

$pdo->prepare('UPDATE ai_chat_messages SET rating = :r, rating_comment = :c WHERE id = :id')
    ->execute([
        ':r' => $rating,
        ':c' => ($rating !== null && $comment !== '') ? $comment : null,
        ':id' => $messageId,
    ]);

json_out(['ok' => true]);
