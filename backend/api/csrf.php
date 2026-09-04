<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/bootstrap.php';
start_session();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_out(['error' => 'Метод не поддерживается'], 405);
}

json_out(['token' => csrf_token()]);
