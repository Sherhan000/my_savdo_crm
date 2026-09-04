<?php

declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
start_session();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(['error' => 'Метод не поддерживается'], 405);
}

$body = json_body();
$action = (string)($body['action'] ?? '');

if ($action !== 'public_settings') {
    csrf_verify();
}

if ($action === 'public_settings') {
    $all = settings_read();
    json_out(['settings' => ['logo' => $all['logo'] ?? 'assets/img/logo.png']]);
}

if ($action === 'login') {

    rate_limit_guard('admin_login', 'global', 5, 30);
    $username = trim((string)($body['username'] ?? ''));
    $password = (string)($body['password'] ?? '');
    $pdo = db();
    $row = null;
    if ($pdo && $username !== '') {
        $stmt = $pdo->prepare('SELECT * FROM admin_accounts WHERE username = :u');
        $stmt->execute([':u' => $username]);
        $row = $stmt->fetch();
    }
    if (!$row || !password_verify($password, (string)$row['password_hash'])) {
        rate_limit_fail('admin_login', 'global', 5, 30);
        json_out(['error' => 'Неверный логин или пароль'], 401);
    }
    rate_limit_clear('admin_login', 'global');
    session_regenerate_id(true);
    $_SESSION['is_admin'] = true;
    $_SESSION['admin_id'] = (int)$row['id'];
    $_SESSION['admin_username'] = $row['username'];
    json_out(['ok' => true, 'username' => $row['username']]);
}

if (empty($_SESSION['is_admin'])) {
    json_out(['error' => 'Нет доступа к админ-панели'], 403);
}

// user_activity_daily хранит клики/время срезом по календарным суткам (см.
// track.php), поэтому "24ч"/"48ч" — это не скользящее окно, а сегодня/
// сегодня+вчера; для недели/месяца/полугода/года это уже точный подсчёт по
// дням. Отдельно "сегодня vs вчера" в activity_overview всегда считается
// точно, по конкретным суткам, независимо от выбранного диапазона.
const ADMIN_RANGE_DAYS = ['24h' => 1, '48h' => 2, '7d' => 7, '30d' => 30, '6m' => 183, '1y' => 365];
function admin_range_days(string $range): int {
    return ADMIN_RANGE_DAYS[$range] ?? 7;
}

const ADMIN_PLAN_TITLES_PHP = ['none' => 'Без тарифа', 'demo' => 'Демо', 'standard' => 'Стандарт', 'business' => 'Бизнес'];

// Экранирование ячейки для CSV-экспорта (export_users_csv) — оборачивает в
// кавычки значение с запятой/кавычкой/переносом строки, как того требует RFC 4180.
function admin_csv_cell($value): string {
    $s = (string)($value ?? '');
    if (preg_match('/[",\r\n]/', $s)) {
        return '"' . str_replace('"', '""', $s) . '"';
    }
    return $s;
}

if ($action === 'whoami') {
    json_out(['username' => $_SESSION['admin_username'] ?? '']);
}

if ($action === 'change_password') {
    $pdo = db();
    if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
    $current = (string)($body['current_password'] ?? '');
    $new = (string)($body['new_password'] ?? '');
    if (strlen($new) < 8) {
        json_out(['error' => 'Новый пароль должен быть не короче 8 символов'], 422);
    }
    $stmt = $pdo->prepare('SELECT * FROM admin_accounts WHERE id = :id');
    $stmt->execute([':id' => (int)($_SESSION['admin_id'] ?? 0)]);
    $row = $stmt->fetch();
    if (!$row || !password_verify($current, (string)$row['password_hash'])) {
        json_out(['error' => 'Текущий пароль указан неверно'], 403);
    }
    $pdo->prepare('UPDATE admin_accounts SET password_hash = :p WHERE id = :id')
        ->execute([':p' => password_hash($new, PASSWORD_BCRYPT), ':id' => (int)$row['id']]);
    json_out(['ok' => true]);
}

switch ($action) {
    case 'list_users':

        $users = store_public_users();
        $pdo = db();
        if ($pdo) {
            require_once __DIR__ . '/../config/features.php';
            foreach ($users as &$u) {
                $uid = (int)$u['id'];
                $u['active_plan'] = user_active_plan($pdo, $uid);
                $ovStmt = $pdo->prepare('SELECT feature_overrides, ai_bonus, last_active_at FROM users WHERE id = :id');
                $ovStmt->execute([':id' => $uid]);
                $ovRow = $ovStmt->fetch() ?: ['feature_overrides' => null, 'ai_bonus' => 0, 'last_active_at' => null];
                $raw = $ovRow['feature_overrides'];
                $u['feature_overrides'] = $raw ? (json_decode((string)$raw, true) ?: (object)[]) : (object)[];
                $u['ai_bonus'] = (int)$ovRow['ai_bonus'];
                $u['features'] = user_features($pdo, $uid);
                $u['last_active_at'] = $ovRow['last_active_at'];
            }
            unset($u);
        }
        json_out(['users' => $users, 'settings' => settings_read()]);
        break;

    case 'overview': {
        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        require_once __DIR__ . '/../config/features.php';

        $totalUsers = (int)$pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();
        $onlineNow = (int)$pdo->query("SELECT COUNT(*) FROM users WHERE last_active_at > datetime('now','-2 minutes')")->fetchColumn();
        $activeToday = (int)$pdo->query("SELECT COUNT(DISTINCT user_id) FROM user_activity_daily WHERE day = date('now')")->fetchColumn();
        $newUsers7d = (int)$pdo->query("SELECT COUNT(*) FROM users WHERE created_at >= datetime('now','-7 days')")->fetchColumn();
        $paymentsPending = (int)$pdo->query("SELECT COUNT(*) FROM payments WHERE status = 'pending'")->fetchColumn();
        $supportUnread = (int)$pdo->query("SELECT COUNT(*) FROM support_messages WHERE direction = 'user' AND read_by_admin = 0")->fetchColumn();
        $aiDown = (int)$pdo->query("SELECT COUNT(*) FROM ai_chat_messages WHERE role = 'assistant' AND rating = -1")->fetchColumn();

        $recentUsers = $pdo->query(
            'SELECT id, shop_name, email, plan, created_at FROM users ORDER BY id DESC LIMIT 6'
        )->fetchAll();

        $recentPayments = $pdo->query(
            "SELECT p.id, p.plan, p.amount, p.created_at, u.shop_name, u.email
               FROM payments p JOIN users u ON u.id = p.user_id
              WHERE p.status = 'pending'
              ORDER BY p.id DESC LIMIT 6"
        )->fetchAll();

        // --- Выручка ---
        // Считаем только по тарифам (не по местам сотрудников/слотам аккаунтов —
        // те тоже approved-платежи, но это не "тариф", у них нет цены в PLANS_META).
        $planList = "'" . implode("','", array_keys(PLANS_META)) . "'";
        $revenueMonth = (int)$pdo->query(
            "SELECT COALESCE(SUM(amount),0) FROM payments
              WHERE status = 'approved' AND plan IN ($planList)
                AND strftime('%Y-%m', decided_at) = strftime('%Y-%m', 'now')"
        )->fetchColumn();
        $revenueTotal = (int)$pdo->query(
            "SELECT COALESCE(SUM(amount),0) FROM payments WHERE status = 'approved' AND plan IN ($planList)"
        )->fetchColumn();
        $revenueTrendStmt = $pdo->query(
            "SELECT date(decided_at) d, SUM(amount) s FROM payments
              WHERE status = 'approved' AND plan IN ($planList) AND decided_at > datetime('now', '-30 days')
              GROUP BY d"
        );
        $revenueByDate = [];
        foreach ($revenueTrendStmt->fetchAll() as $r) $revenueByDate[$r['d']] = (int)$r['s'];
        $revenueTrend = [];
        for ($i = 29; $i >= 0; $i--) {
            $d = date('Y-m-d', strtotime("-{$i} days"));
            $revenueTrend[] = ['date' => $d, 'amount' => $revenueByDate[$d] ?? 0];
        }

        // --- Тарифы: сколько пользователей на каждом (живой активный план,
        // не "последний известный" users.plan, который бывает устаревшим) ---
        $planMixStmt = $pdo->query(
            "SELECT COALESCE(
                (SELECT plan FROM user_plans WHERE user_plans.user_id = users.id AND status = 'active' LIMIT 1),
                'none'
             ) AS bucket, COUNT(*) AS cnt
             FROM users GROUP BY bucket"
        );
        $planMix = [];
        foreach ($planMixStmt->fetchAll() as $r) $planMix[(string)$r['bucket']] = (int)$r['cnt'];
        $paidUsersNow = ($planMix['standard'] ?? 0) + ($planMix['business'] ?? 0);
        $everPaidUsers = (int)$pdo->query("SELECT COUNT(DISTINCT user_id) FROM user_plans WHERE plan IN ('standard','business')")->fetchColumn();
        $arpu = $paidUsersNow > 0 ? round($revenueMonth / $paidUsersNow) : 0;

        // --- Продажи по всей платформе (сумма воронок всех магазинов) ---
        $totalClients = (int)$pdo->query('SELECT COUNT(*) FROM clients')->fetchColumn();
        $totalMessages = (int)$pdo->query('SELECT COUNT(*) FROM messages')->fetchColumn();
        $dealsDoneTotal = (int)$pdo->query("SELECT COUNT(*) FROM clients WHERE stage = 'done'")->fetchColumn();
        $dealsRow = $pdo->query(
            "SELECT COUNT(*) c, COALESCE(SUM(value),0) v FROM clients
              WHERE stage = 'done' AND strftime('%Y-%m', updated_at) = strftime('%Y-%m', 'now')"
        )->fetch();
        $platformConversion = $totalClients > 0 ? round($dealsDoneTotal / $totalClients * 100, 1) : 0.0;

        // --- Какими фичами реально пользуются (доля от всех аккаунтов) ---
        $shopsCount = (int)$pdo->query('SELECT COUNT(*) FROM users WHERE is_shop = 1')->fetchColumn();
        $tgConnected = (int)$pdo->query('SELECT COUNT(*) FROM telegram_bots')->fetchColumn();
        $igConnected = (int)$pdo->query(
            'SELECT COUNT(DISTINCT user_id) FROM (
                SELECT user_id FROM instagram_accounts UNION SELECT user_id FROM instagram_private_accounts
             )'
        )->fetchColumn();
        $employeesActive = (int)$pdo->query("SELECT COUNT(*) FROM shop_employees WHERE status = 'active'")->fetchColumn();
        $aiAutoOn = (int)$pdo->query('SELECT COUNT(*) FROM clients WHERE ai_auto = 1')->fetchColumn();
        $pct = static fn(int $part, int $whole): float => $whole > 0 ? round($part / $whole * 100, 1) : 0.0;

        // --- Удержание: из тех, кто зарегистрировался 7-30 дней назад, сколько
        // заходили за последнюю неделю — грубый, но честный сигнал retention'а ---
        $cohort = (int)$pdo->query(
            "SELECT COUNT(*) FROM users WHERE created_at <= datetime('now','-7 days') AND created_at > datetime('now','-30 days')"
        )->fetchColumn();
        $cohortRetained = (int)$pdo->query(
            "SELECT COUNT(*) FROM users
              WHERE created_at <= datetime('now','-7 days') AND created_at > datetime('now','-30 days')
                AND last_active_at > datetime('now','-7 days')"
        )->fetchColumn();
        $atRisk = (int)$pdo->query(
            "SELECT COUNT(*) FROM users
              WHERE created_at <= datetime('now','-14 days')
                AND (last_active_at IS NULL OR last_active_at < datetime('now','-14 days'))"
        )->fetchColumn();

        json_out([
            'total_users' => $totalUsers,
            'online_now' => $onlineNow,
            'active_today' => $activeToday,
            'new_users_7d' => $newUsers7d,
            'payments_pending' => $paymentsPending,
            'support_unread' => $supportUnread,
            'ai_down' => $aiDown,
            'recent_users' => $recentUsers,
            'recent_payments' => $recentPayments,
            'business' => [
                'revenue_month' => $revenueMonth,
                'revenue_total' => $revenueTotal,
                'revenue_trend_30d' => $revenueTrend,
                'plan_mix' => $planMix,
                'paid_users_now' => $paidUsersNow,
                'ever_paid_users' => $everPaidUsers,
                'arpu_month' => $arpu,
                'total_clients' => $totalClients,
                'total_messages' => $totalMessages,
                'deals_done_total' => $dealsDoneTotal,
                'deals_done_month' => (int)$dealsRow['c'],
                'deals_value_month' => (int)$dealsRow['v'],
                'platform_conversion_pct' => $platformConversion,
                'adoption' => [
                    'shops_pct' => $pct($shopsCount, $totalUsers),
                    'telegram_pct' => $pct($tgConnected, $totalUsers),
                    'instagram_pct' => $pct($igConnected, $totalUsers),
                    'ai_auto_clients' => $aiAutoOn,
                    'employees_active' => $employeesActive,
                ],
                'retention' => [
                    'cohort_7_30d' => $cohort,
                    'cohort_retained' => $cohortRetained,
                    'cohort_retained_pct' => $pct($cohortRetained, $cohort),
                    'at_risk_users' => $atRisk,
                ],
            ],
        ]);
        break;
    }

    case 'export_users_csv': {
        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        require_once __DIR__ . '/../config/features.php';

        $rows = $pdo->query('SELECT id, shop_name, email, plan, created_at, last_active_at FROM users ORDER BY id ASC')->fetchAll();
        $lines = [implode(',', array_map('admin_csv_cell', ['ID', 'Магазин', 'Email', 'Тариф', 'Регистрация', 'Последняя активность']))];
        foreach ($rows as $r) {
            $plan = user_active_plan($pdo, (int)$r['id']);
            $lines[] = implode(',', array_map('admin_csv_cell', [
                $r['id'], $r['shop_name'], $r['email'], ADMIN_PLAN_TITLES_PHP[$plan] ?? $plan, $r['created_at'], $r['last_active_at'] ?? '',
            ]));
        }
        json_out(['csv' => implode("\r\n", $lines)]);
        break;
    }

    case 'grant_plan': {

        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        require_once __DIR__ . '/../config/features.php';
        require_once __DIR__ . '/plan-lib.php';
        $uid = (int)($body['user_id'] ?? 0);
        $plan = (string)($body['plan'] ?? '');
        if ($uid <= 0 || !isset(PLANS_META[$plan])) json_out(['error' => 'Неверные параметры'], 422);
        $exists = $pdo->prepare('SELECT id FROM users WHERE id = :id');
        $exists->execute([':id' => $uid]);
        if (!$exists->fetch()) json_out(['error' => 'Пользователь не найден'], 404);
        planlib_grant($pdo, $uid, $plan);
        json_out(['ok' => true, 'active_plan' => user_active_plan($pdo, $uid)]);
        break;
    }

    case 'set_features': {

        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        require_once __DIR__ . '/../config/features.php';
        $uid = (int)($body['user_id'] ?? 0);
        $ov = $body['overrides'] ?? null;
        if ($uid <= 0 || !is_array($ov)) json_out(['error' => 'Неверные параметры'], 422);

        $clean = [];
        foreach ($ov as $k => $v) {
            if (!isset(FEATURE_KEYS[$k])) continue;
            $type = FEATURE_KEYS[$k];
            if ($type === 'bool') $clean[$k] = (bool)$v;
            elseif ($type === 'int') $clean[$k] = max(0, (int)$v);
            else $clean[$k] = ($v === null || $v === '') ? null : max(0, (int)$v);
        }
        $pdo->prepare('UPDATE users SET feature_overrides = :ov WHERE id = :id')
            ->execute([':ov' => $clean ? json_encode($clean, JSON_UNESCAPED_UNICODE) : null, ':id' => $uid]);
        json_out(['ok' => true, 'features' => user_features($pdo, $uid), 'overrides' => $clean ?: (object)[]]);
        break;
    }

    case 'list_payments': {
        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        $rows = $pdo->query("SELECT p.*, u.email, u.shop_name FROM payments p
                              JOIN users u ON u.id = p.user_id
                             ORDER BY (p.status = 'pending') DESC, p.id DESC LIMIT 50")->fetchAll();
        json_out(['payments' => $rows]);
        break;
    }

    case 'decide_payment': {

        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        require_once __DIR__ . '/../config/features.php';
        require_once __DIR__ . '/plan-lib.php';
        $pid = (int)($body['payment_id'] ?? 0);
        $approve = !empty($body['approve']);
        $stmt = $pdo->prepare("SELECT * FROM payments WHERE id = :id AND status = 'pending'");
        $stmt->execute([':id' => $pid]);
        $payment = $stmt->fetch();
        if (!$payment) json_out(['error' => 'Платёж не найден или уже обработан'], 404);
        // Условие status = 'pending' повторено и в UPDATE — это и есть мьютекс:
        // два одновременных запроса на один и тот же платёж (двойной клик,
        // повтор запроса) оба проходят SELECT выше, но выигрывает только
        // первый UPDATE — WHERE у второго больше не найдёт 'pending' и он
        // сам обнаружит проигрыш по rowCount(), не выдав тариф/слоты дважды.
        $updStmt = $pdo->prepare("UPDATE payments SET status = :s, decided_at = datetime('now') WHERE id = :id AND status = 'pending'");
        $updStmt->execute([':s' => $approve ? 'approved' : 'rejected', ':id' => $pid]);
        if ($updStmt->rowCount() === 0) {
            json_out(['error' => 'Платёж не найден или уже обработан'], 404);
        }
        if ($approve) {
            if ((string)$payment['plan'] === 'employee_slots') {
                $pdo->prepare('UPDATE users SET employee_slots_purchased = employee_slots_purchased + 1 WHERE id = :id')
                    ->execute([':id' => (int)$payment['user_id']]);
            } elseif ((string)$payment['plan'] === 'account_slots') {
                $pdo->prepare('UPDATE users SET account_slots_purchased = account_slots_purchased + 1 WHERE id = :id')
                    ->execute([':id' => (int)$payment['user_id']]);
            } else {
                planlib_grant($pdo, (int)$payment['user_id'], (string)$payment['plan']);
            }
        }
        json_out(['ok' => true]);
        break;
    }

    case 'add_user':
        $shopName = trim((string)($body['shop_name'] ?? 'Новый магазин'));
        $email = trim(strtolower((string)($body['email'] ?? '')));
        $password = (string)($body['password'] ?? '');
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            json_out(['error' => 'Некорректный email'], 422);
        }
        if (strlen($password) < 6) {
            json_out(['error' => 'Пароль должен быть не короче 6 символов'], 422);
        }
        if (store_find_user_by_email($email)) {
            json_out(['error' => 'Пользователь с таким email уже существует'], 409);
        }
        $hash = password_hash($password, PASSWORD_BCRYPT);
        store_create_user($shopName, $email, $hash);
        json_out(['users' => store_public_users()], 201);
        break;

    case 'delete_user':
        $id = (int)($body['id'] ?? 0);
        if ($id <= 0) {
            json_out(['error' => 'Не передан id пользователя'], 422);
        }
        $ok = store_delete_user($id);
        if (!$ok) {
            json_out(['error' => 'Пользователь не найден'], 404);
        }
        json_out(['users' => store_public_users()]);
        break;

    case 'set_logo':
        $logo = trim((string)($body['logo'] ?? ''));
        if ($logo === '') {
            json_out(['error' => 'Не передан логотип'], 422);
        }
        $settings = settings_read();
        $settings['logo'] = $logo;
        settings_write($settings);
        json_out(['settings' => $settings]);
        break;

    case 'set_payment_requisites': {
        // Реквизиты и QR для оплаты тарифа (см. payModal) — хранятся в settings,
        // а не только в env/payment.php, чтобы админ мог менять их без деплоя.
        // Пустое поле сохраняется как есть — plan.php сам подставит дефолт из
        // payment.php, если в settings пусто (см. payment_requisites_read()).
        $settings = settings_read();
        foreach (['payment_card' => 'card', 'payment_holder' => 'holder', 'payment_bank' => 'bank', 'payment_comment' => 'comment'] as $key => $field) {
            if (isset($body[$field])) {
                $settings[$key] = mb_substr(trim((string)$body[$field]), 0, 120);
            }
        }
        if (isset($body['qr'])) {
            $settings['payment_qr'] = trim((string)$body['qr']);
        }
        settings_write($settings);
        json_out(['settings' => $settings]);
        break;
    }

    case 'logout_admin':
        unset($_SESSION['is_admin'], $_SESSION['admin_id'], $_SESSION['admin_username']);
        json_out(['ok' => true]);
        break;

    case 'grant_bonus': {

        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        $uid = (int)($body['user_id'] ?? 0);
        $amount = (int)($body['amount'] ?? 0);
        if ($uid <= 0 || $amount === 0 || abs($amount) > 1000) json_out(['error' => 'Неверные параметры'], 422);
        $upd = $pdo->prepare('UPDATE users SET ai_bonus = MAX(0, ai_bonus + :a) WHERE id = :id');
        $upd->execute([':a' => $amount, ':id' => $uid]);
        if ($upd->rowCount() === 0) json_out(['error' => 'Пользователь не найден'], 404);
        $cur = $pdo->prepare('SELECT ai_bonus FROM users WHERE id = :id');
        $cur->execute([':id' => $uid]);
        json_out(['ok' => true, 'ai_bonus' => (int)$cur->fetchColumn()]);
        break;
    }

    case 'support_threads': {

        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        $rows = $pdo->query("
            SELECT u.id, u.shop_name, u.email, u.avatar,
                   (SELECT text FROM support_messages m2 WHERE m2.user_id = u.id ORDER BY m2.id DESC LIMIT 1) AS last_text,
                   (SELECT direction FROM support_messages m2 WHERE m2.user_id = u.id ORDER BY m2.id DESC LIMIT 1) AS last_direction,
                   (SELECT created_at FROM support_messages m2 WHERE m2.user_id = u.id ORDER BY m2.id DESC LIMIT 1) AS last_at,
                   (SELECT COUNT(*) FROM support_messages m3 WHERE m3.user_id = u.id AND m3.direction = 'user' AND m3.read_by_admin = 0) AS unread
              FROM users u
             WHERE EXISTS (SELECT 1 FROM support_messages m WHERE m.user_id = u.id)
             ORDER BY last_at DESC
             LIMIT 100")->fetchAll();
        $totalUnread = 0;
        foreach ($rows as $r) $totalUnread += (int)$r['unread'];
        json_out(['threads' => $rows, 'total_unread' => $totalUnread]);
        break;
    }

    case 'support_thread': {

        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        $uid = (int)($body['user_id'] ?? 0);
        if ($uid <= 0) json_out(['error' => 'Неверные параметры'], 422);
        $stmt = $pdo->prepare('SELECT * FROM (SELECT * FROM support_messages WHERE user_id = :uid ORDER BY id DESC LIMIT 200) ORDER BY id ASC');
        $stmt->execute([':uid' => $uid]);
        $msgs = $stmt->fetchAll();

        // Личный ответ на историю — приклеиваем короткую цитату (видео+подпись),
        // чтобы админ видел, на что именно отвечает пользователь, как в TG.
        $storyIds = array_values(array_unique(array_filter(array_map(
            static fn($r) => isset($r['story_id']) ? (int)$r['story_id'] : 0,
            $msgs
        ))));
        $storiesById = [];
        if ($storyIds) {
            $placeholders = implode(',', array_fill(0, count($storyIds), '?'));
            $sStmt = $pdo->prepare("SELECT id, video_url, caption FROM stories WHERE id IN ($placeholders)");
            $sStmt->execute($storyIds);
            foreach ($sStmt->fetchAll() as $s) {
                $storiesById[(int)$s['id']] = ['id' => (int)$s['id'], 'video_url' => $s['video_url'], 'caption' => $s['caption']];
            }
        }
        foreach ($msgs as &$m) {
            $sid = isset($m['story_id']) ? (int)$m['story_id'] : 0;
            $m['story'] = $sid > 0 ? ($storiesById[$sid] ?? null) : null;
        }
        unset($m);

        $pdo->prepare("UPDATE support_messages SET read_by_admin = 1 WHERE user_id = :uid AND direction = 'user'")
            ->execute([':uid' => $uid]);
        $u = $pdo->prepare('SELECT id, shop_name, email FROM users WHERE id = :id');
        $u->execute([':id' => $uid]);
        json_out(['messages' => $msgs, 'user' => $u->fetch() ?: null]);
        break;
    }

    case 'support_reply': {

        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        $uid = (int)($body['user_id'] ?? 0);
        $text = mb_substr(trim((string)($body['text'] ?? '')), 0, 2000);
        if ($uid <= 0 || $text === '') json_out(['error' => 'Введите текст ответа'], 422);
        $exists = $pdo->prepare('SELECT id FROM users WHERE id = :id');
        $exists->execute([':id' => $uid]);
        if (!$exists->fetch()) json_out(['error' => 'Пользователь не найден'], 404);
        $pdo->prepare("INSERT INTO support_messages (user_id, direction, text, via, read_by_admin) VALUES (:uid, 'admin', :t, 'web', 1)")
            ->execute([':uid' => $uid, ':t' => $text]);
        $stmt = $pdo->prepare('SELECT * FROM support_messages WHERE id = :id');
        $stmt->execute([':id' => (int)$pdo->lastInsertId()]);
        json_out(['ok' => true, 'message' => $stmt->fetch()], 201);
        break;
    }

    case 'support_bot_get': {
        $s = settings_read();
        json_out([
            'connected' => trim((string)($s['support_bot_token'] ?? '')) !== '',
            'bot_username' => $s['support_bot_username'] ?? null,
            'chat_bound' => trim((string)($s['support_chat_id'] ?? '')) !== '',
            'bind_code' => trim((string)($s['support_chat_id'] ?? '')) === '' ? ($s['support_bind_code'] ?? '') : '',
        ]);
        break;
    }

    case 'support_bot_set': {

        $tok = trim((string)($body['bot_token'] ?? ''));
        if ($tok === '' || !str_contains($tok, ':')) {
            json_out(['error' => 'Похоже, это не токен бота. Токен выглядит так: 123456789:AAExxxx…'], 422);
        }

        if (!function_exists('curl_init')) {
            json_out(['error' => 'Подключение Telegram-бота недоступно на этом сервере (нет расширения PHP curl)'], 500);
        }

        $tgCall = function (string $method, array $params = []) use ($tok): array {
            $ch = curl_init("https://api.telegram.org/bot{$tok}/{$method}");
            curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true, CURLOPT_POSTFIELDS => $params, CURLOPT_TIMEOUT => 10]);
            $raw = curl_exec($ch);
            $d = json_decode((string)$raw, true);
            return is_array($d) ? $d : ['ok' => false, 'description' => 'нет ответа от Telegram'];
        };

        $me = $tgCall('getMe');
        if (empty($me['ok'])) {
            json_out(['error' => 'Telegram не принял токен: ' . ($me['description'] ?? 'проверьте токен из @BotFather')], 422);
        }

        $scheme = 'http';
        if ((!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && strtolower($_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https')
            || (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
            || (int)($_SERVER['SERVER_PORT'] ?? 0) === 443) {
            $scheme = 'https';
        }
        $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
        $isLocal = str_starts_with($host, 'localhost') || str_starts_with($host, '127.0.0.1');
        if ($scheme !== 'https' && !$isLocal) {
            json_out(['error' => 'Telegram принимает вебхуки только по HTTPS. Включите SSL на хостинге и подключите бота снова.'], 422);
        }
        $scriptDir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/backend/api/x.php')), '/');
        $webhookUrl = $scheme . '://' . $host . $scriptDir . '/support-telegram.php';

        $secret = bin2hex(random_bytes(16));
        $set = $tgCall('setWebhook', [
            'url' => $webhookUrl,
            'secret_token' => $secret,
            'drop_pending_updates' => 'true',
            'allowed_updates' => json_encode(['message']),
        ]);
        if (empty($set['ok'])) {
            json_out(['error' => 'Не удалось подключить вебхук: ' . ($set['description'] ?? 'неизвестная ошибка Telegram')], 422);
        }

        $bindCode = (string)random_int(100000, 999999);
        $s = settings_read();
        $s['support_bot_token'] = $tok;
        $s['support_bot_username'] = (string)($me['result']['username'] ?? '');
        $s['support_bot_secret'] = $secret;
        $s['support_bind_code'] = $bindCode;
        $s['support_chat_id'] = '';
        settings_write($s);

        json_out(['ok' => true, 'bot_username' => $s['support_bot_username'], 'bind_code' => $bindCode]);
        break;
    }

    case 'support_bot_delete': {
        $s = settings_read();
        $tok = trim((string)($s['support_bot_token'] ?? ''));
        if ($tok !== '' && function_exists('curl_init')) {
            $ch = curl_init("https://api.telegram.org/bot{$tok}/deleteWebhook");
            curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10]);
            curl_exec($ch);
        }
        foreach (['support_bot_token', 'support_bot_username', 'support_bot_secret', 'support_bind_code', 'support_chat_id'] as $k) {
            $s[$k] = '';
        }
        settings_write($s);
        json_out(['ok' => true]);
        break;
    }

    case 'track_stats': {
        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);

        $clicks = $pdo->query(
            'SELECT target, SUM(count) AS total_count
               FROM user_click_stats
              GROUP BY target
              ORDER BY total_count DESC
              LIMIT 30'
        )->fetchAll();

        $screens = $pdo->query(
            'SELECT screen, SUM(total_ms) AS total_ms
               FROM user_screen_time
              GROUP BY screen
              ORDER BY total_ms DESC
              LIMIT 30'
        )->fetchAll();

        $usersTracked = (int)$pdo->query(
            'SELECT COUNT(DISTINCT user_id) FROM (
                SELECT user_id FROM user_click_stats
                UNION
                SELECT user_id FROM user_screen_time
             )'
        )->fetchColumn();

        json_out([
            'clicks' => array_map(static fn($r) => ['target' => $r['target'], 'count' => (int)$r['total_count']], $clicks),
            'screens' => array_map(static fn($r) => ['screen' => $r['screen'], 'total_ms' => (int)$r['total_ms']], $screens),
            'users_tracked' => $usersTracked,
        ]);
        break;
    }

    case 'activity_overview': {
        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        $range = (string)($body['range'] ?? '7d');
        $days = admin_range_days($range);

        $stmt = $pdo->prepare(
            "SELECT day, SUM(active_ms) AS ms, SUM(clicks) AS clicks, COUNT(DISTINCT user_id) AS users
               FROM user_activity_daily
              WHERE day >= date('now', :off)
              GROUP BY day"
        );
        $stmt->execute([':off' => '-' . ($days - 1) . ' days']);
        $byDay = [];
        foreach ($stmt->fetchAll() as $r) $byDay[$r['day']] = $r;

        $series = [];
        for ($i = $days - 1; $i >= 0; $i--) {
            $d = date('Y-m-d', strtotime("-{$i} days"));
            $row = $byDay[$d] ?? null;
            $series[] = [
                'date' => $d,
                'active_ms' => (int)($row['ms'] ?? 0),
                'clicks' => (int)($row['clicks'] ?? 0),
                'active_users' => (int)($row['users'] ?? 0),
            ];
        }

        $activeUsersStmt = $pdo->prepare("SELECT COUNT(DISTINCT user_id) FROM user_activity_daily WHERE day >= date('now', :off)");
        $activeUsersStmt->execute([':off' => '-' . ($days - 1) . ' days']);

        // "Сегодня vs вчера" — всегда точное сравнение по календарным суткам,
        // независимо от выбранного диапазона выше.
        $todayRow = $pdo->query("SELECT COALESCE(SUM(active_ms),0) ms, COALESCE(SUM(clicks),0) c FROM user_activity_daily WHERE day = date('now')")->fetch();
        $yestRow = $pdo->query("SELECT COALESCE(SUM(active_ms),0) ms, COALESCE(SUM(clicks),0) c FROM user_activity_daily WHERE day = date('now','-1 day')")->fetch();
        $todayMs = (int)$todayRow['ms']; $yestMs = (int)$yestRow['ms'];
        $todayClicks = (int)$todayRow['c']; $yestClicks = (int)$yestRow['c'];
        $pctDelta = static function (int $today, int $yesterday): float {
            if ($yesterday > 0) return round((($today - $yesterday) / $yesterday) * 100, 1);
            return $today > 0 ? 100.0 : 0.0;
        };

        $onlineNow = (int)$pdo->query("SELECT COUNT(*) FROM users WHERE last_active_at > datetime('now','-2 minutes')")->fetchColumn();

        json_out([
            'range' => $range,
            'series' => $series,
            'total_active_ms' => array_sum(array_column($series, 'active_ms')),
            'total_clicks' => array_sum(array_column($series, 'clicks')),
            'active_users' => (int)$activeUsersStmt->fetchColumn(),
            'today' => ['active_ms' => $todayMs, 'clicks' => $todayClicks],
            'yesterday' => ['active_ms' => $yestMs, 'clicks' => $yestClicks],
            'delta_active_ms_pct' => $pctDelta($todayMs, $yestMs),
            'delta_clicks_pct' => $pctDelta($todayClicks, $yestClicks),
            'online_now' => $onlineNow,
        ]);
        break;
    }

    case 'activity_users': {
        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        $days = admin_range_days((string)($body['range'] ?? '7d'));
        $stmt = $pdo->prepare(
            "SELECT u.id, u.shop_name, u.email, u.avatar, u.last_active_at, u.last_screen,
                    COALESCE(SUM(a.active_ms),0) AS active_ms, COALESCE(SUM(a.clicks),0) AS clicks
               FROM users u
               LEFT JOIN user_activity_daily a ON a.user_id = u.id AND a.day >= date('now', :off)
              GROUP BY u.id
              ORDER BY active_ms DESC, u.id ASC
              LIMIT 300"
        );
        $stmt->execute([':off' => '-' . ($days - 1) . ' days']);
        json_out(['users' => array_map(static fn($r) => [
            'id' => (int)$r['id'],
            'shop_name' => $r['shop_name'],
            'email' => $r['email'],
            'avatar' => $r['avatar'],
            'last_active_at' => $r['last_active_at'],
            'current_screen' => $r['last_screen'],
            'active_ms' => (int)$r['active_ms'],
            'clicks' => (int)$r['clicks'],
        ], $stmt->fetchAll())]);
        break;
    }

    case 'activity_user_detail': {
        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        $uid = (int)($body['user_id'] ?? 0);
        if ($uid <= 0) json_out(['error' => 'Неверные параметры'], 422);
        $days = admin_range_days((string)($body['range'] ?? '30d'));

        $u = $pdo->prepare('SELECT id, shop_name, email, avatar, last_active_at, last_screen FROM users WHERE id = :id');
        $u->execute([':id' => $uid]);
        $user = $u->fetch();
        if (!$user) json_out(['error' => 'Пользователь не найден'], 404);

        $stmt = $pdo->prepare("SELECT day, active_ms, clicks FROM user_activity_daily WHERE user_id = :uid AND day >= date('now', :off)");
        $stmt->execute([':uid' => $uid, ':off' => '-' . ($days - 1) . ' days']);
        $byDay = [];
        foreach ($stmt->fetchAll() as $r) $byDay[$r['day']] = $r;

        $series = [];
        for ($i = $days - 1; $i >= 0; $i--) {
            $d = date('Y-m-d', strtotime("-{$i} days"));
            $row = $byDay[$d] ?? null;
            $series[] = ['date' => $d, 'active_ms' => (int)($row['active_ms'] ?? 0), 'clicks' => (int)($row['clicks'] ?? 0)];
        }

        // Персональная разбивка — на что именно кликает и на каких экранах
        // проводит время этот конкретный пользователь (в отличие от общего
        // среза в track_stats, который считает всех пользователей вместе).
        $clicksStmt = $pdo->prepare(
            'SELECT target, count FROM user_click_stats WHERE user_id = :uid ORDER BY count DESC LIMIT 15'
        );
        $clicksStmt->execute([':uid' => $uid]);
        $screensStmt = $pdo->prepare(
            'SELECT screen, total_ms FROM user_screen_time WHERE user_id = :uid ORDER BY total_ms DESC LIMIT 15'
        );
        $screensStmt->execute([':uid' => $uid]);

        json_out([
            'user' => $user,
            'series' => $series,
            'total_active_ms' => array_sum(array_column($series, 'active_ms')),
            'total_clicks' => array_sum(array_column($series, 'clicks')),
            'clicks' => array_map(static fn($r) => ['target' => $r['target'], 'count' => (int)$r['count']], $clicksStmt->fetchAll()),
            'screens' => array_map(static fn($r) => ['screen' => $r['screen'], 'total_ms' => (int)$r['total_ms']], $screensStmt->fetchAll()),
        ]);
        break;
    }

    case 'ai_feedback_list': {
        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        $filter = (string)($body['rating'] ?? 'all');
        $where = "a.role = 'assistant' AND a.rating IS NOT NULL";
        $params = [];
        if ($filter === '1' || $filter === '-1') {
            $where .= ' AND a.rating = :r';
            $params[':r'] = (int)$filter;
        }
        $stmt = $pdo->prepare(
            "SELECT a.id, a.user_id, a.content AS answer, a.thinking, a.source, a.rating, a.rating_comment, a.created_at,
                    u.shop_name, u.email,
                    (SELECT content FROM ai_chat_messages q
                      WHERE q.user_id = a.user_id AND q.role = 'user' AND q.id < a.id
                      ORDER BY q.id DESC LIMIT 1) AS question
               FROM ai_chat_messages a
               JOIN users u ON u.id = a.user_id
              WHERE $where
              ORDER BY a.id DESC
              LIMIT 100"
        );
        $stmt->execute($params);
        $counts = $pdo->query("SELECT SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) up, SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) down FROM ai_chat_messages WHERE role = 'assistant'")->fetch();
        json_out([
            'items' => $stmt->fetchAll(),
            'counts' => ['up' => (int)($counts['up'] ?? 0), 'down' => (int)($counts['down'] ?? 0)],
        ]);
        break;
    }

    case 'ai_chat_thread': {
        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        $uid = (int)($body['user_id'] ?? 0);
        if ($uid <= 0) json_out(['error' => 'Неверные параметры'], 422);
        $stmt = $pdo->prepare('SELECT * FROM (SELECT * FROM ai_chat_messages WHERE user_id = :uid ORDER BY id DESC LIMIT 200) ORDER BY id ASC');
        $stmt->execute([':uid' => $uid]);
        $u = $pdo->prepare('SELECT id, shop_name, email FROM users WHERE id = :id');
        $u->execute([':id' => $uid]);
        json_out(['messages' => $stmt->fetchAll(), 'user' => $u->fetch() ?: null]);
        break;
    }

    case 'story_create': {
        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        $videoUrl = trim((string)($body['video_url'] ?? ''));
        $caption = trim((string)($body['caption'] ?? ''));
        $durationH = (int)($body['duration_h'] ?? 24);
        if ($videoUrl === '' || !upload_url_valid($videoUrl)) {
            json_out(['error' => 'Не передано видео'], 422);
        }
        if (!in_array($durationH, [24, 48], true)) {
            $durationH = 24;
        }
        if (mb_strlen($caption) > 300) {
            $caption = mb_substr($caption, 0, 300);
        }
        $stmt = $pdo->prepare(
            "INSERT INTO stories (video_url, caption, duration_h, expires_at)
             VALUES (:v, :c, :d, datetime('now', :off))"
        );
        $stmt->execute([':v' => $videoUrl, ':c' => $caption !== '' ? $caption : null, ':d' => $durationH, ':off' => "+{$durationH} hours"]);
        $id = (int)$pdo->lastInsertId();
        $row = $pdo->prepare('SELECT * FROM stories WHERE id = :id');
        $row->execute([':id' => $id]);
        json_out(['ok' => true, 'story' => $row->fetch()], 201);
        break;
    }

    case 'story_list': {
        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        $stories = $pdo->query('SELECT * FROM stories ORDER BY id DESC LIMIT 100')->fetchAll();

        $reactCounts = $pdo->query(
            "SELECT message_id AS story_id, emoji, COUNT(*) AS cnt
               FROM message_reactions WHERE scope = 'story' GROUP BY message_id, emoji"
        )->fetchAll();
        $byStory = [];
        foreach ($reactCounts as $r) {
            $sid = (int)$r['story_id'];
            $byStory[$sid]['counts'][(string)$r['emoji']] = (int)$r['cnt'];
            $byStory[$sid]['total'] = ($byStory[$sid]['total'] ?? 0) + (int)$r['cnt'];
        }
        $replyCounts = $pdo->query(
            "SELECT story_id, COUNT(*) AS cnt FROM support_messages WHERE story_id IS NOT NULL GROUP BY story_id"
        )->fetchAll();
        $repliesByStory = [];
        foreach ($replyCounts as $r) {
            $repliesByStory[(int)$r['story_id']] = (int)$r['cnt'];
        }

        json_out(['stories' => array_map(static function ($s) use ($byStory, $repliesByStory): array {
            $id = (int)$s['id'];
            return [
                'id' => $id,
                'video_url' => $s['video_url'],
                'caption' => $s['caption'],
                'duration_h' => (int)$s['duration_h'],
                'active' => (bool)$s['active'],
                'created_at' => $s['created_at'],
                'expires_at' => $s['expires_at'],
                'reaction_counts' => (object)($byStory[$id]['counts'] ?? []),
                'reaction_total' => (int)($byStory[$id]['total'] ?? 0),
                'reply_count' => $repliesByStory[$id] ?? 0,
            ];
        }, $stories)]);
        break;
    }

    case 'story_delete': {
        $pdo = db();
        if (!$pdo) json_out(['error' => 'Нет базы данных'], 503);
        $id = (int)($body['id'] ?? 0);
        if ($id <= 0) json_out(['error' => 'Не передан id истории'], 422);
        $stmt = $pdo->prepare('SELECT video_url FROM stories WHERE id = :id');
        $stmt->execute([':id' => $id]);
        $row = $stmt->fetch();
        if (!$row) json_out(['error' => 'История не найдена'], 404);

        $pdo->prepare('DELETE FROM stories WHERE id = :id')->execute([':id' => $id]);
        $pdo->prepare("DELETE FROM message_reactions WHERE scope = 'story' AND message_id = :id")->execute([':id' => $id]);

        // Файл лучше всего удалять — но не критично, если не получится (тихо
        // молчим): чат-цитаты в support_messages.story_id уже просто увидят
        // null через LEFT JOIN и покажут "история удалена".
        if (upload_url_valid((string)$row['video_url'])) {
            @unlink(__DIR__ . '/../../' . ltrim((string)$row['video_url'], '/'));
        }
        json_out(['ok' => true]);
        break;
    }

    default:
        json_out(['error' => 'Неизвестное действие'], 400);
}
