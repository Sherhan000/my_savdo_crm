<?php
declare(strict_types=1);

if (!defined('PLANLIB_MONTH_SECONDS')) {
    define('PLANLIB_MONTH_SECONDS', 30 * 24 * 3600);
}

function planlib_get_active(PDO $pdo, int $userId): ?array {
    $s = $pdo->prepare("SELECT * FROM user_plans WHERE user_id = :uid AND status = 'active' LIMIT 1");
    $s->execute([':uid' => $userId]);
    return $s->fetch() ?: null;
}

function planlib_activate_row(PDO $pdo, array $row, int $userId): void {
    $seconds = $row['remaining_seconds'] !== null ? max(60, (int)$row['remaining_seconds']) : PLANLIB_MONTH_SECONDS;
    $pdo->prepare("UPDATE user_plans
                      SET status = 'active', starts_at = datetime('now'),
                          ends_at = datetime('now', '+' || :s || ' seconds'),
                          remaining_seconds = NULL
                    WHERE id = :id")
        ->execute([':s' => $seconds, ':id' => (int)$row['id']]);
    $pdo->prepare('UPDATE users SET plan = :p WHERE id = :id')
        ->execute([':p' => $row['plan'], ':id' => $userId]);
}

function planlib_pause_active(PDO $pdo, array $active): void {
    $left = $pdo->query(
        "SELECT CAST(MAX(0, (julianday(" . $pdo->quote((string)$active['ends_at']) . ") - julianday('now')) * 86400) AS INTEGER)"
    )->fetchColumn();
    $pdo->prepare("UPDATE user_plans SET status = 'paused', remaining_seconds = :left, ends_at = NULL WHERE id = :id")
        ->execute([':left' => max(0, (int)$left), ':id' => (int)$active['id']]);
}

function planlib_ensure(PDO $pdo, int $userId): void {
    $count = $pdo->prepare('SELECT COUNT(*) FROM user_plans WHERE user_id = :uid');
    $count->execute([':uid' => $userId]);
    $rowCount = (int)$count->fetchColumn();
    if ($rowCount === 0) {
        $pdo->prepare("INSERT INTO user_plans (user_id, plan, status, starts_at, ends_at)
                        VALUES (:uid, 'demo', 'active', datetime('now'), datetime('now', '+' || :s || ' seconds'))")
            ->execute([':uid' => $userId, ':s' => PLANLIB_MONTH_SECONDS]);
        $pdo->prepare("UPDATE users SET plan = 'demo' WHERE id = :id")->execute([':id' => $userId]);
        return;
    }

    $maxIterations = max(5, $rowCount);
    for ($i = 0; $i < $maxIterations; $i++) {
        $active = planlib_get_active($pdo, $userId);
        if ($active) {
            $expired = $pdo->query("SELECT datetime('now') > " . $pdo->quote((string)$active['ends_at']))->fetchColumn();
            if (!$expired) return;
            $pdo->prepare("UPDATE user_plans SET status = 'expired', remaining_seconds = NULL WHERE id = :id")
                ->execute([':id' => (int)$active['id']]);
        }
        $pen = $pdo->prepare("SELECT * FROM user_plans WHERE user_id = :uid AND status = 'paused'
                              ORDER BY (plan = 'demo') ASC, id ASC LIMIT 1");
        $pen->execute([':uid' => $userId]);
        $paused = $pen->fetch();
        if (!$paused) {
            // users.plan — NOT NULL DEFAULT 'demo' (см. db.php), поэтому NULL сюда
            // писать нельзя — раньше это роняло запрос PDOException'ом у любого
            // юзера, чей тариф истёк без запасного (paused) плана в очереди.
            // 'none' — тот же ключ, что и в PLAN_FEATURES/user_active_plan()
            // для «активного тарифа нет», так что фичи всё равно выключатся как надо.
            $pdo->prepare("UPDATE users SET plan = 'none' WHERE id = :id")->execute([':id' => $userId]);
            return;
        }
        planlib_activate_row($pdo, $paused, $userId);
    }
}

function planlib_grant(PDO $pdo, int $userId, string $plan): void {
    planlib_ensure($pdo, $userId);
    $active = planlib_get_active($pdo, $userId);
    $isPaid = (PLANS_META[$plan]['price'] ?? 0) > 0;

    if (!$active) {
        $pdo->prepare("INSERT INTO user_plans (user_id, plan, status, starts_at, ends_at)
                        VALUES (:uid, :plan, 'active', datetime('now'), datetime('now', '+' || :s || ' seconds'))")
            ->execute([':uid' => $userId, ':plan' => $plan, ':s' => PLANLIB_MONTH_SECONDS]);
        $pdo->prepare('UPDATE users SET plan = :p WHERE id = :id')->execute([':p' => $plan, ':id' => $userId]);
        return;
    }

    $activeIsFree = (PLANS_META[$active['plan']]['price'] ?? 0) === 0;

    if ($isPaid && $activeIsFree) {
        planlib_pause_active($pdo, $active);
        $pdo->prepare("INSERT INTO user_plans (user_id, plan, status, starts_at, ends_at)
                        VALUES (:uid, :plan, 'active', datetime('now'), datetime('now', '+' || :s || ' seconds'))")
            ->execute([':uid' => $userId, ':plan' => $plan, ':s' => PLANLIB_MONTH_SECONDS]);
        $pdo->prepare('UPDATE users SET plan = :p WHERE id = :id')->execute([':p' => $plan, ':id' => $userId]);
        return;
    }

    $pdo->prepare("INSERT INTO user_plans (user_id, plan, status, remaining_seconds)
                    VALUES (:uid, :plan, 'paused', :s)")
        ->execute([':uid' => $userId, ':plan' => $plan, ':s' => PLANLIB_MONTH_SECONDS]);
}
