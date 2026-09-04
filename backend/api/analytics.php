<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
start_session();

if (empty($_SESSION['user_id'])) {
    json_fail('Не авторизован', 401);
}
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_fail('Метод не поддерживается', 405);
}
$userId = (int)$_SESSION['user_id'];

$pdo = db();
if (!$pdo) {
    json_fail('Аналитика недоступна на этом сервере (нет PDO SQLite)', 503);
}

// Период графика заявок — 7/30/90 дней, как переключатель периодов в
// админке (см. adminActivityRange в admin.js), только тут за своими же
// клиентами, не за всей платформой.
$rangeDays = ['7d' => 7, '30d' => 30, '90d' => 90][(string)($_GET['range'] ?? '7d')] ?? 7;

$trendStmt = $pdo->prepare(
    "SELECT date(m.created_at) AS d, COUNT(*) AS cnt
       FROM messages m JOIN clients c ON c.id = m.client_id
      WHERE c.user_id = :uid AND m.direction = 'in'
        AND m.created_at > datetime('now', :off)
      GROUP BY d"
);
$trendStmt->execute([':uid' => $userId, ':off' => "-{$rangeDays} days"]);
$trendByDate = [];
foreach ($trendStmt->fetchAll() as $r) {
    $trendByDate[$r['d']] = (int)$r['cnt'];
}
$trend = [];
for ($i = $rangeDays - 1; $i >= 0; $i--) {
    $date = date('Y-m-d', strtotime("-{$i} days"));
    $trend[] = ['date' => $date, 'count' => $trendByDate[$date] ?? 0];
}

// Для сравнения "период к периоду" (как в YouTube Studio — "+12% к прошлым
// 7 дням") — та же ширина окна, сразу ПЕРЕД текущим периодом.
$prevTotalStmt = $pdo->prepare(
    "SELECT COUNT(*) FROM messages m JOIN clients c ON c.id = m.client_id
      WHERE c.user_id = :uid AND m.direction = 'in'
        AND m.created_at > datetime('now', :from) AND m.created_at <= datetime('now', :to)"
);
$prevTotalStmt->execute([':uid' => $userId, ':from' => '-' . ($rangeDays * 2) . ' days', ':to' => "-{$rangeDays} days"]);
$trendPrevTotal = (int)$prevTotalStmt->fetchColumn();

$heatStmt = $pdo->prepare(
    "SELECT strftime('%w', m.created_at) AS dow, strftime('%H', m.created_at) AS hr, COUNT(*) AS cnt
       FROM messages m JOIN clients c ON c.id = m.client_id
      WHERE c.user_id = :uid AND m.direction = 'in'
        AND m.created_at > datetime('now', '-30 days')
      GROUP BY dow, hr"
);
$heatStmt->execute([':uid' => $userId]);

$total = 0;
$grid = array_fill(0, 7, array_fill(0, 6, 0));
foreach ($heatStmt->fetchAll() as $r) {
    $dow = (int)$r['dow'];
    $di = ($dow + 6) % 7;
    $hr = (int)$r['hr'];
    if ($hr < 6) {
        continue;
    }
    $hi = min(5, intdiv($hr - 6, 3));
    $grid[$di][$hi] += (int)$r['cnt'];
    $total += (int)$r['cnt'];
}

// Цель продаж на месяц: план — из профиля продавца, факт — сумма value
// заявок, дошедших до этапа "done" в текущем календарном месяце (по
// updated_at — тому же полю, на котором строится конверсия на фронтенде).
$goalStmt = $pdo->prepare('SELECT sales_goal FROM users WHERE id = :uid');
$goalStmt->execute([':uid' => $userId]);
$salesGoalRaw = $goalStmt->fetchColumn();
$salesGoal = ($salesGoalRaw !== false && $salesGoalRaw !== null) ? (int)$salesGoalRaw : 0;

$doneStmt = $pdo->prepare(
    "SELECT COALESCE(SUM(value), 0) FROM clients
      WHERE user_id = :uid AND stage = 'done'
        AND strftime('%Y-%m', updated_at) = strftime('%Y-%m', 'now')"
);
$doneStmt->execute([':uid' => $userId]);
$salesDoneMonth = (int)$doneStmt->fetchColumn();

// Причины удаления заявок за последние 90 дней — см. client_deletions в
// db.php (пишется в clients.php DELETE). Не за всё время, чтобы старые
// разовые случаи не забивали текущую картину навсегда.
$reasonsStmt = $pdo->prepare(
    "SELECT reason, COUNT(*) AS cnt FROM client_deletions
      WHERE user_id = :uid AND deleted_at > datetime('now', '-90 days')
      GROUP BY reason ORDER BY cnt DESC"
);
$reasonsStmt->execute([':uid' => $userId]);
$deleteReasons = array_map(
    fn(array $r) => ['reason' => $r['reason'], 'count' => (int)$r['cnt']],
    $reasonsStmt->fetchAll()
);

json_out([
    'trend' => $trend, 'trend_range' => $rangeDays, 'trend_total' => array_sum(array_column($trend, 'count')),
    'trend_prev_total' => $trendPrevTotal,
    'heatmap' => $grid, 'total' => $total,
    'sales_goal' => $salesGoal, 'sales_done_month' => $salesDoneMonth,
    'delete_reasons' => $deleteReasons,
]);
