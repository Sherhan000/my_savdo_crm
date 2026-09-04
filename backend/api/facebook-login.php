<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/facebook.php';
start_session();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(['error' => 'Метод не поддерживается'], 405);
}
csrf_verify();

if (FACEBOOK_APP_ID === '' || FACEBOOK_APP_ID === 'ВСТАВЬ_СЮДА_СВОЙ_APP_ID') {
    json_out(['error' => 'Вход через Facebook не настроен: не задан FACEBOOK_APP_ID в backend/config/facebook.php'], 500);
}

rate_limit_guard('oauth_facebook', 'global', 20, 15);

$body = json_body();
$accessToken = (string)($body['accessToken'] ?? '');

if ($accessToken === '') {
    json_out(['error' => 'Не передан токен Facebook'], 422);
}

$profile = facebook_verify_token($accessToken);

if (!$profile) {
    rate_limit_fail('oauth_facebook', 'global', 20, 15);
    json_out(['error' => 'Не удалось проверить токен Facebook — истёк или выдан для другого приложения'], 401);
}

$facebookId = $profile['id'];
$email = $profile['email'] ? strtolower($profile['email']) : null;
$name = $profile['name'] ?? ($email ? explode('@', $email)[0] : 'Мой магазин');
$avatar = $profile['picture'] ?? null;

$user = store_find_user_by_facebook_id($facebookId);

if (!$user && $email && store_find_user_by_email($email)) {
    json_out(['error' => 'Аккаунт с такой почтой уже зарегистрирован — войдите обычным способом (email/пароль, Google или Telegram), а Facebook можно будет привязать в настройках профиля'], 409);
}

if (!$user) {
    if (!$email) {
        json_out(['error' => 'Facebook не передал email — разрешите доступ к email в настройках приложения Facebook и повторите вход'], 422);
    }
    $hash = password_hash(bin2hex(random_bytes(16)), PASSWORD_BCRYPT);
    $user = store_create_user($name, $email, $hash, [
        'facebook_id' => $facebookId,
        'avatar' => $avatar,
        'password_set' => false,
    ]);

    store_mark_user_verified((int)$user['id']);
    $user = store_find_user_by_id((int)$user['id']);
}

session_regenerate_id(true);
$_SESSION['user_id'] = $user['id'];

json_out(['user' => [
    'id' => $user['id'],
    'shop_name' => $user['shop_name'],
    'email' => $user['email'],
    'plan' => $user['plan'],
    'avatar' => $user['avatar'] ?? null,
    'username' => $user['username'] ?? null,
    'is_guest' => !empty($user['is_guest']),
]]);
