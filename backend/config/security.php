<?php
declare(strict_types=1);

function client_ip(): string {

    $remote = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';

    if (getenv('TRUST_PROXY_HEADERS') === '1') {
        $xf = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
        if ($xf !== '') {
            $first = trim(explode(',', $xf)[0]);
            if (filter_var($first, FILTER_VALIDATE_IP)) {
                return $first;
            }
        }
    }
    return $remote;
}

function rate_limit_guard(string $action, string $identifier, int $maxAttempts = 7, int $blockMinutes = 15): void {
    $pdo = function_exists('db') ? db() : null;
    if (!$pdo) {
        return;
    }
    $key = $action . '|' . client_ip() . '|' . mb_strtolower($identifier);
    $stmt = $pdo->prepare('SELECT attempts, blocked_until FROM login_attempts WHERE key_id = :k');
    $stmt->execute([':k' => $key]);
    $row = $stmt->fetch();
    if ($row && $row['blocked_until'] !== null) {
        $blockedUntil = strtotime((string)$row['blocked_until'] . ' UTC');
        if ($blockedUntil !== false && $blockedUntil > time()) {
            $mins = (int)ceil(($blockedUntil - time()) / 60);
            json_fail("Слишком много неудачных попыток. Попробуйте снова через {$mins} мин.", 429);
        }
    }
}

function rate_limit_fail(string $action, string $identifier, int $maxAttempts = 7, int $blockMinutes = 15): void {
    $pdo = function_exists('db') ? db() : null;
    if (!$pdo) {
        return;
    }
    $key = $action . '|' . client_ip() . '|' . mb_strtolower($identifier);
    $pdo->prepare("INSERT INTO login_attempts (key_id, attempts, last_attempt_at)
                    VALUES (:k, 1, datetime('now'))
                    ON CONFLICT(key_id) DO UPDATE SET
                      attempts = CASE
                        WHEN datetime(last_attempt_at, '+30 minutes') < datetime('now') THEN 1
                        ELSE attempts + 1 END,
                      last_attempt_at = datetime('now')")
        ->execute([':k' => $key]);

    $stmt = $pdo->prepare('SELECT attempts FROM login_attempts WHERE key_id = :k');
    $stmt->execute([':k' => $key]);
    $attempts = (int)$stmt->fetchColumn();
    if ($attempts >= $maxAttempts) {
        $pdo->prepare("UPDATE login_attempts SET blocked_until = datetime('now', '+' || :m || ' minutes') WHERE key_id = :k")
            ->execute([':m' => $blockMinutes, ':k' => $key]);
    }
}

function rate_limit_clear(string $action, string $identifier): void {
    $pdo = function_exists('db') ? db() : null;
    if (!$pdo) {
        return;
    }
    $key = $action . '|' . client_ip() . '|' . mb_strtolower($identifier);
    $pdo->prepare('DELETE FROM login_attempts WHERE key_id = :k')->execute([':k' => $key]);
}

function csrf_token(): string {
    if (session_status() !== PHP_SESSION_ACTIVE) {
        start_session();
    }
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf_token'];
}

function csrf_verify(): void {
    $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    $known = $_SESSION['csrf_token'] ?? '';
    if ($known === '' || $sent === '' || !hash_equals($known, $sent)) {
        json_fail('Сессия устарела — обновите страницу и попробуйте снова', 403);
    }
}
