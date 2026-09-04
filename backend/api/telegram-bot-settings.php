<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
start_session();

if (empty($_SESSION['user_id'])) {
    json_fail('Не авторизован', 401);
}
$userId = (int)$_SESSION['user_id'];

$pdo = db();
if (!$pdo) {
    json_fail('Хранилище недоступно на этом сервере (нет PDO SQLite)', 503);
}

function telegram_api(string $token, string $method, array $params = []): array {
    if (!function_exists('curl_init')) {
        json_fail('Подключение Telegram-бота недоступно на этом сервере (нет расширения PHP curl)', 500);
    }
    $ch = curl_init("https://api.telegram.org/bot{$token}/{$method}");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $params,
        CURLOPT_TIMEOUT => 10,
    ]);
    $raw = curl_exec($ch);
    $err = curl_error($ch);
    if ($raw === false) return ['ok' => false, 'description' => $err];
    $data = json_decode($raw, true);
    return is_array($data) ? $data : ['ok' => false, 'description' => 'bad response'];
}

function request_scheme(): string {
    if (!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && strtolower($_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https') {
        return 'https';
    }
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
        return 'https';
    }
    if ((int)($_SERVER['SERVER_PORT'] ?? 0) === 443) {
        return 'https';
    }
    return 'http';
}

function webhook_url(string $botToken): string {
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';

    $scriptDir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/backend/api/x.php')), '/');
    return request_scheme() . '://' . $host . $scriptDir . '/telegram-webhook.php?bot_token=' . rawurlencode($botToken);
}

function setupBot(PDO $pdo, int $userId, string $botToken): array {

    $host = $_SERVER['HTTP_HOST'] ?? '';
    $isLocal = str_starts_with($host, 'localhost') || str_starts_with($host, '127.0.0.1');
    if (request_scheme() !== 'https' && !$isLocal) {
        return ['ok' => false, 'error' => 'Telegram принимает вебхуки только по HTTPS. Включите SSL-сертификат на хостинге (обычно бесплатный Let\'s Encrypt в панели хостинга) и откройте сайт по https://, затем подключите бота снова.'];
    }

    $me = telegram_api($botToken, 'getMe');
    if (empty($me['ok'])) {
        return ['ok' => false, 'error' => 'Telegram не принял токен: ' . ($me['description'] ?? 'проверьте токен из @BotFather')];
    }
    $username = $me['result']['username'] ?? null;

    $existing = $pdo->prepare('SELECT user_id FROM telegram_bots WHERE bot_token = :t');
    $existing->execute([':t' => $botToken]);
    $row = $existing->fetch();
    if ($row && (int)$row['user_id'] !== $userId) {
        return ['ok' => false, 'error' => 'Этот бот уже подключен к другому аккаунту MySavdo'];
    }

    $secret = bin2hex(random_bytes(16));

    $set = telegram_api($botToken, 'setWebhook', [
        'url' => webhook_url($botToken),
        'secret_token' => $secret,
        'drop_pending_updates' => 'true',
        // my_chat_member — момент, когда владелец добавляет бота в свою
        // Telegram-группу (группа появляется на сайте автоматически);
        // chat_member — вход/выход/смена роли участников той же группы.
        'allowed_updates' => json_encode(['message', 'my_chat_member', 'chat_member']),
    ]);
    if (empty($set['ok'])) {
        return ['ok' => false, 'error' => 'Не удалось подключить вебхук: ' . ($set['description'] ?? 'неизвестная ошибка Telegram')];
    }

    $pdo->prepare('INSERT INTO telegram_bots (user_id, bot_token, bot_username, webhook_secret)
                    VALUES (:uid, :token, :username, :secret)
                    ON CONFLICT(user_id) DO UPDATE SET
                      bot_token = excluded.bot_token,
                      bot_username = excluded.bot_username,
                      webhook_secret = excluded.webhook_secret')
        ->execute([':uid' => $userId, ':token' => $botToken, ':username' => $username, ':secret' => $secret]);

    return ['ok' => true, 'bot_username' => $username];
}

$method = $_SERVER['REQUEST_METHOD'];
if ($method !== 'GET') {
    csrf_verify();
}

if ($method === 'GET') {
    $stmt = $pdo->prepare('SELECT bot_username FROM telegram_bots WHERE user_id = :uid');
    $stmt->execute([':uid' => $userId]);
    $row = $stmt->fetch();
    json_out(['connected' => (bool)$row, 'bot_username' => $row['bot_username'] ?? null]);
}

if ($method === 'POST') {
    $body = json_body();
    $token = trim((string)($body['bot_token'] ?? ''));
    if ($token === '' || !str_contains($token, ':')) {
        json_fail('Похоже, это не токен бота. Токен выглядит так: 123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 422);
    }
    $result = setupBot($pdo, $userId, $token);
    if (!$result['ok']) {
        json_fail($result['error'], 422);
    }
    json_out(['connected' => true, 'bot_username' => $result['bot_username']]);
}

if ($method === 'DELETE') {
    $stmt = $pdo->prepare('SELECT bot_token FROM telegram_bots WHERE user_id = :uid');
    $stmt->execute([':uid' => $userId]);
    $row = $stmt->fetch();
    if ($row) {
        telegram_api($row['bot_token'], 'deleteWebhook');
        $pdo->prepare('DELETE FROM telegram_bots WHERE user_id = :uid')->execute([':uid' => $userId]);
    }
    json_out(['ok' => true]);
}

json_fail('Метод не поддерживается', 405);
