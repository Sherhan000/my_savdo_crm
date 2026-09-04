<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/bootstrap.php';
start_session();

$pdo = db();
if (!$pdo) {
    json_fail('Хранилище отзывов недоступно на этом сервере (нет PDO SQLite)', 503);
}

$method = $_SERVER['REQUEST_METHOD'];
if ($method !== 'GET') {
    csrf_verify();
}

function review_row_out(array $row): array {
    return [
        'id' => (int)$row['id'],
        'shop_name' => $row['shop_name'],
        'avatar' => $row['avatar'] ?? null,
        'rating' => (int)$row['rating'],
        'text' => $row['text'],
        'created_at' => $row['created_at'],
    ];
}

if ($method === 'GET') {
    if (isset($_GET['mine'])) {
        if (empty($_SESSION['user_id'])) {
            json_fail('Не авторизован', 401);
        }
        $stmt = $pdo->prepare('SELECT rating, text FROM reviews WHERE user_id = :uid');
        $stmt->execute([':uid' => (int)$_SESSION['user_id']]);
        $row = $stmt->fetch();
        json_out(['review' => $row ? ['rating' => (int)$row['rating'], 'text' => $row['text']] : null]);
    }

    $stmt = $pdo->query(
        'SELECT r.*, u.shop_name, u.avatar
           FROM reviews r
           JOIN users u ON u.id = r.user_id
          ORDER BY r.created_at DESC
          LIMIT 60'
    );
    $rows = $stmt->fetchAll();

    $stat = $pdo->query('SELECT COUNT(*) AS cnt, COALESCE(AVG(rating),0) AS avg FROM reviews')->fetch();

    json_out([
        'reviews' => array_map('review_row_out', $rows),
        'count' => (int)$stat['cnt'],
        'avg' => round((float)$stat['avg'], 2),
    ]);
}

if (empty($_SESSION['user_id'])) {
    json_fail('Войдите в аккаунт, чтобы оставить отзыв', 401);
}
$userId = (int)$_SESSION['user_id'];

if ($method === 'POST') {
    $body = json_body();
    $rating = (int)($body['rating'] ?? 0);
    if ($rating < 1 || $rating > 5) {
        json_fail('Оценка должна быть от 1 до 5 звёзд', 422);
    }
    $text = trim((string)($body['text'] ?? ''));
    if (mb_strlen($text) > 500) {
        $text = mb_substr($text, 0, 500);
    }

    $stmt = $pdo->prepare(
        "INSERT INTO reviews (user_id, rating, text, created_at, updated_at)
         VALUES (:uid, :rating, :text, datetime('now'), datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET rating = excluded.rating, text = excluded.text, updated_at = datetime('now')"
    );
    $stmt->execute([':uid' => $userId, ':rating' => $rating, ':text' => $text !== '' ? $text : null]);

    json_out(['ok' => true]);
}

if ($method === 'DELETE') {
    $stmt = $pdo->prepare('DELETE FROM reviews WHERE user_id = :uid');
    $stmt->execute([':uid' => $userId]);
    json_out(['ok' => true]);
}

json_fail('Метод не поддерживается', 405);
