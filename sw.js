
// v3 → v4: admin.html и assets/js/admin.js не входили в SHELL_FILES вообще,
// а обычная статика (app.js, style.css) отдавалась stale-while-revalidate —
// то есть СРАЗУ из кэша, сеть только обновляла кэш "на будущее". Из-за этого
// после любого деплоя пользователь (особенно в админке, где правки идут
// часто) видел старый JS/CSS практически всегда, пока не делал жёсткий
// Ctrl+Shift+R — обычная перезагрузка старую версию не лечила. Ниже —
// network-first для всей своей статики: свежий код важнее офлайн-скорости,
// пока сайт активно меняется.
const SW_VERSION = 'v4';
const SHELL_CACHE = `mysavdo-shell-${SW_VERSION}`;
const RUNTIME_CACHE = `mysavdo-runtime-${SW_VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './admin.html',
  './offline.html',
  './assets/css/style.css',
  './assets/js/app.js',
  './assets/js/admin.js',
  './assets/js/mobile-bridge.js',
  './assets/manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

const RUNTIME_ORIGINS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  return url.pathname.includes('/backend/api/') || url.pathname.includes('/backend/');
}

function isRuntimeCacheable(url) {
  return RUNTIME_ORIGINS.includes(url.hostname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST/PUT и т.п. — не наше дело, идут в сеть напрямую

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Бэкенд и любые другие сторонние запросы (OAuth SDK, GTM и т.п.) — не перехватываем.
  if (sameOrigin && isApiRequest(url)) return;
  if (!sameOrigin && !isRuntimeCacheable(url)) return;

  // Навигация (открытие/обновление страницы) — сеть в приоритете, офлайн-страница как запасной вариант.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html') || caches.match('./offline.html')))
    );
    return;
  }

  // Свой JS/CSS/статика — network-first: идём в сеть, кэш только как запасной
  // вариант (офлайн или сеть недоступна). Раньше здесь было
  // stale-while-revalidate ("сразу из кэша, сеть — в фоне на будущее") — из-за
  // этого свежий деплой становился виден только со второго захода.
  // Google Fonts — они меняются к практически никогда, для них оставляем
  // старое поведение "кэш в приоритете, сеть — в фоне", ради скорости.
  if (!sameOrigin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
