# MySavdo

## Настройка подтверждения email

Регистрация может отправлять пользователю 6-значный код подтверждения на почту. Письма уходят через Gmail SMTP (библиотека [PHPMailer](https://github.com/PHPMailer/PHPMailer), файлы вынесены в `backend/lib/PHPMailer/` — без Composer, как и весь остальной проект).

### 1. Получить App Password в Gmail

Обычный пароль от Gmail для SMTP не подойдёт — нужен отдельный пароль приложения:

1. Включите двухфакторную аутентификацию (2FA) на аккаунте Google, если она ещё не включена: https://myaccount.google.com/security
2. Откройте https://myaccount.google.com/apppasswords
3. Создайте новый пароль приложения (можно назвать, например, «MySavdo»)
4. Google покажет 16-символьный пароль вида `xxxx xxxx xxxx xxxx` — это и есть `SMTP_PASS`

### 2. Переменные окружения

Добавьте в `.env` (см. `.env.example`):

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=your-gmail-address@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
SMTP_SECURE=true
```

- `SMTP_USER` — адрес Gmail, с которого будут уходить письма. Gmail не позволяет подставить произвольный `From`, поэтому письма всегда отправляются именно с этого адреса.
- `SMTP_PORT=465` — implicit TLS (SMTPS). Если нужен `587`, код сам переключится на STARTTLS.

### 3. Как это работает

- `POST backend/api/request-verification.php` `{ "email": "..." }` — генерирует код, отправляет письмо. Не чаще раза в 60 секунд на один email. Всегда отвечает `{"ok": true}`, не раскрывая, зарегистрирован ли такой email.
- `POST backend/api/verify-email.php` `{ "email": "...", "code": "123456" }` — проверяет код. При успехе помечает `users.is_verified = 1` и `users.email_verified_at`, удаляет код. После 5 неверных попыток код аннулируется и нужно запросить новый.
- Код хранится в таблице `email_verifications` только в виде bcrypt-хэша (`code_hash`), с TTL 10 минут — сам код нигде не сохраняется в открытом виде.
- Ошибки отправки (недоступен SMTP, неверный пароль приложения и т.п.) пишутся в `database/php-error.log`; клиент в любом случае получает нейтральный ответ.
