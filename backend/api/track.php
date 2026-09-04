<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/bootstrap.php';
start_session();

// лёгкая телеметрия для админки — не авторизован или нет БД, просто молчим,
// это не тот случай, чтобы ронять клиента ошибкой
if (empty($_SESSION['user_id'])) {
    json_out(['ok' => true]);
}
$pdo = db();
if (!$pdo) {
    json_out(['ok' => true]);
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_fail('Метод не поддерживается', 405);
}
csrf_verify();

$userId = (int)$_SESSION['user_id'];
$body = json_body();

$clicks = is_array($body['clicks'] ?? null) ? $body['clicks'] : [];
$screens = is_array($body['screens'] ?? null) ? $body['screens'] : [];

// Какой экран открыт сейчас — отдельно от накопительной статистики ниже,
// даёт админке "живой" список того, чем пользователь занят прямо сейчас
// (см. activity_users/activity_user_detail в admin.php).
$currentScreen = trim((string)($body['current_screen'] ?? ''));
if ($currentScreen !== '') {
    $currentScreen = mb_substr($currentScreen, 0, 60);
    $pdo->prepare('UPDATE users SET last_screen = :s WHERE id = :id')
        ->execute([':s' => $currentScreen, ':id' => $userId]);
}

$clickStmt = $pdo->prepare(
    'INSERT INTO user_click_stats (user_id, target, count, last_at) VALUES (:uid, :target, :count, datetime(\'now\'))
     ON CONFLICT(user_id, target) DO UPDATE SET count = count + excluded.count, last_at = excluded.last_at'
);
$i = 0;
$totalClicks = 0;
foreach ($clicks as $target => $count) {
    if (++$i > 50) break;
    $target = mb_substr(trim((string)$target), 0, 60);
    $count = max(1, min(1000, (int)$count));
    if ($target === '') continue;
    $clickStmt->execute([':uid' => $userId, ':target' => $target, ':count' => $count]);
    $totalClicks += $count;
}

$screenStmt = $pdo->prepare(
    'INSERT INTO user_screen_time (user_id, screen, total_ms, last_at) VALUES (:uid, :screen, :ms, datetime(\'now\'))
     ON CONFLICT(user_id, screen) DO UPDATE SET total_ms = total_ms + excluded.total_ms, last_at = excluded.last_at'
);
$i = 0;
$totalMs = 0;
foreach ($screens as $screen => $ms) {
    if (++$i > 30) break;
    $screen = mb_substr(trim((string)$screen), 0, 60);
    $ms = max(0, min(3600000, (int)$ms));
    if ($screen === '' || $ms === 0) continue;
    $screenStmt->execute([':uid' => $userId, ':screen' => $screen, ':ms' => $ms]);
    $totalMs += $ms;
}

// Дневной срез — на нём строятся фильтры периодов и сравнение "сегодня/вчера"
// в статистике админки (см. admin.php: activity_overview / activity_users).
if ($totalClicks > 0 || $totalMs > 0) {
    $pdo->prepare(
        "INSERT INTO user_activity_daily (user_id, day, active_ms, clicks) VALUES (:uid, date('now'), :ms, :clicks)
         ON CONFLICT(user_id, day) DO UPDATE SET active_ms = active_ms + excluded.active_ms, clicks = clicks + excluded.clicks"
    )->execute([':uid' => $userId, ':ms' => $totalMs, ':clicks' => $totalClicks]);
}

json_out(['ok' => true]);
