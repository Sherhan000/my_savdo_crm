<?php
declare(strict_types=1);

require_once __DIR__ . '/groq.php';
require_once __DIR__ . '/features.php';

function autoreply_generate(PDO $pdo, int $userId, int $clientId, string $channelLabel = 'мессенджере'): ?string {

    $ownerFeatures = user_features($pdo, $userId);
    if (empty($ownerFeatures['ai_auto'])) {
        return null;
    }
    if (GROQ_API_KEY === '' || strpos(GROQ_API_KEY, 'ВСТАВЬ_СЮДА') !== false) {
        return null;
    }

    $histStmt = $pdo->prepare(
        'SELECT direction, text FROM messages
          WHERE client_id = :cid AND text IS NOT NULL
       ORDER BY id DESC LIMIT 8'
    );
    $histStmt->execute([':cid' => $clientId]);
    $history = array_reverse($histStmt->fetchAll());
    if (!$history) {
        return null;
    }

    $chatMessages = [[
        'role' => 'system',
        'content' => 'Ты — вежливый ассистент продавца в интернет-магазине в Таджикистане, отвечаешь клиенту в '
            . $channelLabel . ' от имени магазина. Ты также глубокий эксперт и носитель таджикского языка — '
            . 'свободно понимаешь литературный (забони адабӣ) и разговорный/народный таджикский (забони мардумӣ), '
            . 'региональный сленг и устойчивые выражения, кириллицу и латиницу. '
            . 'Определяй язык клиента автоматически: если он пишет на таджикском (в любом виде — литературно, разговорно, '
            . 'сленгом, кириллицей или латиницей), отвечай ТОЛЬКО на таджикском, живым естественным языком носителя, '
            . 'а не дословным переводом с русского, подстраиваясь под тон клиента (просто и по-свойски — так же и в ответ; '
            . 'официально — грамотным литературным таджикским). Если клиент пишет по-русски или на другом языке — отвечай на этом же языке. '
            . 'Не смешивай языки в одном ответе. '
            . 'Отвечай коротко (1-3 предложения), дружелюбно. '
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

    if ($response === null || $httpCode >= 400) {
        return null;
    }
    $data = json_decode($response, true);
    $reply = trim((string)($data['choices'][0]['message']['content'] ?? ''));

    return $reply !== '' ? $reply : null;
}
