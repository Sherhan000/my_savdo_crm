<?php

require_once __DIR__ . '/db.php';

function store_using_db(): bool {
    return db() !== null;
}

function store_find_user_by_email(string $email): ?array {
    $email = strtolower($email);
    if ($pdo = db()) {
        $stmt = $pdo->prepare('SELECT * FROM users WHERE lower(email) = :email LIMIT 1');
        $stmt->execute([':email' => $email]);
        $row = $stmt->fetch();
        return $row ?: null;
    }
    foreach (store_read_users_json() as $u) {
        if (strtolower($u['email']) === $email) {
            return $u;
        }
    }
    return null;
}

function store_find_user_by_id(int $id): ?array {
    if ($pdo = db()) {
        $stmt = $pdo->prepare('SELECT * FROM users WHERE id = :id LIMIT 1');
        $stmt->execute([':id' => $id]);
        $row = $stmt->fetch();
        return $row ?: null;
    }
    foreach (store_read_users_json() as $u) {
        if ((int)$u['id'] === $id) {
            return $u;
        }
    }
    return null;
}

function store_find_user_by_google_id(string $googleId): ?array {
    if ($pdo = db()) {
        $stmt = $pdo->prepare('SELECT * FROM users WHERE google_id = :gid LIMIT 1');
        $stmt->execute([':gid' => $googleId]);
        $row = $stmt->fetch();
        return $row ?: null;
    }
    foreach (store_read_users_json() as $u) {
        if (($u['google_id'] ?? null) === $googleId) {
            return $u;
        }
    }
    return null;
}

function store_find_user_by_facebook_id(string $facebookId): ?array {
    if ($pdo = db()) {
        $stmt = $pdo->prepare('SELECT * FROM users WHERE facebook_id = :fid LIMIT 1');
        $stmt->execute([':fid' => $facebookId]);
        $row = $stmt->fetch();
        return $row ?: null;
    }
    foreach (store_read_users_json() as $u) {
        if (($u['facebook_id'] ?? null) === $facebookId) {
            return $u;
        }
    }
    return null;
}

function store_find_user_by_shop_username(string $shopUsername): ?array {
    if ($pdo = db()) {
        $stmt = $pdo->prepare('SELECT * FROM users WHERE shop_username = :su LIMIT 1');
        $stmt->execute([':su' => $shopUsername]);
        $row = $stmt->fetch();
        return $row ?: null;
    }
    foreach (store_read_users_json() as $u) {
        if (($u['shop_username'] ?? null) === $shopUsername) {
            return $u;
        }
    }
    return null;
}

function store_find_user_by_telegram_id(string $telegramId): ?array {
    if ($pdo = db()) {
        $stmt = $pdo->prepare('SELECT * FROM users WHERE telegram_id = :tid LIMIT 1');
        $stmt->execute([':tid' => $telegramId]);
        $row = $stmt->fetch();
        return $row ?: null;
    }
    foreach (store_read_users_json() as $u) {
        if (($u['telegram_id'] ?? null) === $telegramId) {
            return $u;
        }
    }
    return null;
}

function store_username_valid(string $username): bool {
    return (bool)preg_match('/^[a-z0-9_]{3,24}$/', $username);
}

function store_find_user_by_username(string $username): ?array {
    $username = strtolower($username);
    if ($pdo = db()) {
        $stmt = $pdo->prepare('SELECT * FROM users WHERE username = :u LIMIT 1');
        $stmt->execute([':u' => $username]);
        $row = $stmt->fetch();
        return $row ?: null;
    }
    foreach (store_read_users_json() as $u) {
        if (($u['username'] ?? null) === $username) {
            return $u;
        }
    }
    return null;
}

function store_create_user(string $shopName, string $email, ?string $passwordHash, array $extra = []): array {
    $email = strtolower($email);
    if ($pdo = db()) {
        $username = $extra['username'] ?? db_generate_username($pdo, $shopName !== '' ? $shopName : explode('@', $email)[0]);
        $stmt = $pdo->prepare('INSERT INTO users (shop_name, email, password_hash, google_id, facebook_id, telegram_id, avatar, plan, password_set, is_guest, username, phone) VALUES (:shop_name, :email, :password_hash, :google_id, :facebook_id, :telegram_id, :avatar, :plan, :password_set, :is_guest, :username, :phone)');
        $stmt->execute([
            ':shop_name' => $shopName !== '' ? $shopName : 'Мой магазин',
            ':email' => $email,
            ':password_hash' => $passwordHash,
            ':google_id' => $extra['google_id'] ?? null,
            ':facebook_id' => $extra['facebook_id'] ?? null,
            ':telegram_id' => $extra['telegram_id'] ?? null,
            ':avatar' => $extra['avatar'] ?? null,
            ':plan' => $extra['plan'] ?? 'demo',
            ':password_set' => ($extra['password_set'] ?? true) ? 1 : 0,
            ':is_guest' => ($extra['is_guest'] ?? false) ? 1 : 0,
            ':username' => $username,
            ':phone' => $extra['phone'] ?? null,
        ]);
        $id = (int)$pdo->lastInsertId();
        return store_find_user_by_id($id);
    }

    $users = store_read_users_json();
    $maxId = 0;
    foreach ($users as $u) {
        $maxId = max($maxId, (int)$u['id']);
    }
    $user = [
        'id' => $maxId + 1,
        'shop_name' => $shopName !== '' ? $shopName : 'Мой магазин',
        'email' => $email,
        'password_hash' => $passwordHash,
        'google_id' => $extra['google_id'] ?? null,
        'facebook_id' => $extra['facebook_id'] ?? null,
        'telegram_id' => $extra['telegram_id'] ?? null,
        'avatar' => $extra['avatar'] ?? null,
        'plan' => $extra['plan'] ?? 'demo',
        'password_set' => ($extra['password_set'] ?? true) ? 1 : 0,
        'is_guest' => ($extra['is_guest'] ?? false) ? 1 : 0,
        'username' => $extra['username'] ?? ($shopName !== '' ? $shopName : explode('@', $email)[0]),
        'phone' => $extra['phone'] ?? null,
        'created_at' => date('c'),
    ];
    $users[] = $user;
    store_write_users_json($users);
    return $user;
}

function store_update_user_google_link(int $id, string $googleId, ?string $avatar): void {
    if ($pdo = db()) {
        $stmt = $pdo->prepare('UPDATE users SET google_id = :gid, avatar = COALESCE(:avatar, avatar) WHERE id = :id');
        $stmt->execute([':gid' => $googleId, ':avatar' => $avatar, ':id' => $id]);
        return;
    }
    $users = store_read_users_json();
    foreach ($users as &$u) {
        if ((int)$u['id'] === $id) {
            $u['google_id'] = $googleId;
            if ($avatar) $u['avatar'] = $avatar;
        }
    }
    unset($u);
    store_write_users_json($users);
}

function store_update_user_facebook_link(int $id, string $facebookId, ?string $avatar): void {
    if ($pdo = db()) {
        $stmt = $pdo->prepare('UPDATE users SET facebook_id = :fid, avatar = COALESCE(:avatar, avatar) WHERE id = :id');
        $stmt->execute([':fid' => $facebookId, ':avatar' => $avatar, ':id' => $id]);
        return;
    }
    $users = store_read_users_json();
    foreach ($users as &$u) {
        if ((int)$u['id'] === $id) {
            $u['facebook_id'] = $facebookId;
            if ($avatar) $u['avatar'] = $avatar;
        }
    }
    unset($u);
    store_write_users_json($users);
}

function store_mark_user_verified(int $userId): void {
    $pdo = db();
    if (!$pdo) return;
    $pdo->prepare("UPDATE users SET is_verified = 1, email_verified_at = datetime('now') WHERE id = :id")->execute([':id' => $userId]);
}

function otp_generate_code(): string {
    return str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
}

function otp_create_for_email(string $email, string $code, int $ttlMinutes): void {
    $pdo = db();
    if (!$pdo) return;
    $email = strtolower($email);
    $pdo->prepare('DELETE FROM email_verifications WHERE email = :email')->execute([':email' => $email]);
    $stmt = $pdo->prepare(
        "INSERT INTO email_verifications (email, code_hash, expires_at)
         VALUES (:email, :hash, datetime('now', '+' || :ttl || ' minutes'))"
    );
    $stmt->execute([
        ':email' => $email,
        ':hash' => password_hash($code, PASSWORD_BCRYPT),
        ':ttl' => $ttlMinutes,
    ]);
}

function otp_find_for_email(string $email): ?array {
    $pdo = db();
    if (!$pdo) return null;
    $stmt = $pdo->prepare('SELECT * FROM email_verifications WHERE email = :email ORDER BY id DESC LIMIT 1');
    $stmt->execute([':email' => strtolower($email)]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function otp_bump_attempts(int $id): int {
    $pdo = db();
    if (!$pdo) return 0;
    $pdo->prepare('UPDATE email_verifications SET attempts = attempts + 1 WHERE id = :id')->execute([':id' => $id]);
    $stmt = $pdo->prepare('SELECT attempts FROM email_verifications WHERE id = :id');
    $stmt->execute([':id' => $id]);
    return (int)($stmt->fetchColumn() ?: 0);
}

function otp_delete_for_email(string $email): void {
    $pdo = db();
    if (!$pdo) return;
    $pdo->prepare('DELETE FROM email_verifications WHERE email = :email')->execute([':email' => strtolower($email)]);
}

function store_delete_user(int $id): bool {
    if ($pdo = db()) {
        $stmt = $pdo->prepare('DELETE FROM users WHERE id = :id');
        $stmt->execute([':id' => $id]);
        return $stmt->rowCount() > 0;
    }
    $users = store_read_users_json();
    $filtered = array_values(array_filter($users, fn($u) => (int)$u['id'] !== $id));
    if (count($filtered) === count($users)) {
        return false;
    }
    return store_write_users_json($filtered);
}

function store_public_users(): array {
    $map = function (array $u): array {
        return [
            'id' => (int)$u['id'],
            'shop_name' => $u['shop_name'],
            'email' => $u['email'],
            'plan' => $u['plan'] ?? 'demo',
            'created_at' => $u['created_at'] ?? null,
            'has_google' => !empty($u['google_id']),
            'has_facebook' => !empty($u['facebook_id']),
            'has_telegram' => !empty($u['telegram_id']),
        ];
    };
    if ($pdo = db()) {
        $stmt = $pdo->query('SELECT * FROM users ORDER BY id ASC');
        return array_map($map, $stmt->fetchAll());
    }
    return array_map($map, store_read_users_json());
}

function store_path(): string {
    $dir = __DIR__ . '/../../database';
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
    }
    return $dir . '/users.json';
}

function store_read_users_json(): array {
    $path = store_path();
    if (!file_exists($path)) {
        return [];
    }
    $raw = @file_get_contents($path);
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function store_write_users_json(array $users): bool {
    $path = store_path();
    $tmp = $path . '.tmp';
    $ok = @file_put_contents($tmp, json_encode($users, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    if ($ok === false) {
        return false;
    }
    return @rename($tmp, $path);
}

function settings_read(): array {
    if ($pdo = db()) {
        $stmt = $pdo->query('SELECT key, value FROM settings');
        $out = ['logo' => 'assets/img/logo.png'];
        foreach ($stmt->fetchAll() as $row) {
            $out[$row['key']] = $row['value'];
        }
        return $out;
    }
    $path = settings_path();
    if (!file_exists($path)) {
        return ['logo' => 'assets/img/logo.png'];
    }
    $raw = @file_get_contents($path);
    $data = json_decode((string)$raw, true);
    return is_array($data) ? $data : ['logo' => 'assets/img/logo.png'];
}

function settings_write(array $settings): bool {
    if ($pdo = db()) {
        $stmt = $pdo->prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (:key, :value)');
        $pdo->beginTransaction();
        foreach ($settings as $k => $v) {
            $stmt->execute([':key' => (string)$k, ':value' => (string)$v]);
        }
        $pdo->commit();
        return true;
    }
    $path = settings_path();
    $tmp = $path . '.tmp';
    $ok = @file_put_contents($tmp, json_encode($settings, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    if ($ok === false) {
        return false;
    }
    return @rename($tmp, $path);
}

function settings_path(): string {
    $dir = __DIR__ . '/../../database';
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
    }
    return $dir . '/settings.json';
}

function upload_url_valid(string $url): bool {
    $url = ltrim($url, '/');
    if (!str_starts_with($url, 'assets/img/uploads/')) {
        return false;
    }
    $name = basename($url);
    $path = realpath(__DIR__ . '/../../assets/img/uploads/' . $name);
    $dir = realpath(__DIR__ . '/../../assets/img/uploads');
    return $path !== false && $dir !== false && str_starts_with($path, $dir);
}

function json_body(): array {
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

// Пачкой подтягивает реакции для списка id сообщений одного чата — используется
// при отдаче истории чата (messages.php/dm.php/support.php GET), чтобы не
// делать отдельный запрос на реакции для каждого сообщения.
function reactions_batch(PDO $pdo, string $scope, array $ids, int $userId): array {
    $ids = array_values(array_unique(array_filter(array_map('intval', $ids))));
    if (!$ids) {
        return [];
    }
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $stmt = $pdo->prepare(
        "SELECT message_id, emoji, user_id FROM message_reactions
          WHERE scope = ? AND message_id IN ($placeholders)"
    );
    $stmt->execute(array_merge([$scope], $ids));
    $out = [];
    foreach ($stmt->fetchAll() as $r) {
        $mid = (int)$r['message_id'];
        if (!isset($out[$mid])) {
            $out[$mid] = ['counts' => [], 'mine' => null];
        }
        $emoji = (string)$r['emoji'];
        $out[$mid]['counts'][$emoji] = ($out[$mid]['counts'][$emoji] ?? 0) + 1;
        if ((int)$r['user_id'] === $userId) {
            $out[$mid]['mine'] = $emoji;
        }
    }
    foreach ($out as &$entry) {
        $entry['counts'] = (object)$entry['counts'];
    }
    unset($entry);
    return $out;
}

function start_session(): void {
    if (session_status() !== PHP_SESSION_ACTIVE) {
        $lifetime = 60 * 60 * 24 * 30;

        // Store sessions inside the app's own writable database/ dir instead of
        // relying on the system tmp dir, which is frequently blocked by
        // open_basedir / permissions on shared hosting and would otherwise make
        // sessions silently fail to persist (causing spurious "session expired"
        // errors on every mutating request, e.g. registration).
        $sessionDir = __DIR__ . '/../../database/sessions';
        if (!is_dir($sessionDir)) {
            @mkdir($sessionDir, 0775, true);
        }
        if (is_dir($sessionDir) && is_writable($sessionDir)) {
            session_save_path($sessionDir);
        }

        // Make sure the server-side garbage collector doesn't expire session
        // data long before the cookie itself expires (PHP's default
        // gc_maxlifetime is often ~24 minutes on shared hosts).
        ini_set('session.gc_maxlifetime', (string)$lifetime);

        $isHttps = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
            || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
        session_set_cookie_params([
            'lifetime' => $lifetime,
            'path' => '/',
            'httponly' => true,
            'secure' => $isHttps,
            'samesite' => 'Lax',
        ]);
        session_start();
    }

    if (!empty($_SESSION['employee_id']) && ($pdo = db())) {
        $stmt = $pdo->prepare("SELECT id FROM shop_employees WHERE id = :id AND status = 'active'");
        $stmt->execute([':id' => (int)$_SESSION['employee_id']]);
        if (!$stmt->fetch()) {
            unset($_SESSION['user_id'], $_SESSION['employee_id']);
        }
    }

    if (!empty($_SESSION['user_id'])) {
        touch_presence((int)$_SESSION['user_id']);
    }
}

// Отмечает пользователя "в сети" — вызывается на каждый авторизованный запрос
// (start_session() дергается почти из всех api/*.php), но пишет в базу не
// чаще раза в ~45 секунд на пользователя, чтобы не превращать обычный поллинг
// чатов в лишнюю нагрузку на SQLite.
function touch_presence(int $userId): void {
    $pdo = db();
    if (!$pdo) {
        return;
    }
    try {
        $pdo->prepare(
            "UPDATE users SET last_active_at = datetime('now')
              WHERE id = :id AND (last_active_at IS NULL OR last_active_at < datetime('now', '-45 seconds'))"
        )->execute([':id' => $userId]);
    } catch (Throwable $e) {
        // молча — присутствие не критично для ответа API
    }
}
