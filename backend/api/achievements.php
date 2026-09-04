<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/achievements.php';
require_once __DIR__ . '/../config/shop.php';
start_session();

if (empty($_SESSION['user_id'])) {
    json_fail('Не авторизован', 401);
}
$userId = (int)$_SESSION['user_id'];

$pdo = db();
if (!$pdo) {
    json_fail('Хранилище недоступно на этом сервере (нет PDO SQLite)', 503);
}
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_fail('Метод не поддерживается', 405);
}
// «Путь продавца» — прогресс владельца магазина; у сотрудников своего пути нет.
require_owner_session();

$user = store_find_user_by_id($userId);
if (!$user) {
    json_fail('Пользователь не найден', 404);
}

$stats = achievements_stats($pdo, $userId, $user);

$unlockedStmt = $pdo->prepare('SELECT achievement_key, unlocked_at FROM seller_achievements WHERE user_id = :uid');
$unlockedStmt->execute([':uid' => $userId]);
$unlockedRows = $unlockedStmt->fetchAll(PDO::FETCH_KEY_PAIR);

$insert = $pdo->prepare('INSERT OR IGNORE INTO seller_achievements (user_id, achievement_key, unlocked_at) VALUES (:uid, :key, datetime(\'now\'))');

// Живой счётчик для трёх ai_helper_* ачивок — вместо статичного "10/50/200
// раз" показываем реальный прогресс и грубую оценку сэкономленного времени,
// чтобы цифра ощущалась настоящей, а не просто условием разблокировки.
$aiReplies = (int)$stats['ai_auto_replies'];
$aiMinutesSaved = $aiReplies * AI_HELPER_MINUTES_PER_REPLY;
$aiDescByKey = $aiReplies > 0
    ? "Бот сам ответил уже {$aiReplies} раз(а) — это ~" . achievements_format_minutes($aiMinutesSaved) . ' вашего времени'
    : null;

$out = [];
$xp = 0;
foreach (SELLER_ACHIEVEMENTS as $a) {
    $met = achievements_is_met($a['key'], $stats);
    $unlockedAt = $unlockedRows[$a['key']] ?? null;
    $justUnlocked = false;

    if ($met && $unlockedAt === null) {
        // Достигнуто впервые прямо сейчас — фиксируем дату и помечаем для
        // праздничной анимации на фронте.
        $insert->execute([':uid' => $userId, ':key' => $a['key']]);
        $unlockedAt = gmdate('Y-m-d H:i:s');
        $justUnlocked = true;
    }

    if ($unlockedAt !== null) {
        $xp += $a['xp'];
    }

    $isAiHelper = str_starts_with($a['key'], 'ai_helper_');

    $out[] = [
        'key' => $a['key'],
        'title' => $a['title'],
        'desc' => ($isAiHelper && $aiDescByKey !== null) ? $aiDescByKey : $a['desc'],
        'icon' => $a['icon'],
        'xp' => $a['xp'],
        'unlocked' => $unlockedAt !== null,
        'unlocked_at' => $unlockedAt,
        'just_unlocked' => $justUnlocked,
    ];
}

json_out([
    'achievements' => $out,
    'level' => achievements_level_for_xp($xp),
    'total_xp' => achievements_total_xp(),
]);
