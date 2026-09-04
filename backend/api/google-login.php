<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/google.php';
start_session();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(['error' => 'Метод не поддерживается'], 405);
}
csrf_verify();

if (GOOGLE_CLIENT_ID === '' || GOOGLE_CLIENT_ID === 'ВСТАВЬ_СЮДА_СВОЙ_CLIENT_ID') {
    json_out(['error' => 'Вход через Google не настроен: не задан GOOGLE_CLIENT_ID в backend/config/google.php'], 500);
}

rate_limit_guard('oauth_google', 'global', 20, 15);

$body = json_body();
$credential = (string)($body['credential'] ?? '');

if ($credential === '') {
    json_out(['error' => 'Не передан токен Google'], 422);
}

$tokenData = google_verify_id_token($credential);

if (!$tokenData) {
    rate_limit_fail('oauth_google', 'global', 20, 15);
    json_out(['error' => 'Не удалось проверить токен Google — истёк или выдан для другого приложения'], 401);
}

if (($tokenData['email_verified'] ?? 'false') !== 'true') {
    json_out(['error' => 'Email в Google-аккаунте не подтверждён'], 401);
}

$email = strtolower($tokenData['email']);
$name = $tokenData['name'] ?? $tokenData['given_name'] ?? explode('@', $email)[0];
$googleId = (string)($tokenData['sub'] ?? '');
$avatar = $tokenData['picture'] ?? null;

$user = $googleId !== '' ? store_find_user_by_google_id($googleId) : null;

// Если Google-аккаунт ещё не привязан, но email совпадает с уже
// зарегистрированным паролем аккаунтом — не привязываем автоматически
// (как и facebook-login.php ниже): подтверждённый email на стороне Google
// не доказывает, что человек знает пароль от существующего аккаунта MySavdo.
// Привязка делается осознанно, через профиль, обычным входом.
if (!$user && $email && store_find_user_by_email($email)) {
    json_out(['error' => 'Аккаунт с такой почтой уже зарегистрирован — войдите обычным способом (email/пароль, Facebook или Telegram), а Google можно будет привязать в настройках профиля'], 409);
}

if (!$user) {
    $hash = password_hash(bin2hex(random_bytes(16)), PASSWORD_BCRYPT);
    $user = store_create_user($name, $email, $hash, [
        'google_id' => $googleId,
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
