<?php
declare(strict_types=1);

// Достаёт из переписки с клиентом структурированные детали заказа (товар,
// вариант/размер/цвет, город, сумма, если она реально прозвучала в чате) —
// продавцу больше не нужно вручную перечитывать историю и переносить это в
// заметку самому. Ничего не пишет в базу сам — только возвращает предложение,
// применяет его фронтенд отдельным PATCH к clients.php по кнопке продавца.

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
if (empty($feat['ai_reply'])) {
    json_fail('ИИ-подсказки недоступны на вашем тарифе или отключены администратором', 403, null);
}

// Тот же щедрый, но конечный потолок, что и у подсказок ответа (mode=reply
// в ai-reply.php) — отдельный от дневного лимита тарифа ключ действия.
rate_limit_guard('ai_extract_order', (string)$userId, 60, 10);
rate_limit_fail('ai_extract_order', (string)$userId, 60, 10);

$body = json_body();
$clientId = (int)($body['client_id'] ?? 0);
if ($clientId <= 0) {
    json_fail('Не указан client_id', 422);
}

$clientStmt = $pdo->prepare('SELECT id, name FROM clients WHERE id = :id AND user_id = :uid');
$clientStmt->execute([':id' => $clientId, ':uid' => $userId]);
$client = $clientStmt->fetch();
if (!$client) {
    json_fail('Заявка не найдена', 404);
}

$msgStmt = $pdo->prepare(
    "SELECT direction, text FROM messages
      WHERE client_id = :cid AND text IS NOT NULL AND text != ''
      ORDER BY id DESC LIMIT 40"
);
$msgStmt->execute([':cid' => $clientId]);
$history = array_reverse($msgStmt->fetchAll());

if (!$history) {
    json_out(['error' => 'В переписке пока нет текстовых сообщений — извлекать нечего'], 422);
}

if (GROQ_API_KEY === '' || strpos(GROQ_API_KEY, 'ВСТАВЬ_СЮДА') !== false) {
    json_out(['error' => 'Ключ Groq не настроен на сервере — извлечение заказа недоступно в демо-режиме'], 503);
}

$transcript = '';
foreach ($history as $h) {
    $who = $h['direction'] === 'in' ? 'Клиент' : 'Продавец';
    $transcript .= $who . ': ' . trim((string)$h['text']) . "\n";
}
$transcript = mb_substr($transcript, 0, 6000);

$systemPrompt = 'Ты помогаешь продавцу в Таджикистане разобрать переписку с клиентом и вытащить детали заказа. '
    . 'НИЧЕГО НЕ ВЫДУМЫВАЙ — бери только то, что реально сказано в переписке. Если какого-то поля в переписке нет, '
    . 'оставь его пустой строкой. Особенно осторожно с полем budget: заполняй его ТОЛЬКО если в переписке названо '
    . 'конкретное число (сумма, цена, "беру за X"), а не общими словами вроде "недорого". '
    . 'Верни СТРОГО JSON без пояснений вокруг, формата: '
    . '{"item": "...", "variant": "...", "city": "...", "budget": "...", "budget_currency": "...", "summary": "..."}. '
    . 'item — что хочет клиент (товар/услуга), variant — размер/цвет/модель/количество, city — город доставки, '
    . 'budget — число без валюты, если названо (иначе ""), budget_currency — валюта, если названа (иначе ""), '
    . 'summary — одна короткая строка на русском или таджикском (языке переписки), резюмирующая заказ для заметки '
    . 'в CRM, например: "Платье M, синее, доставка в Худжанд, 350 сомони".';

$payload = [
    'model' => GROQ_MODEL,
    'messages' => [
        ['role' => 'system', 'content' => $systemPrompt],
        ['role' => 'user', 'content' => "Переписка с клиентом «{$client['name']}»:\n{$transcript}"],
    ],
    'temperature' => 0.2,
    // response_format: json_object убран — актуальные модели Groq отдают
    // на нём 400 json_validate_failed; JSON просится текстом в systemPrompt
    // и разбирается тем же fallback-парсером, что и ниже.
    'max_tokens' => 400,
];

[$response, $httpCode, $err] = groq_request($payload);

if ($response === null || $httpCode >= 400 || $httpCode === 0) {
    json_out(['error' => 'Ошибка Groq API: ' . groq_error_detail($response, $httpCode, $err)], 502);
}

$data = json_decode($response, true);
$content = trim((string)($data['choices'][0]['message']['content'] ?? ''));
if ($content === '') {
    json_out(['error' => 'Groq не вернул ответ'], 502);
}

$parsed = json_decode($content, true);
if (!is_array($parsed)) {
    $stripped = preg_replace('/^```(?:json)?|```$/m', '', $content);
    $parsed = json_decode(trim((string)$stripped), true);
}
if (!is_array($parsed)) {
    json_out(['error' => 'Не удалось разобрать ответ ИИ'], 502);
}

$item = trim((string)($parsed['item'] ?? ''));
$variant = trim((string)($parsed['variant'] ?? ''));
$city = trim((string)($parsed['city'] ?? ''));
$budgetRaw = trim((string)($parsed['budget'] ?? ''));
$budgetCurrency = trim((string)($parsed['budget_currency'] ?? ''));
$summary = trim((string)($parsed['summary'] ?? ''));

// budget отдаём фронту только если это реально распознаётся как число —
// не доверяем ИИ слепо на поле, которое может лечь в сумму сделки.
$budget = null;
if ($budgetRaw !== '' && preg_match('/^\d+(?:[.,]\d+)?$/', $budgetRaw)) {
    $budget = (int)round((float)str_replace(',', '.', $budgetRaw));
}

json_out([
    'found' => !($item === '' && $variant === '' && $city === '' && $budget === null && $summary === ''),
    'item' => $item !== '' ? $item : null,
    'variant' => $variant !== '' ? $variant : null,
    'city' => $city !== '' ? $city : null,
    'budget' => $budget,
    'budget_currency' => $budgetCurrency !== '' ? $budgetCurrency : null,
    'summary' => $summary !== '' ? $summary : null,
]);
