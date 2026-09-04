<?php

declare(strict_types=1);

// Переключатель между несколькими аккаунтами MySavdo с одного устройства.
// Свой аккаунт + 1 бесплатный дополнительный = 2 всего. Каждый следующий —
// платный слот, оплата вручную (как места сотрудников в shop.php), без
// подписки — разовая доплата за слот.
define('ACCOUNT_SWITCH_FREE_EXTRA', 1);
define('ACCOUNT_SWITCH_SLOT_PRICE', 25);

// Сколько ещё чужих аккаунтов можно подключить к переключателю (не считая
// самого себя).
function account_switch_slot_total(array $user): int {
    return ACCOUNT_SWITCH_FREE_EXTRA + (int)($user['account_slots_purchased'] ?? 0);
}

function account_switch_used_slots(PDO $pdo, int $userId): int {
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM linked_accounts WHERE user_id = :uid AND counts_toward_quota = 1');
    $stmt->execute([':uid' => $userId]);
    return (int)$stmt->fetchColumn();
}
