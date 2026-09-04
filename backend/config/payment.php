<?php
declare(strict_types=1);

if (!defined('PAYMENT_CARD_NUMBER')) {
    define('PAYMENT_CARD_NUMBER', getenv('PAYMENT_CARD_NUMBER') ?: '0000 0000 0000 0000');
}
if (!defined('PAYMENT_CARD_HOLDER')) {
    define('PAYMENT_CARD_HOLDER', getenv('PAYMENT_CARD_HOLDER') ?: 'ИМЯ ВЛАДЕЛЬЦА');
}
if (!defined('PAYMENT_BANK_NAME')) {
    define('PAYMENT_BANK_NAME', getenv('PAYMENT_BANK_NAME') ?: 'Название банка');
}
if (!defined('PAYMENT_COMMENT_PREFIX')) {

    define('PAYMENT_COMMENT_PREFIX', 'MYSAVDO');
}
