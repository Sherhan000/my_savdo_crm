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
csrf_verify();

$body = json_body();
$clientId = (int)($body['client_id'] ?? 0);
$text = trim((string)($body['text'] ?? ''));
$photoUrl = trim((string)($body['photo_url'] ?? ''));
$audioUrl = trim((string)($body['audio_url'] ?? ''));

if ($clientId <= 0 || ($text === '' && $photoUrl === '' && $audioUrl === '')) {
    json_fail('Не указан client_id или содержимое сообщения', 422);
}

$stmt = $pdo->prepare("SELECT * FROM clients WHERE id = :id AND user_id = :uid AND channel = 'Telegram'");
$stmt->execute([':id' => $clientId, ':uid' => $userId]);
$client = $stmt->fetch();
if (!$client) {
    json_fail('Заявка не найдена или это не Telegram-клиент', 404);
}
if (empty($client['channel_id'])) {
    json_fail('У этой заявки нет привязки к Telegram-чату', 422);
}

$botStmt = $pdo->prepare('SELECT bot_token FROM telegram_bots WHERE user_id = :uid');
$botStmt->execute([':uid' => $userId]);
$bot = $botStmt->fetch();
if (!$bot) {
    json_fail('У вас не подключен Telegram-бот', 422);
}

function tg_api(string $token, string $method, array $params): array {
    if (!function_exists('curl_init')) {
        json_fail('Отправка в Telegram недоступна на этом сервере (нет расширения PHP curl)', 500);
    }
    $ch = curl_init("https://api.telegram.org/bot{$token}/{$method}");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $params,
        CURLOPT_TIMEOUT => 25,
    ]);
    $raw = curl_exec($ch);
    $data = json_decode((string)$raw, true);
    return is_array($data) ? $data : ['ok' => false, 'description' => 'нет ответа от Telegram'];
}

function local_upload_path(string $url): ?string {
    if (!upload_url_valid($url)) {
        return null;
    }
    return realpath(__DIR__ . '/../../assets/img/uploads/' . basename($url));
}

$chatId = (string)$client['channel_id'];
$token = (string)$bot['bot_token'];

if ($audioUrl !== '') {
    $path = local_upload_path($audioUrl);
    if (!$path) {
        json_fail('Голосовое сообщение не найдено на сервере', 422);
    }
    $file = new CURLFile($path);

    $res = tg_api($token, 'sendVoice', ['chat_id' => $chatId, 'voice' => $file]);
    if (empty($res['ok'])) {

        $res = tg_api($token, 'sendAudio', ['chat_id' => $chatId, 'audio' => new CURLFile($path), 'title' => 'Голосовое сообщение']);
    }
    if (empty($res['ok'])) {
        json_fail('Telegram не принял голосовое: ' . ($res['description'] ?? 'неизвестная ошибка'), 502);
    }
    $pdo->prepare("INSERT INTO messages (client_id, direction, audio_url) VALUES (:cid, 'out', :a)")
        ->execute([':cid' => $clientId, ':a' => $audioUrl]);
} elseif ($photoUrl !== '') {
    $path = local_upload_path($photoUrl);
    if (!$path) {
        json_fail('Фото не найдено на сервере', 422);
    }
    $res = tg_api($token, 'sendPhoto', ['chat_id' => $chatId, 'photo' => new CURLFile($path)]);
    if (empty($res['ok'])) {
        json_fail('Telegram не принял фото: ' . ($res['description'] ?? 'неизвестная ошибка'), 502);
    }
    $pdo->prepare("INSERT INTO messages (client_id, direction, photo_url) VALUES (:cid, 'out', :p)")
        ->execute([':cid' => $clientId, ':p' => $photoUrl]);
} else {
    $res = tg_api($token, 'sendMessage', ['chat_id' => $chatId, 'text' => $text]);
    if (empty($res['ok'])) {
        json_fail('Telegram не принял сообщение: ' . ($res['description'] ?? 'неизвестная ошибка'), 502);
    }
    $pdo->prepare("INSERT INTO messages (client_id, direction, text) VALUES (:cid, 'out', :text)")
        ->execute([':cid' => $clientId, ':text' => $text]);
}

$pdo->prepare("UPDATE clients SET updated_at = datetime('now') WHERE id = :id")
    ->execute([':id' => $clientId]);

json_out(['ok' => true]);
