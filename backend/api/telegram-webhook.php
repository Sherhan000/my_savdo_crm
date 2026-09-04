<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/bootstrap.php';

$pdo = db();
if (!$pdo) {
    json_out(['ok' => false], 200);
}

$botToken = (string)($_GET['bot_token'] ?? '');
if ($botToken === '') {
    json_out(['ok' => false], 200);
}

$stmt = $pdo->prepare('SELECT * FROM telegram_bots WHERE bot_token = :t');
$stmt->execute([':t' => $botToken]);
$bot = $stmt->fetch();
if (!$bot) {
    json_out(['ok' => false], 200);
}

$incomingSecret = $_SERVER['HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'] ?? '';
if (!hash_equals((string)$bot['webhook_secret'], $incomingSecret)) {
    json_out(['ok' => false], 403);
}

$userId = (int)$bot['user_id'];

$update = json_body();

// Бот добавили/удалили из группы, повысили/понизили — событие всей группы,
// не привязано к конкретному сообщению. Именно отсюда группа появляется на
// сайте автоматически (Bot API не даёт боту создать группу самому — это
// делает владелец руками в приложении Telegram, а мы просто замечаем момент,
// когда бот в неё попадает).
if (isset($update['my_chat_member'])) {
    tg_handle_my_chat_member($pdo, $userId, $update['my_chat_member']);
    json_out(['ok' => true]);
}

// Кто-то вошёл/вышел/сменил роль в группе — обновляем список участников.
// Приходит, только если явно запрошено в allowed_updates при setWebhook
// (см. telegram-bot-settings.php).
if (isset($update['chat_member'])) {
    tg_handle_chat_member($pdo, $userId, $update['chat_member']);
    json_out(['ok' => true]);
}

$message = $update['message'] ?? null;
if (!$message) {
    json_out(['ok' => true]);
}

$chatId = (string)($message['chat']['id'] ?? '');
if ($chatId === '') {
    json_out(['ok' => true]);
}

$chatType = (string)($message['chat']['type'] ?? 'private');
if ($chatType === 'group' || $chatType === 'supergroup') {
    // Групповые сообщения идут в отдельную ленту (telegram_group_messages),
    // а не в 1:1 переписку с "клиентом" — дальше по файлу вся логика уже
    // только про личные сообщения боту.
    tg_handle_group_message($pdo, $botToken, $userId, $message);
    json_out(['ok' => true]);
}

$text = trim((string)($message['text'] ?? ''));
$caption = trim((string)($message['caption'] ?? ''));

$replyKeyboard = [
    'keyboard' => [[ ['text' => '✍️ Написать'], ['text' => 'ℹ️ Информация'] ]],
    'resize_keyboard' => true,
    'is_persistent' => true,
];

// Клавиатура с кнопкой "поделиться номером" (request_contact) — Telegram сам
// подставляет настоящий номер из аккаунта пользователя, вводить руками не надо.
$phoneKeyboard = [
    'keyboard' => [
        [ ['text' => '📱 Отправить номер телефона', 'request_contact' => true] ],
        [ ['text' => '➡️ Пропустить'] ],
    ],
    'resize_keyboard' => true,
    'is_persistent' => true,
];

function tg_call(string $token, string $method, array $params): array {
    if (!function_exists('curl_init')) {
        return ['ok' => false];
    }
    $ch = curl_init("https://api.telegram.org/bot{$token}/{$method}");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $params,
        CURLOPT_TIMEOUT => 15,
    ]);
    $raw = curl_exec($ch);
    $data = json_decode((string)$raw, true);
    return is_array($data) ? $data : ['ok' => false];
}

function tg_send(string $token, string $chatId, string $text, ?array $replyMarkup = null): void {
    $params = ['chat_id' => $chatId, 'text' => $text];
    if ($replyMarkup) $params['reply_markup'] = json_encode($replyMarkup);
    tg_call($token, 'sendMessage', $params);
}

function tg_download_file(string $token, string $fileId, string $ext): ?string {
    $info = tg_call($token, 'getFile', ['file_id' => $fileId]);
    $filePath = $info['result']['file_path'] ?? null;
    if (!$filePath) return null;

    if (!function_exists('curl_init')) {
        return null;
    }
    $url = "https://api.telegram.org/file/bot{$token}/{$filePath}";
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30]);
    $data = curl_exec($ch);
    if ($data === false || $data === '') return null;

    $dir = __DIR__ . '/../../assets/img/uploads';
    if (!is_dir($dir)) @mkdir($dir, 0775, true);

    $realExt = strtolower(pathinfo($filePath, PATHINFO_EXTENSION)) ?: $ext;
    if (!preg_match('/^[a-z0-9]{1,5}$/', $realExt)) $realExt = $ext;
    $name = bin2hex(random_bytes(12)) . '.' . $realExt;
    if (@file_put_contents($dir . '/' . $name, $data) === false) return null;
    return 'assets/img/uploads/' . $name;
}

function tg_group_id_for_chat(PDO $pdo, int $userId, string $chatId): ?int {
    $stmt = $pdo->prepare('SELECT id FROM telegram_groups WHERE user_id = :uid AND chat_id = :cid');
    $stmt->execute([':uid' => $userId, ':cid' => $chatId]);
    $id = $stmt->fetchColumn();
    return $id !== false ? (int)$id : null;
}

// Бота добавили/удалили из группы (или сменили его роль) — заводим или
// деактивируем запись группы. Единственный официальный способ узнать о новой
// группе: Bot API не умеет создавать группы, только реагировать на то, что
// владелец добавил уже существующего бота в свою.
function tg_handle_my_chat_member(PDO $pdo, int $userId, array $upd): void {
    $chat = $upd['chat'] ?? [];
    $chatType = (string)($chat['type'] ?? '');
    if ($chatType !== 'group' && $chatType !== 'supergroup') {
        return;
    }
    $chatId = (string)($chat['id'] ?? '');
    if ($chatId === '') {
        return;
    }
    $title = trim((string)($chat['title'] ?? '')) ?: 'Группа';
    $status = (string)($upd['new_chat_member']['status'] ?? '');

    if (in_array($status, ['member', 'administrator', 'creator'], true)) {
        $groupId = tg_group_id_for_chat($pdo, $userId, $chatId);
        if ($groupId) {
            $pdo->prepare('UPDATE telegram_groups SET title = :title, type = :type, active = 1 WHERE id = :id')
                ->execute([':title' => $title, ':type' => $chatType, ':id' => $groupId]);
        } else {
            $pdo->prepare('INSERT INTO telegram_groups (user_id, chat_id, title, type) VALUES (:uid, :cid, :title, :type)')
                ->execute([':uid' => $userId, ':cid' => $chatId, ':title' => $title, ':type' => $chatType]);
        }
    } elseif (in_array($status, ['left', 'kicked'], true)) {
        $pdo->prepare('UPDATE telegram_groups SET active = 0 WHERE user_id = :uid AND chat_id = :cid')
            ->execute([':uid' => $userId, ':cid' => $chatId]);
    }
}

// Вход/выход/смена роли участника — наполняет список участников группы,
// который иначе взять неоткуда (Bot API не отдаёт полный список сразу).
function tg_handle_chat_member(PDO $pdo, int $userId, array $upd): void {
    $chat = $upd['chat'] ?? [];
    $chatType = (string)($chat['type'] ?? '');
    if ($chatType !== 'group' && $chatType !== 'supergroup') {
        return;
    }
    $chatId = (string)($chat['id'] ?? '');
    $groupId = tg_group_id_for_chat($pdo, $userId, $chatId);
    if (!$groupId) {
        return;
    }

    $newMember = $upd['new_chat_member'] ?? [];
    $user = $newMember['user'] ?? [];
    $tgUserId = (string)($user['id'] ?? '');
    if ($tgUserId === '' || !empty($user['is_bot'])) {
        return;
    }
    $status = (string)($newMember['status'] ?? 'member');

    if (in_array($status, ['left', 'kicked'], true)) {
        $pdo->prepare('DELETE FROM telegram_group_members WHERE group_id = :gid AND tg_user_id = :uid')
            ->execute([':gid' => $groupId, ':uid' => $tgUserId]);
        return;
    }

    $name = trim(($user['first_name'] ?? '') . ' ' . ($user['last_name'] ?? ''));
    $username = trim((string)($user['username'] ?? ''));
    if ($name === '') {
        $name = $username !== '' ? $username : ('Участник ' . $tgUserId);
    }

    $pdo->prepare(
        "INSERT INTO telegram_group_members (group_id, tg_user_id, name, username, role, last_seen_at)
         VALUES (:gid, :uid, :name, :uname, :role, datetime('now'))
         ON CONFLICT(group_id, tg_user_id) DO UPDATE SET
           name = excluded.name, username = excluded.username, role = excluded.role, last_seen_at = excluded.last_seen_at"
    )->execute([':gid' => $groupId, ':uid' => $tgUserId, ':name' => $name, ':uname' => $username ?: null, ':role' => $status]);
}

// Обычное сообщение в группе — своя лента (telegram_group_messages), не
// смешивается с 1:1 перепиской. Заодно фиксируем отправителя как участника —
// так список участников наполняется, даже если update.chat_member не пришёл.
function tg_handle_group_message(PDO $pdo, string $botToken, int $userId, array $message): void {
    $chat = $message['chat'] ?? [];
    $chatId = (string)($chat['id'] ?? '');
    if ($chatId === '') {
        return;
    }
    $title = trim((string)($chat['title'] ?? ''));
    $chatType = (string)($chat['type'] ?? 'group');

    $groupId = tg_group_id_for_chat($pdo, $userId, $chatId);
    if (!$groupId) {
        // На случай, если update.my_chat_member ещё не пришёл или потерялся —
        // заводим группу прямо здесь, лишь бы сообщение не пропало.
        $pdo->prepare('INSERT INTO telegram_groups (user_id, chat_id, title, type) VALUES (:uid, :cid, :title, :type)')
            ->execute([':uid' => $userId, ':cid' => $chatId, ':title' => $title ?: 'Группа', ':type' => $chatType]);
        $groupId = (int)$pdo->lastInsertId();
    } elseif ($title !== '') {
        $pdo->prepare('UPDATE telegram_groups SET title = :title WHERE id = :id')->execute([':title' => $title, ':id' => $groupId]);
    }

    // Кто-то закрепил/открепил сообщение — это сервисное уведомление, а не
    // текст от живого участника: синхронизируем pinned_message_id и выходим.
    if (!empty($message['pinned_message']['message_id'])) {
        $pinnedTgId = (string)$message['pinned_message']['message_id'];
        $find = $pdo->prepare('SELECT id FROM telegram_group_messages WHERE group_id = :gid AND tg_message_id = :tid');
        $find->execute([':gid' => $groupId, ':tid' => $pinnedTgId]);
        $localId = $find->fetchColumn();
        $pdo->prepare('UPDATE telegram_groups SET pinned_message_id = :pid WHERE id = :id')
            ->execute([':pid' => $localId ?: null, ':id' => $groupId]);
        return;
    }

    $from = $message['from'] ?? [];
    if (!empty($from['is_bot'])) {
        return;
    }

    $gText = trim((string)($message['text'] ?? ''));
    $gCaption = trim((string)($message['caption'] ?? ''));
    $msgText = $gText !== '' ? $gText : ($gCaption !== '' ? $gCaption : null);

    $photoUrl = null;
    $videoUrl = null;
    $audioUrl = null;
    if (!empty($message['photo']) && is_array($message['photo'])) {
        $best = end($message['photo']);
        if (!empty($best['file_id'])) {
            $photoUrl = tg_download_file($botToken, (string)$best['file_id'], 'jpg');
        }
    }
    if (!empty($message['video']['file_id'])) {
        $videoUrl = tg_download_file($botToken, (string)$message['video']['file_id'], 'mp4');
    }
    if (!empty($message['voice']['file_id'])) {
        $audioUrl = tg_download_file($botToken, (string)$message['voice']['file_id'], 'ogg');
    } elseif (!empty($message['audio']['file_id'])) {
        $audioUrl = tg_download_file($botToken, (string)$message['audio']['file_id'], 'mp3');
    }

    if ($msgText === null && $photoUrl === null && $videoUrl === null && $audioUrl === null) {
        // Служебное сообщение без контента (кто-то зашёл/вышел и т.п.).
        return;
    }

    $tgUserId = (string)($from['id'] ?? '');
    $senderName = trim(($from['first_name'] ?? '') . ' ' . ($from['last_name'] ?? ''));
    $senderUsername = trim((string)($from['username'] ?? ''));
    if ($senderName === '') {
        $senderName = $senderUsername !== '' ? $senderUsername : 'Участник';
    }

    $replyLocalId = null;
    if (!empty($message['reply_to_message']['message_id'])) {
        $rp = $pdo->prepare('SELECT id FROM telegram_group_messages WHERE group_id = :gid AND tg_message_id = :tid');
        $rp->execute([':gid' => $groupId, ':tid' => (string)$message['reply_to_message']['message_id']]);
        $replyLocalId = $rp->fetchColumn() ?: null;
    }

    $pdo->prepare(
        "INSERT INTO telegram_group_messages
            (group_id, tg_message_id, direction, sender_tg_id, sender_name, sender_username, text, photo_url, video_url, audio_url, reply_to_id)
         VALUES (:gid, :tid, 'in', :suid, :sname, :suname, :text, :photo, :video, :audio, :reply)"
    )->execute([
        ':gid' => $groupId, ':tid' => (string)($message['message_id'] ?? ''),
        ':suid' => $tgUserId ?: null, ':sname' => $senderName, ':suname' => $senderUsername ?: null,
        ':text' => $msgText, ':photo' => $photoUrl, ':video' => $videoUrl, ':audio' => $audioUrl,
        ':reply' => $replyLocalId,
    ]);
    $pdo->prepare("UPDATE telegram_groups SET last_message_at = datetime('now') WHERE id = :id")->execute([':id' => $groupId]);

    if ($tgUserId !== '') {
        $pdo->prepare(
            "INSERT INTO telegram_group_members (group_id, tg_user_id, name, username, role, last_seen_at)
             VALUES (:gid, :uid, :name, :uname, 'member', datetime('now'))
             ON CONFLICT(group_id, tg_user_id) DO UPDATE SET
               name = excluded.name, username = excluded.username, last_seen_at = excluded.last_seen_at"
        )->execute([':gid' => $groupId, ':uid' => $tgUserId, ':name' => $senderName, ':uname' => $senderUsername ?: null]);
    }
}

if ($text === '/start') {
    $userStmt = $pdo->prepare('SELECT shop_name FROM users WHERE id = :id');
    $userStmt->execute([':id' => $userId]);
    $shopName = $userStmt->fetchColumn() ?: 'нашего магазина';
    tg_send($botToken, $chatId, "Здравствуйте! Это чат-бот {$shopName}.\nВыберите действие ниже или просто напишите ваш вопрос.", $replyKeyboard);
    json_out(['ok' => true]);
}
if ($text === 'ℹ️ Информация') {
    $userStmt = $pdo->prepare('SELECT shop_name, shop_info, phone FROM users WHERE id = :id');
    $userStmt->execute([':id' => $userId]);
    $u = $userStmt->fetch();
    $info = $u['shop_info'] ?: ("Магазин: " . ($u['shop_name'] ?? '') . "\nНапишите нам, и мы ответим как можно скорее.");
    if (!empty($u['phone'])) {
        $info .= "\n📞 " . $u['phone'];
    }
    tg_send($botToken, $chatId, $info);
    json_out(['ok' => true]);
}
if ($text === '✍️ Написать') {
    tg_send($botToken, $chatId, 'Напишите ваше сообщение, мы ответим как можно скорее.');
    json_out(['ok' => true]);
}
if ($text === '➡️ Пропустить') {
    tg_send($botToken, $chatId, 'Хорошо, продолжим без номера — можете написать вопрос.', $replyKeyboard);
    json_out(['ok' => true]);
}

$photoUrl = null;
$audioUrl = null;

if (!empty($message['photo']) && is_array($message['photo'])) {

    $best = end($message['photo']);
    if (!empty($best['file_id'])) {
        $photoUrl = tg_download_file($botToken, (string)$best['file_id'], 'jpg');
    }
}
if (!empty($message['voice']['file_id'])) {
    $audioUrl = tg_download_file($botToken, (string)$message['voice']['file_id'], 'ogg');
} elseif (!empty($message['audio']['file_id'])) {
    $audioUrl = tg_download_file($botToken, (string)$message['audio']['file_id'], 'mp3');
}

// Кнопка "Отправить номер телефона" присылает не текст, а объект contact —
// проверяем его отдельно от текста/фото/голоса, иначе сообщение отсеется
// как пустое до того, как мы вообще посмотрим на клиента.
$contactPhone = null;
if (!empty($message['contact']['phone_number'])) {
    $contactFromId = $message['contact']['user_id'] ?? null;
    $senderId = $message['from']['id'] ?? null;
    // Кнопка request_contact всегда шлёт номер именно того, кто нажал —
    // но на всякий случай не принимаем чужой пересланный контакt.
    if ($contactFromId === null || $senderId === null || (string)$contactFromId === (string)$senderId) {
        $contactPhone = preg_replace('/[^0-9+]/', '', (string)$message['contact']['phone_number']);
    }
}

$msgText = $text !== '' ? $text : ($caption !== '' ? $caption : null);
if ($msgText === null && $photoUrl === null && $audioUrl === null && $contactPhone === null) {
    json_out(['ok' => true]);
}

$fromName = trim(($message['from']['first_name'] ?? '') . ' ' . ($message['from']['last_name'] ?? ''));
$tgUsername = trim((string)($message['from']['username'] ?? ''));
if ($fromName === '') {
    $fromName = $tgUsername !== '' ? $tgUsername : ('Клиент ' . $chatId);
}

$find = $pdo->prepare("SELECT * FROM clients WHERE user_id = :uid AND channel = 'Telegram' AND channel_id = :cid");
$find->execute([':uid' => $userId, ':cid' => $chatId]);
$client = $find->fetch();
$isNewClient = false;

if ($client) {
    $clientId = (int)$client['id'];
    $pdo->prepare("UPDATE clients SET updated_at = datetime('now'), last_seen_at = datetime('now') WHERE id = :id")
        ->execute([':id' => $clientId]);
} else {
    $ins = $pdo->prepare("INSERT INTO clients (user_id, name, channel, channel_id, handle, stage, value, sentiment, last_seen_at)
                           VALUES (:uid, :name, 'Telegram', :cid, :handle, 'new', 0, 'neu', datetime('now'))");
    $ins->execute([
        ':uid' => $userId, ':name' => $fromName, ':cid' => $chatId,
        ':handle' => $tgUsername !== '' ? ('@' . $tgUsername) : null,
    ]);
    $clientId = (int)$pdo->lastInsertId();
    $client = ['id' => $clientId, 'name' => $fromName, 'ai_auto' => 0, 'phone' => null];
    $isNewClient = true;
}

// Клиент нажал "Отправить номер телефона" — сохраняем и на этом всё, это
// не текстовое сообщение, а служебное действие клавиатуры.
if ($contactPhone !== null) {
    $pdo->prepare("UPDATE clients SET phone = :phone, updated_at = datetime('now'), last_seen_at = datetime('now') WHERE id = :id")
        ->execute([':phone' => $contactPhone, ':id' => $clientId]);
    $pdo->prepare("INSERT INTO messages (client_id, direction, text) VALUES (:cid, 'in', :text)")
        ->execute([':cid' => $clientId, ':text' => '📱 Поделился(-ась) номером телефона: ' . $contactPhone]);
    tg_send($botToken, $chatId, 'Спасибо! Номер сохранён — свяжемся с вами при необходимости.', $replyKeyboard);
    json_out(['ok' => true]);
}

$pdo->prepare("INSERT INTO messages (client_id, direction, text, photo_url, audio_url) VALUES (:cid, 'in', :text, :photo, :audio)")
    ->execute([':cid' => $clientId, ':text' => $msgText, ':photo' => $photoUrl, ':audio' => $audioUrl]);

// Первое обращение — сразу после того как сообщение легло в базу, вежливо
// просим номер телефона (можно пропустить кнопкой "Пропустить" выше).
if ($isNewClient && empty($client['phone'])) {
    $pdo->prepare("UPDATE clients SET phone_requested_at = datetime('now') WHERE id = :id")->execute([':id' => $clientId]);
    tg_send(
        $botToken,
        $chatId,
        'Спасибо за обращение! Поделитесь, пожалуйста, номером телефона — так нам будет проще с вами связаться, если понадобится.',
        $phoneKeyboard
    );
}

if (!empty($client['ai_auto']) && $msgText !== null) {
    require_once __DIR__ . '/../config/groq.php';
    require_once __DIR__ . '/../config/features.php';

    $ownerFeatures = user_features($pdo, $userId);
    // Защита от накрутки счёта за Groq: недобросовестный "клиент" мог закидать
    // бота сообщениями и на каждое получить платный ИИ-ответ без остановки —
    // считаем по этому конкретному клиенту, не трогая дневной лимит тарифа
    // (у "Бизнес", где ai_auto вообще доступен, лимит и так не ограничен).
    $floodStmt = $pdo->prepare(
        "SELECT COUNT(*) FROM messages WHERE client_id = :cid AND direction = 'out' AND created_at > datetime('now', '-10 minutes')"
    );
    $floodStmt->execute([':cid' => $clientId]);
    $autoReplyFlooded = (int)$floodStmt->fetchColumn() >= 20;

    if (empty($ownerFeatures['ai_auto']) || $autoReplyFlooded) {
        // отключено тарифом/админом или сработала защита от флуда — тихо
        // пропускаем, вебхук всё равно должен ответить Telegram'у 200 OK
    } elseif (GROQ_API_KEY !== '' && strpos(GROQ_API_KEY, 'ВСТАВЬ_СЮДА') === false) {

        $histStmt = $pdo->prepare('SELECT direction, text FROM messages WHERE client_id = :cid AND text IS NOT NULL ORDER BY id DESC LIMIT 8');
        $histStmt->execute([':cid' => $clientId]);
        $history = array_reverse($histStmt->fetchAll());

        $chatMessages = [[
            'role' => 'system',
            'content' => 'Ты — вежливый ассистент продавца в интернет-магазине в Таджикистане, отвечаешь клиенту в Telegram от имени магазина. '
                . 'Отвечай коротко (1-3 предложения), дружелюбно, на том же языке, на котором пишет клиент. '
                . 'Уточняй размер, цвет или город доставки, если это уместно. Не выдумывай цены, скидки и наличие товара — '
                . 'если клиент спрашивает точную цену или наличие, вежливо скажи, что менеджер уточнит и ответит в ближайшее время. '
                . 'Никогда не выходи за рамки темы магазина и заказа.'
        ]];
        foreach ($history as $h) {
            $chatMessages[] = [
                'role' => $h['direction'] === 'in' ? 'user' : 'assistant',
                'content' => (string)$h['text'],
            ];
        }

        [$response, $httpCode] = groq_request([
            'model' => GROQ_MODEL,
            'messages' => $chatMessages,
            'temperature' => 0.6,
            'max_tokens' => 220,
        ]);

        if ($response !== null && $httpCode < 400) {
            $data = json_decode($response, true);
            $reply = trim((string)($data['choices'][0]['message']['content'] ?? ''));
            if ($reply !== '') {
                tg_send($botToken, $chatId, $reply);
                $pdo->prepare("INSERT INTO messages (client_id, direction, text, by_ai) VALUES (:cid, 'out', :text, 1)")
                    ->execute([':cid' => $clientId, ':text' => $reply]);
                $pdo->prepare("UPDATE clients SET updated_at = datetime('now') WHERE id = :id")
                    ->execute([':id' => $clientId]);
            }
        } else {
            // Автоответ клиенту молча пропускается при ошибке (вебхук всё равно
            // должен ответить Telegram'у 200 OK) — но причину стоит видеть в логе,
            // а не гадать, почему бот вдруг перестал отвечать сам.
            groq_error_detail($response, $httpCode, null);
        }
    }
}

json_out(['ok' => true]);
