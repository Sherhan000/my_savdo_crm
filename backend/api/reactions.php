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
    json_fail('Реакции недоступны на этом сервере (нет PDO SQLite)', 503);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_fail('Метод не поддерживается', 405);
}
csrf_verify();

const REACTION_SCOPES = ['client', 'support', 'dm', 'story'];
const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

// Проверяет, что message_id из scope действительно принадлежит текущему
// пользователю (или он участник переписки) — иначе можно было бы поставить
// реакцию на чужое сообщение просто угадав id. Истории — исключение: это
// публичная рассылка от админа, реагировать может любой залогиненный
// пользователь, поэтому проверяем только что история вообще существует.
function reaction_assert_access(PDO $pdo, string $scope, int $messageId, int $userId): void {
    if ($scope === 'client') {
        $stmt = $pdo->prepare(
            'SELECT 1 FROM messages m JOIN clients c ON c.id = m.client_id
              WHERE m.id = :mid AND c.user_id = :uid'
        );
        $stmt->execute([':mid' => $messageId, ':uid' => $userId]);
    } elseif ($scope === 'support') {
        $stmt = $pdo->prepare('SELECT 1 FROM support_messages WHERE id = :mid AND user_id = :uid');
        $stmt->execute([':mid' => $messageId, ':uid' => $userId]);
    } elseif ($scope === 'story') {
        $stmt = $pdo->prepare('SELECT 1 FROM stories WHERE id = :mid');
        $stmt->execute([':mid' => $messageId]);
    } else {
        $stmt = $pdo->prepare(
            'SELECT 1 FROM dm_messages m JOIN conversations c ON c.id = m.conversation_id
              WHERE m.id = :mid AND (c.user_a_id = :uid OR c.user_b_id = :uid)'
        );
        $stmt->execute([':mid' => $messageId, ':uid' => $userId]);
    }
    if (!$stmt->fetch()) {
        json_fail('Сообщение не найдено', 404);
    }
}

function reaction_summary(PDO $pdo, string $scope, int $messageId, int $userId): array {
    $stmt = $pdo->prepare('SELECT emoji, user_id FROM message_reactions WHERE scope = :s AND message_id = :mid');
    $stmt->execute([':s' => $scope, ':mid' => $messageId]);
    $counts = [];
    $mine = null;
    foreach ($stmt->fetchAll() as $r) {
        $emoji = (string)$r['emoji'];
        $counts[$emoji] = ($counts[$emoji] ?? 0) + 1;
        if ((int)$r['user_id'] === $userId) {
            $mine = $emoji;
        }
    }
    return ['message_id' => $messageId, 'counts' => (object)$counts, 'mine' => $mine];
}

$body = json_body();
$scope = (string)($body['scope'] ?? '');
$messageId = (int)($body['message_id'] ?? 0);
$emoji = trim((string)($body['emoji'] ?? ''));

if (!in_array($scope, REACTION_SCOPES, true) || $messageId <= 0) {
    json_fail('Неверные параметры', 422);
}
if (!in_array($emoji, REACTION_EMOJI, true)) {
    json_fail('Недопустимая реакция', 422);
}

reaction_assert_access($pdo, $scope, $messageId, $userId);

$existing = $pdo->prepare('SELECT emoji FROM message_reactions WHERE scope = :s AND message_id = :mid AND user_id = :uid');
$existing->execute([':s' => $scope, ':mid' => $messageId, ':uid' => $userId]);
$current = $existing->fetchColumn();

if ($current === $emoji) {
    // повторный тап по своей же реакции — снимаем
    $pdo->prepare('DELETE FROM message_reactions WHERE scope = :s AND message_id = :mid AND user_id = :uid')
        ->execute([':s' => $scope, ':mid' => $messageId, ':uid' => $userId]);
} else {
    $pdo->prepare(
        'INSERT INTO message_reactions (scope, message_id, user_id, emoji) VALUES (:s, :mid, :uid, :emoji)
         ON CONFLICT(scope, message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = datetime(\'now\')'
    )->execute([':s' => $scope, ':mid' => $messageId, ':uid' => $userId, ':emoji' => $emoji]);
}

json_out(['ok' => true, 'reaction' => reaction_summary($pdo, $scope, $messageId, $userId)]);
