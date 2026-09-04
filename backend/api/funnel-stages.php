<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/shop.php';
start_session();

if (empty($_SESSION['user_id'])) {
    json_fail('Не авторизован', 401);
}
$userId = (int)$_SESSION['user_id'];

$pdo = db();
if (!$pdo) {
    json_fail('Хранилище недоступно на этом сервере (нет PDO SQLite)', 503);
}

const FUNNEL_CUSTOM_STAGES_MAX = 12;
// 5 стандартных этапов, зашитых в бэкенде (см. clients.php/achievements.php) —
// их id менять нельзя, но порядок и видимость колонки — можно.
const FUNNEL_BUILTIN_KEYS = ['new', 'consult', 'deal', 'pay', 'done'];

function funnel_stage_out(array $row): array {
    return [
        'key' => $row['stage_key'],
        'title' => $row['title'],
        'position' => (int)$row['position'],
    ];
}

function funnel_custom_stages_list(PDO $pdo, int $userId): array {
    $stmt = $pdo->prepare('SELECT * FROM funnel_custom_stages WHERE user_id = :uid ORDER BY position ASC, id ASC');
    $stmt->execute([':uid' => $userId]);
    return array_map('funnel_stage_out', $stmt->fetchAll());
}

// col_key => ['position' => int, 'hidden' => bool]
function funnel_column_prefs_map(PDO $pdo, int $userId): array {
    $stmt = $pdo->prepare('SELECT col_key, position, hidden FROM funnel_column_prefs WHERE user_id = :uid');
    $stmt->execute([':uid' => $userId]);
    $out = [];
    foreach ($stmt->fetchAll() as $row) {
        $out[$row['col_key']] = ['position' => (int)$row['position'], 'hidden' => (bool)$row['hidden']];
    }
    return $out;
}

// Полный порядок ключей (стандартные + свои) с учётом сохранённых
// предпочтений; колонки без сохранённой позиции остаются в естественном
// порядке в конце списка.
function funnel_full_order(array $naturalKeys, array $prefs): array {
    $withPref = array_values(array_filter($naturalKeys, fn($k) => isset($prefs[$k])));
    usort($withPref, fn($a, $b) => $prefs[$a]['position'] <=> $prefs[$b]['position']);
    $withoutPref = array_values(array_diff($naturalKeys, $withPref));
    return array_merge($withPref, $withoutPref);
}

function funnel_hidden_keys(array $naturalKeys, array $prefs): array {
    return array_values(array_filter($naturalKeys, fn($k) => !empty($prefs[$k]['hidden'])));
}

function funnel_state_out(PDO $pdo, int $userId, array $customStages): array {
    $naturalKeys = array_merge(FUNNEL_BUILTIN_KEYS, array_map(fn($s) => $s['key'], $customStages));
    $prefs = funnel_column_prefs_map($pdo, $userId);
    return [
        'stages' => $customStages,
        'order' => funnel_full_order($naturalKeys, $prefs),
        'hidden' => funnel_hidden_keys($naturalKeys, $prefs),
    ];
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    json_out(funnel_state_out($pdo, $userId, funnel_custom_stages_list($pdo, $userId)));
}

if ($method !== 'POST') {
    json_fail('Метод не поддерживается', 405);
}
csrf_verify();
require_owner_session();

$body = json_body();
$action = (string)($body['action'] ?? '');

if ($action === 'add') {
    $title = mb_substr(trim((string)($body['title'] ?? '')), 0, 30);
    if ($title === '') {
        json_fail('Введите название колонки', 422);
    }

    $countStmt = $pdo->prepare('SELECT COUNT(*), COALESCE(MAX(position), -1) FROM funnel_custom_stages WHERE user_id = :uid');
    $countStmt->execute([':uid' => $userId]);
    [$count, $maxPos] = $countStmt->fetch(PDO::FETCH_NUM);
    if ((int)$count >= FUNNEL_CUSTOM_STAGES_MAX) {
        json_fail('Можно добавить не больше ' . FUNNEL_CUSTOM_STAGES_MAX . ' своих колонок — сначала удалите ненужные', 422);
    }

    $pdo->prepare('INSERT INTO funnel_custom_stages (user_id, stage_key, title, position) VALUES (:uid, :k, :t, :p)')
        ->execute([':uid' => $userId, ':k' => 'pending', ':t' => $title, ':p' => (int)$maxPos + 1]);
    $newId = (int)$pdo->lastInsertId();
    $stageKey = 'custom_' . $newId;
    $pdo->prepare('UPDATE funnel_custom_stages SET stage_key = :k WHERE id = :id')
        ->execute([':k' => $stageKey, ':id' => $newId]);

    json_out(array_merge(['ok' => true], funnel_state_out($pdo, $userId, funnel_custom_stages_list($pdo, $userId))), 201);
}

if ($action === 'rename') {
    $key = (string)($body['key'] ?? '');
    $title = mb_substr(trim((string)($body['title'] ?? '')), 0, 30);
    if ($title === '') {
        json_fail('Введите название колонки', 422);
    }
    $stmt = $pdo->prepare('UPDATE funnel_custom_stages SET title = :t WHERE user_id = :uid AND stage_key = :k');
    $stmt->execute([':t' => $title, ':uid' => $userId, ':k' => $key]);
    if ($stmt->rowCount() === 0) {
        json_fail('Колонка не найдена', 404);
    }
    json_out(array_merge(['ok' => true], funnel_state_out($pdo, $userId, funnel_custom_stages_list($pdo, $userId))));
}

if ($action === 'delete') {
    $key = (string)($body['key'] ?? '');
    $stmt = $pdo->prepare('DELETE FROM funnel_custom_stages WHERE user_id = :uid AND stage_key = :k');
    $stmt->execute([':uid' => $userId, ':k' => $key]);
    if ($stmt->rowCount() === 0) {
        json_fail('Колонка не найдена', 404);
    }
    // Карточки, которые были в этой колонке, не теряем — переносим на
    // самый первый этап, чтобы они остались на виду и не потерялись.
    $pdo->prepare("UPDATE clients SET stage = 'new' WHERE user_id = :uid AND stage = :k")
        ->execute([':uid' => $userId, ':k' => $key]);
    $pdo->prepare('DELETE FROM funnel_column_prefs WHERE user_id = :uid AND col_key = :k')
        ->execute([':uid' => $userId, ':k' => $key]);
    json_out(array_merge(['ok' => true], funnel_state_out($pdo, $userId, funnel_custom_stages_list($pdo, $userId))));
}

if ($action === 'reorder') {
    $customStages = funnel_custom_stages_list($pdo, $userId);
    $naturalKeys = array_merge(FUNNEL_BUILTIN_KEYS, array_map(fn($s) => $s['key'], $customStages));
    $rawKeys = $body['keys'] ?? null;
    if (!is_array($rawKeys)) {
        json_fail('Некорректный порядок колонок', 422);
    }
    $keys = array_values(array_map('strval', $rawKeys));
    // Порядок обязан содержать ровно тот же набор колонок, что есть у
    // продавца сейчас — ни одной чужой, ни одной потерянной.
    $sortedKeys = $keys;
    sort($sortedKeys);
    $sortedExpected = $naturalKeys;
    sort($sortedExpected);
    if ($sortedKeys !== $sortedExpected) {
        json_fail('Некорректный порядок колонок', 422);
    }
    $prefs = funnel_column_prefs_map($pdo, $userId);

    $pdo->beginTransaction();
    try {
        $upsert = $pdo->prepare('INSERT INTO funnel_column_prefs (user_id, col_key, position, hidden) VALUES (:uid, :k, :p, :h)
            ON CONFLICT(user_id, col_key) DO UPDATE SET position = excluded.position');
        foreach ($keys as $i => $key) {
            $hidden = !empty($prefs[$key]['hidden']);
            $upsert->execute([':uid' => $userId, ':k' => $key, ':p' => $i, ':h' => $hidden ? 1 : 0]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_fail('Не удалось сохранить порядок колонок', 500);
    }

    json_out(array_merge(['ok' => true], funnel_state_out($pdo, $userId, $customStages)));
}

if ($action === 'toggle') {
    $customStages = funnel_custom_stages_list($pdo, $userId);
    $naturalKeys = array_merge(FUNNEL_BUILTIN_KEYS, array_map(fn($s) => $s['key'], $customStages));
    $key = (string)($body['key'] ?? '');
    $hidden = !empty($body['hidden']);
    if (!in_array($key, $naturalKeys, true)) {
        json_fail('Колонка не найдена', 404);
    }

    if ($hidden) {
        $prefs = funnel_column_prefs_map($pdo, $userId);
        $currentlyHidden = funnel_hidden_keys($naturalKeys, $prefs);
        if (!in_array($key, $currentlyHidden, true) && count($currentlyHidden) + 1 >= count($naturalKeys)) {
            json_fail('Нужна хотя бы одна активная колонка', 422);
        }
    }

    $order = funnel_full_order($naturalKeys, funnel_column_prefs_map($pdo, $userId));
    $position = array_search($key, $order, true);
    $position = $position === false ? count($order) : $position;

    $pdo->prepare('INSERT INTO funnel_column_prefs (user_id, col_key, position, hidden) VALUES (:uid, :k, :p, :h)
        ON CONFLICT(user_id, col_key) DO UPDATE SET hidden = excluded.hidden')
        ->execute([':uid' => $userId, ':k' => $key, ':p' => $position, ':h' => $hidden ? 1 : 0]);

    json_out(array_merge(['ok' => true], funnel_state_out($pdo, $userId, $customStages)));
}

json_fail('Неизвестное действие', 422);
