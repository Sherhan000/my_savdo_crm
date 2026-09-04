<?php

define('SHOP_FREE_SLOTS', 4);
define('SHOP_SLOTS_PER_BLOCK', 5);
define('SHOP_SLOT_BLOCK_PRICE', 20);

function shop_slot_total(array $user): int {
    return SHOP_FREE_SLOTS + SHOP_SLOTS_PER_BLOCK * (int)($user['employee_slots_purchased'] ?? 0);
}

function shop_active_employee_count(PDO $pdo, int $shopUserId): int {
    $stmt = $pdo->prepare("SELECT COUNT(*) FROM shop_employees WHERE shop_user_id = :sid AND status = 'active'");
    $stmt->execute([':sid' => $shopUserId]);
    return (int)$stmt->fetchColumn();
}

function shop_username_valid(string $username): bool {
    return (bool)preg_match('/^[a-z0-9_]{3,24}$/', $username);
}

function shop_generate_login_id(PDO $pdo): string {
    $alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    do {
        $code = '';
        for ($i = 0; $i < 8; $i++) {
            $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }
        $stmt = $pdo->prepare('SELECT 1 FROM shop_employees WHERE login_id = :lid');
        $stmt->execute([':lid' => $code]);
        $exists = (bool)$stmt->fetchColumn();
    } while ($exists);
    return $code;
}

function shop_generate_password(): string {
    $alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    $password = '';
    for ($i = 0; $i < 10; $i++) {
        $password .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    }
    return $password;
}

function require_owner_session(): void {
    if (!empty($_SESSION['employee_id'])) {
        json_fail('Недоступно для сотрудников — нужен вход владельца магазина', 403);
    }
}

function shop_employee_row_out(array $row): array {
    return [
        'id' => (int)$row['id'],
        'display_name' => $row['display_name'],
        'login_id' => $row['login_id'],
        'status' => $row['status'],
        'created_at' => $row['created_at'],
        'decided_at' => $row['decided_at'] ?? null,
    ];
}
