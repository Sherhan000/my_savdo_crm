<?php
declare(strict_types=1);

const PLANS_META = [
    'demo'     => ['title' => 'Демо',     'price' => 0],
    'standard' => ['title' => 'Стандарт', 'price' => 79],
    'business' => ['title' => 'Бизнес',   'price' => 179],
];

const PLAN_FEATURES = [

    'none' => [
        'ai_chat' => false,
        'ai_daily_limit' => 0,
        'ai_reply' => false,
        'ai_auto' => false,
        'analytics_full' => false,
        'socials_limit' => 0,
        'clients_limit' => 0,
        'can_send' => false,
        'panel_funnel' => true, 'panel_analytics' => true, 'panel_clients' => true, 'panel_plan' => true,
    ],
    'demo' => [
        'ai_chat' => true,
        'ai_daily_limit' => 15,
        'ai_reply' => true,
        'ai_auto' => false,
        'analytics_full' => false,
        'socials_limit' => 1,
        'clients_limit' => 100,
        'can_send' => true,
        'panel_funnel' => true, 'panel_analytics' => true, 'panel_clients' => true, 'panel_plan' => true,
    ],
    'standard' => [
        'ai_chat' => true,
        'ai_daily_limit' => 50,
        'ai_reply' => true,
        'ai_auto' => false,
        'analytics_full' => true,
        'socials_limit' => 1,
        'clients_limit' => null,
        'can_send' => true,
        'panel_funnel' => true, 'panel_analytics' => true, 'panel_clients' => true, 'panel_plan' => true,
    ],
    'business' => [
        'ai_chat' => true,
        'ai_daily_limit' => null,
        'ai_reply' => true,
        'ai_auto' => true,
        'analytics_full' => true,
        'socials_limit' => 2,
        'clients_limit' => null,
        'can_send' => true,
        'panel_funnel' => true, 'panel_analytics' => true, 'panel_clients' => true, 'panel_plan' => true,
    ],
];

const FEATURE_KEYS = [
    'ai_chat' => 'bool',
    'ai_daily_limit' => 'int_or_null',
    'ai_reply' => 'bool',
    'ai_auto' => 'bool',
    'analytics_full' => 'bool',
    'socials_limit' => 'int',
    'clients_limit' => 'int_or_null',
    'can_send' => 'bool',

    'panel_funnel' => 'bool',
    'panel_analytics' => 'bool',
    'panel_clients' => 'bool',
    'panel_plan' => 'bool',
];

function user_active_plan(PDO $pdo, int $userId): string {
    $stmt = $pdo->prepare("SELECT plan FROM user_plans WHERE user_id = :uid AND status = 'active' LIMIT 1");
    $stmt->execute([':uid' => $userId]);
    $plan = $stmt->fetchColumn();
    return ($plan && isset(PLAN_FEATURES[$plan])) ? (string)$plan : 'none';
}

function user_features(PDO $pdo, int $userId): array {
    $plan = user_active_plan($pdo, $userId);
    $features = PLAN_FEATURES[$plan];

    $stmt = $pdo->prepare('SELECT feature_overrides FROM users WHERE id = :id');
    $stmt->execute([':id' => $userId]);
    $raw = $stmt->fetchColumn();
    if ($raw) {
        $ov = json_decode((string)$raw, true);
        if (is_array($ov)) {
            foreach ($ov as $k => $v) {
                if (!isset(FEATURE_KEYS[$k])) continue;
                $type = FEATURE_KEYS[$k];
                if ($type === 'bool') $features[$k] = (bool)$v;
                elseif ($type === 'int') $features[$k] = max(0, (int)$v);
                else $features[$k] = $v === null ? null : max(0, (int)$v);
            }
        }
    }
    $features['plan'] = $plan;
    return $features;
}

function ai_used_today(PDO $pdo, int $userId): int {
    $stmt = $pdo->prepare("SELECT used FROM ai_usage WHERE user_id = :uid AND day = date('now')");
    $stmt->execute([':uid' => $userId]);
    return (int)($stmt->fetchColumn() ?: 0);
}

function ai_bump_usage(PDO $pdo, int $userId): void {
    $pdo->prepare("INSERT INTO ai_usage (user_id, day, used) VALUES (:uid, date('now'), 1)
                   ON CONFLICT(user_id, day) DO UPDATE SET used = used + 1")
        ->execute([':uid' => $userId]);
}
