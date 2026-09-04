<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/bootstrap.php';

$pdo = db();
if (!$pdo) {
    json_out(['ok' => false], 200);
}

$settings = settings_read();
$token = trim((string)($settings['support_bot_token'] ?? ''));
if ($token === '') {
    json_out(['ok' => false], 200);
}

$incomingSecret = $_SERVER['HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'] ?? '';
$ourSecret = (string)($settings['support_bot_secret'] ?? '');
if ($ourSecret !== '' && !hash_equals($ourSecret, $incomingSecret)) {
    json_out(['ok' => false], 403);
}

function sup_tg_send(string $token, string $chatId, string $text): void {
    if (!function_exists('curl_init')) {
        return;
    }
    $ch = curl_init("https://api.telegram.org/bot{$token}/sendMessage");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => ['chat_id' => $chatId, 'text' => $text],
        CURLOPT_TIMEOUT => 10,
    ]);
    curl_exec($ch);
}

$update = json_body();
$message = $update['message'] ?? null;
if (!$message) {
    json_out(['ok' => true]);
}

$chatId = (string)($message['chat']['id'] ?? '');
$text = trim((string)($message['text'] ?? ''));
if ($chatId === '' || $text === '') {
    json_out(['ok' => true]);
}

$boundChatId = trim((string)($settings['support_chat_id'] ?? ''));
$bindCode = trim((string)($settings['support_bind_code'] ?? ''));

if ($text === '/start') {
    if ($boundChatId === $chatId) {
        sup_tg_send($token, $chatId, "✅ Этот чат уже привязан к поддержке MySavdo.\nСообщения пользователей будут приходить сюда. Чтобы ответить — свайпните сообщение и напишите ответ, либо отправьте «#ID текст» (например: #3 Здравствуйте!).");
    } else {
        sup_tg_send($token, $chatId, "👋 Это бот поддержки MySavdo.\nЧтобы привязать этот чат, отправьте код привязки из админ-панели сайта (раздел «Поддержка» → «Telegram-бот»).");
    }
    json_out(['ok' => true]);
}

if ($bindCode !== '' && hash_equals($bindCode, $text)) {
    $s = settings_read();
    $s['support_chat_id'] = $chatId;

    $s['support_bind_code'] = '';
    settings_write($s);
    sup_tg_send($token, $chatId, "✅ Готово! Чат привязан к поддержке MySavdo.\nТеперь сообщения пользователей будут приходить сюда.\n\nКак отвечать:\n• свайпните сообщение пользователя и напишите ответ, или\n• отправьте «#ID текст» (ID указан в сообщении, например: #3 Здравствуйте!).");
    json_out(['ok' => true]);
}

if ($boundChatId === '' || $boundChatId !== $chatId) {
    sup_tg_send($token, $chatId, "Этот чат не привязан к поддержке MySavdo. Отправьте код привязки из админ-панели.");
    json_out(['ok' => true]);
}

function sup_admin_reply(PDO $pdo, string $token, string $chatId, int $userId, string $reply): void {
    $u = $pdo->prepare('SELECT shop_name, email FROM users WHERE id = :id');
    $u->execute([':id' => $userId]);
    $row = $u->fetch();
    if (!$row) {
        sup_tg_send($token, $chatId, "⚠️ Пользователь #U{$userId} не найден (возможно, аккаунт удалён).");
        return;
    }
    $reply = mb_substr($reply, 0, 2000);
    $pdo->prepare("INSERT INTO support_messages (user_id, direction, text, via, read_by_admin) VALUES (:uid, 'admin', :t, 'telegram', 1)")
        ->execute([':uid' => $userId, ':t' => $reply]);
    $name = $row['shop_name'] ?: $row['email'];
    sup_tg_send($token, $chatId, "✅ Ответ отправлен «{$name}» — он появится у пользователя в чате на сайте.");
}

$replyTo = $message['reply_to_message']['text'] ?? '';
if ($replyTo !== '' && preg_match('/#U(\d+)/u', (string)$replyTo, $m)) {
    sup_admin_reply($pdo, $token, $chatId, (int)$m[1], $text);
    json_out(['ok' => true]);
}

if (preg_match('/^#\s*(\d+)\s+(.+)$/su', $text, $m)) {
    sup_admin_reply($pdo, $token, $chatId, (int)$m[1], trim($m[2]));
    json_out(['ok' => true]);
}

sup_tg_send($token, $chatId, "🤔 Не понял, кому это отправить.\nОтветьте свайпом на сообщение пользователя или используйте формат «#ID текст» (например: #3 Здравствуйте!).");
json_out(['ok' => true]);
