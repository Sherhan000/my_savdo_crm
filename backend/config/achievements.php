<?php

declare(strict_types=1);

// «Путь продавца» — геймификация роста магазина. Каждая ачивка проверяется
// живыми данными (achievements_stats), а не отдельным счётчиком событий —
// это исключает рассинхрон и не требует ловить каждое действие в коде.
// XP суммируется в уровень (SELLER_LEVELS ниже).
const SELLER_ACHIEVEMENTS = [
    ['key' => 'first_client',        'title' => 'Первая заявка',           'desc' => 'Появился первый клиент в воронке',        'icon' => 'icon-target',  'xp' => 10],
    ['key' => 'telegram_connected',  'title' => 'Подключили Telegram',     'desc' => 'Бот принимает заявки прямо в CRM',        'icon' => 'icon-plane',   'xp' => 15],
    ['key' => 'instagram_connected', 'title' => 'Подключили Instagram',    'desc' => 'Directory-сообщения летят в CRM',          'icon' => 'icon-camera',  'xp' => 15],
    ['key' => 'clients_10',          'title' => '10 клиентов',             'desc' => 'Воронка начала расти',                    'icon' => 'icon-users',   'xp' => 20],
    ['key' => 'first_sale',          'title' => 'Первая продажа',          'desc' => 'Клиент дошёл до оплаты',                  'icon' => 'icon-bag',     'xp' => 25],
    ['key' => 'month_alive',         'title' => 'Магазин прожил месяц',    'desc' => 'Вы с нами уже 30 дней',                   'icon' => 'icon-clock',   'xp' => 15],
    ['key' => 'employee_added',      'title' => 'Первый сотрудник',        'desc' => 'Команда начала расти',                    'icon' => 'icon-heart',   'xp' => 15],
    ['key' => 'tg_group_connected',  'title' => 'Telegram-группа',         'desc' => 'Общаетесь с клиентами группой',           'icon' => 'icon-message', 'xp' => 15],
    ['key' => 'paid_plan',           'title' => 'Платный тариф',           'desc' => 'Перешли на Стандарт или Бизнес',          'icon' => 'icon-star',    'xp' => 25],
    ['key' => 'clients_50',          'title' => '50 клиентов',             'desc' => 'Серьёзная база клиентов',                 'icon' => 'icon-trend',   'xp' => 30],
    ['key' => 'clients_100',         'title' => '100 клиентов',            'desc' => 'Настоящий мастер продаж',                 'icon' => 'icon-sparkle', 'xp' => 40],
    ['key' => 'ai_helper_10',        'title' => 'ИИ-помощник',             'desc' => 'Бот сам ответил клиенту в Telegram 10 раз',   'icon' => 'icon-lime', 'xp' => 15],
    ['key' => 'ai_helper_50',        'title' => 'Правая рука',             'desc' => 'Бот сам ответил клиенту в Telegram 50 раз',   'icon' => 'icon-lime', 'xp' => 25],
    ['key' => 'ai_helper_200',       'title' => 'ИИ-магазин',              'desc' => 'Бот сам ответил клиенту в Telegram 200 раз',  'icon' => 'icon-lime', 'xp' => 40],
];

// Сколько минут живого времени в среднем экономит один автоответ ИИ клиенту
// (набрать + отправить вручную) — грубая, но честная оценка для геймификации,
// не претендует на точность.
const AI_HELPER_MINUTES_PER_REPLY = 2;

const SELLER_LEVELS = [
    ['min' => 0,   'title' => 'Новичок'],
    ['min' => 20,  'title' => 'Начинающий продавец'],
    ['min' => 50,  'title' => 'Растущий продавец'],
    ['min' => 100, 'title' => 'Опытный продавец'],
    ['min' => 170, 'title' => 'Мастер продаж'],
    ['min' => 225, 'title' => 'Легенда MySavdo'],
];

function achievements_total_xp(): int {
    return array_sum(array_column(SELLER_ACHIEVEMENTS, 'xp'));
}

// Живые данные для проверки условий — один заход в базу на каждую сущность,
// не на каждую ачивку.
function achievements_stats(PDO $pdo, int $userId, array $user): array {
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM clients WHERE user_id = :uid');
    $stmt->execute([':uid' => $userId]);
    $clientsTotal = (int)$stmt->fetchColumn();

    $stmt = $pdo->prepare("SELECT COUNT(*) FROM clients WHERE user_id = :uid AND stage IN ('pay','done')");
    $stmt->execute([':uid' => $userId]);
    $clientsSold = (int)$stmt->fetchColumn();

    $stmt = $pdo->prepare('SELECT COUNT(*) FROM telegram_bots WHERE user_id = :uid');
    $stmt->execute([':uid' => $userId]);
    $telegramConnected = (int)$stmt->fetchColumn() > 0;

    $stmt = $pdo->prepare('SELECT COUNT(*) FROM instagram_accounts WHERE user_id = :uid');
    $stmt->execute([':uid' => $userId]);
    $instagramConnected = (int)$stmt->fetchColumn() > 0;

    $stmt = $pdo->prepare("SELECT COUNT(*) FROM shop_employees WHERE shop_user_id = :uid AND status = 'active'");
    $stmt->execute([':uid' => $userId]);
    $employeesCount = (int)$stmt->fetchColumn();

    $stmt = $pdo->prepare('SELECT COUNT(*) FROM telegram_groups WHERE user_id = :uid AND active = 1');
    $stmt->execute([':uid' => $userId]);
    $tgGroupsCount = (int)$stmt->fetchColumn();

    $stmt = $pdo->prepare("SELECT COUNT(*) FROM user_plans WHERE user_id = :uid AND plan IN ('standard','business')");
    $stmt->execute([':uid' => $userId]);
    $paidPlanEver = (int)$stmt->fetchColumn() > 0;

    $stmt = $pdo->prepare(
        "SELECT COUNT(*) FROM messages m JOIN clients c ON c.id = m.client_id
          WHERE c.user_id = :uid AND m.by_ai = 1"
    );
    $stmt->execute([':uid' => $userId]);
    $aiAutoReplies = (int)$stmt->fetchColumn();

    $createdAt = (string)($user['created_at'] ?? '');
    $shopAgeDays = 0;
    if ($createdAt !== '') {
        $created = strtotime($createdAt . ' UTC');
        if ($created !== false) {
            $shopAgeDays = (int)floor((time() - $created) / 86400);
        }
    }

    return [
        'clients_total'       => $clientsTotal,
        'clients_sold'        => $clientsSold,
        'telegram_connected'  => $telegramConnected,
        'instagram_connected' => $instagramConnected,
        'employees_count'     => $employeesCount,
        'tg_groups_count'     => $tgGroupsCount,
        'paid_plan_ever'      => $paidPlanEver,
        'shop_age_days'       => $shopAgeDays,
        'ai_auto_replies'     => $aiAutoReplies,
    ];
}

function achievements_is_met(string $key, array $stats): bool {
    switch ($key) {
        case 'first_client':        return $stats['clients_total'] >= 1;
        case 'telegram_connected':  return $stats['telegram_connected'];
        case 'instagram_connected': return $stats['instagram_connected'];
        case 'clients_10':          return $stats['clients_total'] >= 10;
        case 'first_sale':          return $stats['clients_sold'] >= 1;
        case 'month_alive':         return $stats['shop_age_days'] >= 30;
        case 'employee_added':      return $stats['employees_count'] >= 1;
        case 'tg_group_connected':  return $stats['tg_groups_count'] >= 1;
        case 'paid_plan':           return $stats['paid_plan_ever'];
        case 'clients_50':          return $stats['clients_total'] >= 50;
        case 'clients_100':         return $stats['clients_total'] >= 100;
        case 'ai_helper_10':        return $stats['ai_auto_replies'] >= 10;
        case 'ai_helper_50':        return $stats['ai_auto_replies'] >= 50;
        case 'ai_helper_200':       return $stats['ai_auto_replies'] >= 200;
        default:                    return false;
    }
}

// "1 ч 20 мин" / "45 мин" — для живого счётчика сэкономленного времени в
// описании ачивок ai_helper_* (см. backend/api/achievements.php).
function achievements_format_minutes(int $minutes): string {
    if ($minutes < 60) {
        return $minutes . ' мин';
    }
    $h = intdiv($minutes, 60);
    $m = $minutes % 60;
    return $m > 0 ? "{$h} ч {$m} мин" : "{$h} ч";
}

function achievements_level_for_xp(int $xp): array {
    $current = SELLER_LEVELS[0];
    $currentIndex = 0;
    foreach (SELLER_LEVELS as $i => $lvl) {
        if ($xp >= $lvl['min']) {
            $current = $lvl;
            $currentIndex = $i;
        }
    }
    $next = SELLER_LEVELS[$currentIndex + 1] ?? null;
    return [
        'index' => $currentIndex + 1,
        'count' => count(SELLER_LEVELS),
        'title' => $current['title'],
        'xp' => $xp,
        'next_title' => $next['title'] ?? null,
        'next_min' => $next['min'] ?? null,
        'progress' => $next ? round((($xp - $current['min']) / ($next['min'] - $current['min'])) * 100) : 100,
    ];
}
