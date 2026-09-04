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

function bonus_state(PDO $pdo, int $userId): array {
    $stmt = $pdo->prepare('SELECT ai_bonus, insta_bonus_at FROM users WHERE id = :id');
    $stmt->execute([':id' => $userId]);
    $row = $stmt->fetch() ?: ['ai_bonus' => 0, 'insta_bonus_at' => null];
    return [
        'ai_bonus' => (int)$row['ai_bonus'],
        'insta_claimed' => $row['insta_bonus_at'] !== null,
    ];
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    json_out(bonus_state($pdo, $userId));
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_fail('Метод не поддерживается', 405);
}
csrf_verify();

$body = json_body();
$action = (string)($body['action'] ?? '');

if ($action === 'claim_instagram') {

    $upd = $pdo->prepare("UPDATE users
                             SET ai_bonus = ai_bonus + 5,
                                 insta_bonus_at = datetime('now')
                           WHERE id = :id AND insta_bonus_at IS NULL");
    $upd->execute([':id' => $userId]);
    if ($upd->rowCount() === 0) {
        json_out(['error' => 'Бонус за Instagram уже получен на этом аккаунте', 'state' => bonus_state($pdo, $userId)], 422);
    }
    json_out(['ok' => true, 'awarded' => 5, 'state' => bonus_state($pdo, $userId)]);
}

json_fail('Неизвестное действие', 422);
