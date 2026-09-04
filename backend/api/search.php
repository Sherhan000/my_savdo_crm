<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
start_session();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_out(['error' => 'Метод не поддерживается'], 405);
}

$pdo = db();
if (!$pdo) {
    json_out(['results' => []]);
}

$q = strtolower(trim((string)($_GET['q'] ?? '')));
if ($q === '' || mb_strlen($q) < 2) {
    json_out(['results' => []]);
}
$q = mb_substr($q, 0, 24);

rate_limit_guard('search', 'global', 120, 5);

$meId = (int)($_SESSION['user_id'] ?? 0);

$stmt = $pdo->prepare(
    "SELECT id, username, shop_name, avatar, is_shop, shop_username
       FROM users
      WHERE is_guest = 0 AND username IS NOT NULL
        AND (username LIKE :qprefix ESCAPE '\\' OR lower(shop_name) LIKE :qcontains ESCAPE '\\')
      ORDER BY (username = :qexact) DESC, is_shop DESC, username ASC
      LIMIT 20"
);
$escaped = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $q);
$stmt->execute([':qprefix' => $escaped . '%', ':qcontains' => '%' . $escaped . '%', ':qexact' => $q]);
$rows = $stmt->fetchAll();

$results = array_values(array_filter(array_map(function (array $r) use ($meId): ?array {
    if ((int)$r['id'] === $meId) {
        return null;
    }
    return [
        'id' => (int)$r['id'],
        'username' => $r['username'],
        'display_name' => $r['shop_name'] ?: $r['username'],
        'avatar' => $r['avatar'] ?: null,
        'is_shop' => !empty($r['is_shop']),
        'shop_username' => $r['shop_username'] ?: null,
    ];
}, $rows)));

rate_limit_fail('search', 'global', 120, 5);

json_out(['results' => $results]);
