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

    json_fail('Хранилище заявок недоступно на этом сервере (нет PDO SQLite)', 503);
}

$method = $_SERVER['REQUEST_METHOD'];
if ($method !== 'GET') {
    csrf_verify();
}
// К пяти стандартным этапам подмешиваем собственные колонки продавца (см.
// funnel-stages.php) — иначе перенос карточки в свою колонку тихо
// отклонялся бы валидацией ниже.
$allowedStages = ['new', 'consult', 'deal', 'pay', 'done'];
$customStagesStmt = $pdo->prepare('SELECT stage_key, title FROM funnel_custom_stages WHERE user_id = :uid');
$customStagesStmt->execute([':uid' => $userId]);
$customStagesRows = $customStagesStmt->fetchAll();
foreach ($customStagesRows as $cs) {
    $allowedStages[] = $cs['stage_key'];
}
$allowedSentiments = ['pos', 'neu', 'neg'];
// Причины удаления заявки — фиксированный список (не свободный текст),
// чтобы потом можно было посчитать статистику по ним, а не парсить
// произвольные формулировки. 'other' — единственная, где reason_note
// действительно нужен для контекста.
$allowedDeleteReasons = [
    'refused', 'no_reply', 'cheaper_elsewhere', 'bought_elsewhere',
    'duplicate', 'spam', 'test', 'other',
];

function client_export_date(?string $s): string {
    if (!$s) {
        return '';
    }
    try {
        $dt = new DateTime($s, new DateTimeZone('UTC'));
        $dt->setTimezone(new DateTimeZone('Asia/Dushanbe'));
        return $dt->format('d.m.Y H:i');
    } catch (Throwable $e) {
        return $s;
    }
}

// Телефон, если клиент его дал (см. телеграм-бот), иначе ник/юзернейм в
// мессенджере, иначе хотя бы технический id канала — для колонки "контакт"
// в Excel-выгрузке всегда должно быть хоть что-то, кроме пустоты.
function client_export_contact(array $row): string {
    $phone = trim((string)($row['phone'] ?? ''));
    if ($phone !== '') {
        return $phone;
    }
    $handle = trim((string)($row['handle'] ?? ''));
    if ($handle !== '') {
        return $handle;
    }
    $cid = trim((string)($row['channel_id'] ?? ''));
    return $cid !== '' ? $cid : '—';
}

if ($method === 'GET' && (string)($_GET['export'] ?? '') === 'xlsx') {
    require_once __DIR__ . '/../lib/xlsx.php';

    $stageTitles = ['new' => 'Новая', 'consult' => 'Консультация', 'deal' => 'Сделка', 'pay' => 'Оплата', 'done' => 'Доставлено'];
    foreach ($customStagesRows as $cs) {
        $stageTitles[$cs['stage_key']] = $cs['title'];
    }
    $sentTitles = ['pos' => 'Позитив', 'neu' => 'Нейтрально', 'neg' => 'Негатив'];

    $onlyId = (int)($_GET['id'] ?? 0);
    $sql = 'SELECT * FROM clients WHERE user_id = :uid' . ($onlyId > 0 ? ' AND id = :id' : '') . ' ORDER BY pinned DESC, updated_at DESC';
    $stmt = $pdo->prepare($sql);
    $params = [':uid' => $userId];
    if ($onlyId > 0) {
        $params[':id'] = $onlyId;
    }
    $stmt->execute($params);
    $clientRows = $stmt->fetchAll();

    if ($onlyId > 0 && !$clientRows) {
        json_fail('Заявка не найдена', 404);
    }

    $clientsSheetRows = [['Имя', 'Телефон', 'Ник/юзернейм', 'Канал', 'ID в канале', 'Этап', 'Сумма, сомони', 'Настроение', 'Заметка', 'Напомнить', 'Создан', 'Обновлён']];
    $msgSheetRows = [['Клиент', 'Телефон/ник', 'Канал', 'Дата и время', 'Направление', 'Сообщение']];

    if ($clientRows) {
        $ids = array_map(fn(array $c) => (int)$c['id'], $clientRows);
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $msgStmt = $pdo->prepare("SELECT * FROM messages WHERE client_id IN ($placeholders) ORDER BY client_id ASC, id ASC");
        $msgStmt->execute($ids);
        $msgsByClient = [];
        foreach ($msgStmt->fetchAll() as $m) {
            $msgsByClient[(int)$m['client_id']][] = $m;
        }

        foreach ($clientRows as $c) {
            $contact = client_export_contact($c);
            $clientsSheetRows[] = [
                (string)$c['name'],
                (string)($c['phone'] ?? ''),
                (string)($c['handle'] ?? ''),
                (string)$c['channel'],
                (string)($c['channel_id'] ?? ''),
                $stageTitles[$c['stage']] ?? (string)$c['stage'],
                (string)(int)$c['value'],
                $sentTitles[$c['sentiment']] ?? (string)$c['sentiment'],
                (string)($c['notes'] ?? ''),
                client_export_date($c['remind_at'] ?? null),
                client_export_date($c['created_at']),
                client_export_date($c['updated_at']),
            ];
            foreach ($msgsByClient[(int)$c['id']] ?? [] as $m) {
                $text = trim((string)($m['text'] ?? ''));
                if ($text === '') {
                    $text = !empty($m['photo_url']) ? '[Фото]' : (!empty($m['audio_url']) ? '[Голосовое сообщение]' : '');
                }
                $msgSheetRows[] = [
                    (string)$c['name'],
                    $contact,
                    (string)$c['channel'],
                    client_export_date($m['created_at']),
                    $m['direction'] === 'in' ? 'Входящее (от клиента)' : 'Исходящее (от магазина)',
                    $text,
                ];
            }
        }
    }

    $filename = $onlyId > 0
        ? 'client-' . $onlyId . '-' . date('Y-m-d') . '.xlsx'
        : 'mysavdo-clients-' . date('Y-m-d') . '.xlsx';

    xlsx_send($filename, [
        ['name' => 'Клиенты', 'widths' => [22, 16, 16, 12, 14, 14, 12, 12, 26, 17, 17, 17], 'rows' => $clientsSheetRows],
        ['name' => 'Переписка', 'widths' => [22, 16, 12, 17, 24, 55], 'rows' => $msgSheetRows],
    ]);
}

function client_row_out(array $row): array {
    return [
        'id' => (int)$row['id'],
        'name' => $row['name'],
        'channel' => $row['channel'],
        'channel_id' => $row['channel_id'],
        'phone' => $row['phone'] ?? null,
        'handle' => $row['handle'] ?? null,
        'stage' => $row['stage'],
        'value' => (int)$row['value'],
        'sentiment' => $row['sentiment'],
        'ai_auto' => (int)($row['ai_auto'] ?? 0),
        'notes' => $row['notes'] ?? null,
        'remind_at' => $row['remind_at'] ?? null,
        'remind_note' => $row['remind_note'] ?? null,
        'ai_risk_score' => isset($row['ai_risk_score']) && $row['ai_risk_score'] !== null ? (int)$row['ai_risk_score'] : null,
        'ai_risk_reason' => $row['ai_risk_reason'] ?? null,
        'ai_risk_at' => $row['ai_risk_at'] ?? null,
        'pinned' => (int)($row['pinned'] ?? 0),
        'last_seen_at' => $row['last_seen_at'] ?? null,
        'created_at' => $row['created_at'],
        'updated_at' => $row['updated_at'],

        'last_message_id' => isset($row['last_message_id']) ? (int)$row['last_message_id'] : 0,
        'last_message_text' => $row['last_message_text'] ?? null,
        'last_message_dir' => $row['last_message_dir'] ?? null,
        'last_message_kind' => $row['last_message_kind'] ?? null,
        'last_message_at' => $row['last_message_at'] ?? null,
    ];
}

if ($method === 'GET') {

    $stmt = $pdo->prepare(
        'SELECT c.*,
                m.id         AS last_message_id,
                m.text       AS last_message_text,
                m.direction  AS last_message_dir,
                CASE WHEN m.audio_url IS NOT NULL THEN \'audio\'
                     WHEN m.photo_url IS NOT NULL THEN \'photo\'
                     ELSE \'text\' END AS last_message_kind,
                m.created_at AS last_message_at
           FROM clients c
      LEFT JOIN messages m ON m.id = (SELECT id FROM messages WHERE client_id = c.id ORDER BY id DESC LIMIT 1)
          WHERE c.user_id = :uid
       ORDER BY c.pinned DESC, c.updated_at DESC'
    );
    $stmt->execute([':uid' => $userId]);
    $rows = $stmt->fetchAll();
    json_out(['clients' => array_map('client_row_out', $rows)]);
}

if ($method === 'POST') {
    require_once __DIR__ . '/../config/features.php';
    $feat = user_features($pdo, $userId);
    $limit = $feat['clients_limit'];
    if ($limit !== null) {
        $cnt = $pdo->prepare('SELECT COUNT(*) FROM clients WHERE user_id = :uid');
        $cnt->execute([':uid' => $userId]);
        if ((int)$cnt->fetchColumn() >= (int)$limit) {
            json_fail("Достигнут лимит заявок вашего тарифа ({$limit}). Перейдите на «Стандарт» или «Бизнес» — там лимитов нет.", 403);
        }
    }
    $body = json_body();
    $name = trim((string)($body['name'] ?? ''));
    if ($name === '') {
        json_fail('Укажите имя клиента', 422);
    }
    $channel = trim((string)($body['channel'] ?? 'Telegram'));
    $channelId = isset($body['channel_id']) ? trim((string)$body['channel_id']) : null;
    $stage = (string)($body['stage'] ?? 'new');
    if (!in_array($stage, $allowedStages, true)) {
        $stage = 'new';
    }
    $value = isset($body['value']) ? max(0, (int)$body['value']) : 0;
    $sentiment = (string)($body['sentiment'] ?? 'neu');
    if (!in_array($sentiment, $allowedSentiments, true)) {
        $sentiment = 'neu';
    }

    $stmt = $pdo->prepare('INSERT INTO clients (user_id, name, channel, channel_id, stage, value, sentiment)
                            VALUES (:uid, :name, :channel, :channel_id, :stage, :value, :sentiment)');
    $stmt->execute([
        ':uid' => $userId, ':name' => $name, ':channel' => $channel,
        ':channel_id' => $channelId, ':stage' => $stage, ':value' => $value, ':sentiment' => $sentiment,
    ]);
    $id = (int)$pdo->lastInsertId();

    if (!empty($body['first_message'])) {
        $msg = $pdo->prepare("INSERT INTO messages (client_id, direction, text) VALUES (:cid, 'in', :text)");
        $msg->execute([':cid' => $id, ':text' => (string)$body['first_message']]);
    }

    $stmt = $pdo->prepare('SELECT * FROM clients WHERE id = :id');
    $stmt->execute([':id' => $id]);
    json_out(['client' => client_row_out($stmt->fetch())], 201);
}

if ($method === 'PATCH' || $method === 'PUT') {
    $id = (int)($_GET['id'] ?? 0);
    if ($id <= 0) {
        json_fail('Не указан id заявки', 422);
    }
    $check = $pdo->prepare('SELECT id FROM clients WHERE id = :id AND user_id = :uid');
    $check->execute([':id' => $id, ':uid' => $userId]);
    if (!$check->fetch()) {
        json_fail('Заявка не найдена', 404);
    }

    $body = json_body();
    $fields = [];
    $params = [':id' => $id];

    if (isset($body['stage']) && in_array($body['stage'], $allowedStages, true)) {
        $fields[] = 'stage = :stage';
        $params[':stage'] = $body['stage'];
    }
    if (isset($body['sentiment']) && in_array($body['sentiment'], $allowedSentiments, true)) {
        $fields[] = 'sentiment = :sentiment';
        $params[':sentiment'] = $body['sentiment'];
    }
    if (isset($body['value'])) {
        $fields[] = 'value = :value';
        $params[':value'] = max(0, (int)$body['value']);
    }
    if (isset($body['name']) && trim((string)$body['name']) !== '') {
        $fields[] = 'name = :name';
        $params[':name'] = trim((string)$body['name']);
    }
    if (isset($body['ai_auto'])) {
        $fields[] = 'ai_auto = :ai_auto';
        $params[':ai_auto'] = ((int)$body['ai_auto']) ? 1 : 0;
    }
    if (isset($body['notes'])) {
        $notes = trim((string)$body['notes']);
        $fields[] = 'notes = :notes';
        $params[':notes'] = $notes !== '' ? mb_substr($notes, 0, 2000) : null;
    }
    if (isset($body['pinned'])) {
        $fields[] = 'pinned = :pinned';
        $params[':pinned'] = ((int)$body['pinned']) ? 1 : 0;
    }
    if (isset($body['remind_at'])) {
        $raw = trim((string)$body['remind_at']);
        if ($raw === '') {
            $fields[] = 'remind_at = NULL';
        } else {
            // Фронтенд шлёт ISO-строку в UTC (new Date(...).toISOString()) —
            // как и все остальные даты в базе (datetime('now') тоже UTC), без
            // всякого пересчёта часовых поясов на бэкенде.
            try {
                $dt = new DateTime($raw);
                $fields[] = 'remind_at = :remind_at';
                $params[':remind_at'] = $dt->format('Y-m-d H:i:s');
            } catch (Throwable $e) {
                json_fail('Некорректная дата напоминания', 422);
            }
        }
    }
    if (isset($body['remind_note'])) {
        $note = trim((string)$body['remind_note']);
        $fields[] = 'remind_note = :remind_note';
        $params[':remind_note'] = $note !== '' ? mb_substr($note, 0, 300) : null;
    }
    if (!$fields) {
        json_fail('Нечего обновлять', 422);
    }
    $fields[] = "updated_at = datetime('now')";

    $sql = 'UPDATE clients SET ' . implode(', ', $fields) . ' WHERE id = :id';
    $pdo->prepare($sql)->execute($params);

    $stmt = $pdo->prepare('SELECT * FROM clients WHERE id = :id');
    $stmt->execute([':id' => $id]);
    json_out(['client' => client_row_out($stmt->fetch())]);
}

if ($method === 'DELETE') {
    $id = (int)($_GET['id'] ?? 0);
    if ($id <= 0) {
        json_fail('Не указан id заявки', 422);
    }
    $check = $pdo->prepare('SELECT * FROM clients WHERE id = :id AND user_id = :uid');
    $check->execute([':id' => $id, ':uid' => $userId]);
    $row = $check->fetch();
    if (!$row) {
        json_fail('Заявка не найдена', 404);
    }

    $body = json_body();
    $reason = (string)($body['reason'] ?? '');
    if (!in_array($reason, $allowedDeleteReasons, true)) {
        $reason = 'other';
    }
    $reasonNote = trim((string)($body['reason_note'] ?? ''));

    // Заявку удаляем насовсем (как и раньше), но сначала оставляем след —
    // причину, канал и сумму сделки — чтобы продавец потом мог посмотреть
    // сводку "почему теряем клиентов", а не только развести руками.
    $pdo->prepare(
        'INSERT INTO client_deletions (user_id, client_name, channel, stage, value, reason, reason_note)
         VALUES (:uid, :name, :channel, :stage, :value, :reason, :note)'
    )->execute([
        ':uid' => $userId,
        ':name' => (string)$row['name'],
        ':channel' => (string)$row['channel'],
        ':stage' => (string)$row['stage'],
        ':value' => (int)$row['value'],
        ':reason' => $reason,
        ':note' => $reasonNote !== '' ? mb_substr($reasonNote, 0, 300) : null,
    ]);

    $stmt = $pdo->prepare('DELETE FROM clients WHERE id = :id AND user_id = :uid');
    $stmt->execute([':id' => $id, ':uid' => $userId]);
    if ($stmt->rowCount() === 0) {
        json_fail('Заявка не найдена', 404);
    }
    json_out(['ok' => true]);
}

json_fail('Метод не поддерживается', 405);
