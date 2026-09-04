// Простой релей-прокси для Groq API — деплоится как Cloudflare Worker
// (бесплатно, 100k запросов/день). Нужен, только если хостинг сайта не
// может напрямую достучаться до api.groq.com (см. комментарий в groq.php).
// Ходит через сеть Cloudflare, а не с IP хостинга — так обходится сетевая
// блокировка, из-за которой Groq отдаёт "пустой" 403 без деталей.
//
// Как задеплоить:
// 1. dash.cloudflare.com → бесплатная регистрация, если аккаунта ещё нет.
// 2. Слева "Workers & Pages" → "Create" → "Create Worker" → любое имя
//    (например groq-proxy) → "Deploy" (сначала будет шаблон-заглушка).
// 3. "Edit code" — стереть всё, что там есть, вставить целиком этот файл,
//    "Deploy" ещё раз.
// 4. Settings → Variables and Secrets → Add → тип "Secret", имя PROXY_SECRET,
//    значение — придумайте длинную случайную строку (просто набор символов,
//    как пароль). Сохранить.
// 5. Скопировать адрес воркера сверху страницы — вида
//    https://groq-proxy.<ваш-логин>.workers.dev
// 6. На сервере сайта в .env добавить две строки:
//      GROQ_PROXY_URL=https://groq-proxy.<ваш-логин>.workers.dev
//      GROQ_PROXY_SECRET=<та же случайная строка, что в шаге 4>
//
// После этого backend/config/groq.php сам начнёт слать запросы через воркер
// — никаких других правок не нужно.

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Секрет знают только наш сайт и этот воркер — без него прокси не
    // отдаст доступ к вашему ключу Groq никому постороннему, кто случайно
    // найдёт адрес воркера.
    const secret = request.headers.get('X-Proxy-Secret');
    if (!env.PROXY_SECRET || secret !== env.PROXY_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }

    const url = new URL(request.url);
    const target = 'https://api.groq.com' + url.pathname + url.search;

    const headers = new Headers(request.headers);
    headers.delete('x-proxy-secret');
    headers.delete('host');

    const groqResponse = await fetch(target, {
      method: 'POST',
      headers,
      body: request.body,
    });

    return new Response(groqResponse.body, {
      status: groqResponse.status,
      headers: groqResponse.headers,
    });
  },
};
