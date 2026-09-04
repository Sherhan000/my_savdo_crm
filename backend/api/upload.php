<?php

declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
start_session();

if (empty($_SESSION['user_id']) && empty($_SESSION['is_admin'])) {
    json_out(['error' => 'Не авторизован'], 401);
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(['error' => 'Метод не поддерживается'], 405);
}
csrf_verify();

$kind = null;
if (!empty($_FILES['photo']) && is_array($_FILES['photo'])) {
    $kind = 'photo';
    $file = $_FILES['photo'];
} elseif (!empty($_FILES['audio']) && is_array($_FILES['audio'])) {
    $kind = 'audio';
    $file = $_FILES['audio'];
} elseif (!empty($_FILES['video']) && is_array($_FILES['video'])) {
    // Видео для историй на главном экране (грузит админ) или для поста в
    // свою Telegram-группу (грузит обычный продавец) — оба пути используют
    // одну и ту же валидацию; авторизация уже проверена выше.
    $kind = 'video';
    $file = $_FILES['video'];
} else {
    json_out(['error' => 'Файл не передан'], 422);
}

if ((int)$file['error'] !== UPLOAD_ERR_OK) {
    json_out(['error' => 'Ошибка загрузки файла (код ' . $file['error'] . ')'], 422);
}

$maxBytes = $kind === 'video' ? 40 * 1024 * 1024 : 8 * 1024 * 1024;
if ((int)$file['size'] > $maxBytes) {
    json_out(['error' => $kind === 'video' ? 'Видео слишком большое — максимум 40 МБ' : 'Файл слишком большой — максимум 8 МБ'], 422);
}

$allowedPhoto = [
    'image/jpeg' => 'jpg',
    'image/png' => 'png',
    'image/webp' => 'webp',
    'image/gif' => 'gif',
];

$allowedAudio = [
    'audio/webm' => 'webm',
    'video/webm' => 'webm',
    'audio/ogg'  => 'ogg',
    'application/ogg' => 'ogg',
    'audio/mp4'  => 'm4a',
    'video/mp4'  => 'm4a',
    'audio/mpeg' => 'mp3',
    'audio/x-m4a' => 'm4a',
];

$allowedVideo = [
    'video/mp4'       => 'mp4',
    'video/webm'      => 'webm',
    'video/quicktime' => 'mov',
];

$allowed = $kind === 'photo' ? $allowedPhoto : ($kind === 'video' ? $allowedVideo : $allowedAudio);

if (!function_exists('finfo_open')) {
    json_out(['error' => 'Загрузка файлов недоступна на этом сервере (нет расширения PHP fileinfo)'], 500);
}

$finfo = finfo_open(FILEINFO_MIME_TYPE);
$mime = $finfo ? finfo_file($finfo, $file['tmp_name']) : false;
if ($finfo) {
    finfo_close($finfo);
}

if ($mime === false || !isset($allowed[$mime])) {
    $msg = 'Не удалось распознать аудиофайл — попробуйте записать голосовое ещё раз';
    if ($kind === 'photo') $msg = 'Разрешены только изображения (JPG, PNG, WEBP, GIF)';
    if ($kind === 'video') $msg = 'Разрешены только видео (MP4, WEBM, MOV)';
    json_out(['error' => $msg], 422);
}

$uploadsDir = __DIR__ . '/../../assets/img/uploads';
if (!is_dir($uploadsDir)) {
    @mkdir($uploadsDir, 0775, true);
}

$name = bin2hex(random_bytes(12)) . '.' . $allowed[$mime];
$destination = $uploadsDir . '/' . $name;

if (!@move_uploaded_file($file['tmp_name'], $destination)) {
    json_out(['error' => 'Не удалось сохранить файл на сервере'], 500);
}

json_out(['url' => 'assets/img/uploads/' . $name]);
