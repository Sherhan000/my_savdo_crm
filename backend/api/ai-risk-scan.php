<?php
declare(strict_types=1);

// Заменяет наивную эвристику "давно не отвечали + плохой тон" на реальную
// оценку ИИ: одним запросом к Groq анализирует сразу все незавершённые
// сделки продавца и для каждой возвращает риск потери (0-100) с коротким
// объяснением на русском/таджикском. Результат кэшируется в clients —
// это НЕ считается на каждый рендер экрана, только по кнопке продавца.

require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/groq.php';
require_once __DIR__ . '/../config/features.php';
start_session();

if (empty($_SESSION['user_id'])) {
    json_fail('Не авторизован', 401);
}
$userId = (int)$_SESSION['user_id'];

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_fail('Метод не поддерживается', 405);
}
csrf_verify();

$pdo = db();
if (!$pdo) {
    json_fail('Хранилище недоступно на этом сервере (нет PDO SQLite)', 503);
}

$feat = user_features($pdo, $userId);
if (empty($feat['analytics_full'])) {
    json_fail('ИИ-анализ рисков доступен на тарифах «Стандарт» и «Бизнес»', 403);
}

// Скан по всему магазину дороже одной подсказки — лимит куда строже, чем у
// ai-reply.php/ai-extract-order.php.
rate_limit_guard('ai_risk_scan', (string)$userId, 6, 30);
rate_limit_fail('ai_risk_scan', (string)$userId, 6, 30);

// До 25 самых "живых" незавершённых сделок — достаточно для реального
// внимания продавца за раз и держит промпт (и счёт за Groq) в разумных
// пределах.
$clientsStmt = $pdo->prepare(
    "SELECT id, name, stage, value, sentiment, updated_at
       FROM clients
      WHERE user_id = :uid AND stage != 'done'
      ORDER BY updated_at DESC LIMIT 25"
);
$clientsStmt->execute([':uid' => $userId]);
$clientRows = $clientsStmt->fetchAll();

if (!$clientRows) {
    json_out(['scanned' => 0, 'clients' => []]);
}

if (GROQ_API_KEY === '' || strpos(GROQ_API_KEY, 'ВСТАВЬ_СЮДА') !== false) {
    json_out(['error' => 'Ключ Groq не настроен на сервере — ИИ-анализ недоступен в демо-режиме'], 503);
}

$ids = array_map(fn(array $c) => (int)$c['id'], $clientRows);
$placeholders = implode(',', array_fill(0, count($ids), '?'));
$msgStmt = $pdo->prepare(
    "SELECT client_id, direction, text FROM messages
      WHERE client_id IN ($placeholders) AND text IS NOT NULL AND text != ''
      ORDER BY id DESC"
);
$msgStmt->execute($ids);
$msgsByClient = [];
foreach ($msgStmt->fetchAll() as $m) {
    $cid = (int)$m['client_id'];
    // Уже отобрано по id DESC — берём только последние 4 на клиента, потом
    // развернём порядок при сборке промпта.
    if (count($msgsByClient[$cid] ?? []) >= 4) continue;
    $msgsByClient[$cid][] = $m;
}

$lines = [];
foreach ($clientRows as $c) {
    $cid = (int)$c['id'];
    $minutesAgo = 0;
    $ts = strtotime((string)$c['updated_at'] . ' UTC');
    if ($ts !== false) {
        $minutesAgo = max(0, (int)round((time() - $ts) / 60));
    }
    $lines[] = "### client_id={$cid}, имя: {$c['name']}, этап: {$c['stage']}, сумма: {$c['value']} сомони, "
        . "тон последнего сообщения: {$c['sentiment']}, с последнего сообщения прошло {$minutesAgo} мин.";
    $msgs = array_reverse($msgsByClient[$cid] ?? []);
    foreach ($msgs as $m) {
        $who = $m['direction'] === 'in' ? 'Клиент' : 'Продавец';
        $lines[] = '  ' . $who . ': ' . mb_substr(trim((string)$m['text']), 0, 200);
    }
}
$transcript = mb_substr(implode("\n", $lines), 0, 8000);

$systemPrompt = 'Ты — опытный руководитель отдела продаж, анализируешь список незавершённых сделок продавца в '
    . 'Таджикистане (CRM для соцсетей). Для КАЖДОГО client_id из списка оцени риск, что сделка сорвётся/клиент '
    . 'уйдёт без покупки, от 0 (всё хорошо, клиент точно купит) до 100 (сделка почти наверняка потеряна). '
    . 'Учитывай: как давно не отвечали клиенту, тон переписки, есть ли открытый вопрос без ответа, признаки '
    . 'раздражения или сомнений клиента. Верни СТРОГО JSON без пояснений вокруг, формата '
    . '{"items": [{"client_id": 123, "risk": 0-100, "reason": "..."}]}. '
    . 'reason — ОДНА короткая фраза на русском или таджикском (языке переписки), с конкретной причиной и что делать, '
    . 'например "клиент 40 минут ждёт ответ про размер" или "спрашивал скидку, ответа не было". '
    . 'Верни ровно по одному объекту на каждый client_id из списка, ничего не пропускай.';

$payload = [
    'model' => GROQ_MODEL,
    'messages' => [
        ['role' => 'system', 'content' => $systemPrompt],
        ['role' => 'user', 'content' => "Сделки:\n{$transcript}"],
    ],
    'temperature' => 0.3,
    // response_format: json_object убран — актуальные модели Groq отдают
    // на нём 400 json_validate_failed; JSON просится текстом в systemPrompt
    // и разбирается тем же fallback-парсером, что и ниже. 2000 вместо 1500 —
    // до 25 клиентов в одном ответе, легко упереться в старый потолок.
    'max_tokens' => 2000,
];

[$response, $httpCode, $err] = groq_request($payload);

if ($response === null || $httpCode >= 400 || $httpCode === 0) {
    json_out(['error' => 'Ошибка Groq API: ' . groq_error_detail($response, $httpCode, $err)], 502);
}

$data = json_decode($response, true);
$content = trim((string)($data['choices'][0]['message']['content'] ?? ''));
$parsed = json_decode($content, true);
if (!is_array($parsed)) {
    $stripped = preg_replace('/^```(?:json)?|```$/m', '', $content);
    $parsed = json_decode(trim((string)$stripped), true);
}
$items = is_array($parsed) && is_array($parsed['items'] ?? null) ? $parsed['items'] : null;
if ($items === null) {
    json_out(['error' => 'Не удалось разобрать ответ ИИ'], 502);
}

$validIds = array_flip($ids);
$upd = $pdo->prepare("UPDATE clients SET ai_risk_score = :s, ai_risk_reason = :r, ai_risk_at = datetime('now') WHERE id = :id AND user_id = :uid");
$out = [];
foreach ($items as $it) {
    if (!is_array($it)) continue;
    $cid = (int)($it['client_id'] ?? 0);
    if (!isset($validIds[$cid])) continue;
    $risk = max(0, min(100, (int)($it['risk'] ?? 0)));
    $reason = mb_substr(trim((string)($it['reason'] ?? '')), 0, 200);
    $upd->execute([':s' => $risk, ':r' => $reason !== '' ? $reason : null, ':id' => $cid, ':uid' => $userId]);
    $out[] = ['client_id' => $cid, 'risk' => $risk, 'reason' => $reason !== '' ? $reason : null];
}

json_out(['scanned' => count($clientRows), 'clients' => $out]);
