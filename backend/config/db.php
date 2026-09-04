<?php

declare(strict_types=1);

define('DB_AVAILABLE', class_exists('PDO') && in_array('sqlite', PDO::getAvailableDrivers(), true));
define('DB_PATH', __DIR__ . '/../../database/mysavdo.sqlite3');

function db(): ?PDO {
    static $pdo = null;
    static $tried = false;

    if ($pdo !== null) {
        return $pdo;
    }
    if ($tried || !DB_AVAILABLE) {
        return null;
    }
    $tried = true;

    $dir = dirname(DB_PATH);
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
    }

    try {
        $pdo = new PDO('sqlite:' . DB_PATH);
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $pdo->exec('PRAGMA foreign_keys = ON');
        $pdo->exec('PRAGMA journal_mode = WAL');
        // Без этого конкурентная запись (два запроса в одну и ту же секунду —
        // вебхук + обычный визит и т.п.) сразу падает с "database is locked"
        // вместо того чтобы недолго подождать освобождения блокировки.
        $pdo->exec('PRAGMA busy_timeout = 5000');
        db_migrate($pdo);
    } catch (Throwable $e) {
        error_log('[MySavdo DB] Не удалось открыть SQLite-базу: ' . $e->getMessage());
        $pdo = null;
    }

    return $pdo;
}

function db_migrate(PDO $pdo): void {
    // BEGIN IMMEDIATE берёт блокировку на запись сразу — если два запроса
    // одновременно попадут сюда на "холодной" (только что созданной или ещё не
    // до конца смигрированной) базе, второй просто подождёт первого (см.
    // busy_timeout в db()) и, зайдя в транзакцию уже после его COMMIT, увидит
    // колонки/строки уже добавленными и молча пропустит свои ALTER/INSERT —
    // вместо гонки "duplicate column name" / "UNIQUE constraint failed".
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        db_migrate_body($pdo);
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
}

function db_migrate_body(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_name     TEXT NOT NULL DEFAULT 'Мой магазин',
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        google_id     TEXT UNIQUE,
        avatar        TEXT,
        plan          TEXT NOT NULL DEFAULT 'demo',
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)");

    $cols = $pdo->query("PRAGMA table_info(users)")->fetchAll();
    $colNames = array_column($cols, 'name');
    if (!in_array('shop_info', $colNames, true)) {
        $pdo->exec("ALTER TABLE users ADD COLUMN shop_info TEXT");
    }

    if (!in_array('feature_overrides', $colNames, true)) {
        $pdo->exec("ALTER TABLE users ADD COLUMN feature_overrides TEXT");
    }

    if (!in_array('ai_bonus', $colNames, true)) {
        $pdo->exec("ALTER TABLE users ADD COLUMN ai_bonus INTEGER NOT NULL DEFAULT 0");
    }

    if (!in_array('insta_bonus_at', $colNames, true)) {
        $pdo->exec("ALTER TABLE users ADD COLUMN insta_bonus_at TEXT");
    }

    if (!in_array('facebook_id', $colNames, true)) {
        $pdo->exec("ALTER TABLE users ADD COLUMN facebook_id TEXT");
        $pdo->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_facebook_id ON users(facebook_id)");
    }

    if (!in_array('is_verified', $colNames, true)) {
        $pdo->exec("ALTER TABLE users ADD COLUMN is_verified INTEGER NOT NULL DEFAULT 0");
    }

    if (!in_array('telegram_id', $colNames, true)) {
        $pdo->exec("ALTER TABLE users ADD COLUMN telegram_id TEXT");
        $pdo->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id)");
    }

    if (!in_array('is_shop', $colNames, true)) {
        $pdo->exec("ALTER TABLE users ADD COLUMN is_shop INTEGER NOT NULL DEFAULT 0");
    }
    if (!in_array('shop_username', $colNames, true)) {
        $pdo->exec("ALTER TABLE users ADD COLUMN shop_username TEXT");
        $pdo->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_shop_username ON users(shop_username)");
    }
    if (!in_array('employee_slots_purchased', $colNames, true)) {
        $pdo->exec("ALTER TABLE users ADD COLUMN employee_slots_purchased INTEGER NOT NULL DEFAULT 0");
    }
    if (!in_array('password_set', $colNames, true)) {

        $pdo->exec("ALTER TABLE users ADD COLUMN password_set INTEGER NOT NULL DEFAULT 1");
        $pdo->exec("UPDATE users SET password_set = 0 WHERE google_id IS NOT NULL OR facebook_id IS NOT NULL OR telegram_id IS NOT NULL");
    }
    if (!in_array('is_guest', $colNames, true)) {
        $pdo->exec("ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0");
    }
    if (!in_array('username', $colNames, true)) {
        $pdo->exec("ALTER TABLE users ADD COLUMN username TEXT");
        $pdo->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)");
        db_backfill_usernames($pdo);
    }

    $pdo->exec("CREATE TABLE IF NOT EXISTS support_messages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        direction     TEXT NOT NULL DEFAULT 'user',
        text          TEXT NOT NULL,
        via           TEXT NOT NULL DEFAULT 'web',
        read_by_admin INTEGER NOT NULL DEFAULT 0,
        read_by_user  INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_support_user ON support_messages(user_id)");

    $pdo->exec("CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        plan TEXT NOT NULL,
        amount INTEGER NOT NULL,
        payer_name TEXT,
        payer_digits TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS ai_usage (
        user_id INTEGER NOT NULL,
        day TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day)
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS user_click_stats (
        user_id INTEGER NOT NULL,
        target TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        last_at TEXT,
        PRIMARY KEY (user_id, target)
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS user_screen_time (
        user_id INTEGER NOT NULL,
        screen TEXT NOT NULL,
        total_ms INTEGER NOT NULL DEFAULT 0,
        last_at TEXT,
        PRIMARY KEY (user_id, screen)
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS login_attempts (
        key_id TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        blocked_until TEXT
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS user_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        plan TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        starts_at TEXT NOT NULL DEFAULT (datetime('now')),
        ends_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS reviews (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        rating     INTEGER NOT NULL,
        text       TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS clients (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        channel    TEXT NOT NULL DEFAULT 'Telegram',
        channel_id TEXT,
        stage      TEXT NOT NULL DEFAULT 'new',
        value      INTEGER NOT NULL DEFAULT 0,
        sentiment  TEXT NOT NULL DEFAULT 'neu',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(user_id)");

    $pdo->exec("CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        direction  TEXT NOT NULL DEFAULT 'in',
        text       TEXT,
        photo_url  TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(client_id)");

    $pdo->exec("CREATE TABLE IF NOT EXISTS password_resets (
        token      TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS telegram_bots (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        bot_token      TEXT NOT NULL,
        bot_username   TEXT,
        webhook_secret TEXT NOT NULL,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS instagram_accounts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        ig_user_id    TEXT NOT NULL UNIQUE,
        ig_scoped_id  TEXT,
        username      TEXT,
        access_token  TEXT NOT NULL,
        token_expires TEXT,
        subscribed    INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_ig_accounts_igid ON instagram_accounts(ig_user_id)");

    $pdo->exec("CREATE TABLE IF NOT EXISTS instagram_seen (
        mid        TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS instagram_private_accounts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        ig_username TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS shop_employees (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        applicant_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        display_name      TEXT NOT NULL,
        login_id          TEXT UNIQUE,
        password_hash     TEXT,
        status            TEXT NOT NULL DEFAULT 'active',
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at        TEXT
    )");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_shop_employees_shop ON shop_employees(shop_user_id)");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_shop_employees_applicant ON shop_employees(applicant_user_id)");

    db_add_column($pdo, 'clients',  'ai_auto',           "INTEGER NOT NULL DEFAULT 0");
    db_add_column($pdo, 'clients',  'last_seen_at',      "TEXT");
    db_add_column($pdo, 'messages', 'audio_url',         "TEXT");
    db_add_column($pdo, 'user_plans','remaining_seconds', "INTEGER");
    db_add_column($pdo, 'clients',  'notes',             "TEXT");
    db_add_column($pdo, 'clients',  'pinned',            "INTEGER NOT NULL DEFAULT 0");

    // Телефон клиента (запрашивается ботом при первом обращении, см.
    // telegram-webhook.php) и ник/юзернейм в мессенджере/соцсети — два разных
    // способа связаться с клиентом вне самого чата, оба нужны для экспорта в Excel.
    db_add_column($pdo, 'clients',  'phone',              "TEXT");
    db_add_column($pdo, 'clients',  'handle',             "TEXT");
    db_add_column($pdo, 'clients',  'phone_requested_at', "TEXT");

    $pdo->exec("CREATE TABLE IF NOT EXISTS conversations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_a_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_b_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        last_message_at TEXT NOT NULL DEFAULT (datetime('now'))
    )");
    $pdo->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_pair ON conversations(user_a_id, user_b_id)");

    $pdo->exec("CREATE TABLE IF NOT EXISTS dm_messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text            TEXT NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        read_at         TEXT
    )");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_dm_messages_conv ON dm_messages(conversation_id)");

    $pdo->exec("CREATE TABLE IF NOT EXISTS admin_accounts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )");
    db_bootstrap_admin_account($pdo);

    if (!in_array('email_verified_at', $colNames, true)) {
        $pdo->exec("ALTER TABLE users ADD COLUMN email_verified_at TEXT");
    }

    $evExists = $pdo->query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'email_verifications'")->fetchColumn();
    if ($evExists) {
        $evCols = array_column($pdo->query("PRAGMA table_info(email_verifications)")->fetchAll(), 'name');
        if (!in_array('email', $evCols, true)) {
            // Leftover table from the old (pre-Phase-5) token+code verification flow that was
            // removed from this file but never dropped from existing databases — safe to
            // replace, its rows are orphaned codes nothing has read since then.
            $pdo->exec("DROP TABLE email_verifications");
        }
    }

    $pdo->exec("CREATE TABLE IF NOT EXISTS email_verifications (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        email      TEXT NOT NULL,
        code_hash  TEXT NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_email_verifications_email ON email_verifications(email)");

    // Присутствие пользователя (онлайн/оффлайн, "был(а) в сети") — обновляется
    // на каждый авторизованный запрос, см. touch_presence() в store.php.
    db_add_column($pdo, 'users', 'last_active_at', "TEXT");

    // Какой экран открыт у пользователя прямо сейчас — пишется вместе с
    // телеметрией кликов/времени раз в ~минуту, см. backend/api/track.php.
    // Даёт админке "живой" список того, чем пользователь занят сейчас.
    db_add_column($pdo, 'users', 'last_screen', "TEXT");

    // Ответ на сообщение (цитата) — одна и та же колонка в трёх чатах.
    db_add_column($pdo, 'messages',         'reply_to_id', "INTEGER");
    db_add_column($pdo, 'dm_messages',      'reply_to_id', "INTEGER");
    db_add_column($pdo, 'support_messages', 'reply_to_id', "INTEGER");

    // Реакции на сообщения — общая таблица на все виды чатов (client/dm/support),
    // по одной реакции на пользователя на сообщение.
    $pdo->exec("CREATE TABLE IF NOT EXISTS message_reactions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        scope      TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji      TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )");
    $pdo->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_reactions_unique ON message_reactions(scope, message_id, user_id)");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_reactions_lookup ON message_reactions(scope, message_id)");

    // Чат с ИИ-помощником — раньше жил только в памяти браузера; теперь
    // сохраняем, чтобы можно было оценить ответ (лайк/дизлайк уходит админу).
    $pdo->exec("CREATE TABLE IF NOT EXISTS ai_chat_messages (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role           TEXT NOT NULL,
        mode           TEXT NOT NULL DEFAULT 'assistant',
        content        TEXT NOT NULL,
        thinking       TEXT,
        source         TEXT,
        rating         INTEGER,
        rating_comment TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_ai_chat_user ON ai_chat_messages(user_id)");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_ai_chat_rating ON ai_chat_messages(rating)");

    // Дневной срез активности (клики + время на экранах) — на нём строятся
    // фильтры периодов и сравнение "сегодня/вчера" в админке.
    $pdo->exec("CREATE TABLE IF NOT EXISTS user_activity_daily (
        user_id   INTEGER NOT NULL,
        day       TEXT NOT NULL,
        active_ms INTEGER NOT NULL DEFAULT 0,
        clicks    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day)
    )");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_activity_daily_day ON user_activity_daily(day)");

    // Истории (видео от админа на главном экране, как в Telegram/Instagram) —
    // живут duration_h часов, после чего просто перестают отдаваться viewer'у.
    $pdo->exec("CREATE TABLE IF NOT EXISTS stories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        video_url  TEXT NOT NULL,
        caption    TEXT,
        duration_h INTEGER NOT NULL DEFAULT 24,
        active     INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
    )");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories(expires_at)");

    // Личный ответ на историю (в отличие от мини-коммента — реакции emoji,
    // см. message_reactions со scope='story') — обычное сообщение в чат
    // поддержки, просто с цитатой истории.
    db_add_column($pdo, 'support_messages', 'story_id', "INTEGER");

    // Индикатор "печатает…" в личных сообщениях — просто короткоживущий пинг
    // с TTL, без вебсокетов: клиент шлёт его пока печатает, собеседник видит
    // при обычном поллинге треда (см. action=typing в dm.php).
    $pdo->exec("CREATE TABLE IF NOT EXISTS dm_typing (
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        until           TEXT NOT NULL,
        PRIMARY KEY (conversation_id, user_id)
    )");

    // Контактный телефон продавца — задаётся при регистрации или позже в
    // настройках профиля, показывается клиентам в Telegram-боте (кнопка
    // "ℹ️ Информация"), чтобы можно было связаться напрямую помимо чата.
    db_add_column($pdo, 'users', 'phone', "TEXT");

    // Переключатель между несколькими аккаунтами MySavdo с одного устройства
    // (свой аккаунт + 1 бесплатный дополнительный = 2 всего, дальше — платные
    // слоты, см. backend/config/account_switch.php).
    db_add_column($pdo, 'users', 'account_slots_purchased', "INTEGER NOT NULL DEFAULT 0");

    // Каждая строка — "держатель" может переключиться на "linked_user_id" по
    // token_hash без пароля. Связь создаётся сразу в обе стороны (см.
    // backend/api/account-switch.php), но лимит слотов расходует только
    // тот, кто инициировал связывание (counts_toward_quota = 1 у него).
    $pdo->exec("CREATE TABLE IF NOT EXISTS linked_accounts (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        linked_user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash          TEXT NOT NULL,
        counts_toward_quota INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        last_switched_at    TEXT
    )");
    $pdo->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_accounts_pair ON linked_accounts(user_id, linked_user_id)");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_linked_accounts_user ON linked_accounts(user_id)");

    // «Путь продавца» — геймификация: какие ачивки уже разблокированы и
    // когда. Список самих ачивок и условия их получения живут в коде
    // (backend/config/achievements.php), тут только факт разблокировки —
    // достижение проверяется живыми данными при каждом заходе на экран,
    // а сюда пишется один раз, чтобы запомнить дату первого достижения.
    $pdo->exec("CREATE TABLE IF NOT EXISTS seller_achievements (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        achievement_key TEXT NOT NULL,
        unlocked_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )");
    $pdo->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_achievements_pair ON seller_achievements(user_id, achievement_key)");

    // Свои колонки в воронке продаж — 5 стандартных этапов (new/consult/
    // deal/pay/done) остаются как есть, зашиты в коде фронтенда и в
    // достижениях (см. achievements.php), а тут только ДОПОЛНИТЕЛЬНЫЕ
    // колонки, которые продавец добавляет и называет сам. stage_key
    // генерируется как 'custom_<id>' сразу после вставки строки.
    $pdo->exec("CREATE TABLE IF NOT EXISTS funnel_custom_stages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stage_key  TEXT NOT NULL,
        title      TEXT NOT NULL,
        position   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )");
    $pdo->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_funnel_custom_stages_key ON funnel_custom_stages(user_id, stage_key)");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_funnel_custom_stages_user ON funnel_custom_stages(user_id)");

    // Порядок и видимость колонок воронки — продавец может перетащить
    // колонку (в т.ч. одну из 5 стандартных) на другое место или временно
    // скрыть её с доски. Хранится отдельно от funnel_custom_stages, потому
    // что охватывает и стандартные колонки тоже (их id в коде не трогаем).
    // Нет строки для колонки — значит она в естественном порядке и видима.
    $pdo->exec("CREATE TABLE IF NOT EXISTS funnel_column_prefs (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        col_key  TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        hidden   INTEGER NOT NULL DEFAULT 0
    )");
    $pdo->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_funnel_column_prefs_key ON funnel_column_prefs(user_id, col_key)");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_funnel_column_prefs_user ON funnel_column_prefs(user_id)");

    // Telegram-группы, привязанные к магазину — бот не может создать группу
    // сам (ограничение Bot API), поэтому запись появляется автоматически,
    // когда владелец добавляет уже подключённого бота в свою группу (см.
    // обработку update.my_chat_member в telegram-webhook.php). У одного
    // магазина может быть несколько групп (разные отделы/сегменты клиентов).
    $pdo->exec("CREATE TABLE IF NOT EXISTS telegram_groups (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chat_id            TEXT NOT NULL,
        title              TEXT NOT NULL DEFAULT 'Группа',
        type               TEXT NOT NULL DEFAULT 'group',
        photo_url          TEXT,
        member_count       INTEGER NOT NULL DEFAULT 0,
        pinned_message_id  INTEGER,
        active             INTEGER NOT NULL DEFAULT 1,
        last_read_at       TEXT,
        last_message_at    TEXT,
        created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    )");
    $pdo->exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_groups_chat ON telegram_groups(user_id, chat_id)");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_tg_groups_user ON telegram_groups(user_id)");

    // Сообщения из этих групп — отдельно от 1:1 переписки с клиентами
    // (messages/clients), потому что у группового чата много отправителей
    // и своя лента, а не один клиент на диалог.
    $pdo->exec("CREATE TABLE IF NOT EXISTS telegram_group_messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id        INTEGER NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
        tg_message_id   TEXT,
        direction       TEXT NOT NULL DEFAULT 'in',
        sender_tg_id    TEXT,
        sender_name     TEXT,
        sender_username TEXT,
        text            TEXT,
        photo_url       TEXT,
        video_url       TEXT,
        audio_url       TEXT,
        reply_to_id     INTEGER,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_tg_group_msgs_group ON telegram_group_messages(group_id)");

    // Участники группы — Bot API не даёт полный список участников напрямую,
    // список наполняется по мере того, как люди пишут в группу или когда
    // приходят update.chat_member (вход/выход/смена роли).
    $pdo->exec("CREATE TABLE IF NOT EXISTS telegram_group_members (
        group_id     INTEGER NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
        tg_user_id   TEXT NOT NULL,
        name         TEXT,
        username     TEXT,
        role         TEXT NOT NULL DEFAULT 'member',
        last_seen_at TEXT,
        PRIMARY KEY (group_id, tg_user_id)
    )");

    // Напоминание «написать/позвонить клиенту снова» — дата+заметка на карточке
    // заявки, показывается в блоке «Требуют внимания» на Главной (см.
    // renderNextActions() в app.js) и бейджем на карточке в воронке.
    db_add_column($pdo, 'clients', 'remind_at',   "TEXT");
    db_add_column($pdo, 'clients', 'remind_note', "TEXT");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_clients_remind ON clients(user_id, remind_at)");

    // Личная цель продаж на месяц (сомони) — задаётся в профиле, прогресс
    // считается в analytics.php по сумме value заявок, дошедших до этапа
    // "done" в текущем календарном месяце.
    db_add_column($pdo, 'users', 'sales_goal', "INTEGER");

    // Сообщение отправлено автоответчиком ИИ (ai_auto в telegram-webhook.php),
    // а не вручную продавцом/сотрудником — на этом строится геймификация
    // "ИИ-помощник" (см. achievements.php) и подсчёт сэкономленного времени.
    db_add_column($pdo, 'messages', 'by_ai', "INTEGER NOT NULL DEFAULT 0");

    // Оценка риска потери сделки от ИИ (см. backend/api/ai-risk-scan.php) —
    // считается по запросу продавца (кнопка "Обновить ИИ-анализ" в блоке
    // "Что сделать в первую очередь"), не на каждый рендер: ai_risk_at нужен,
    // чтобы фронтенд понимал, не устарела ли оценка после новых сообщений.
    db_add_column($pdo, 'clients', 'ai_risk_score',  "INTEGER");
    db_add_column($pdo, 'clients', 'ai_risk_reason', "TEXT");
    db_add_column($pdo, 'clients', 'ai_risk_at',     "TEXT");

    // Причина удаления заявки — сама заявка при удалении стирается насовсем
    // (см. DELETE в clients.php), но причина остаётся здесь, чтобы продавец
    // потом мог посмотреть, почему вообще теряются лиды (спам? дорого?
    // не отвечают?), а не гадать по памяти.
    $pdo->exec("CREATE TABLE IF NOT EXISTS client_deletions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_name TEXT NOT NULL,
        channel     TEXT,
        stage       TEXT,
        value       INTEGER NOT NULL DEFAULT 0,
        reason      TEXT NOT NULL,
        reason_note TEXT,
        deleted_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_client_deletions_user ON client_deletions(user_id, deleted_at)");
}

function db_bootstrap_admin_account(PDO $pdo): void {
    $count = (int)$pdo->query('SELECT COUNT(*) FROM admin_accounts')->fetchColumn();
    if ($count > 0) {
        return;
    }
    $username = trim((string)(getenv('ADMIN_BOOTSTRAP_USERNAME') ?: ''));
    $password = (string)(getenv('ADMIN_BOOTSTRAP_PASSWORD') ?: '');
    if ($username === '' || strlen($password) < 8) {
        return;
    }
    $pdo->prepare('INSERT INTO admin_accounts (username, password_hash) VALUES (:u, :p)')
        ->execute([':u' => $username, ':p' => password_hash($password, PASSWORD_BCRYPT)]);
}

function db_translit(string $s): string {
    static $map = [
        'а'=>'a','б'=>'b','в'=>'v','г'=>'g','ғ'=>'g','д'=>'d','е'=>'e','ё'=>'yo','ж'=>'zh','з'=>'z',
        'и'=>'i','ӣ'=>'i','й'=>'y','к'=>'k','қ'=>'q','л'=>'l','м'=>'m','н'=>'n','о'=>'o','п'=>'p',
        'р'=>'r','с'=>'s','т'=>'t','у'=>'u','ӯ'=>'u','ф'=>'f','х'=>'h','ҳ'=>'h','ц'=>'ts','ч'=>'ch',
        'ҷ'=>'j','ш'=>'sh','щ'=>'sch','ъ'=>'','ы'=>'y','ь'=>'','э'=>'e','ю'=>'yu','я'=>'ya',
    ];
    $s = mb_strtolower($s, 'UTF-8');
    $out = '';
    foreach (preg_split('//u', $s, -1, PREG_SPLIT_NO_EMPTY) as $ch) {
        $out .= $map[$ch] ?? $ch;
    }
    return $out;
}

function db_generate_username(PDO $pdo, string $seed): string {
    $base = strtolower(str_replace([' ', '-'], '_', db_translit($seed)));
    $base = preg_replace('/[^a-z0-9_]+/', '', $base) ?? '';
    $base = trim($base, '_');
    if ($base === '') {
        $base = 'user';
    }
    $base = substr($base, 0, 20);
    if (strlen($base) < 3) {
        $base = str_pad($base, 3, '0');
    }

    $candidate = $base;
    for ($attempt = 0; $attempt < 30; $attempt++) {
        $stmt = $pdo->prepare('SELECT 1 FROM users WHERE username = :u');
        $stmt->execute([':u' => $candidate]);
        if (!$stmt->fetchColumn()) {
            return $candidate;
        }
        $suffix = (string)random_int(10, 9999);
        $candidate = substr($base, 0, 24 - strlen($suffix) - 1) . '_' . $suffix;
    }
    return 'user_' . bin2hex(random_bytes(5));
}

function db_backfill_usernames(PDO $pdo): void {
    $rows = $pdo->query('SELECT id, shop_name, email FROM users WHERE username IS NULL')->fetchAll();
    foreach ($rows as $row) {
        $seed = trim((string)$row['shop_name']) !== '' ? (string)$row['shop_name'] : explode('@', (string)$row['email'])[0];
        $username = db_generate_username($pdo, $seed);
        $pdo->prepare('UPDATE users SET username = :u WHERE id = :id')
            ->execute([':u' => $username, ':id' => (int)$row['id']]);
    }
}

function db_add_column(PDO $pdo, string $table, string $column, string $definition): void {
    $cols = array_column($pdo->query("PRAGMA table_info(" . $table . ")")->fetchAll(), 'name');
    if (!$cols) {
        return;
    }
    if (!in_array($column, $cols, true)) {
        $pdo->exec("ALTER TABLE {$table} ADD COLUMN {$column} {$definition}");
    }
}

