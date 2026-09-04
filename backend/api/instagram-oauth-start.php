<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/instagram-meta.php';
start_session();

if (empty($_SESSION['user_id'])) {
    json_fail('Не авторизован', 401);
}

if (INSTAGRAM_APP_ID === '' || INSTAGRAM_APP_SECRET === '') {
    json_fail('Вход через Instagram не настроен на сервере (не задан INSTAGRAM_APP_ID/INSTAGRAM_APP_SECRET)', 500);
}

$state = bin2hex(random_bytes(16));
$_SESSION['ig_oauth_state'] = $state;

$authorizeUrl = INSTAGRAM_OAUTH_AUTHORIZE_URL . '?' . http_build_query([
    'client_id' => INSTAGRAM_APP_ID,
    'redirect_uri' => instagram_meta_redirect_uri(),
    'response_type' => 'code',
    'scope' => INSTAGRAM_OAUTH_SCOPE,
    'state' => $state,
]);

header('Location: ' . $authorizeUrl);
exit;
