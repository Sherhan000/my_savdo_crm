<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
require_once __DIR__ . '/../config/instagram-meta.php';
start_session();

function instagram_oauth_fail(string $reason): void {
    header('Location: ' . instagram_meta_site_root() . '/?ig_error=' . rawurlencode($reason));
    exit;
}

if (empty($_SESSION['user_id'])) {
    instagram_oauth_fail('session');
}
$userId = (int)$_SESSION['user_id'];

if (!empty($_GET['error'])) {
    instagram_oauth_fail('denied');
}

$state = (string)($_GET['state'] ?? '');
$expectedState = (string)($_SESSION['ig_oauth_state'] ?? '');
unset($_SESSION['ig_oauth_state']);
if ($state === '' || $expectedState === '' || !hash_equals($expectedState, $state)) {
    instagram_oauth_fail('state');
}

$code = (string)($_GET['code'] ?? '');
if ($code === '') {
    instagram_oauth_fail('code');
}

$pdo = db();
if (!$pdo) {
    instagram_oauth_fail('storage');
}

$short = instagram_meta_exchange_code($code);
if (!$short || empty($short['access_token']) || empty($short['user_id'])) {
    instagram_oauth_fail('exchange');
}

$long = instagram_meta_long_lived_token((string)$short['access_token']);
if (!$long || empty($long['access_token'])) {
    instagram_oauth_fail('exchange');
}

$igUserId = (string)$short['user_id'];
$accessToken = (string)$long['access_token'];
$expiresIn = (int)($long['expires_in'] ?? 5184000);

$profile = instagram_meta_profile($accessToken, $igUserId);
$username = $profile['username'] ?? null;

error_log('[MySavdo IG Meta] OAuth-подключение: user_id из обмена кода=' . $igUserId
    . ', user_id из профиля=' . ($profile['user_id'] ?? 'нет')
    . ', username=' . ($username ?? 'нет'));

// ID из обмена кода на токен и "канонический" ID профиля (именно он приходит
// в entry[].id вебхуков от Meta) — разные значения. Сохраняем профильный,
// иначе входящие сообщения никогда не найдут аккаунт в instagram_accounts.
if (!empty($profile['user_id'])) {
    $igUserId = (string)$profile['user_id'];
}

$tokenExpires = date('Y-m-d H:i:s', time() + $expiresIn);

$existing = $pdo->prepare('SELECT user_id FROM instagram_accounts WHERE ig_user_id = :igid');
$existing->execute([':igid' => $igUserId]);
$existingUserId = $existing->fetchColumn();
if ($existingUserId !== false && (int)$existingUserId !== $userId) {
    instagram_oauth_fail('taken');
}

$subscribed = instagram_meta_subscribe($accessToken, $igUserId);
if (!$subscribed) {
    error_log("[MySavdo IG Meta] Не удалось подписать аккаунт на вебхуки: ig_user_id={$igUserId}, user_id={$userId}");
}

$pdo->prepare('INSERT INTO instagram_accounts (user_id, ig_user_id, username, access_token, token_expires, subscribed)
                VALUES (:uid, :igid, :un, :tok, :exp, :sub)
                ON CONFLICT(user_id) DO UPDATE SET
                  ig_user_id = excluded.ig_user_id,
                  username = excluded.username,
                  access_token = excluded.access_token,
                  token_expires = excluded.token_expires,
                  subscribed = excluded.subscribed')
    ->execute([
        ':uid' => $userId,
        ':igid' => $igUserId,
        ':un' => $username,
        ':tok' => $accessToken,
        ':exp' => $tokenExpires,
        ':sub' => $subscribed ? 1 : 0,
    ]);

$redirect = instagram_meta_site_root() . '/?ig_connected=1';
if (!$subscribed) {
    $redirect .= '&ig_warn=subscribe_failed';
}
header('Location: ' . $redirect);
exit;
