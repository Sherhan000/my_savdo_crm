
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];

const _nativeFetch = window.fetch.bind(window);
let _csrfToken = null;
let _csrfPromise = null;
function ensureCsrfToken(force = false){
  if (_csrfToken && !force) return Promise.resolve(_csrfToken);
  if (!_csrfPromise || force){
    _csrfPromise = _nativeFetch('backend/api/csrf.php', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { _csrfToken = (d && d.token) || null; return _csrfToken; })
      .catch(() => null)
      .finally(() => { _csrfPromise = null; });
  }
  return _csrfPromise;
}
async function apiFetch(url, opts = {}){
  const method = (opts.method || 'GET').toUpperCase();
  const mutating = method !== 'GET' && method !== 'HEAD';
  const doFetch = async () => {
    const headers = new Headers(opts.headers || {});
    if (mutating){
      const token = await ensureCsrfToken();
      if (token) headers.set('X-CSRF-Token', token);
    }
    return _nativeFetch(url, { credentials: 'include', ...opts, headers });
  };
  let res = await doFetch();
  if (mutating && res.status === 403){
    await ensureCsrfToken(true);
    res = await doFetch();
  }
  return res;
}

function displayEmail(email){
  if (email && /@telegram\.mysavdo\.local$/i.test(email)) return 'Вход через Telegram';
  if (email && /@guest\.mysavdo\.local$/i.test(email)) return 'Гостевой доступ';
  return email || '';
}

function showScreen(id){
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  window.scrollTo(0,0);

  document.body.classList.toggle('on-landing', id === 'screen-landing');
  if (id !== 'screen-landing'){
    setMagnifierActive(false);
    toggleAiPanel(false);
  }

  if (id === 'screen-dashboard' || id === 'screen-landing'){
    localStorage.setItem('mysavdo_last_screen', id);
  }
}

window.addEventListener('scroll', () => {
  const header = $('.site-header');
  if (header) header.classList.toggle('scrolled', window.scrollY > 8);
}, { passive:true });

function fmtTime(ts){
  const d = new Date(ts);
  if (isNaN(d)) return '';
  const now = new Date();
  const hm = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return hm;
  return String(d.getDate()).padStart(2,'0') + '.' + String(d.getMonth()+1).padStart(2,'0') + ' ' + hm;
}
function parseServerTime(s){
  if (!s) return Date.now();

  const t = new Date(String(s).replace(' ', 'T') + 'Z').getTime();
  return isNaN(t) ? Date.now() : t;
}

let _toastWrap = null;
function showToast(text, type = 'info'){
  if (!_toastWrap){
    _toastWrap = document.createElement('div');
    _toastWrap.className = 'toast-wrap';
    document.body.appendChild(_toastWrap);
  }
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  const txt = document.createElement('div');
  txt.className = 'toast-txt';
  const span = document.createElement('span');
  span.textContent = text;
  txt.appendChild(span);
  el.appendChild(txt);
  _toastWrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, 3400);
}

// --- Действия с сообщениями: копировать / ответить / реакция / выбрать / удалить.
// Общий модуль для всех чатов (воронка, поддержка, личные сообщения) — каждый
// чат сам решает, какие действия предложить и как отправить их на сервер,
// модуль отвечает только за попап, полоску реакций и режим множественного выбора.
const MsgActions = (() => {
  const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  let openPop = null;

  function closePopover(){
    if (openPop){ openPop.remove(); openPop = null; }
  }
  document.addEventListener('click', e => {
    if (openPop && !openPop.contains(e.target)) closePopover();
  });
  document.addEventListener('scroll', closePopover, true);
  window.addEventListener('resize', closePopover);

  function showPopover(anchorEl, actions){
    closePopover();
    const pop = document.createElement('div');
    pop.className = 'msg-actions-pop';
    actions.forEach(a => {
      if (a.type === 'reactions'){
        const row = document.createElement('div');
        row.className = 'msg-actions-emoji-row';
        REACTIONS.forEach(em => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'msg-emoji-btn';
          b.textContent = em;
          b.addEventListener('click', () => { closePopover(); a.onPick(em); });
          row.appendChild(b);
        });
        pop.appendChild(row);
        return;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'msg-action-btn' + (a.danger ? ' danger' : '');
      btn.innerHTML = `<svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-${a.icon}"/></svg><span>${a.label}</span>`;
      btn.addEventListener('click', () => { closePopover(); a.onClick(); });
      pop.appendChild(btn);
    });
    document.body.appendChild(pop);

    const r = anchorEl.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    let left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, r.left));
    pop.style.left = left + 'px';
    const spaceBelow = window.innerHeight - r.bottom;
    if (spaceBelow < popRect.height + 16){
      pop.style.top = Math.max(8, r.top - popRect.height - 6) + 'px';
    } else {
      pop.style.top = (r.bottom + 6) + 'px';
    }
    openPop = pop;
  }

  // Долгое нажатие на тач-устройствах, правый клик — на десктопе.
  function attachTrigger(el, cb){
    let timer = null, moved = false, sx = 0, sy = 0;
    el.addEventListener('touchstart', e => {
      moved = false;
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY;
      timer = setTimeout(() => {
        if (!moved){ cb(el); if (navigator.vibrate) navigator.vibrate(8); }
      }, 450);
    }, { passive:true });
    el.addEventListener('touchmove', e => {
      const t = e.touches[0];
      if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10){ moved = true; clearTimeout(timer); }
    }, { passive:true });
    el.addEventListener('touchend', () => clearTimeout(timer));
    el.addEventListener('touchcancel', () => clearTimeout(timer));
    el.addEventListener('contextmenu', e => { e.preventDefault(); cb(el); });
  }

  function renderReactions(bubbleEl, data, onPick){
    let row = bubbleEl.querySelector('.msg-reactions');
    const counts = (data && data.counts) || {};
    const mine = data ? data.mine : null;
    const keys = Object.keys(counts).filter(k => counts[k] > 0);
    if (!keys.length){
      if (row) row.remove();
      return;
    }
    if (!row){
      row = document.createElement('div');
      row.className = 'msg-reactions';
      bubbleEl.appendChild(row);
    }
    row.innerHTML = '';
    keys.forEach(em => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'msg-reaction-chip' + (mine === em ? ' mine' : '');
      chip.innerHTML = `<span>${em}</span><b>${counts[em]}</b>`;
      chip.addEventListener('click', e => { e.stopPropagation(); onPick(em); });
      row.appendChild(chip);
    });
  }

  function renderReplyPreview(bubbleEl, snippet, onJump){
    let box = bubbleEl.querySelector('.msg-reply-quote');
    if (!snippet){ if (box) box.remove(); return; }
    if (!box){
      box = document.createElement('div');
      box.className = 'msg-reply-quote';
      bubbleEl.insertBefore(box, bubbleEl.firstChild);
    }
    box.textContent = snippet;
    if (onJump) box.addEventListener('click', e => { e.stopPropagation(); onJump(); });
  }

  // Полоска "Ответ на: …" над формой ввода — общая логика для всех трёх чатов.
  function createReplyBar(formEl){
    let target = null;
    const bar = document.createElement('div');
    bar.className = 'msg-reply-bar';
    bar.innerHTML = `<div class="msg-reply-bar-text"></div><button type="button" class="msg-reply-bar-close">✕</button>`;
    formEl.parentElement.insertBefore(bar, formEl);
    bar.querySelector('.msg-reply-bar-close').addEventListener('click', () => clear());
    function set(id, snippet){
      target = { id, snippet };
      bar.querySelector('.msg-reply-bar-text').textContent = 'Ответ на: ' + (snippet || '…');
      bar.classList.add('show');
    }
    function clear(){ target = null; bar.classList.remove('show'); }
    function get(){ return target; }
    return { set, clear, get };
  }

  // Режим "выбрать несколько" — чекбоксы на пузырях + плавающая панель действий.
  function createSelection({ mountBeforeEl, onCopy, onDelete }){
    let active = false;
    const selected = new Map(); // id -> bubbleEl
    let bar = null;

    function updateBar(){
      if (!bar) return;
      bar.querySelector('.msg-select-count').textContent = `Выбрано: ${selected.size}`;
    }
    function start(){
      if (active) return;
      active = true;
      selected.clear();
      mountBeforeEl.classList.add('selecting');
      bar = document.createElement('div');
      bar.className = 'msg-select-bar';
      bar.innerHTML = `
        <span class="msg-select-count">Выбрано: 0</span>
        <div class="msg-select-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-a="cancel">Отмена</button>
          <button type="button" class="icon-btn" data-a="copy" title="Скопировать"><svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-copy"/></svg></button>
          <button type="button" class="icon-btn danger" data-a="del" title="Удалить"><svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-trash"/></svg></button>
        </div>`;
      bar.querySelector('[data-a="cancel"]').addEventListener('click', stop);
      bar.querySelector('[data-a="copy"]').addEventListener('click', () => {
        if (!selected.size) return;
        onCopy([...selected.keys()]);
      });
      bar.querySelector('[data-a="del"]').addEventListener('click', async () => {
        if (!selected.size) return;
        if (!confirm(`Удалить выбранные сообщения (${selected.size})? Это действие нельзя отменить.`)) return;
        await onDelete([...selected.keys()]);
        stop();
      });
      mountBeforeEl.parentElement.insertBefore(bar, mountBeforeEl);
      updateBar();
    }
    function stop(){
      active = false;
      mountBeforeEl.classList.remove('selecting');
      mountBeforeEl.querySelectorAll('.bubble.selected').forEach(b => b.classList.remove('selected'));
      selected.clear();
      if (bar){ bar.remove(); bar = null; }
    }
    function toggle(id, bubbleEl){
      if (selected.has(id)){ selected.delete(id); bubbleEl.classList.remove('selected'); }
      else { selected.set(id, bubbleEl); bubbleEl.classList.add('selected'); }
      updateBar();
      if (active && selected.size === 0) stop();
    }
    function isActive(){ return active; }
    return { start, stop, toggle, isActive };
  }

  function copyTexts(texts){
    const joined = texts.filter(Boolean).join('\n');
    if (!joined) return;
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(joined).then(() => showToast('Скопировано', 'ok')).catch(() => showToast('Не удалось скопировать', 'error'));
    } else {
      showToast('Копирование недоступно в этом браузере', 'error');
    }
  }

  return { showPopover, closePopover, attachTrigger, renderReactions, renderReplyPreview, createReplyBar, createSelection, copyTexts, REACTIONS };
})();

// Черновик сообщения — чтобы набранный, но не отправленный текст не
// пропадал при закрытии чата/обновлении страницы. Чисто локально.
const Draft = {
  key(scope, id){ return `mysavdo_draft_${scope}_${id ?? 'main'}`; },
  save(scope, id, text){
    const k = this.key(scope, id);
    if (text) localStorage.setItem(k, text); else localStorage.removeItem(k);
  },
  load(scope, id){ return localStorage.getItem(this.key(scope, id)) || ''; },
  clear(scope, id){ localStorage.removeItem(this.key(scope, id)); },
  bind(inputEl, scope, getId){
    inputEl.addEventListener('input', () => this.save(scope, getId(), inputEl.value));
  },
};

// Быстрые шаблоны ответа — короткий список готовых фраз, хранится локально
// у продавца (не завязан на бэкенд, чтобы фича была совсем лёгкой).
const CannedReplies = (() => {
  const KEY = 'mysavdo_canned_replies';
  function load(){
    try{ const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch(_){ return []; }
  }
  function save(list){ localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20))); }
  function add(text){
    text = text.trim();
    if (!text) return;
    const list = load().filter(t => t !== text);
    list.unshift(text);
    save(list);
  }
  function remove(text){ save(load().filter(t => t !== text)); }

  let pop = null;
  function close(){ if (pop){ pop.remove(); pop = null; } }
  document.addEventListener('click', e => {
    if (pop && !pop.contains(e.target) && !e.target.closest('#btnCannedReplies')) close();
  });
  window.addEventListener('resize', close);

  function open(anchorEl, inputEl){
    if (pop){ close(); return; }
    const list = load();
    pop = document.createElement('div');
    pop.className = 'msg-actions-pop canned-pop';

    if (!list.length){
      const empty = document.createElement('div');
      empty.className = 'canned-empty';
      empty.textContent = 'Пока нет сохранённых шаблонов';
      pop.appendChild(empty);
    }
    list.forEach(text => {
      const row = document.createElement('div');
      row.className = 'canned-row';
      const span = document.createElement('span');
      span.textContent = text;
      span.addEventListener('click', () => {
        inputEl.value = text;
        inputEl.dispatchEvent(new Event('input'));
        inputEl.focus();
        close();
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'canned-del';
      del.textContent = '✕';
      del.title = 'Удалить шаблон';
      del.addEventListener('click', e => { e.stopPropagation(); remove(text); open(anchorEl, inputEl); });
      row.appendChild(span);
      row.appendChild(del);
      pop.appendChild(row);
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'canned-add-btn';
    addBtn.textContent = '+ Сохранить текущий текст как шаблон';
    addBtn.disabled = !inputEl.value.trim();
    addBtn.addEventListener('click', () => {
      add(inputEl.value);
      open(anchorEl, inputEl);
    });
    pop.appendChild(addBtn);

    document.body.appendChild(pop);
    const r = anchorEl.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    let left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, r.left));
    pop.style.left = left + 'px';
    pop.style.top = Math.max(8, r.top - popRect.height - 6) + 'px';
  }

  return { load, add, remove, open, close };
})();

// Полноэкранный просмотр фото из переписки — тап на превью в пузыре.
function openLightbox(url){
  const overlay = $('#lightboxOverlay');
  if (!overlay || !url) return;
  $('#lightboxImg').src = url;
  overlay.classList.add('active');
}
function closeLightbox(){
  const overlay = $('#lightboxOverlay');
  if (!overlay) return;
  overlay.classList.remove('active');
  setTimeout(() => { $('#lightboxImg').src = ''; }, 200);
}
$('#lightboxOverlay')?.addEventListener('click', e => { if (e.target.id === 'lightboxOverlay' || e.target.id === 'lightboxClose') closeLightbox(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#lightboxOverlay')?.classList.contains('active')) closeLightbox();
});

function attachPasswordToggle(input){
  if (!input || input.dataset.toggleAttached) return;
  input.dataset.toggleAttached = '1';
  const wrap = document.createElement('div');
  wrap.className = 'pass-field-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  input.classList.add('has-pass-toggle');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pass-toggle';
  btn.setAttribute('aria-label', 'Показать пароль');
  btn.innerHTML = '<svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-eye"/></svg>';
  btn.addEventListener('click', () => {
    const willShow = input.type === 'password';
    input.type = willShow ? 'text' : 'password';
    btn.innerHTML = `<svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-${willShow ? 'eye-off' : 'eye'}"/></svg>`;
    btn.setAttribute('aria-label', willShow ? 'Скрыть пароль' : 'Показать пароль');
  });
  wrap.appendChild(btn);
}
function attachPasswordTogglesIn(root = document){
  root.querySelectorAll('input[type="password"]').forEach(attachPasswordToggle);
}
attachPasswordTogglesIn();

const T = {
  'ob.next': 'Далее →',
  'ob.start': 'Старт →',
  'nav.replay': '↺ Обучалка',
  'nav.register': 'Регистрация',
  'nav.tariffs': 'Тарифы',
  'nav.start_free': 'Начать бесплатно',
  'auth.title.reg': 'Создать аккаунт', 'auth.title.login': 'Войти в MySavdo',
  'auth.sub.reg': 'Первый месяц бесплатно, без карты', 'auth.sub.login': 'Рады видеть снова',
  'auth.submit.reg': 'Создать аккаунт', 'auth.submit.login': 'Войти',
  'auth.switchtxt.reg': 'Уже есть аккаунт?', 'auth.switchtxt.login': 'Ещё нет аккаунта?',
  'auth.switchbtn.reg': 'Войти', 'auth.switchbtn.login': 'Создать',
  'loading.label': 'Загрузка…',
};
function t(key){ return T[key] || key; }

const LOADING_FACTS = [
  'MySavdo собирает Instagram, Telegram и WhatsApp в один инбокс — без переключений между приложениями.',
  'Каждая карточка заявки показывает настроение клиента — зелёный, серый или красный индикатор.',
  'ИИ-помощник подскажет готовый ответ клиенту, когда это понадобится.',
  'Панель «Что сделать в первую очередь» сама поднимает наверх недовольных клиентов и зависшие сделки.',
];
let loadingFactTimer = null;
function startLoadingFacts(){
  const el = $('#loadingFact');
  if (!el) return;
  const facts = LOADING_FACTS;
  let i = 0;
  const show = () => {
    el.classList.remove('show');
    setTimeout(() => { el.textContent = facts[i % facts.length]; el.classList.add('show'); i++; }, 220);
  };
  show();
  loadingFactTimer = setInterval(show, 1700);
}
function stopLoadingFacts(){ if (loadingFactTimer){ clearInterval(loadingFactTimer); loadingFactTimer = null; } }

$('#btnLaunch').addEventListener('click', () => {
  showScreen('screen-loading');
  const fill = $('#loadingFill');
  const pct = $('#loadingPct');
  const ring = $('#loadingRingFg');
  const RING_LEN = 327;
  requestAnimationFrame(() => { fill.style.width = '100%'; });
  startLoadingFacts();
  let p = 0;
  const t = setInterval(() => {
    p = Math.min(100, p + Math.round(100/30));
    pct.textContent = `${t('loading.label')} ${p}%`;
    if (ring) ring.style.strokeDashoffset = String(RING_LEN - (RING_LEN * p / 100));
    if (p >= 100) clearInterval(t);
  }, 100);
  setTimeout(() => {
    stopLoadingFacts();
    goToOnboarding();
  }, 3000);
});

let obIndex = 0;
const obSlides = $$('.ob-slide');
const obDots = $$('.ob-dot');
const obPath = $('#obPath');

function goToOnboarding(){
  showScreen('screen-onboarding');
  obIndex = 0;
  renderOb();
}
function renderOb(){
  obSlides.forEach((s,i) => s.classList.toggle('active', i === obIndex));
  obDots.forEach((d,i) => d.classList.toggle('active', i === obIndex));
  const total = obPath.getTotalLength();
  const offset = total - (total * (obIndex) / (obSlides.length - 1));
  obPath.style.strokeDasharray = total;
  obPath.style.strokeDashoffset = offset;
  obPath.classList.toggle('drawn', obIndex > 0);
  $('#obNext').textContent = obIndex === obSlides.length - 1 ? t('ob.start') : t('ob.next');
}
$('#obNext').addEventListener('click', () => {
  if (obIndex < obSlides.length - 1){
    obIndex++;
    renderOb();
  } else {
    finishOnboarding();
  }
});
$('#obSkip').addEventListener('click', finishOnboarding);

function finishOnboarding(){
  localStorage.setItem('mysavdo_onboarded', '1');
  showScreen('screen-landing');
  if (!localStorage.getItem('mysavdo_site_tour_done')){
    setTimeout(() => startTour(LANDING_TOUR, 'mysavdo_site_tour_done'), 550);
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  if (localStorage.getItem('mysavdo_onboarded') === '1'){
    showScreen('screen-landing');
    await Auth.syncSession();
    applyAuthUI();
    refreshShopMenuUI();

    if (Auth.current() && localStorage.getItem('mysavdo_last_screen') === 'screen-dashboard'){
      openDashboard();
      const savedView = localStorage.getItem('mysavdo_last_view');
      if (savedView) switchDashView(savedView);
    }

    const params = new URLSearchParams(location.search);
    const igConnected = params.get('ig_connected');
    const igError = params.get('ig_error');
    const igWarn = params.get('ig_warn');
    if ((igConnected || igError) && Auth.current()){
      if (localStorage.getItem('mysavdo_last_screen') !== 'screen-dashboard') openDashboard();
      if (igConnected){
        showToast('Instagram подключён', 'success');
        if (igWarn === 'subscribe_failed'){
          showToast('Аккаунт подключён, но подписка на сообщения не подтвердилась — попробуйте переподключить, если заявки из Direct не будут приходить', 'error');
        }
        openInstagramModal();
      } else {
        const messages = {
          denied: 'Вы отменили вход через Instagram',
          taken: 'Этот Instagram-аккаунт уже подключён к другому магазину на MySavdo',
          session: 'Сессия истекла, войдите и попробуйте снова',
        };
        showToast(messages[igError] || 'Не удалось подключить Instagram', 'error');
      }
      history.replaceState(null, '', location.pathname);
    }
  }
});

$('#btnReplay').addEventListener('click', () => {
  showScreen('screen-welcome');
});

$$('.faq-item').forEach(item => {
  $('.faq-q', item).addEventListener('click', () => {
    const wasOpen = item.classList.contains('open');
    $$('.faq-item').forEach(i => i.classList.remove('open'));
    if (!wasOpen) item.classList.add('open');
  });
});

const Auth = (() => {
  let mode = null;
  let user = JSON.parse(localStorage.getItem('mysavdo_user') || 'null');
  let employee = JSON.parse(localStorage.getItem('mysavdo_employee') || 'null');

  async function detectBackend(){
    if (mode) return mode;
    try{
      const r = await apiFetch('backend/api/me.php', { credentials:'include' });
      mode = r.ok || r.status === 401 ? 'api' : 'demo';
    } catch(e){ mode = 'demo'; }
    return mode;
  }

  async function syncSession(){
    await detectBackend();
    if (mode !== 'api') return user;
    try{
      const r = await apiFetch('backend/api/me.php', { credentials:'include' });
      if (r.ok){
        const data = await r.json();
        user = data.user; employee = data.employee || null; persist();
      } else if (user) {

        user = null; employee = null;
        localStorage.removeItem('mysavdo_user');
        localStorage.removeItem('mysavdo_employee');
      }
    } catch(e) {  }
    return user;
  }

  async function register(name, email, pass, phone){
    await detectBackend();
    if (mode === 'api'){
      const r = await apiFetch('backend/api/register.php', {
        method:'POST', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({shop_name:name, email, password:pass, phone: phone || ''})
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Ошибка регистрации');
      user = data.user; persist(); return user;
    }

    if (!email || !pass || pass.length < 6) throw new Error('Проверьте email и пароль (мин. 6 символов)');
    user = { id: Date.now(), shop_name: name || 'Мой магазин', email };
    persist(); return user;
  }

  async function login(email, pass){
    await detectBackend();
    if (mode === 'api'){
      const r = await apiFetch('backend/api/login.php', {
        method:'POST', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({email, password:pass})
      });
      const data = await r.json();
      if (!r.ok){
        throw new Error(data.error || 'Неверный email или пароль');
      }
      user = data.user; persist(); return user;
    }
    if (!email || !pass) throw new Error('Введите email и пароль');
    user = { id: Date.now(), shop_name: email.split('@')[0], email };
    persist(); return user;
  }

  function setUser(u){ user = u; persist(); return user; }

  async function loginWithGoogleCredential(credential){
    await detectBackend();
    const r = await apiFetch('backend/api/google-login.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ credential })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Не удалось войти через Google');
    user = data.user; persist(); return user;
  }

  async function loginWithTelegram(tgUser){
    await detectBackend();
    const r = await apiFetch('backend/api/telegram-login.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(tgUser)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Не удалось войти через Telegram');
    user = data.user; persist(); return user;
  }

  async function loginWithFacebookToken(accessToken){
    await detectBackend();
    const r = await apiFetch('backend/api/facebook-login.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ accessToken })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Не удалось войти через Facebook');
    user = data.user; persist(); return user;
  }

  async function guestLogin(){
    await detectBackend();
    if (mode === 'api'){
      const r = await apiFetch('backend/api/guest-login.php', { method:'POST', credentials:'include' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Не удалось войти как гость');
      user = data.user; persist(); return user;
    }
    user = { id: Date.now(), shop_name: 'Гость', email: 'guest@local', is_guest: true, username: 'guest' };
    persist(); return user;
  }

  async function loginWithEmployee(loginId, password){
    await detectBackend();
    const r = await apiFetch('backend/api/employee-login.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ login_id: loginId, password })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Не удалось войти как сотрудник');
    user = data.user; employee = data.employee || null; persist();
    return user;
  }

  function persist(){
    localStorage.setItem('mysavdo_user', JSON.stringify(user));
    if (employee) localStorage.setItem('mysavdo_employee', JSON.stringify(employee));
    else localStorage.removeItem('mysavdo_employee');
  }
  function logout(){
    user = null; employee = null;
    localStorage.removeItem('mysavdo_user');
    localStorage.removeItem('mysavdo_employee');
    apiFetch('backend/api/logout.php',{method:'POST', credentials:'include'}).catch(()=>{});
  }
  function current(){ return user; }
  function currentEmployee(){ return employee; }

  return { register, login, guestLogin, loginWithGoogleCredential, loginWithFacebookToken, loginWithTelegram, loginWithEmployee, logout, current, currentEmployee, syncSession, setUser };
})();

function applyAuthUI(){
  const user = Auth.current();
  const actions = $('#headerActions');
  if (user){
    const initial = escapeHtml(((user.shop_name || user.email || '?')[0] || '?').toUpperCase());
    const avatarHtml = user.avatar
      ? `<img src="${escapeHtml(user.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
      : initial;
    actions.innerHTML = `
      <button class="btn btn-outline btn-sm" id="btnReplay2">${t('nav.replay')}</button>
      <a href="#pricing"><button class="btn btn-outline btn-sm">${t('nav.tariffs')}</button></a>
      <div class="user-chip">
        <div class="user-avatar">${avatarHtml}</div>
        ${escapeHtml(user.shop_name || displayEmail(user.email))}
      </div>
      <button class="btn btn-primary btn-sm" id="btnGoDash">${t('nav.start_free')}</button>`;
    $('#btnGoDash').addEventListener('click', openDashboard);
    $('#btnReplay2').addEventListener('click', () => showScreen('screen-welcome'));
  }
}

let authMode = 'register';
let authIntent = 'dashboard';
function openAuth(mode='register', intent='dashboard'){
  authMode = mode;
  authIntent = intent;
  $('#authError').classList.remove('show');
  $('#authForm').reset();
  syncAuthTexts();
  $('#authModal').classList.add('active');
  initGoogleSignIn();
  initFacebookSignIn();
  initTelegramSignIn();
}
function closeAuth(){ $('#authModal').classList.remove('active'); }
async function proceedAfterAuth(){
  await Auth.syncSession();
  applyAuthUI();
  refreshShopMenuUI();
  if (authIntent === 'review'){ openReviewModal(); }
  else { openDashboard(); }
  authIntent = 'dashboard';
}
function afterAuthSuccess(){
  closeAuth();
  proceedAfterAuth();
}

function syncAuthTexts(){
  const isReg = authMode === 'register';
  if (!$('#authTitle')) return;
  $('#authTitle').textContent = isReg ? t('auth.title.reg') : t('auth.title.login');
  $('#authSub').textContent = isReg ? t('auth.sub.reg') : t('auth.sub.login');
  $('#authSubmit').textContent = isReg ? t('auth.submit.reg') : t('auth.submit.login');
  $('#fieldName').style.display = isReg ? 'block' : 'none';
  if ($('#fieldPhone')) $('#fieldPhone').style.display = isReg ? 'block' : 'none';
  $('#authSwitchTxt').textContent = isReg ? t('auth.switchtxt.reg') : t('auth.switchtxt.login');
  $('#authSwitchBtn').textContent = isReg ? t('auth.switchbtn.reg') : t('auth.switchbtn.login');
  const forgotWrap = $('#authForgotWrap');
  if (forgotWrap) forgotWrap.style.display = isReg ? 'none' : 'block';
}

['btnOpenAuth','btnHeroStart','btnCtaStart'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', () => {
    const user = Auth.current();
    if (user) openDashboard(); else openAuth('register');
  });
});
$('#authClose').addEventListener('click', closeAuth);
$('#authModal').addEventListener('click', e => { if (e.target.id === 'authModal') closeAuth(); });
$('#authSwitchBtn').addEventListener('click', () => { authMode = authMode === 'register' ? 'login' : 'register'; syncAuthTexts(); });

const GOOGLE_CLIENT_ID = '906827182414-400113smr26c09nord2dkb08e7q75qu5.apps.googleusercontent.com';

let gsiRetries = 0;
function gsiShowMessage(text){
  const notReady = $('#gsiNotReady');
  const label = $('#gsiNotReadyText');
  if (label) label.textContent = text;
  notReady.style.display = 'flex';
}
function initGoogleSignIn(){
  const wrap = $('#gsiButtonContainer');
  const notReady = $('#gsiNotReady');
  if (!GOOGLE_CLIENT_ID){
    wrap.innerHTML = '';
    gsiShowMessage('Вход через Google ещё не настроен');
    return;
  }
  notReady.style.display = 'none';
  if (!window.google || !window.google.accounts){
    gsiRetries++;
    if (gsiRetries > 25){

      gsiShowMessage('Не удалось загрузить вход через Google — проверьте интернет и обновите страницу');
      return;
    }
    setTimeout(initGoogleSignIn, 300);
    return;
  }
  gsiRetries = 0;
  try{
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleCredential,
      ux_mode: 'popup',
    });
    wrap.innerHTML = '';

    const btnWidth = Math.max(200, Math.min(320, wrap.clientWidth || 320));
    google.accounts.id.renderButton(wrap, { theme:'outline', size:'large', shape:'pill', width:btnWidth, text:'continue_with', locale:'ru' });

    setTimeout(() => {
      if (!wrap.querySelector('iframe') && !wrap.querySelector('div')){
        gsiShowMessage('Google не разрешил вход с этого домена — добавьте домен сайта в настройках OAuth (см. НАСТРОЙКА.md)');
      }
    }, 1500);
  } catch(e){
    gsiShowMessage('Ошибка инициализации входа через Google');
  }
}

async function handleGoogleCredential(response){
  const errBox = $('#authError');
  errBox.classList.remove('show');
  try{
    await Auth.loginWithGoogleCredential(response.credential);
    afterAuthSuccess();
  } catch(err){
    errBox.textContent = err.message;
    errBox.classList.add('show');
  }
}

const FACEBOOK_APP_ID = 'ВСТАВЬ_СЮДА_СВОЙ_APP_ID';
let fbSdkReady = false;

window.fbAsyncInit = function(){
  if (!FACEBOOK_APP_ID || FACEBOOK_APP_ID.startsWith('ВСТАВЬ')) return;
  FB.init({ appId: FACEBOOK_APP_ID, cookie:true, xfbml:false, version:'v19.0' });
  fbSdkReady = true;
};

let fbRetries = 0;
function fbShowMessage(text){
  const btn = $('#btnFacebookLogin');
  const notReady = $('#fbNotReady');
  const label = $('#fbNotReadyText');
  if (btn) btn.style.display = 'none';
  if (label) label.textContent = text;
  if (notReady) notReady.style.display = 'flex';
}
function initFacebookSignIn(){
  const btn = $('#btnFacebookLogin');
  const notReady = $('#fbNotReady');
  if (!btn) return;
  if (!FACEBOOK_APP_ID || FACEBOOK_APP_ID.startsWith('ВСТАВЬ')){
    fbShowMessage('Вход через Facebook ещё не настроен');
    return;
  }
  if (!fbSdkReady){
    fbRetries++;
    if (fbRetries > 25){
      fbShowMessage('Не удалось загрузить вход через Facebook — проверьте интернет и обновите страницу');
      return;
    }
    setTimeout(initFacebookSignIn, 300);
    return;
  }
  fbRetries = 0;
  btn.style.display = 'flex';
  if (notReady) notReady.style.display = 'none';
}

async function handleFacebookCredential(accessToken){
  const errBox = $('#authError');
  errBox.classList.remove('show');
  try{
    await Auth.loginWithFacebookToken(accessToken);
    afterAuthSuccess();
  } catch(err){
    errBox.textContent = err.message;
    errBox.classList.add('show');
  }
}

const btnFacebookLogin = $('#btnFacebookLogin');
if (btnFacebookLogin){
  btnFacebookLogin.addEventListener('click', () => {
    if (!fbSdkReady || typeof FB === 'undefined') return;
    FB.login((response) => {
      if (response.authResponse){
        handleFacebookCredential(response.authResponse.accessToken);
      }
    }, { scope: 'public_profile,email' });
  });
}

const TELEGRAM_BOT_USERNAME = 'registration_mysavdo_bot';

function tgShowMessage(text){
  const wrap = $('#tgLoginContainer');
  const notReady = $('#tgNotReady');
  const label = $('#tgNotReadyText');
  if (wrap) wrap.innerHTML = '';
  if (label) label.textContent = text;
  if (notReady) notReady.style.display = 'flex';
}

function initTelegramSignIn(){
  const wrap = $('#tgLoginContainer');
  const notReady = $('#tgNotReady');
  if (!wrap) return;
  if (!TELEGRAM_BOT_USERNAME || TELEGRAM_BOT_USERNAME.startsWith('ВСТАВЬ')){
    tgShowMessage('Вход через Telegram ещё не настроен');
    return;
  }
  if (notReady) notReady.style.display = 'none';
  wrap.innerHTML = '';
  window.onTelegramAuth = handleTelegramAuth;
  const script = document.createElement('script');
  script.src = 'https://telegram.org/js/telegram-widget.js?22';
  script.async = true;
  script.setAttribute('data-telegram-login', TELEGRAM_BOT_USERNAME);
  script.setAttribute('data-size', 'large');
  script.setAttribute('data-radius', '999');
  script.setAttribute('data-onauth', 'onTelegramAuth(user)');
  script.setAttribute('data-request-access', 'write');
  wrap.appendChild(script);
}

async function handleTelegramAuth(tgUser){
  const errBox = $('#authError');
  errBox.classList.remove('show');
  try{
    await Auth.loginWithTelegram(tgUser);
    afterAuthSuccess();
  } catch(err){
    errBox.textContent = err.message;
    errBox.classList.add('show');
  }
}

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#regName').value.trim();
  const email = $('#regEmail').value.trim();
  const phone = $('#regPhone').value.trim();
  const pass = $('#regPass').value;
  const errBox = $('#authError');
  errBox.classList.remove('show');
  try{
    const wasRegister = authMode === 'register';
    if (wasRegister){
      await Auth.register(name, email, pass, phone);
    } else {
      await Auth.login(email, pass);
    }
    afterAuthSuccess();
    const cur = Auth.current();
    if (wasRegister && cur && !cur.is_verified){
      openEmailVerifyModal(cur.email);
    }
  }catch(err){
    errBox.textContent = err.message;
    errBox.classList.add('show');
  }
});

let verifyEmailAddr = '';
let verifyResendTimer = null;
function startVerifyResendCooldown(seconds = 60){
  const btn = $('#emailVerifyResendBtn');
  if (!btn) return;
  clearInterval(verifyResendTimer);
  let left = seconds;
  const label = () => `Отправить код ещё раз (${left})`;
  btn.disabled = true;
  btn.textContent = label();
  verifyResendTimer = setInterval(() => {
    left--;
    if (left <= 0){
      clearInterval(verifyResendTimer);
      btn.disabled = false;
      btn.textContent = 'Отправить код ещё раз';
    } else {
      btn.textContent = label();
    }
  }, 1000);
}
async function openEmailVerifyModal(email){
  verifyEmailAddr = email;
  $('#emailVerifyError').classList.remove('show');
  $('#emailVerifyForm').reset();
  $('#emailVerifyModal').classList.add('active');
  startVerifyResendCooldown();
  try{
    await apiFetch('backend/api/request-verification.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email }),
    });
  }catch(e){}
}
function closeEmailVerifyModal(){
  $('#emailVerifyModal').classList.remove('active');
  clearInterval(verifyResendTimer);
}
$('#emailVerifyClose').addEventListener('click', closeEmailVerifyModal);
$('#emailVerifyLaterBtn').addEventListener('click', closeEmailVerifyModal);
$('#emailVerifyModal').addEventListener('click', e => { if (e.target.id === 'emailVerifyModal') closeEmailVerifyModal(); });
$('#emailVerifyResendBtn').addEventListener('click', async () => {
  const errBox = $('#emailVerifyError');
  errBox.classList.remove('show');
  try{
    const r = await apiFetch('backend/api/request-verification.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email: verifyEmailAddr }),
    });
    if (!r.ok){
      const data = await r.json();
      throw new Error(data.error || 'Не удалось отправить код');
    }
    startVerifyResendCooldown();
    showToast('Код отправлен ещё раз', 'ok');
  }catch(err){
    errBox.textContent = err.message;
    errBox.classList.add('show');
  }
});
$('#emailVerifyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#emailVerifyCode').value.trim();
  const errBox = $('#emailVerifyError');
  errBox.classList.remove('show');
  try{
    const r = await apiFetch('backend/api/verify-email.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email: verifyEmailAddr, code }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Неверный код подтверждения');
    const cur = Auth.current();
    if (cur){ cur.is_verified = true; Auth.setUser(cur); }
    closeEmailVerifyModal();
    updateVerifyBanner(cur);
    showToast('Почта подтверждена', 'ok');
  }catch(err){
    errBox.textContent = err.message;
    errBox.classList.add('show');
  }
});
function updateVerifyBanner(user){
  const banner = $('#verifyEmailBanner');
  if (!banner) return;
  banner.style.display = (user && !user.is_verified) ? 'block' : 'none';
}
const btnVerifyEmailBannerEl = document.getElementById('btnVerifyEmailBanner');
if (btnVerifyEmailBannerEl) btnVerifyEmailBannerEl.addEventListener('click', () => {
  const cur = Auth.current();
  if (cur) openEmailVerifyModal(cur.email);
});

$('#authForgotBtn').addEventListener('click', () => {
  const email = $('#regEmail').value.trim();
  closeAuth();
  $('#forgotPasswordError').classList.remove('show');
  $('#forgotPasswordOk').style.display = 'none';
  $('#forgotPasswordForm').reset();
  if (email) $('#forgotPasswordEmail').value = email;
  $('#forgotPasswordModal').classList.add('active');
});
$('#forgotPasswordClose').addEventListener('click', () => $('#forgotPasswordModal').classList.remove('active'));
$('#forgotPasswordModal').addEventListener('click', e => { if (e.target.id === 'forgotPasswordModal') $('#forgotPasswordModal').classList.remove('active'); });
$('#forgotPasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#forgotPasswordEmail').value.trim();
  const errBox = $('#forgotPasswordError');
  errBox.classList.remove('show');
  try{
    const r = await apiFetch('backend/api/request-password-reset.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email }),
    });
    if (!r.ok){
      const data = await r.json();
      throw new Error(data.error || 'Не удалось отправить письмо');
    }
    $('#forgotPasswordForm').style.display = 'none';
    $('#forgotPasswordOk').style.display = 'block';
  }catch(err){
    errBox.textContent = err.message;
    errBox.classList.add('show');
  }
});

let resetPasswordToken = '';
function checkResetPasswordUrl(){
  const params = new URLSearchParams(location.search);
  const token = params.get('reset');
  if (!token) return;
  resetPasswordToken = token;
  $('#resetPasswordError').classList.remove('show');
  $('#resetPasswordForm').reset();
  $('#resetPasswordModal').classList.add('active');
  const url = new URL(location.href);
  url.searchParams.delete('reset');
  history.replaceState({}, '', url);
}
$('#resetPasswordClose').addEventListener('click', () => $('#resetPasswordModal').classList.remove('active'));
$('#resetPasswordModal').addEventListener('click', e => { if (e.target.id === 'resetPasswordModal') $('#resetPasswordModal').classList.remove('active'); });
$('#resetPasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#resetPasswordPass').value;
  const errBox = $('#resetPasswordError');
  errBox.classList.remove('show');
  try{
    const r = await apiFetch('backend/api/reset-password.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token: resetPasswordToken, password }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Не удалось сохранить пароль');
    $('#resetPasswordModal').classList.remove('active');
    showToast('Пароль изменён — теперь можно войти', 'ok');
    openAuth('login');
  }catch(err){
    errBox.textContent = err.message;
    errBox.classList.add('show');
  }
});
checkResetPasswordUrl();

function escapeHtml(str){
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function starsHtml(rating){
  let html = '';
  for (let i=1;i<=5;i++){
    html += `<svg class="icon icon-sm star${i <= rating ? ' filled' : ''}" viewBox="0 0 24 24"><use href="#icon-star"/></svg>`;
  }
  return html;
}

function pluralReviews(n){
  const mod10 = n % 10, mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return `${n} отзывов`;
  if (mod10 === 1) return `${n} отзыв`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} отзыва`;
  return `${n} отзывов`;
}

function fmtReviewDate(s){
  const d = new Date(parseServerTime(s));
  return String(d.getDate()).padStart(2,'0') + '.' + String(d.getMonth()+1).padStart(2,'0') + '.' + d.getFullYear();
}

async function loadReviews(){
  try{
    const r = await apiFetch('backend/api/reviews.php', { credentials:'include' });
    if (!r.ok) return;
    const data = await r.json();
    renderReviews(data.reviews || [], data.avg || 0, data.count || 0);
  } catch(e){}
}

function renderReviews(reviews, avg, count){
  const grid = $('#reviewsGrid');
  const empty = $('#reviewsEmpty');
  if (grid){
    grid.innerHTML = reviews.map(rv => `
      <div class="review-card">
        <div class="review-card-top">
          <div class="review-avatar">${rv.avatar ? `<img src="${escapeHtml(rv.avatar)}" alt="">` : escapeHtml((rv.shop_name || '?')[0].toUpperCase())}</div>
          <div class="review-card-info">
            <b>${escapeHtml(rv.shop_name)}</b>
            <div class="review-stars">${starsHtml(rv.rating)}</div>
          </div>
          <div class="review-date">${fmtReviewDate(rv.created_at)}</div>
        </div>
        ${rv.text ? `<p class="review-text">${escapeHtml(rv.text)}</p>` : ''}
      </div>
    `).join('');
    grid.style.display = reviews.length ? 'grid' : 'none';
  }
  if (empty) empty.style.display = reviews.length ? 'none' : 'flex';

  const avgEl = $('#reviewsAvgScore');
  const starsEl = $('#reviewsAvgStars');
  const countEl = $('#reviewsCountLabel');
  if (avgEl) avgEl.textContent = count ? avg.toFixed(1) : '—';
  if (starsEl) starsEl.innerHTML = starsHtml(Math.round(avg));
  if (countEl) countEl.textContent = count ? pluralReviews(count) : 'Пока нет отзывов';

  const badge = $('#siteRatingBadge');
  if (badge){
    if (count > 0){
      badge.style.display = 'flex';
      $('#siteRatingValue').textContent = avg.toFixed(1);
      $('#siteRatingCount').textContent = `(${count})`;
    } else {
      badge.style.display = 'none';
    }
  }
}

let reviewRating = 0;
function updateStarsPicker(val){
  $$('#reviewStarsPicker .star-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.val) <= val);
  });
}
$$('#reviewStarsPicker .star-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    reviewRating = Number(btn.dataset.val);
    updateStarsPicker(reviewRating);
  });
  btn.addEventListener('mouseenter', () => updateStarsPicker(Number(btn.dataset.val)));
});
const reviewStarsPickerEl = $('#reviewStarsPicker');
if (reviewStarsPickerEl) reviewStarsPickerEl.addEventListener('mouseleave', () => updateStarsPicker(reviewRating));

function closeReviewModal(){ $('#reviewModal').classList.remove('active'); }

async function openReviewModal(){
  const errBox = $('#reviewError');
  errBox.classList.remove('show');
  $('#reviewForm').reset();
  reviewRating = 0;
  updateStarsPicker(0);
  $('#reviewDeleteWrap').style.display = 'none';
  $('#reviewModal').classList.add('active');
  try{
    const r = await apiFetch('backend/api/reviews.php?mine=1', { credentials:'include' });
    if (r.ok){
      const data = await r.json();
      if (data.review){
        reviewRating = data.review.rating;
        updateStarsPicker(reviewRating);
        $('#reviewText').value = data.review.text || '';
        $('#reviewDeleteWrap').style.display = 'block';
      }
    }
  } catch(e){}
}

$('#btnOpenReview').addEventListener('click', () => {
  if (Auth.current()) openReviewModal();
  else openAuth('register', 'review');
});
$('#reviewClose').addEventListener('click', closeReviewModal);
$('#reviewModal').addEventListener('click', e => { if (e.target.id === 'reviewModal') closeReviewModal(); });

$('#reviewForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = $('#reviewError');
  errBox.classList.remove('show');
  if (reviewRating < 1){
    errBox.textContent = 'Выберите оценку от 1 до 5 звёзд';
    errBox.classList.add('show');
    return;
  }
  const text = $('#reviewText').value.trim();
  try{
    const r = await apiFetch('backend/api/reviews.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ rating: reviewRating, text })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Не удалось сохранить отзыв');
    closeReviewModal();
    showToast('Спасибо за отзыв!', 'success');
    loadReviews();
  } catch(err){
    errBox.textContent = err.message;
    errBox.classList.add('show');
  }
});

$('#btnDeleteReview').addEventListener('click', async () => {
  try{
    await apiFetch('backend/api/reviews.php', { method:'DELETE', credentials:'include' });
    closeReviewModal();
    showToast('Отзыв удалён', 'info');
    loadReviews();
  } catch(e){}
});

loadReviews();

$('#btnLogout').addEventListener('click', () => {
  Track.send();
  Auth.logout();
  if (simTimer){ clearInterval(simTimer); simTimer = null; }
  stopRealPolling();
  stopPlanCountdown();
  planState = null;
  isRealMode = false;
  localStorage.setItem('mysavdo_last_screen', 'screen-landing');
  clients = [];
  showScreen('screen-landing');
  $('#headerActions').innerHTML = `
    <button class="btn btn-outline btn-sm" id="btnReplay">${t('nav.replay')}</button>
    <button class="btn btn-primary btn-sm" id="btnOpenAuth">${t('nav.register')}</button>`;
  document.getElementById('btnReplay').addEventListener('click', () => showScreen('screen-welcome'));
  document.getElementById('btnOpenAuth').addEventListener('click', () => openAuth('register'));
});

async function askGrokBackend(mode, userMsg, clientName, history){
  const r = await apiFetch('backend/api/ai-reply.php', {
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ message: userMsg, client_name: clientName || 'клиент', mode, history: history || [] }),
  });
  const raw = await r.text();
  let data;
  try{
    data = JSON.parse(raw);
  } catch(e){
    throw new Error('Сервер вернул не JSON (похоже, PHP-бэкенд не выполняется — запустите `php -S localhost:8000` в папке проекта). Ответ сервера: ' + raw.slice(0,120));
  }
  if (!r.ok || !data.reply){
    const err = new Error(data.error || ('HTTP ' + r.status));
    err.code = data.code || null;
    if (data.ai_usage) err.ai_usage = data.ai_usage;
    throw err;
  }
  return {
    reply: data.reply, thinking: data.thinking || '', ai_usage: data.ai_usage || null, source: data.source || 'demo',
    assistant_message_id: data.assistant_message_id || null,
  };
}

async function askAI(mode, userMsg, clientName){
  try{
    const res = await askGrokBackend(mode, userMsg, clientName);
    console.log('[MySavdo AI] ✓ ответ от Groq — через backend');
    return { reply: res.reply, source: res.source };
  } catch(e){
    console.warn('[MySavdo AI] backend не смог:', e.message, '— показываю демо-ответ');
  }
  return null;
}
const AI_DEMO_BADGE = '<span class="ai-demo-badge">демо-ответ, ИИ не подключён</span>';

// Первые 5 — стандартные этапы, зашиты в бэкенде (валидация в clients.php,
// проверка «первая продажа» в achievements.php) — их id менять нельзя.
// Дальше в этот же массив дозаписываются свои колонки продавца (см.
// loadFunnelStages) — все места, где идёт по COLUMNS.forEach/.map, подхватят
// их сами, без отдельного кода на каждый виджет.
const BUILTIN_COLUMNS_COUNT = 5;
const COLUMNS = [
  { id:'new', title:'Новый запрос' },
  { id:'consult', title:'Консультация' },
  { id:'deal', title:'Договор' },
  { id:'pay', title:'Оплата' },
  { id:'done', title:'Доставлено' },
];
// Захватываем id стандартных колонок до того, как applyColumnPrefs() начнёт
// сортировать COLUMNS — после сортировки первые 5 элементов массива уже не
// обязательно стандартные этапы.
const BUILTIN_COLUMN_IDS = new Set(COLUMNS.map(c => c.id));

let customFunnelStages = [];
// Порядок и скрытые колонки — сохраняются на сервере (funnel-stages.php),
// applyColumnPrefs() каждый раз пересобирает COLUMNS: сначала естественный
// порядок (стандартные + свои), потом сортировка по funnelColumnOrder и
// простановка .hidden по funnelHiddenKeys. visibleColumns() — то, что
// реально рисуется на доске канбана и в графиках воронки; сам массив
// COLUMNS остаётся полным (по id всё ещё можно найти любую колонку, даже
// скрытую — например, чтобы показать название этапа уже существующей
// карточки).
let funnelColumnOrder = [];
let funnelHiddenKeys = [];
function applyColumnPrefs(){
  COLUMNS.length = BUILTIN_COLUMNS_COUNT;
  customFunnelStages.forEach(s => COLUMNS.push({ id: s.key, title: s.title }));
  if (funnelColumnOrder.length){
    const orderIndex = new Map(funnelColumnOrder.map((k, i) => [k, i]));
    COLUMNS.sort((a, b) => (orderIndex.has(a.id) ? orderIndex.get(a.id) : 999) - (orderIndex.has(b.id) ? orderIndex.get(b.id) : 999));
  }
  const hiddenSet = new Set(funnelHiddenKeys);
  COLUMNS.forEach(col => { col.hidden = hiddenSet.has(col.id); });
}
function visibleColumns(){ return COLUMNS.filter(col => !col.hidden); }
async function loadFunnelStages(){
  try{
    const r = await apiFetch('backend/api/funnel-stages.php', { credentials:'include' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return;
    customFunnelStages = data.stages || [];
    funnelColumnOrder = data.order || [];
    funnelHiddenKeys = data.hidden || [];
    applyColumnPrefs();
  } catch(e){  }
}
const CHANNELS = [
  { name:'Telegram', cls:'tg', icon:'icon-plane' },
  { name:'Instagram', cls:'ig', icon:'icon-camera' },
  { name:'WhatsApp', cls:'wa', icon:'icon-message' },
];
function chanBadge(ch){
  return `<span class="chan-badge ${ch.cls}"><svg class="icon" viewBox="0 0 24 24"><use href="#${ch.icon}"/></svg></span>`;
}

const CSV_SENT_LABEL = { pos:'Позитив', neu:'Нейтрально', neg:'Негатив' };
function csvCell(v){
  const s = String(v ?? '');
  // Экранируем разделитель (;), кавычки и переносы строк — иначе Excel/Google
  // Таблицы разъедут колонки на любой заметке с запятой или точкой с запятой.
  return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportClientsCsv(){
  // В реальном режиме отдаём настоящий .xlsx с сервера — там же полная
  // переписка (когда писал, что писал) и телефон/ник клиента, не только
  // сводка по карточкам. CSV остаётся запасным вариантом для демо-режима
  // без сервера (там таких данных просто нет).
  if (isRealMode){
    window.location.href = 'backend/api/clients.php?export=xlsx';
    return;
  }
  if (!clients.length){ showToast('Пока нет клиентов для экспорта', 'info'); return; }
  const header = ['Имя', 'Канал', 'Этап', 'Сумма, сомони', 'Настроение', 'Заметка', 'Создано', 'Обновлено'];
  const rows = clients.map(c => [
    c.name,
    c.channel.name,
    (COLUMNS.find(col => col.id === c.col) || {}).title || c.col,
    Number(c.value) || 0,
    CSV_SENT_LABEL[c.sentiment] || c.sentiment,
    c.notes || '',
    c.createdAt ? new Date(c.createdAt).toLocaleString('ru-RU') : '',
    c.updatedAt ? new Date(c.updatedAt).toLocaleString('ru-RU') : '',
  ]);
  // ; вместо , — Excel в русской/таджикской локали по умолчанию ждёт именно
  // точку с запятой (запятая занята под десятичный разделитель).
  const csv = [header, ...rows].map(r => r.map(csvCell).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mysavdo-clients-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast(`Выгружено клиентов: ${clients.length}`, 'ok');
}
$('#btnExportClientsCsv')?.addEventListener('click', exportClientsCsv);

// Мини-карточка клиента — открывается кликом по кружку-аватару в карточке
// (отдельно от клика по всей карточке, который открывает чат).
function openClientInfoModal(id){
  const c = clients.find(x => x.id === id);
  if (!c) return;
  $('#clientInfoAvatar').innerHTML = `<span>${escapeHtml(initials(c.name))}</span>`;
  $('#clientInfoName').textContent = c.name;
  $('#clientInfoChan').innerHTML = `${chanBadge(c.channel)}${escapeHtml(c.channel.name)}`;
  $('#clientInfoPhone').textContent = c.phone || '—';
  $('#clientInfoHandle').textContent = c.handle || c.channelId || '—';
  $('#clientInfoStage').textContent = (COLUMNS.find(col => col.id === c.col) || {}).title || c.col;
  $('#clientInfoValue').textContent = `${Number(c.value) || 0} сомони`;
  const sent = SENTIMENT_META[c.sentiment || 'neu'];
  $('#clientInfoSentiment').textContent = sent ? sent.label : '—';
  $('#clientInfoCreated').textContent = c.createdAt ? new Date(c.createdAt).toLocaleString('ru-RU') : '—';
  $('#clientInfoSeen').textContent = c.lastSeenAt ? new Date(c.lastSeenAt).toLocaleString('ru-RU') : 'ещё не было';
  const notesWrap = $('#clientInfoNotesWrap');
  if (c.notes){
    notesWrap.style.display = 'block';
    $('#clientInfoNotes').textContent = c.notes;
  } else {
    notesWrap.style.display = 'none';
  }
  $('#clientInfoModal').dataset.clientId = c.id;
  $('#clientInfoModal').classList.add('active');
}
$('#clientInfoClose')?.addEventListener('click', () => $('#clientInfoModal').classList.remove('active'));
$('#clientInfoModal')?.addEventListener('click', e => { if (e.target.id === 'clientInfoModal') $('#clientInfoModal').classList.remove('active'); });
$('#clientInfoOpenChat')?.addEventListener('click', () => {
  const id = Number($('#clientInfoModal').dataset.clientId);
  $('#clientInfoModal').classList.remove('active');
  switchDashView('funnel');
  openChat(id);
});
$('#clientInfoExport')?.addEventListener('click', () => {
  const id = $('#clientInfoModal').dataset.clientId;
  if (!isRealMode){ showToast('Экспорт доступен после входа в аккаунт', 'info'); return; }
  window.location.href = 'backend/api/clients.php?export=xlsx&id=' + encodeURIComponent(id);
});
const NAMES = ['Рахимов З.','Фарида А.','Дилноза М.','Зарина К.','Лола Т.','Сорбон Н.','Мадина Р.','Умар Т.'];
const SAMPLE_MSGS = [
  'Здравствуйте! Есть это платье в наличии?',
  'Здравствуйте, а доставка в Худжанд есть?',
  'Можно скинуть фото в другом цвете?',
  'Подскажите, сколько стоит новая ваза?',
  'Оплата картой возможна?',
  'Заказ уже готов к отправке?',
  'Спасибо большое, всё отлично, очень довольна!',
  'Здравствуйте! Размер S есть в наличии?',
  'Это уже третий день жду ответа, очень плохо',
  'Разочарован качеством, хочу вернуть деньги',
  'Обманули с размером, это ужасно',
  'Отлично, беру! Когда доставите?',
  'Супер, именно то что искала, спасибо!',
];

function computeSentiment(text){
  const t = text.toLowerCase();
  const neg = ['плохо','ужас','обман','верните','возврат','разочарован','долго жду','недоволен','жалоба','не работает'];
  const pos = ['спасибо','отлично','супер','класс','нравится','довольна','довольн','беру','заказываю','рада'];
  if (neg.some(w => t.includes(w))) return 'neg';
  if (pos.some(w => t.includes(w))) return 'pos';
  return 'neu';
}
const SENTIMENT_META = {
  pos: { label:'Довольный', cls:'sent-pos' },
  neu: { label:'Нейтральный', cls:'sent-neu' },
  neg: { label:'Недоволен', cls:'sent-neg' },
};

let clients = [];
let clientSeq = 1;
const MAX_PER_COLUMN = 6;

function enforceColumnCap(colId){
  const items = clients.filter(c => c.col === colId).sort((a,b) => a.id - b.id);
  const excess = items.length - MAX_PER_COLUMN;
  if (excess <= 0) return;
  let removed = 0;
  for (const c of items){
    if (removed >= excess) break;
    if (c.id === activeChatId) continue;
    const idx = clients.findIndex(x => x.id === c.id);
    if (idx > -1){ clients.splice(idx, 1); removed++; }
  }
}

function seedClients(){
  clients = [];
  const seedCounts = { new:3, consult:2, deal:1, pay:1, done:2 };
  Object.entries(seedCounts).forEach(([col, n]) => {
    for (let i=0;i<n;i++) clients.push(makeClient(col, Math.random()*95));
  });
}
function makeClient(col, ageMinutes=0){
  const name = NAMES[Math.floor(Math.random()*NAMES.length)];
  const chan = CHANNELS[Math.floor(Math.random()*CHANNELS.length)];
  const msg = SAMPLE_MSGS[Math.floor(Math.random()*SAMPLE_MSGS.length)];
  return {
    id: clientSeq++,
    name, channel: chan,
    lastMsg: msg,
    sentiment: computeSentiment(msg),
    col,
    value: Math.round((Math.random()*1050 + 150) / 10) * 10,
    updatedAt: Date.now() - ageMinutes*60000,
    createdAt: Date.now() - ageMinutes*60000,
    isNew: false,
    history: [{ from:'in', text: msg, at: Date.now() - ageMinutes*60000 }]
  };
}

function initials(name){ return name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase(); }

let dragSourceId = null;

let isRealMode = false;

async function apiListClients(){
  let r;
  try{
    r = await apiFetch('backend/api/clients.php', { credentials:'include' });
  } catch(e){
    const err = new Error('network_failed');
    err.code = 0;
    throw err;
  }
  if (!r.ok){
    const err = new Error('list_failed');
    err.code = r.status;
    throw err;
  }
  const data = await r.json();
  return data.clients || [];
}
async function apiUpdateClientStage(id, stage){
  const r = await apiFetch(`backend/api/clients.php?id=${id}`, {
    method:'PATCH', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ stage })
  });
  if (!r.ok) throw new Error('update_failed');
  return (await r.json()).client;
}
async function apiListMessages(clientId){
  const r = await fetch(`backend/api/messages.php?client_id=${clientId}`, { credentials:'include' });
  if (!r.ok) throw new Error('messages_failed');
  return (await r.json()).messages || [];
}
async function apiSendMessage(clientId, text){
  const r = await apiFetch('backend/api/messages.php', {
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ client_id: clientId, direction:'out', text })
  });
  if (!r.ok) throw new Error('send_failed');
}
async function apiSendTelegram(clientId, text){
  const r = await apiFetch('backend/api/telegram-send.php', {
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ client_id: clientId, text })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'telegram_send_failed');
}

function lastMsgPreview(row){
  if (row.last_message_kind === 'photo') return '📷 Фото';
  if (row.last_message_kind === 'audio') return '🎤 Голосовое сообщение';
  return row.last_message_text || '';
}
function mapApiClientToLocal(row){
  const chan = CHANNELS.find(c => c.name === row.channel) || CHANNELS[0];
  return {
    id: row.id,
    name: row.name,
    channel: chan,
    channelId: row.channel_id,
    phone: row.phone || '',
    handle: row.handle || '',
    lastMsg: lastMsgPreview(row),
    sentiment: row.sentiment || 'neu',
    col: row.stage,
    value: row.value || 0,
    aiAuto: !!row.ai_auto,
    notes: row.notes || '',
    remindAt: row.remind_at ? parseServerTime(row.remind_at) : null,
    remindNote: row.remind_note || '',
    aiRisk: typeof row.ai_risk_score === 'number' ? row.ai_risk_score : null,
    aiRiskReason: row.ai_risk_reason || '',
    aiRiskAt: row.ai_risk_at ? parseServerTime(row.ai_risk_at) : null,
    pinned: !!row.pinned,
    lastSeenAt: row.last_seen_at ? parseServerTime(row.last_seen_at) : null,
    updatedAt: row.updated_at ? parseServerTime(row.updated_at) : Date.now(),
    createdAt: row.created_at ? parseServerTime(row.created_at) : Date.now(),
    isNew: false,
    history: [],
    _historyLoaded: false,
    _lastMsgId: row.last_message_id || 0,
  };
}

async function tryLoadRealClients(){
  try{
    const rows = await apiListClients();
    clients = rows.map(mapApiClientToLocal);
    isRealMode = true;
    startRealPolling();
    return 'ok';
  } catch(e){
    isRealMode = false;
    if (e && e.code === 401) return 'unauthorized';
    return 'error';
  }
}

let clientsRetryTimer = null;
let clientsRetryAttempt = 0;
const CLIENTS_RETRY_DELAYS = [5000, 15000, 30000];
async function loadDashboardClients(){
  clearTimeout(clientsRetryTimer);
  const status = await tryLoadRealClients();

  if (status === 'unauthorized'){
    $('#serviceUnavailableBanner').style.display = 'none';
    $('#dashEmptyState').style.display = 'none';
    clients = [];
    stopRealPolling();
    Auth.setUser(null);
    showScreen('screen-landing');
    openAuth('login');
    return status;
  }

  if (status === 'error'){
    clients = [];
    $('#serviceUnavailableBanner').style.display = 'block';
    if (clientsRetryAttempt < CLIENTS_RETRY_DELAYS.length){
      const delay = CLIENTS_RETRY_DELAYS[clientsRetryAttempt];
      clientsRetryAttempt++;
      clientsRetryTimer = setTimeout(async () => {
        await loadDashboardClients();
        await loadAnalytics();
        buildTrendData();
        renderAll();
      }, delay);
    }
  } else {
    $('#serviceUnavailableBanner').style.display = 'none';
    clientsRetryAttempt = 0;
  }

  $('#dashEmptyState').style.display = (status === 'ok' && clients.length === 0) ? 'flex' : 'none';
  return status;
}
$('#btnRetryClients')?.addEventListener('click', async () => {
  clientsRetryAttempt = 0;
  await loadDashboardClients();
  await loadAnalytics();
  buildTrendData();
  renderAll();
});

let realPollTimer = null;
let realPollInFlight = false;
function startRealPolling(){
  if (realPollTimer) return;
  realPollTimer = setInterval(pollRealClients, 6000);
}
function stopRealPolling(){
  if (realPollTimer){ clearInterval(realPollTimer); realPollTimer = null; }
}
async function pollRealClients(){
  if (!isRealMode || !Auth.current()) return;
  if (document.hidden) return;
  if (realPollInFlight) return;
  realPollInFlight = true;
  let rows;
  try{ rows = await apiListClients(); } catch(e){ realPollInFlight = false; return; }
  realPollInFlight = false;

  const prevById = {};
  clients.forEach(c => { prevById[c.id] = c; });
  let changed = false;

  const nextClients = rows.map(row => {
    const prev = prevById[row.id];
    if (!prev){

      const c = mapApiClientToLocal(row);
      if ((row.last_message_dir || 'in') === 'in' && c.lastMsg){
        c.isNew = true;
        c.sentiment = row.last_message_text ? computeSentiment(row.last_message_text) : c.sentiment;
        pushNotification(c, c.lastMsg);
      }
      changed = true;
      return c;
    }

    const gotNewIncoming = (row.last_message_id || 0) > (prev._lastMsgId || 0) && row.last_message_dir === 'in';
    prev.col = row.stage;
    prev.value = row.value || 0;
    prev.aiAuto = !!row.ai_auto;
    prev.lastSeenAt = row.last_seen_at ? parseServerTime(row.last_seen_at) : prev.lastSeenAt;
    prev.updatedAt = row.updated_at ? parseServerTime(row.updated_at) : prev.updatedAt;
    if ((row.last_message_id || 0) !== (prev._lastMsgId || 0)){
      prev.lastMsg = lastMsgPreview(row) || prev.lastMsg;
      prev._lastMsgId = row.last_message_id || 0;
      prev._historyLoaded = false;
      changed = true;
    }
    if (gotNewIncoming){
      prev.isNew = true;
      if (row.last_message_text) prev.sentiment = computeSentiment(row.last_message_text);
      pushNotification(prev, prev.lastMsg);
      playNotifSound();

      if (activeChatId === prev.id && $('#chatOverlay').classList.contains('active')){
        apiListMessages(prev.id).then(msgRows => {
          prev.history = msgRows.map(m => ({
            from: m.direction === 'in' ? 'in' : 'out',
            text: m.text || '',
            photo: m.photo_url || null,
            audio: m.audio_url || null,
            at: parseServerTime(m.created_at),
          }));
          prev._historyLoaded = true;
          if (activeChatId === prev.id) renderChatHeaderAndBody(prev);
        }).catch(() => {});
      }
    }
    return prev;
  });

  clients = nextClients;
  if (changed){
    renderAll();
    setTimeout(() => { clients.forEach(c => c.isNew = false); }, 1400);
  } else {

    if (activeChatId) updateChatStatus(clients.find(x => x.id === activeChatId));
  }
}

let _audioCtx = null;
function playNotifSound(){
  try{
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = _audioCtx.createOscillator();
    const g = _audioCtx.createGain();
    o.connect(g); g.connect(_audioCtx.destination);
    o.type = 'sine';
    o.frequency.setValueAtTime(880, _audioCtx.currentTime);
    o.frequency.exponentialRampToValueAtTime(660, _audioCtx.currentTime + 0.12);
    g.gain.setValueAtTime(0.06, _audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, _audioCtx.currentTime + 0.25);
    o.start(); o.stop(_audioCtx.currentTime + 0.26);
  } catch(e){  }
  if (navigator.vibrate) { try{ navigator.vibrate(60); } catch(e){} }
}

function moveClientToCol(c, colId, x, y){
  if (!c || c.col === colId) return;
  const prevCol = c.col;
  const wasDone = c.col === 'done';
  c.col = colId;
  renderAll();
  if (colId === 'done' && !wasDone) fireConfetti(x, y);
  if (isRealMode){
    apiUpdateClientStage(c.id, colId).catch(() => {
      c.col = prevCol;
      renderAll();
      alert('Не удалось сохранить изменение на сервере — попробуйте ещё раз');
    });
  }
}

function renderKanban(){
  const board = $('#kanban');

  const firstRects = {};
  $$('.kcard', board).forEach(el => { firstRects[el.dataset.id] = el.getBoundingClientRect(); });
  const isFirstEverRender = board.dataset.rendered !== '1';
  board.dataset.rendered = '1';

  board.innerHTML = '';
  board.appendChild(kanbanAllColumnsBtn());
  visibleColumns().forEach(col => {
    const items = clients.filter(c => c.col === col.id);
    const colEl = document.createElement('div');
    colEl.className = 'kcol';
    // Сумма и средний чек по колонке — видно с первого взгляда, где реально
    // "лежат деньги" в воронке, не открывая Аналитику отдельно.
    const colTotal = items.reduce((s, c) => s + (Number(c.value) || 0), 0);
    const colAvg = items.length ? Math.round(colTotal / items.length) : 0;
    colEl.innerHTML = `
      <div class="kcol-head"><h4>${escapeHtml(col.title)}</h4><span class="kcol-count">${items.length}</span></div>
      ${items.length ? `<div class="kcol-stats">
        <span class="kcol-stat" title="Сумма сделок в колонке"><b>${colTotal.toLocaleString('ru-RU')}</b> см. всего</span>
        <span class="kcol-stat" title="Средний чек в колонке">~<b>${colAvg.toLocaleString('ru-RU')}</b> ср.</span>
      </div>` : ''}
      <div class="kcards" data-col="${col.id}"></div>`;
    const cardsWrap = $('.kcards', colEl);
    items.forEach(c => {
      const isTrulyNew = !firstRects[c.id] && !isFirstEverRender;
      cardsWrap.appendChild(renderCard(c, isTrulyNew));
    });

    cardsWrap.addEventListener('dragover', e => { e.preventDefault(); cardsWrap.classList.add('drag-over'); });
    cardsWrap.addEventListener('dragleave', () => cardsWrap.classList.remove('drag-over'));
    cardsWrap.addEventListener('drop', e => {
      e.preventDefault();
      cardsWrap.classList.remove('drag-over');
      const c = clients.find(x => x.id === dragSourceId);
      moveClientToCol(c, col.id, e.clientX, e.clientY);
    });

    board.appendChild(colEl);
  });

  requestAnimationFrame(() => {
    $$('.kcard', board).forEach(el => {
      const first = firstRects[el.dataset.id];
      if (!first) return;
      const last = el.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1){
        el.style.transition = 'none';
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        requestAnimationFrame(() => {
          el.classList.add('flip-move');
          el.style.transform = '';
          setTimeout(() => { el.classList.remove('flip-move'); el.style.transition = ''; }, 420);
        });
      }
    });
  });
}

function kanbanAllColumnsBtn(){
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'kanban-all-btn';
  btn.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><use href="#icon-command"/></svg><span>Все колонки</span>`;
  btn.addEventListener('click', openFunnelStagesModal);
  return btn;
}

function showKanbanSkeleton(){
  const board = $('#kanban');
  board.dataset.rendered = '0';
  board.innerHTML = '<div class="kanban-all-btn"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-command"/></svg><span>Все колонки</span></div>' + visibleColumns().map(col => `
    <div class="kcol">
      <div class="kcol-head"><h4>${escapeHtml(col.title)}</h4><span class="kcol-count">–</span></div>
      <div class="kcards">
        <div class="skeleton kcard-skeleton"></div>
        <div class="skeleton kcard-skeleton"></div>
      </div>
    </div>`).join('');
}

// «Тестовая карточка» — быстрый способ увидеть, как выглядит и ведёт себя
// настоящая карточка клиента (со всеми бейджами — SLA, напоминание, риск
// ИИ и т.п.), не дожидаясь реального обращения. Создаётся тем же POST
// clients.php, что и обычная заявка, — значит подчиняется тем же лимитам
// тарифа и её так же можно удалить/отредактировать как любую другую.
$('#btnAddTestCard')?.addEventListener('click', async () => {
  if (!isRealMode){ showToast('Доступно после входа в аккаунт', 'info'); return; }
  const btn = $('#btnAddTestCard');
  if (btn.dataset.busy === '1') return;
  btn.dataset.busy = '1';
  btn.disabled = true;
  try{
    const name = NAMES[Math.floor(Math.random() * NAMES.length)];
    const chan = CHANNELS[Math.floor(Math.random() * CHANNELS.length)];
    const msg = SAMPLE_MSGS[Math.floor(Math.random() * SAMPLE_MSGS.length)];
    const value = Math.round((Math.random() * 1050 + 150) / 10) * 10;
    const r = await apiFetch('backend/api/clients.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        name: `${name} (тест)`, channel: chan.name, stage:'new',
        value, sentiment: computeSentiment(msg), first_message: msg,
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Не удалось создать тестовую карточку');
    const c = mapApiClientToLocal(data.client);
    c.isNew = true;
    clients.push(c);
    renderAll();
    switchDashView('funnel');
    openChat(c.id);
    showToast('Тестовая карточка добавлена — удалить её можно как обычную заявку, в чате', 'ok');
  } catch(e){
    showToast(e.message || 'Не удалось создать тестовую карточку', 'error');
  } finally {
    btn.dataset.busy = '0';
    btn.disabled = false;
  }
});

function slaInfo(c){
  const min = (Date.now() - c.updatedAt) / 60000;
  if (c.col === 'done') return null;
  if (min < 20) return { cls:'sla-ok', label: min < 1 ? 'только что' : Math.round(min) + ' мин' };
  if (min < 60) return { cls:'sla-warn', label: Math.round(min) + ' мин' };
  return { cls:'sla-danger', label: Math.round(min/60) + ' ч ' + Math.round(min%60) + ' м' };
}

function renderCard(c, animateEnter){
  const el = document.createElement('div');
  el.className = 'kcard' + (c.isNew ? ' flash' : '') + (c.pinned ? ' pinned' : '') + (animateEnter ? ' card-enter' : '');
  el.dataset.id = c.id;
  el.draggable = true;
  const sent = SENTIMENT_META[c.sentiment || 'neu'];
  const sla = slaInfo(c);
  const remindDue = c.remindAt && c.remindAt <= Date.now();
  // Свежая (после последнего изменения сделки) высокая оценка риска от
  // ИИ-скана (см. #riskScanBtn) — та же граница (>=30), что и в
  // renderNextActions(), чтобы бейдж на карточке и список "Что сделать в
  // первую очередь" не противоречили друг другу.
  const highRisk = c.aiRisk !== null && c.aiRiskAt && c.aiRiskAt >= c.updatedAt && c.aiRisk >= 30;
  const isFresh = !c.isNew && (Date.now() - (c.createdAt || 0)) < 30 * 60 * 1000;
  const lastEntry = c.history[c.history.length - 1];
  const photo = lastEntry && lastEntry.photo ? lastEntry.photo : null;
  el.innerHTML = `
    ${c.pinned ? '<svg class="icon icon-sm kcard-pin" viewBox="0 0 24 24"><use href="#icon-pin"/></svg>' : ''}
    <div class="kcard-top">
      <div class="kcard-avatar">${escapeHtml(initials(c.name))}</div>
      <div>
        <div class="kcard-name">${escapeHtml(c.name)}${isFresh ? '<span class="kcard-fresh">новая</span>' : ''}</div>
        <div class="kcard-chan">${chanBadge(c.channel)}${escapeHtml(c.channel.name)}</div>
      </div>
      <span class="kcard-value">${Number(c.value) || 0} см.</span>
    </div>
    ${photo ? `<img class="kcard-photo" src="${escapeHtml(photo)}" alt="Фото от клиента">` : ''}
    <div class="kcard-msg">${escapeHtml(c.lastMsg)}</div>
    <div class="kcard-foot">
      <span class="kcard-sent-label ${sent.cls}"><span class="sent-dot"></span>${sent.label}</span>
      ${sla ? `<span class="sla-badge ${sla.cls}"><svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-clock"/></svg>${sla.label}</span>` : ''}
      ${remindDue ? `<span class="sla-badge sla-warn"><svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-bell"/></svg>Напомнить</span>` : ''}
      ${highRisk ? `<span class="sla-badge sla-danger"><svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-sparkle"/></svg>Риск ${c.aiRisk}%</span>` : ''}
    </div>
    ${c.isNew ? '<span class="kcard-badge">Новое сообщение</span>' : ''}
  `;
  el.addEventListener('click', () => {
    if (touchDragState.justDragged) return;
    openChat(c.id);
  });
  $('.kcard-avatar', el)?.addEventListener('click', e => {
    e.stopPropagation();
    openClientInfoModal(c.id);
  });
  el.addEventListener('dragstart', e => {
    dragSourceId = c.id;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => { el.classList.remove('dragging'); dragSourceId = null; });
  attachTouchDrag(el, c);
  return el;
}

const Track = (() => {
  let clicks = {};
  let screenTimes = {};
  let currentScreen = null;
  let screenStartedAt = null;
  let inited = false;

  function bumpClick(target){
    if (!target) return;
    clicks[target] = (clicks[target] || 0) + 1;
  }

  function flushScreenTime(){
    if (currentScreen && screenStartedAt){
      const ms = Date.now() - screenStartedAt;
      if (ms > 0) screenTimes[currentScreen] = (screenTimes[currentScreen] || 0) + ms;
    }
    screenStartedAt = Date.now();
  }

  function enterScreen(screen){
    flushScreenTime();
    currentScreen = screen;
  }

  async function send(){
    flushScreenTime();
    if (!Auth.current()){ clicks = {}; screenTimes = {}; return; }
    if (Object.keys(clicks).length === 0 && Object.keys(screenTimes).length === 0 && !currentScreen) return;
    const payload = { clicks, screens: screenTimes, current_screen: currentScreen || '' };
    clicks = {}; screenTimes = {};
    try{
      await apiFetch('backend/api/track.php', {
        method:'POST', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload),
      });
    } catch(e){}
  }

  function init(){
    if (inited) return;
    inited = true;
    document.addEventListener('click', (e) => {
      const el = e.target.closest('.dash-nav button[data-view], .dash-tabbar button[data-view], button[id], a[id]');
      if (!el || !el.closest('#screen-dashboard')) return;
      bumpClick(el.dataset.view ? ('view:' + el.dataset.view) : el.id);
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) send(); });
    setInterval(send, 60000);
  }

  return { bumpClick, enterScreen, send, init };
})();

function openDashboard(){
  const user = Auth.current();
  if (!user){ showScreen('screen-landing'); openAuth('register'); return; }
  Track.init();
  Track.enterScreen(localStorage.getItem('mysavdo_last_view') || 'home');
  showScreen('screen-dashboard');
  {
    const initial = escapeHtml((user.shop_name || user.email)[0].toUpperCase());
    const avatarHtml = user.avatar
      ? `<img src="${escapeHtml(user.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
      : initial;
    $('#dashAvatar').innerHTML = avatarHtml;
    $('#accountMenuAvatar').innerHTML = avatarHtml;
    $('#accountMenuName').textContent = user.shop_name || 'Продавец';
    $('#accountMenuEmail').textContent = displayEmail(user.email);
    $('#dashGreeting').textContent = `С возвращением, ${user.shop_name || 'продавец'}!`;
    updateAccountMenuMeta(user);
  }
  updateVerifyBanner(user);
  refreshShopMenuUI();
  refreshDmBadge();
  refreshJourneyBadge();

  showKanbanSkeleton();
  clientsRetryAttempt = 0;
  (async () => {
    const [status] = await Promise.all([loadDashboardClients(), loadFunnelStages()]);
    if (user) loadPlanState().catch(() => {});
    if (status === 'ok') await loadAnalytics();
    buildTrendData();
    renderAll();
  })();

  refreshTelegramStatus();
  refreshInstagramStatus();
  initSupportWidget();
  loadStories();
  if (!localStorage.getItem('mysavdo_dash_tour_done')){
    setTimeout(() => startTour(DASHBOARD_TOUR, 'mysavdo_dash_tour_done'), 650);
  }
}
const btnDashTourEl = document.getElementById('btnDashTour');
if (btnDashTourEl) btnDashTourEl.addEventListener('click', () => {
  $('#accountMenu').classList.remove('open');
  startTour(DASHBOARD_TOUR, 'mysavdo_dash_tour_done');
});

async function refreshTelegramStatus(){
  if (!Auth.current()) return;
  try{
    const r = await apiFetch('backend/api/telegram-bot-settings.php', { credentials:'include' });
    if (!r.ok) return;
    const data = await r.json();
    const label = $('#telegramMenuLabel');
    if (label) label.textContent = data.connected ? `Telegram: @${data.bot_username}` : 'Подключить Telegram';
  } catch(e){  }
}

function openTelegramModal(){
  $('#accountMenu').classList.remove('open');
  $('#telegramModal').classList.add('active');
  $('#telegramModalError').classList.remove('show');
  apiFetch('backend/api/telegram-bot-settings.php', { credentials:'include' })
    .then(r => r.ok ? r.json() : { connected:false })
    .then(data => {
      $('#telegramConnectedState').style.display = data.connected ? 'block' : 'none';
      $('#telegramConnectForm').style.display = data.connected ? 'none' : 'block';
      if (data.connected) $('#telegramConnectedUsername').textContent = '@' + data.bot_username;
    })
    .catch(() => {});
}
$('#btnOpenTelegramModal')?.addEventListener('click', openTelegramModal);
$('#telegramModalClose')?.addEventListener('click', () => $('#telegramModal').classList.remove('active'));
$('#telegramModal')?.addEventListener('click', e => { if (e.target.id === 'telegramModal') $('#telegramModal').classList.remove('active'); });

$('#telegramConnectForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const token = $('#telegramTokenInput').value.trim();
  const errBox = $('#telegramModalError');
  errBox.classList.remove('show');
  if (!token){ errBox.textContent = 'Вставьте токен бота'; errBox.classList.add('show'); return; }

  const submitBtn = $('#telegramConnectSubmit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Подключаем…';
  try{
    const r = await apiFetch('backend/api/telegram-bot-settings.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ bot_token: token })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Не удалось подключить бота');

    $('#telegramConnectForm').style.display = 'none';
    $('#telegramConnectedState').style.display = 'block';
    $('#telegramConnectedUsername').textContent = '@' + data.bot_username;
    $('#telegramTokenInput').value = '';
    refreshTelegramStatus();
  } catch(err){
    errBox.textContent = err.message || 'Не удалось подключить бота';
    errBox.classList.add('show');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Подключить';
  }
});

$('#btnTelegramDisconnect')?.addEventListener('click', async () => {
  if (!confirm('Отключить Telegram-бота? Заявки, которые уже пришли, останутся в CRM.')) return;
  try{
    await apiFetch('backend/api/telegram-bot-settings.php', { method:'DELETE', credentials:'include' });
  } catch(e){}
  $('#telegramConnectedState').style.display = 'none';
  $('#telegramConnectForm').style.display = 'block';
  refreshTelegramStatus();
});

let igState = null;

async function fetchInstagramStatus(){
  try{
    const r = await apiFetch('backend/api/instagram-status.php', { credentials:'include' });
    if (!r.ok) return null;
    return await r.json();
  } catch(e){ return null; }
}

async function refreshInstagramStatus(){
  const data = await fetchInstagramStatus();
  if (!data) return;
  igState = data;
  const label = $('#instagramMenuLabel');
  if (label) label.textContent = data.connected ? `Instagram: @${data.username}` : 'Подключить Instagram';
}

function renderInstagramModal(data){
  const connected = !!(data && data.connected);
  $('#instagramConnectedState').style.display = connected ? 'block' : 'none';
  $('#instagramMetaConnect').style.display = connected ? 'none' : 'block';
  $('#instagramModalError').classList.remove('show');

  if (connected){
    $('#instagramConnectedUsername').textContent = '@' + (data.username || '');
  }
}

async function openInstagramModal(){
  $('#accountMenu').classList.remove('open');
  $('#instagramModal').classList.add('active');
  renderInstagramModal(igState);
  const data = await fetchInstagramStatus();
  if (data){ igState = data; renderInstagramModal(data); }
}

$('#btnOpenInstagramModal')?.addEventListener('click', openInstagramModal);
$('#instagramModalClose')?.addEventListener('click', () => $('#instagramModal').classList.remove('active'));
$('#instagramModal')?.addEventListener('click', e => { if (e.target.id === 'instagramModal') $('#instagramModal').classList.remove('active'); });

$('#btnInstagramMetaConnect')?.addEventListener('click', () => {
  location.href = 'backend/api/instagram-oauth-start.php';
});

// «Другие соцсети» — просто список «в очереди», без бэкенда: раскрывашка,
// чтобы не загромождать экран одиннадцатью неактивными карточками сразу.
$('#socialMoreToggle')?.addEventListener('click', () => {
  const btn = $('#socialMoreToggle');
  const panel = $('#socialMorePanel');
  const willOpen = panel.hidden;
  panel.hidden = !willOpen;
  btn.classList.toggle('open', willOpen);
  btn.querySelector('span').textContent = willOpen ? 'Скрыть' : 'Другие соцсети и мессенджеры';
});

$('#btnInstagramDisconnect')?.addEventListener('click', async () => {
  if (!confirm('Отключить Instagram? Заявки, которые уже пришли, останутся в CRM.')) return;
  try{
    await apiFetch('backend/api/instagram-status.php', { method:'DELETE', credentials:'include' });
  } catch(e){}
  igState = null;
  renderInstagramModal(null);
  refreshInstagramStatus();
});

function renderAll(){
  renderKanban();
  renderHome();
  renderClients();
  renderAnalytics();
}

$$('.dash-nav button, .account-menu button[data-view]').forEach(btn => {
  btn.addEventListener('click', () => { switchDashView(btn.dataset.view); closeAccountMenu(); });
});
$$('[data-goto]').forEach(el => {
  el.addEventListener('click', () => switchDashView(el.dataset.goto));
});
function switchDashView(name){
  localStorage.setItem('mysavdo_last_view', name);
  Track.enterScreen(name);
  $$('.dash-nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $$('.dash-tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $$('.dash-view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'ai' && aiMessages.length === 0) aiWelcome();
  if (name === 'plan') renderPlanView();
  else stopPlanCountdown();
  const dashBody = $('.dash-body');
  if (dashBody) window.scrollTo({ top: 0, behavior: 'smooth' });
}

$$('.dash-tabbar button').forEach(btn => {
  btn.addEventListener('click', () => switchDashView(btn.dataset.view));
});

const PLAN_CATALOG = [
  { plan:'demo',     title:'Демо',     price:0,  socials:1, feats:['1 месяц бесплатно','Instagram или Telegram — на выбор','Базовая воронка: до 100 заявок','Чат ИИ: 15 сообщений в день'] },
  { plan:'standard', title:'Стандарт', price:79, socials:1, feats:['Безлимит заявок','Instagram или Telegram — на выбор','Полная аналитика и отчёты','Чат ИИ: 15 сообщений в день'] },
  { plan:'business', title:'Бизнес',   price:179, socials:2, feats:['Всё из «Стандарта»','Instagram и Telegram — одновременно','ИИ-автоответчик клиентам','Чат ИИ без дневных лимитов'] },
];

const PANEL_DEFAULTS = { panel_funnel:true, panel_analytics:true, panel_clients:true, panel_plan:true };
const PLAN_FEATURES_JS = {
  none:     Object.assign({ ai_chat:false, ai_daily_limit:0,  ai_reply:false, ai_auto:false, analytics_full:false, socials_limit:0, clients_limit:0,   can_send:false }, PANEL_DEFAULTS),
  demo:     Object.assign({ ai_chat:true,  ai_daily_limit:15, ai_reply:true,  ai_auto:false, analytics_full:false, socials_limit:1, clients_limit:100, can_send:true  }, PANEL_DEFAULTS),
  standard: Object.assign({ ai_chat:true,  ai_daily_limit:50,  ai_reply:true,  ai_auto:false, analytics_full:true,  socials_limit:1, clients_limit:null,can_send:true  }, PANEL_DEFAULTS),
  business: Object.assign({ ai_chat:true,  ai_daily_limit:null,ai_reply:true,  ai_auto:true,  analytics_full:true,  socials_limit:2, clients_limit:null,can_send:true  }, PANEL_DEFAULTS),
};
let userFeatures = Object.assign({}, PLAN_FEATURES_JS.demo);
let aiUsage = { used: 0, limit: 15 };
let planState = null;
let planLocalMode = false;
let planCountdownTimer = null;

// Общий безопасный разбор локального (офлайн/неавторизованного) состояния
// тарифа — connectPlan()/switchToPlan() раньше делали голый JSON.parse без
// защиты и падали с TypeError, если их дёргали до loadPlanState() (который
// один сам сеет значение по умолчанию) или если ключ пропал из localStorage.
function localPlanRead(){
  let local = null;
  try{ local = JSON.parse(localStorage.getItem('mysavdo_local_plan_v2')); } catch(_){}
  if (!local || typeof local !== 'object'){
    const now = Date.now();
    local = { active:{ plan:'demo', starts: now, ends: now + 30*24*3600*1000 }, paused: [], demoUsed: true };
  }
  if (!Array.isArray(local.paused)) local.paused = [];
  return local;
}

async function loadPlanState(){
  try{
    const r = await apiFetch('backend/api/plan.php', { credentials:'include' });
    if (!r.ok) throw new Error();
    planState = await r.json();
    planLocalMode = false;
    if (planState.features) userFeatures = planState.features;
    if (planState.ai_usage) aiUsage = planState.ai_usage;
  } catch(e){

    planLocalMode = true;
    let local = null;
    try{ local = JSON.parse(localStorage.getItem('mysavdo_local_plan_v2')); } catch(_){}
    if (!local){
      const now = Date.now();
      local = { active:{ plan:'demo', starts: now, ends: now + 30*24*3600*1000 }, paused: [], demoUsed: true };
      localStorage.setItem('mysavdo_local_plan_v2', JSON.stringify(local));
    }

    while (local.active && local.active.ends <= Date.now()){
      local.paused.sort((a,b) => (a.plan==='demo') - (b.plan==='demo'));
      const next = local.paused.shift();
      local.active = next ? { plan: next.plan, starts: Date.now(), ends: Date.now() + next.remaining } : null;
      localStorage.setItem('mysavdo_local_plan_v2', JSON.stringify(local));
      if (!next) break;
    }
    const metaOf = p => PLAN_CATALOG.find(x => x.plan === p) || PLAN_CATALOG[0];
    planState = {
      active: local.active ? Object.assign({ title: metaOf(local.active.plan).title, price: metaOf(local.active.plan).price,
        plan: local.active.plan, starts_at: local.active.starts, ends_at: local.active.ends }, {}) : null,
      paused: local.paused.map((p,i) => ({ id: i+1, plan: p.plan, title: metaOf(p.plan).title, price: metaOf(p.plan).price, remaining_seconds: Math.round(p.remaining/1000) })),
      demo_used: !!local.demoUsed,
      payments: [],
    };
    userFeatures = Object.assign({}, PLAN_FEATURES_JS[local.active ? local.active.plan : 'none']);
    let usedToday = 0;
    try{
      const u = JSON.parse(localStorage.getItem('mysavdo_ai_usage'));
      if (u && u.day === new Date().toDateString()) usedToday = u.used;
    } catch(_){}
    aiUsage = { used: usedToday, limit: userFeatures.ai_daily_limit };
  }
  applyFeaturesUI();
  return planState;
}

function applyFeaturesUI(){
  const f = userFeatures;

  const PANEL_VIEWS = { funnel:'panel_funnel', analytics:'panel_analytics', clients:'panel_clients', plan:'panel_plan' };
  Object.entries(PANEL_VIEWS).forEach(([view, key]) => {
    const visible = f[key] !== false;
    $$(`.dash-nav [data-view="${view}"], .dash-tabbar [data-view="${view}"], .account-menu [data-view="${view}"]`)
      .forEach(btn => { btn.style.display = visible ? '' : 'none'; });

    const viewEl = document.getElementById('view-' + view);
    if (!visible && viewEl && viewEl.classList.contains('active')) switchDashView('home');
  });

  updateAiLimitBadge();
  updateInstaPromo();
  const aiLocked = !f.ai_chat;
  const aiPage = document.querySelector('.ai-page');
  if (aiPage){
    let lock = $('#aiPageLock');
    if (aiLocked){
      if (!lock){
        lock = document.createElement('div');
        lock.id = 'aiPageLock';
        lock.className = 'feature-lock';
        lock.innerHTML = `<div class="feature-lock-box">🔒<b>Чат ИИ недоступен</b><p>Эта возможность отключена для вашего аккаунта или недоступна на текущем тарифе.</p></div>`;
        aiPage.appendChild(lock);
      }
    } else if (lock){ lock.remove(); }
  }

  const aiReplyBtn = $('#btnAiReply');
  if (aiReplyBtn) aiReplyBtn.style.display = f.ai_reply ? '' : 'none';

  const aiToggle = $('#chatAiToggle');
  if (aiToggle){
    aiToggle.disabled = !f.ai_auto;
    const row = aiToggle.closest('.ai-status');
    if (row) row.classList.toggle('feature-disabled', !f.ai_auto);
    if (!f.ai_auto) aiToggle.title = 'ИИ-автоответчик доступен на тарифе «Бизнес»';
    else aiToggle.title = '';
  }

  const riskScanBtn = $('#riskScanBtn');
  if (riskScanBtn) riskScanBtn.style.display = f.analytics_full ? '' : 'none';

  const heatCard = $('#heatmap') && $('#heatmap').closest('.home-card');
  if (heatCard){
    let lock = $('#heatmapLock');
    if (!f.analytics_full){
      heatCard.classList.add('feature-blurred-card');
      if (!lock){
        lock = document.createElement('div');
        lock.id = 'heatmapLock';
        lock.className = 'feature-lock';
        lock.innerHTML = `<div class="feature-lock-box">🔒<b>Полная аналитика</b><p>Тепловая карта активности доступна на тарифах «Стандарт» и «Бизнес».</p><button class="btn btn-primary btn-sm" id="heatmapUpgradeBtn">Смотреть тарифы</button></div>`;
        heatCard.style.position = 'relative';
        heatCard.appendChild(lock);
        lock.querySelector('#heatmapUpgradeBtn').addEventListener('click', () => switchDashView('plan'));
      }
    } else {
      heatCard.classList.remove('feature-blurred-card');
      if (lock) lock.remove();
    }
  }
}

function updateAiLimitBadge(){
  const badge = $('#aiLimitBadge');
  if (!badge) return;
  const limit = aiUsage.limit;
  if (!userFeatures.ai_chat){ badge.style.display = 'none'; return; }
  badge.style.display = 'inline-flex';
  const bonus = aiUsage.bonus || 0;
  const left = limit > 0 ? Math.max(0, limit - aiUsage.used) : null;
  let text = limit > 0 ? `осталось ${left} из ${limit}` : 'без лимита';
  if (limit > 0 && bonus > 0) text += ` +${bonus} 🎁`;
  $('#aiLimitText').textContent = text;
  badge.classList.toggle('exhausted', limit > 0 && left === 0 && bonus === 0);
}

const INSTA_PROMO_URL = 'https://www.instagram.com/p/DbL79cPCD6t/?igsh=MTJodWV3ZDRhM3JuZQ==';

function updateInstaPromo(){
  const promo = $('#instaPromo');
  if (!promo) return;

  const show = !!Auth.current() && !planLocalMode && planState && planState.insta_bonus_claimed === false && userFeatures.ai_chat;
  promo.style.display = show ? 'flex' : 'none';
}

const instaPromoBtnEl = document.getElementById('instaPromoBtn');
if (instaPromoBtnEl) instaPromoBtnEl.addEventListener('click', async () => {

  window.open(INSTA_PROMO_URL, '_blank', 'noopener');
  instaPromoBtnEl.disabled = true;
  instaPromoBtnEl.textContent = 'Начисляем…';
  try{
    const r = await apiFetch('backend/api/bonus.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'claim_instagram' }),
    });
    const data = await r.json();
    if (!r.ok){
      const err = new Error(data.error || 'Не удалось получить бонус');
      err.alreadyClaimed = r.status === 422;
      throw err;
    }
    aiUsage.bonus = (data.state && data.state.ai_bonus) || (aiUsage.bonus || 0) + 5;
    if (planState) planState.insta_bonus_claimed = true;
    updateAiLimitBadge();
    const promo = $('#instaPromo');
    if (promo){
      promo.classList.add('claimed');
      promo.querySelector('.insta-promo-text b').textContent = '+5 сообщений начислено! 🎉';
      promo.querySelector('.insta-promo-text span').textContent = 'Бонус не сгорает — тратится после дневного лимита';
      instaPromoBtnEl.textContent = 'Получено ✓';
      setTimeout(() => { promo.style.opacity = '0'; setTimeout(() => { promo.style.display = 'none'; }, 400); }, 3500);
    }
    showToast('+5 бонусных сообщений ИИ за Instagram 🎉', 'ok');
  } catch(e){
    instaPromoBtnEl.disabled = false;
    instaPromoBtnEl.textContent = 'Получить +5';
    if (e && e.alreadyClaimed){
      if (planState) planState.insta_bonus_claimed = true;
      updateInstaPromo();
    }
    showToast(e.message, 'info');
  }
});

function bumpLocalAiUsage(){
  aiUsage.used++;
  if (planLocalMode){
    localStorage.setItem('mysavdo_ai_usage', JSON.stringify({ day: new Date().toDateString(), used: aiUsage.used }));
  }
  updateAiLimitBadge();
}

function planTime(v){

  return typeof v === 'number' ? v : parseServerTime(v);
}

async function connectPlan(plan){
  const meta = PLAN_CATALOG.find(p => p.plan === plan);
  if (meta && meta.price > 0){
    openPayModal(meta);
    return;
  }

  if (planLocalMode){
    const local = localPlanRead();
    if (local.demoUsed){ showToast('Тариф «Демо» доступен только один раз', 'error'); return; }
    localStorage.setItem('mysavdo_local_plan_v2', JSON.stringify({
      active:{ plan:'demo', starts: Date.now(), ends: Date.now() + 30*24*3600*1000 },
      paused: local.paused || [], demoUsed: true,
    }));
    showToast('Тариф «Демо» подключён', 'ok');
    renderPlanView();
    return;
  }
  try{
    const r = await apiFetch('backend/api/plan.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'purchase', plan }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Не удалось подключить тариф');
    planState = data;
    if (data.features) userFeatures = data.features;
    applyFeaturesUI();
    showToast('Тариф подключён', 'ok');
    renderPlanView(true);
  } catch(e){
    showToast(e.message || 'Не удалось подключить тариф', 'error');
  }
}

async function switchToPlan(planId){
  if (planLocalMode){
    const local = localPlanRead();
    const idx = planId - 1;
    const target = local.paused[idx];
    if (!target){ showToast('Тариф на паузе не найден', 'error'); return; }
    local.paused.splice(idx, 1);
    if (local.active && local.active.ends > Date.now()){
      local.paused.push({ plan: local.active.plan, remaining: local.active.ends - Date.now() });
    }
    local.active = { plan: target.plan, starts: Date.now(), ends: Date.now() + target.remaining };
    localStorage.setItem('mysavdo_local_plan_v2', JSON.stringify(local));
    showToast('Тариф переключён', 'ok');
    renderPlanView();
    return;
  }
  try{
    const r = await apiFetch('backend/api/plan.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'switch', plan_id: planId }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Не удалось переключить тариф');
    planState = data;
    if (data.features) userFeatures = data.features;
    if (data.ai_usage) aiUsage = data.ai_usage;
    applyFeaturesUI();
    showToast('Тариф переключён — прежний встал на паузу с остатком дней', 'ok');
    renderPlanView(true);
  } catch(e){
    showToast(e.message || 'Не удалось переключить тариф', 'error');
  }
}

let payPlanCurrent = null;
function openPayModal(meta){
  payPlanCurrent = meta;
  $('#payPlanTitle').textContent = `«${meta.title}»`;
  $('#payAmount').textContent = `${meta.price} сомони`;
  const req = (planState && planState.payment_requisites) || {};
  const configured = !!req.card && req.card !== '0000 0000 0000 0000';
  $('#payStepsWrap').style.display = configured ? '' : 'none';
  $('#payNotConfigured').style.display = configured ? 'none' : 'block';
  $('#payReqCard').textContent = req.card || '0000 0000 0000 0000';
  $('#payReqHolder').textContent = req.holder || '—';
  $('#payReqBank').textContent = req.bank || '—';
  $('#payReqComment').textContent = req.comment || 'MYSAVDO';
  if (req.qr){
    $('#payQrImg').src = req.qr;
    $('#payQrRow').style.display = '';
  } else {
    $('#payQrRow').style.display = 'none';
  }
  $('#payError').classList.remove('show');
  $('#payForm').reset();
  $('#payModal').classList.add('active');
}
$('#payClose')?.addEventListener('click', () => $('#payModal').classList.remove('active'));
$('#payModal')?.addEventListener('click', e => { if (e.target.id === 'payModal') $('#payModal').classList.remove('active'); });
$$('.pay-copy').forEach(btn => {
  btn.addEventListener('click', () => {
    const txt = $('#' + btn.dataset.copy)?.textContent || '';
    navigator.clipboard?.writeText(txt).then(() => showToast('Скопировано', 'ok')).catch(() => {});
  });
});
$('#payForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  if (!payPlanCurrent) return;
  const errBox = $('#payError');
  errBox.classList.remove('show');
  const btn = $('#paySubmit');
  btn.disabled = true; btn.textContent = 'Отправляем…';
  try{
    if (planLocalMode) throw new Error('Оплата доступна только на сервере с базой данных');
    const r = await apiFetch('backend/api/plan.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        action:'purchase',
        plan: payPlanCurrent.plan,
        payer_name: $('#payPayerName').value.trim(),
        payer_digits: $('#payPayerDigits').value.trim(),
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Не удалось отправить заявку');
    planState = data;
    $('#payModal').classList.remove('active');
    showToast('Заявка на оплату отправлена — тариф включится после подтверждения', 'ok');
    renderPlanView(true);
  } catch(err){
    errBox.textContent = err.message || 'Не удалось отправить заявку';
    errBox.classList.add('show');
  } finally {
    btn.disabled = false; btn.textContent = 'Я перевёл(а) — отправить на проверку';
  }
});

function stopPlanCountdown(){
  if (planCountdownTimer){ clearInterval(planCountdownTimer); planCountdownTimer = null; }
}

function tickPlanCountdown(){
  if (!planState || !planState.active) return;
  const ends = planTime(planState.active.ends_at);
  const starts = planTime(planState.active.starts_at);
  let left = Math.max(0, ends - Date.now());
  const d = Math.floor(left / 86400000); left -= d * 86400000;
  const h = Math.floor(left / 3600000);  left -= h * 3600000;
  const m = Math.floor(left / 60000);    left -= m * 60000;
  const s = Math.floor(left / 1000);
  const set = (id, v) => { const el = $(id); if (el) el.textContent = String(v).padStart(2,'0'); };
  set('#pcDays', d); set('#pcHours', h); set('#pcMins', m); set('#pcSecs', s);
  const total = Math.max(1, ends - starts);
  const fill = $('#planProgressFill');
  if (fill) fill.style.width = Math.min(100, Math.max(0, (Date.now() - starts) / total * 100)).toFixed(1) + '%';
  if (ends - Date.now() <= 0){
    stopPlanCountdown();
    loadPlanState().then(() => renderPlanView());
  }
}

const SOCIAL_LIMIT_LABEL = { 1:'Instagram или Telegram — на выбор', 2:'Instagram и Telegram — одновременно' };

async function renderPlanView(skipLoad){
  if (!skipLoad) await loadPlanState();
  const st = planState || { active:null, paused:[], demo_used:false, payments:[] };

  const nameEl = $('#planCurrentName');
  const badge = $('#planCurrentBadge');
  if (st.active){
    nameEl.textContent = st.active.title + (st.active.price ? ` · ${st.active.price} сомони/мес` : ' · бесплатно');
    badge.textContent = 'Активен';
    badge.className = 'plan-status-badge active';
    const starts = planTime(st.active.starts_at), ends = planTime(st.active.ends_at);
    $('#planStartedLabel').textContent = 'Подключён ' + new Date(starts).toLocaleDateString('ru-RU');
    $('#planEndsLabel').textContent = 'Действует до ' + new Date(ends).toLocaleDateString('ru-RU');
    $('#planRenewNote').textContent = st.paused.length
      ? `После окончания автоматически включится «${st.paused[0].title}» (его дни сохранены)`
      : 'Следующая покупка — ' + new Date(ends).toLocaleDateString('ru-RU') + '. До этого дня всё работает без ограничений.';
    $('#planCountdown').style.display = '';
    stopPlanCountdown();
    tickPlanCountdown();
    planCountdownTimer = setInterval(tickPlanCountdown, 1000);
  } else {
    nameEl.textContent = 'Нет активного тарифа';
    badge.textContent = 'Истёк';
    badge.className = 'plan-status-badge expired';
    $('#planCountdown').style.display = 'none';
    $('#planStartedLabel').textContent = '';
    $('#planEndsLabel').textContent = '';
    $('#planRenewNote').textContent = 'Подключите тариф ниже, чтобы продолжить принимать заявки.';
    stopPlanCountdown();
  }

  const usageBox = $('#planAiUsage');
  if (usageBox){
    if (userFeatures.ai_chat && aiUsage.limit > 0){
      usageBox.style.display = 'flex';
      const pct = Math.min(100, aiUsage.used / aiUsage.limit * 100);
      $('#planAiUsageFill').style.width = pct + '%';
      $('#planAiUsageText').textContent = `${aiUsage.used} / ${aiUsage.limit}`;
    } else if (userFeatures.ai_chat){
      usageBox.style.display = 'flex';
      $('#planAiUsageFill').style.width = '0%';
      $('#planAiUsageText').textContent = 'без лимита';
    } else {
      usageBox.style.display = 'none';
    }
  }

  const pausedCard = $('#planPausedCard');
  const pausedList = $('#planPausedList');
  if (st.paused.length){
    pausedCard.style.display = '';
    pausedList.innerHTML = st.paused.map(p => {
      const days = Math.max(1, Math.ceil((p.remaining_seconds || 0) / 86400));
      return `
      <div class="plan-paused-row">
        <div class="plan-paused-icon">⏸</div>
        <div class="plan-paused-info">
          <b>${p.title}</b>
          <span>сохранено ${days} дн.</span>
        </div>
        <button class="btn btn-outline btn-sm" data-switch="${p.id}">Включить сейчас</button>
      </div>`;
    }).join('');
    $$('#planPausedList button[data-switch]').forEach(b => {
      b.addEventListener('click', () => switchToPlan(Number(b.dataset.switch)));
    });
  } else {
    pausedCard.style.display = 'none';
  }

  const limit = st.active ? (userFeatures.socials_limit || 0) : 0;
  $('#socialsLimitLabel').textContent = st.active
    ? `на тарифе «${st.active.title}» ${SOCIAL_LIMIT_LABEL[limit] || 'соцсети недоступны'}`
    : 'нет активного тарифа';
  const tgBtn = $('#socialTgBtn');
  const tgStatus = $('#socialTgStatus');
  let tgConnected = false;
  if (!planLocalMode){
    try{
      const r = await apiFetch('backend/api/telegram-bot-settings.php', { credentials:'include' });
      if (r.ok){
        const data = await r.json();
        tgConnected = !!data.connected;
        if (tgConnected) tgStatus.textContent = 'Подключён: @' + data.bot_username;
      }
    } catch(e){}
  }
  if (!tgConnected) tgStatus.textContent = 'Бот принимает заявки прямо в CRM';
  document.querySelector('.social-card[data-social="telegram"]').classList.toggle('connected', tgConnected);
  tgBtn.textContent = tgConnected ? 'Настроить' : 'Подключить';
  tgBtn.disabled = !st.active || limit < 1;
  tgBtn.onclick = () => $('#btnOpenTelegramModal').click();

  const igBtn = $('#socialIgBtn');
  const igStatus = $('#socialIgStatus');
  let igConnected = false;
  if (!planLocalMode){
    const data = await fetchInstagramStatus();
    if (data){
      igState = data;
      igConnected = !!data.connected;
      if (igConnected){
        igStatus.textContent = 'Подключён: @' + data.username;
      }
    }
  }
  if (!igConnected) igStatus.textContent = 'Сообщения из Direct приходят прямо в CRM';
  document.querySelector('.social-card[data-social="instagram"]').classList.toggle('connected', igConnected);
  igBtn.textContent = igConnected ? 'Настроить' : 'Подключить';
  igBtn.disabled = !st.active || limit < 1 || (!igConnected && tgConnected && limit < 2);
  igBtn.onclick = () => openInstagramModal();

  const pendingPayments = (st.payments || []).filter(p => p.status === 'pending');
  const grid = $('#planCardsGrid');
  grid.innerHTML = PLAN_CATALOG.map(p => {
    const isActive = st.active && st.active.plan === p.plan;
    const isPaused = st.paused.some(x => x.plan === p.plan);
    const hasPendingPay = pendingPayments.some(x => x.plan === p.plan);
    const demoLocked = p.plan === 'demo' && st.demo_used && !isActive && !isPaused;
    let btn;
    if (isActive)          btn = `<button class="btn btn-outline btn-sm" disabled>Текущий тариф</button>`;
    else if (isPaused)     btn = `<button class="btn btn-outline btn-sm" disabled>На паузе</button>`;
    else if (hasPendingPay) btn = `<button class="btn btn-outline btn-sm" disabled>Платёж на проверке</button>`;
    else if (demoLocked)   btn = `<button class="btn btn-outline btn-sm" disabled>Использован</button>`;
    else if (p.price > 0)  btn = `<button class="btn btn-primary btn-sm" data-plan="${p.plan}">Купить за ${p.price} сомони</button>`;
    else                   btn = `<button class="btn btn-primary btn-sm" data-plan="${p.plan}">Подключить бесплатно</button>`;
    return `
    <div class="plan-mini-card ${isActive ? 'current' : ''} ${isPaused ? 'pending' : ''}">
      ${isActive ? '<span class="plan-mini-flag">Текущий</span>' : (isPaused ? '<span class="plan-mini-flag wait">На паузе</span>' : (hasPendingPay ? '<span class="plan-mini-flag wait">Проверка оплаты</span>' : ''))}
      <h4>${p.title}</h4>
      <div class="plan-mini-price">${p.price ? p.price + ' <span>сомони/мес</span>' : 'Бесплатно <span>1 месяц</span>'}</div>
      <ul>${p.feats.map(f => `<li>${f}</li>`).join('')}</ul>
      ${btn}
    </div>`;
  }).join('');
  $$('#planCardsGrid button[data-plan]').forEach(b => {
    b.addEventListener('click', async () => {
      // Платные тарифы просто открывают модалку оплаты (мгновенно), а вот
      // бесплатное подключение реально ходит на сервер — без disabled быстрый
      // двойной клик уходил двумя запросами purchase подряд.
      if (b.disabled) return;
      b.disabled = true;
      try{ await connectPlan(b.dataset.plan); }
      finally{ b.disabled = false; }
    });
  });

  const payCard = $('#paymentsCard');
  const payList = $('#paymentsList');
  const pays = st.payments || [];
  if (payCard){
    payCard.hidden = pays.length === 0;
    const PAY_STATUS = { pending:['Ожидает подтверждения','wait'], approved:['Подтверждён','ok'], rejected:['Отклонён','bad'] };
    payList.innerHTML = pays.map(p => {
      const meta = PLAN_CATALOG.find(x => x.plan === p.plan) || { title: p.plan };
      const [label, cls] = PAY_STATUS[p.status] || [p.status, ''];
      return `
      <div class="payment-row">
        <div class="payment-info"><b>«${meta.title}» · ${p.amount} сомони</b><span>${fmtTime(parseServerTime(p.created_at))}</span></div>
        <span class="payment-status ${cls}">${label}</span>
      </div>`;
    }).join('');
  }
}

let simTimer = null;
function startSimulation(){
  if (simTimer) return;
  simTimer = setInterval(() => {

    if (clients.length > 0 && Math.random() < 0.6){
      const c = clients[Math.floor(Math.random()*clients.length)];
      const msg = SAMPLE_MSGS[Math.floor(Math.random()*SAMPLE_MSGS.length)];
      c.lastMsg = msg;
      c.sentiment = computeSentiment(msg);
      c.isNew = true;
      c.updatedAt = Date.now();
      c.history.push({ from:'in', text: msg, at: Date.now() });
      pushNotification(c, msg);
    } else {
      const c = makeClient('new');
      c.isNew = true;
      clients.unshift(c);
      enforceColumnCap('new');
      pushNotification(c, c.lastMsg);
    }
    renderAll();
    setTimeout(() => { clients.forEach(c => c.isNew = false); }, 1200);
  }, 5000);
}

function timeAgo(ts){
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'только что';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  return `${h} ч назад`;
}

function computeStats(){
  const total = clients.length;
  const done = clients.filter(c => c.col === 'done');
  const conversion = total ? Math.round((done.length / total) * 1000) / 10 : 0;
  const avgCheck = done.length ? Math.round(done.reduce((s,c) => s + c.value, 0) / done.length) : 0;
  const byChan = {};
  CHANNELS.forEach(ch => byChan[ch.name] = 0);
  clients.forEach(c => byChan[c.channel.name]++);
  const bestChan = Object.entries(byChan).sort((a,b) => b[1]-a[1])[0];
  return { total, conversion, avgCheck, byChan, bestChan: bestChan ? bestChan[0] : '—' };
}

function renderHome(){
  const s = computeStats();
  const cards = [
    { icon:'icon-users', label:'Всего заявок', num:s.total, delta:null },
    { icon:'icon-trend', label:'Конверсия в продажу', num:s.conversion+'%', delta:'+2.4%' },
    { icon:'icon-bag', label:'Средний чек, сомони', num:s.avgCheck || '—', delta:null },
    { icon:'icon-chart', label:'Лучший канал', num:s.bestChan, delta:null },
  ];
  $('#kpiGrid').innerHTML = cards.map(kpiCardHtml).join('');

  const recent = clients.slice().sort((a,b) => b.updatedAt - a.updatedAt).slice(0,6);
  $('#activityList').innerHTML = recent.map(c => `
    <div class="activity-item" data-id="${c.id}">
      <div class="kcard-avatar">${escapeHtml(initials(c.name))}</div>
      <div class="activity-txt"><b>${escapeHtml(c.name)}</b><span>${escapeHtml(c.lastMsg)}</span></div>
      <div class="activity-time">${timeAgo(c.updatedAt)}</div>
    </div>`).join('') || '<p style="color:var(--muted);font-size:13.5px;">Пока нет сообщений</p>';
  $$('.activity-item', $('#activityList')).forEach(el => {
    el.addEventListener('click', () => { switchDashView('funnel'); openChat(Number(el.dataset.id)); });
  });

  const mfColumns = visibleColumns();
  const maxCol = Math.max(1, ...mfColumns.map(col => clients.filter(c => c.col === col.id).length));
  $('#miniFunnel').innerHTML = mfColumns.map(col => {
    const n = clients.filter(c => c.col === col.id).length;
    return `<div class="mf-row"><div class="mf-label">${escapeHtml(col.title)}</div><div class="mf-track"><div class="mf-fill" style="width:${n/maxCol*100}%"></div></div><div class="mf-count">${n}</div></div>`;
  }).join('');

  renderNextActions();
}

function renderNextActions(){
  const now = Date.now();
  const scoredMap = new Map();
  clients.filter(c => c.col !== 'done').forEach(c => {
    const waitedSec = (now - c.updatedAt) / 1000;
    let score = waitedSec + c.value / 20;
    let reason = `сделка на ${c.value} сомони застряла в статусе «${COLUMNS.find(x => x.id === c.col).title}»`;
    if (c.sentiment === 'neg'){ score += 2000; reason = 'клиент недоволен — нужен быстрый ответ'; }
    else if (waitedSec > 40){ reason = `ждёт ответа ${timeAgo(c.updatedAt)}`; }
    scoredMap.set(c.id, { c, score, reason });
  });
  // Если по клиенту есть свежая (после последнего изменения) оценка ИИ —
  // доверяем ей вместо наивной эвристики выше (см. #riskScanBtn/ai-risk-scan.php).
  // Низкий риск (<30) убираем из списка совсем — ИИ считает, что там порядок.
  clients.forEach(c => {
    if (c.col === 'done') return;
    if (c.aiRisk === null || !c.aiRiskAt || c.aiRiskAt < c.updatedAt) return;
    if (c.aiRisk < 30){ scoredMap.delete(c.id); return; }
    const reason = c.aiRiskReason ? `🤖 ${c.aiRiskReason}` : `🤖 риск потери сделки: ${c.aiRisk}%`;
    scoredMap.set(c.id, { c, score: c.aiRisk * 100, reason });
  });
  // Просроченные/сегодняшние напоминания — приоритет выше всего остального
  // и независимо от этапа сделки (в т.ч. для уже завершённых, "done").
  clients.forEach(c => {
    if (!c.remindAt || c.remindAt > now) return;
    const reason = c.remindNote ? `⏰ Напоминание: ${c.remindNote}` : '⏰ Пора напомнить о себе';
    scoredMap.set(c.id, { c, score: 1e12 + (now - c.remindAt), reason });
  });
  const scored = [...scoredMap.values()].sort((a,b) => b.score - a.score).slice(0,4);

  $('#naBadge').textContent = scored.length;
  const list = $('#nextActionsList');
  if (!scored.length){
    list.innerHTML = '<p style="color:var(--muted);font-size:13.5px;">Пока всё под контролем — срочных заявок нет</p>';
    return;
  }
  list.innerHTML = scored.map(({c, reason}) => {
    const sent = SENTIMENT_META[c.sentiment || 'neu'];
    return `<div class="na-row" data-id="${c.id}">
      <span class="sent-dot ${sent.cls}"></span>
      <div class="kcard-avatar">${escapeHtml(initials(c.name))}</div>
      <div class="na-txt"><b>${escapeHtml(c.name)}</b><span>${escapeHtml(reason)}</span></div>
      <button class="btn btn-outline btn-sm na-open">Открыть</button>
    </div>`;
  }).join('');
  $$('.na-open', list).forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.closest('.na-row').dataset.id);
      switchDashView('funnel'); openChat(id);
    });
  });
}

$('#riskScanBtn')?.addEventListener('click', async () => {
  const btn = $('#riskScanBtn');
  if (btn.dataset.busy === '1' || !isRealMode) return;
  btn.dataset.busy = '1';
  const prevText = btn.textContent;
  btn.textContent = 'Анализирую…';
  try{
    const r = await apiFetch('backend/api/ai-risk-scan.php', { method:'POST', credentials:'include' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Не удалось выполнить анализ');
    const byId = new Map((data.clients || []).map(x => [x.client_id, x]));
    clients.forEach(c => {
      const hit = byId.get(c.id);
      if (!hit) return;
      c.aiRisk = hit.risk;
      c.aiRiskReason = hit.reason || '';
      c.aiRiskAt = Date.now();
    });
    renderAll();
    showToast(byId.size ? `Готово — проверено сделок: ${data.scanned}` : 'Нет незавершённых сделок для анализа', 'ok');
  } catch(e){
    showToast(e.message || 'Не удалось выполнить ИИ-анализ', 'error');
  } finally {
    btn.dataset.busy = '0';
    btn.textContent = prevText;
  }
});

function kpiCardHtml(k){
  return `<div class="kpi-card">
    <div class="kpi-top">
      <div class="kpi-icon"><svg class="icon" viewBox="0 0 24 24"><use href="#${k.icon}"/></svg></div>
      ${k.delta ? `<div class="kpi-delta"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-trend"/></svg>${k.delta}</div>` : ''}
    </div>
    <div class="kpi-num">${k.num}</div>
    <div class="kpi-label">${k.label}</div>
  </div>`;
}

let clientFilter = { chan:'all', q:'' };
function renderClients(){
  let list = clients.slice().sort((a,b) => b.updatedAt - a.updatedAt);
  if (clientFilter.chan !== 'all') list = list.filter(c => c.channel.name === clientFilter.chan);
  if (clientFilter.q) list = list.filter(c => c.name.toLowerCase().includes(clientFilter.q));

  const body = $('#clientsTableBody');
  body.innerHTML = list.map(c => {
    const sent = SENTIMENT_META[c.sentiment || 'neu'];
    return `
    <tr data-id="${c.id}">
      <td><div class="ct-name"><div class="kcard-avatar">${escapeHtml(initials(c.name))}</div>${escapeHtml(c.name)}</div></td>
      <td><div class="ct-chan">${chanBadge(c.channel)}${escapeHtml(c.channel.name)}</div></td>
      <td><span class="stage-tag">${escapeHtml(COLUMNS.find(col => col.id === c.col).title)}</span></td>
      <td><span class="sent-tag ${sent.cls}"><span class="sent-dot ${sent.cls}"></span>${sent.label}</span></td>
      <td class="ct-msg">${escapeHtml(c.lastMsg)}</td>
      <td><button class="btn btn-outline btn-sm ct-open">Открыть</button></td>
    </tr>`;
  }).join('');
  $('#clientsEmpty').style.display = list.length ? 'none' : 'block';
  $$('tr', body).forEach(tr => {
    tr.querySelector('.ct-open').addEventListener('click', () => { switchDashView('funnel'); openChat(Number(tr.dataset.id)); });
    tr.querySelector('.kcard-avatar')?.addEventListener('click', e => {
      e.stopPropagation();
      openClientInfoModal(Number(tr.dataset.id));
    });
  });
}
$('#clientSearch').addEventListener('input', e => { clientFilter.q = e.target.value.trim().toLowerCase(); renderClients(); });
$$('.chip', $('#chanFilters')).forEach(chip => {
  chip.addEventListener('click', () => {
    $$('.chip', $('#chanFilters')).forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    clientFilter.chan = chip.dataset.chan;
    renderClients();
  });
});

let trendData = [];
let analyticsData = null;
let trendRange = '7d';
const TREND_RANGE_DAYS = { '7d':7, '30d':30, '90d':90 };
const DAY_NAMES = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
async function loadAnalytics(){
  if (!Auth.current()){ analyticsData = null; return null; }
  try{
    const r = await apiFetch(`backend/api/analytics.php?range=${encodeURIComponent(trendRange)}`, { credentials:'include' });
    analyticsData = r.ok ? await r.json() : null;
  } catch(e){
    analyticsData = null;
  }
  return analyticsData;
}
function buildTrendData(){
  const days = TREND_RANGE_DAYS[trendRange] || 7;
  if (!Auth.current()){
    trendData = [];
    let base = 6;
    for (let i = days - 1; i >= 0; i--){
      base += Math.round((Math.random()-0.25)*3);
      base = Math.max(3, base);
      const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - i);
      trendData.push({ date: d, v: base });
    }
    return;
  }
  if (analyticsData && analyticsData.trend && (analyticsData.trend_range || 7) === days){
    trendData = analyticsData.trend.map(d => ({ date: new Date(d.date + 'T00:00:00'), v: d.count }));
    return;
  }
  trendData = [];
  for (let i = days - 1; i >= 0; i--){
    const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - i);
    trendData.push({ date: d, v: 0 });
  }
}
$$('#trendRangeChips .chip').forEach(chip => {
  chip.addEventListener('click', async () => {
    if (chip.classList.contains('active')) return;
    $$('#trendRangeChips .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    trendRange = chip.dataset.range;
    if (isRealMode) await loadAnalytics();
    renderAnalytics();
  });
});

// Тот же список, что в <select id="deleteReasonSelect"> в index.html —
// держим в одном месте подписи для показа в аналитике.
const DELETE_REASON_LABELS = {
  refused: 'Отказался от покупки',
  no_reply: 'Не отвечает / пропал',
  cheaper_elsewhere: 'Нашёл дешевле',
  bought_elsewhere: 'Купил в другом магазине',
  duplicate: 'Дубликат заявки',
  spam: 'Спам / бот',
  test: 'Ошибка / тест',
  other: 'Другое',
};
function renderDeleteReasons(){
  const card = $('#deleteReasonsCard');
  if (!card) return;
  const reasons = (analyticsData && analyticsData.delete_reasons) || [];
  if (!isRealMode || !reasons.length){
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  const total = reasons.reduce((s, r) => s + r.count, 0) || 1;
  $('#deleteReasonsBars').innerHTML = reasons.map(r => `
    <div class="cb-row">
      <div class="cb-top"><span>${escapeHtml(DELETE_REASON_LABELS[r.reason] || r.reason)}</span><b>${r.count}</b></div>
      <div class="cb-track"><div class="cb-fill" style="width:${r.count/total*100}%;background:var(--danger)"></div></div>
    </div>`).join('');
}

function renderGoalCard(){
  const card = $('#goalCard');
  if (!card) return;
  if (!Auth.current() || !analyticsData){
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  const goal = Number(analyticsData.sales_goal) || 0;
  const done = Number(analyticsData.sales_done_month) || 0;
  const box = $('#goalProgress');
  if (goal <= 0){
    box.innerHTML = `<p style="color:var(--muted);font-size:13px;margin:0;">Задайте цель продаж на месяц в профиле — здесь появится прогресс</p>`;
    return;
  }
  const pct = Math.min(100, Math.round(done / goal * 100));
  box.innerHTML = `
    <div class="goal-progress-top"><b>${done.toLocaleString('ru-RU')} / ${goal.toLocaleString('ru-RU')} сомони</b><span>${pct}%${pct >= 100 ? ' 🎉' : ''}</span></div>
    <div class="goal-progress-track"><div class="goal-progress-fill${pct >= 100 ? ' goal-reached' : ''}" style="width:${pct}%"></div></div>
  `;
}
$('#goalEditLink')?.addEventListener('click', openProfileModal);

// Крупная карточка графика заявок: большое число + сравнение с прошлым
// периодом (как в YouTube Studio), линия "рисуется" при каждом рендере,
// наведение на точку показывает точную дату и число.
function renderTrendHero(){
  const heroTotal = trendData.reduce((s,d) => s + d.v, 0);
  const numEl = $('#trendHeroNum');
  if (numEl) numEl.textContent = heroTotal.toLocaleString('ru-RU');

  const deltaEl = $('#trendHeroDelta');
  if (deltaEl){
    if (isRealMode && analyticsData && typeof analyticsData.trend_prev_total === 'number' && analyticsData.trend_prev_total > 0){
      const prev = analyticsData.trend_prev_total;
      const pct = Math.round((heroTotal - prev) / prev * 100);
      deltaEl.className = 'trend-hero-delta ' + (pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat');
      deltaEl.textContent = `${pct > 0 ? '▲' : pct < 0 ? '▼' : '●'} ${Math.abs(pct)}% к прошлому периоду`;
    } else if (isRealMode && heroTotal > 0){
      deltaEl.className = 'trend-hero-delta up';
      deltaEl.textContent = 'первые данные за период';
    } else {
      deltaEl.className = 'trend-hero-delta flat';
      deltaEl.textContent = '';
    }
  }

  const svg = $('#trendChart');
  if (!svg) return;
  const W = 560, H = 200, pad = 20;
  const n = trendData.length;
  const max = Math.max(...trendData.map(d => d.v), 1);
  const stepX = n > 1 ? (W - pad*2) / (n - 1) : 0;
  const pts = trendData.map((d,i) => {
    const x = pad + i*stepX;
    const y = H - pad - (d.v/max) * (H - pad*2);
    return [x,y];
  });
  const linePath = pts.map((p,i) => (i===0?'M':'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const areaPath = linePath + ` L ${pts[n-1][0]} ${H-pad} L ${pts[0][0]} ${H-pad} Z`;

  // Подписи по оси X: до 10 точек — подпись у каждой (короткое имя дня),
  // на 30/90 днях — только первая/средняя/последняя точка (дата), иначе
  // подписи налезают друг на друга.
  const dense = n <= 10;
  const labelIdxs = dense ? trendData.map((_,i) => i) : [0, Math.floor((n-1)/2), n-1];
  const labelText = i => dense
    ? DAY_NAMES[trendData[i].date.getDay()]
    : `${String(trendData[i].date.getDate()).padStart(2,'0')}.${String(trendData[i].date.getMonth()+1).padStart(2,'0')}`;

  svg.innerHTML = `
    <defs><linearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--mint-500)" stop-opacity=".55"/>
      <stop offset="100%" stop-color="var(--mint-500)" stop-opacity="0"/>
    </linearGradient></defs>
    <path class="trend-area" d="${areaPath}"></path>
    <path class="trend-line" id="trendLinePath" d="${linePath}"></path>
    ${pts.map((p,i) => `<circle class="trend-dot" data-i="${i}" cx="${p[0]}" cy="${p[1]}" r="${dense ? 4 : 2.5}"></circle>`).join('')}
    ${labelIdxs.map(i => `<text x="${pts[i][0]}" y="${H-2}" font-size="10" fill="var(--muted)" text-anchor="middle" font-family="JetBrains Mono">${labelText(i)}</text>`).join('')}
  `;

  // "Рисуем" линию заново при каждом рендере (смена периода, обновление
  // данных) — stroke-dasharray/dashoffset, классический приём анимации SVG.
  const linePathEl = $('#trendLinePath');
  if (linePathEl && linePathEl.getTotalLength){
    const len = linePathEl.getTotalLength();
    linePathEl.style.transition = 'none';
    linePathEl.style.strokeDasharray = String(len);
    linePathEl.style.strokeDashoffset = String(len);
    linePathEl.getBoundingClientRect();
    requestAnimationFrame(() => {
      linePathEl.style.transition = 'stroke-dashoffset 1.1s var(--ease)';
      linePathEl.style.strokeDashoffset = '0';
    });
  }

  const wrap = svg.closest('.trend-chart-wrap');
  if (wrap){
    let tooltip = $('.trend-tooltip', wrap);
    if (!tooltip){
      tooltip = document.createElement('div');
      tooltip.className = 'trend-tooltip';
      wrap.appendChild(tooltip);
    }
    $$('.trend-dot', svg).forEach(dot => {
      dot.addEventListener('mouseenter', () => {
        const i = Number(dot.dataset.i);
        const d = trendData[i];
        const dateStr = d.date.toLocaleDateString('ru-RU', { day:'numeric', month:'short' });
        tooltip.innerHTML = `${dateStr}: <b>${d.v}</b> сообщ.`;
        const svgRect = svg.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();
        const scaleX = svgRect.width / W;
        const scaleY = svgRect.height / H;
        tooltip.style.left = ((svgRect.left - wrapRect.left) + pts[i][0] * scaleX) + 'px';
        tooltip.style.top = ((svgRect.top - wrapRect.top) + pts[i][1] * scaleY) + 'px';
        tooltip.classList.add('show');
      });
      dot.addEventListener('mouseleave', () => tooltip.classList.remove('show'));
    });
  }
}

function renderAnalytics(){
  const s = computeStats();
  buildTrendData();
  renderGoalCard();
  renderDeleteReasons();
  const trendHint = $('#trendHint');
  if (trendHint){
    const sparse = Auth.current() && analyticsData && analyticsData.total < 5;
    trendHint.textContent = sparse ? 'пока мало данных для точной картины' : '';
  }
  const cards = [
    { icon:'icon-trend', label:'Конверсия в продажу', num:s.conversion+'%', delta:null },
    { icon:'icon-bag', label:'Средний чек, сомони', num:s.avgCheck || '—', delta:null },
    { icon:'icon-users', label:'Всего заявок', num:s.total, delta:null },
    { icon:'icon-chart', label:'Лучший источник', num:s.bestChan, delta:null },
  ];
  $('#kpiGrid2').innerHTML = cards.map(kpiCardHtml).join('');

  const chanColors = { Telegram:'#229ED9', Instagram:'linear-gradient(90deg,#f58529,#dd2a7b)', WhatsApp:'#25D366' };
  const totalC = Math.max(1, s.total);
  $('#chanBars').innerHTML = Object.entries(s.byChan).map(([name, n]) => `
    <div class="cb-row">
      <div class="cb-top"><span>${name}</span><b>${n}</b></div>
      <div class="cb-track"><div class="cb-fill" style="width:${n/totalC*100}%;background:${chanColors[name]}"></div></div>
    </div>`).join('');

  const sbColumns = visibleColumns();
  const maxStage = Math.max(1, ...sbColumns.map(col => clients.filter(c => c.col === col.id).length));
  $('#stageBars').innerHTML = sbColumns.map(col => {
    const n = clients.filter(c => c.col === col.id).length;
    return `<div class="sb-col">
      <div class="sb-num">${n}</div>
      <div class="sb-track"><div class="sb-fill" style="height:${n/maxStage*100}%"></div></div>
      <div class="sb-label">${escapeHtml(col.title)}</div>
    </div>`;
  }).join('');

  renderTrendHero();
  renderHeatmap();
}

let heatmapData = null;
function buildHeatmapData(){
  const hours = ['6–9','9–12','12–15','15–18','18–21','21–24'];
  if (!Auth.current()){
    heatmapData = Array.from({length:7}, (_, di) => hours.map((h, hi) => {
      let base = 3;
      if (hi === 3 || hi === 4) base += 5;
      if (di >= 5) base += 2;
      return Math.max(0, Math.round(base + (Math.random()-0.5)*4));
    }));
    return;
  }
  if (analyticsData && analyticsData.heatmap){
    heatmapData = analyticsData.heatmap;
    return;
  }
  heatmapData = Array.from({length:7}, () => hours.map(() => 0));
}
function renderHeatmap(){
  buildHeatmapData();
  const days = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
  const hours = ['6–9','9–12','12–15','15–18','18–21','21–24'];
  const flat = heatmapData.flat();
  const totalPoints = flat.reduce((a,b) => a+b, 0);
  const max = Math.max(1, ...flat);
  let html = '<div class="hm-corner"></div>';
  hours.forEach(h => html += `<div class="hm-hour">${h}</div>`);
  days.forEach((day, di) => {
    html += `<div class="hm-day">${day}</div>`;
    heatmapData[di].forEach((v, hi) => {
      const op = v === 0 ? 0.06 : 0.15 + (v/max) * 0.85;
      html += `<div class="hm-cell" style="opacity:${op.toFixed(2)}" title="${day}, ${hours[hi]}: ${v} сообщ."></div>`;
    });
  });
  $('#heatmap').innerHTML = html;
  const hint = $('#heatmapHint');
  if (hint) hint.textContent = (isRealMode && totalPoints < 5)
    ? 'данных пока мало — карта наполнится с новыми заявками'
    : 'по дням и времени суток';
}

let notifications = [];
let notifSeq = 1;

function pushNotification(c, msg){
  notifications.unshift({
    id: notifSeq++,
    clientId: c.id,
    name: c.name,
    channel: c.channel.name,
    text: msg,
    time: Date.now(),
    read: false,
  });
  if (notifications.length > 30) notifications.length = 30;
  renderNotifications();
}

function renderNotifications(){
  const unread = notifications.filter(n => !n.read).length;
  const badge = $('#notifBadge');
  if (unread > 0){ badge.style.display = 'flex'; badge.textContent = unread > 9 ? '9+' : String(unread); }
  else { badge.style.display = 'none'; }

  const list = $('#notifList');
  if (!notifications.length){
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-bell"/></svg></div>
        <h5>Пока тихо</h5>
        <p>Здесь появятся новые сообщения от клиентов — вы ничего не пропустите</p>
      </div>`;
    return;
  }
  list.innerHTML = notifications.map(n => `
    <div class="notif-item ${n.read ? '' : 'unread'}" data-id="${n.id}" data-client="${n.clientId}">
      <div class="kcard-avatar">${escapeHtml(initials(n.name))}</div>
      <div class="notif-txt"><b>${escapeHtml(n.name)} · ${escapeHtml(n.channel)}</b><span>${escapeHtml(n.text)}</span></div>
      <div class="notif-time">${timeAgo(n.time)}</div>
    </div>`).join('');
  $$('.notif-item', list).forEach(el => {
    el.addEventListener('click', () => {
      const n = notifications.find(x => x.id === Number(el.dataset.id));
      if (n) n.read = true;
      renderNotifications();
      closeNotifPanel();
      switchDashView('funnel');
      openChat(Number(el.dataset.client));
    });
  });
}

function openNotifPanel(){ $('#notifPanel').classList.add('open'); closeAccountMenu(); notifications.forEach(n => n.read = true); setTimeout(renderNotifications, 250); }
function closeNotifPanel(){ $('#notifPanel').classList.remove('open'); }
$('#btnNotif').addEventListener('click', e => {
  e.stopPropagation();
  $('#notifPanel').classList.contains('open') ? closeNotifPanel() : openNotifPanel();
});
$('#notifClearBtn').addEventListener('click', e => {
  e.stopPropagation();
  notifications = [];
  renderNotifications();
});

function openAccountMenu(){ $('#accountMenu').classList.add('open'); closeNotifPanel(); renderAccountSwitcherRow(); }
function closeAccountMenu(){ $('#accountMenu').classList.remove('open'); }
$('#dashAvatar').addEventListener('click', e => {
  e.stopPropagation();
  $('#accountMenu').classList.contains('open') ? closeAccountMenu() : openAccountMenu();
});
document.addEventListener('click', e => {
  if (!e.target.closest('.account-wrap')) closeAccountMenu();
  if (!e.target.closest('.notif-wrap')) closeNotifPanel();
});

let activeChatId = null;
function openChat(id){
  activeChatId = id;
  const c = clients.find(x => x.id === id);
  if (!c) return;
  c.isNew = false;

  $('#chatOverlay').classList.add('active');
  renderChatHeaderAndBody(c);
  $('#chatReplyInput').value = Draft.load('client', c.id);

  if (isRealMode && !c._historyLoaded){
    apiListMessages(c.id).then(rows => {
      c.history = rows.map(m => ({
        id: m.id,
        from: m.direction === 'in' ? 'in' : 'out',
        text: m.text || '',
        photo: m.photo_url || null,
        audio: m.audio_url || null,
        at: parseServerTime(m.created_at),
        reply_to_id: m.reply_to_id || null,
        reply_to_snippet: m.reply_to_snippet || null,
        reactions: m.reactions || null,
      }));
      c._historyLoaded = true;
      if (rows.length){
        const last = rows[rows.length - 1];
        c.lastMsg = last.text || (last.audio_url ? '🎤 Голосовое сообщение' : (last.photo_url ? '📷 Фото' : ''));
      }
      if (activeChatId === c.id) renderChatHeaderAndBody(c);
      renderAll();
    }).catch(() => {});
  }
}

function localMsgId(m){
  if (m.id === undefined || m.id === null) m.id = 'local_' + Math.random().toString(36).slice(2, 10);
  return m.id;
}
function msgSnippet(m){
  return ((m.text || '') || (m.photo ? '📷 Фото' : '') || (m.audio ? '🎤 Голосовое сообщение' : '')).slice(0, 120);
}

// Реакция на сообщение — в демо-режиме считается локально (без бэкенда), в
// реальном шлётся на backend/api/reactions.php с нужным scope.
async function reactToMessage(scope, m, emoji, onUpdate){
  if (!isRealMode){
    m.reactions = m.reactions || { counts:{}, mine:null };
    const cur = m.reactions.mine;
    const counts = Object.assign({}, m.reactions.counts);
    if (cur) counts[cur] = Math.max(0, (counts[cur] || 0) - 1);
    if (cur === emoji){
      m.reactions = { counts, mine: null };
    } else {
      counts[emoji] = (counts[emoji] || 0) + 1;
      m.reactions = { counts, mine: emoji };
    }
    onUpdate(m.reactions);
    return;
  }
  try{
    const r = await apiFetch('backend/api/reactions.php', {
      method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ scope, message_id: m.id, emoji }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Не удалось поставить реакцию');
    m.reactions = data.reaction;
    onUpdate(m.reactions);
  } catch(e){ showToast(e.message || 'Не удалось поставить реакцию', 'error'); }
}

Draft.bind($('#chatReplyInput'), 'client', () => activeChatId);
$('#btnCannedReplies')?.addEventListener('click', e => {
  e.preventDefault();
  CannedReplies.open(e.currentTarget, $('#chatReplyInput'));
});
const chatReplyBar = MsgActions.createReplyBar($('#chatReplyForm'));
const chatSelection = MsgActions.createSelection({
  mountBeforeEl: $('#chatBody'),
  onCopy: ids => {
    const c = clients.find(x => x.id === activeChatId);
    if (!c) return;
    MsgActions.copyTexts(ids.map(id => {
      const m = c.history.find(x => String(x.id) === String(id));
      return m ? msgSnippet(m) : '';
    }));
  },
  onDelete: async ids => {
    const c = clients.find(x => x.id === activeChatId);
    if (!c) return;
    if (isRealMode){
      await Promise.all(ids.filter(id => /^\d+$/.test(String(id))).map(id =>
        apiFetch('backend/api/messages.php', {
          method:'DELETE', credentials:'include', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ id: Number(id) }),
        }).catch(() => {})
      ));
    }
    c.history = c.history.filter(x => !ids.some(id => String(id) === String(x.id)));
    renderChatHeaderAndBody(c);
    renderAll();
  },
});

async function deleteClientMessage(c, m){
  if (!confirm('Удалить это сообщение?')) return;
  if (isRealMode && /^\d+$/.test(String(m.id))){
    try{
      const r = await apiFetch('backend/api/messages.php', {
        method:'DELETE', credentials:'include', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ id: Number(m.id) }),
      });
      if (!r.ok){ const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Не удалось удалить сообщение'); }
    } catch(e){ showToast(e.message || 'Не удалось удалить сообщение', 'error'); return; }
  }
  c.history = c.history.filter(x => x !== m);
  if (activeChatId === c.id) renderChatHeaderAndBody(c);
  renderAll();
}

function buildBubble(m, c){
  localMsgId(m);
  const b = document.createElement('div');
  b.className = 'bubble ' + (m.from === 'in' ? 'in' : 'out');
  b.dataset.msgId = String(m.id);

  const doReact = emoji => reactToMessage('client', m, emoji, data => MsgActions.renderReactions(b, data, doReact));

  MsgActions.renderReplyPreview(b, m.reply_to_snippet || null);
  if (m.photo){
    const img = document.createElement('img');
    img.className = 'bubble-photo';
    img.src = m.photo;
    img.alt = 'Фото';
    img.loading = 'lazy';
    img.addEventListener('click', e => { e.stopPropagation(); openLightbox(m.photo); });
    b.appendChild(img);
  }
  if (m.audio){
    const wrap = document.createElement('div');
    wrap.className = 'bubble-audio';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = m.audio;
    wrap.appendChild(audio);
    b.appendChild(wrap);
  }
  if (m.text){
    const txt = document.createElement('span');
    txt.className = 'bubble-text';
    txt.textContent = m.text;
    b.appendChild(txt);
  }
  const time = document.createElement('span');
  time.className = 'bubble-time';
  time.textContent = fmtTime(m.at || Date.now());
  b.appendChild(time);
  if (m.failed){
    b.classList.add('bubble-failed');
    const mark = document.createElement('span');
    mark.className = 'bubble-failed-mark';
    mark.textContent = '⚠ не доставлено';
    b.appendChild(mark);
  }
  MsgActions.renderReactions(b, m.reactions, doReact);

  if (c){
    MsgActions.attachTrigger(b, () => {
      if (chatSelection.isActive()){ chatSelection.toggle(m.id, b); return; }
      MsgActions.showPopover(b, [
        { icon:'copy', label:'Копировать', onClick: () => MsgActions.copyTexts([msgSnippet(m)]) },
        { icon:'reply', label:'Ответить', onClick: () => chatReplyBar.set(m.id, msgSnippet(m)) },
        { type:'reactions', onPick: doReact },
        { icon:'checkbox', label:'Выбрать', onClick: () => { chatSelection.start(); chatSelection.toggle(m.id, b); } },
        { icon:'trash', label:'Удалить', danger:true, onClick: () => deleteClientMessage(c, m) },
      ]);
    });
    b.addEventListener('click', () => { if (chatSelection.isActive()) chatSelection.toggle(m.id, b); });
  }
  return b;
}

function clientOnlineInfo(c){
  const lastIn = c.lastSeenAt
    || (c.history || []).slice().reverse().find(m => m.from === 'in')?.at
    || null;
  if (!lastIn) return { online:false, label:'ещё не писал(а)' };
  const min = (Date.now() - lastIn) / 60000;
  if (min < 3) return { online:true, label:'в сети' };
  if (min < 60) return { online:false, label:`был(а) ${Math.round(min)} мин назад` };
  const h = Math.floor(min / 60);
  if (h < 24) return { online:false, label:`был(а) ${h} ч назад` };
  return { online:false, label:'был(а) ' + fmtTime(lastIn) };
}
function updateChatStatus(c){
  const el = $('#chatStatus');
  if (!el || !c) return;
  const info = clientOnlineInfo(c);
  el.innerHTML = `<span class="online-dot ${info.online ? 'on' : ''}"></span>${info.label}`;
}
function msToDatetimeLocalValue(ms){
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderChatHeaderAndBody(c){
  $('#chatAvatar').textContent = initials(c.name);
  $('#chatName').textContent = c.name;
  $('#chatChan').innerHTML = `${chanBadge(c.channel)}${c.channel.name}`;
  updateChatStatus(c);
  const body = $('#chatBody');
  body.innerHTML = '';
  c.history.forEach(m => body.appendChild(buildBubble(m, c)));
  body.scrollTop = body.scrollHeight;

  const select = $('#chatStageSelect');
  // Скрытые колонки не предлагаем как новое направление для карточки, но
  // если клиент уже стоит в скрытой колонке — оставляем её в списке, иначе
  // выбранное значение молча пропадёт из селекта.
  select.innerHTML = COLUMNS.filter(col => !col.hidden || col.id === c.col)
    .map(col => `<option value="${escapeHtml(col.id)}" ${col.id===c.col?'selected':''}>${escapeHtml(col.title)}</option>`).join('');
  $('#chatAiToggle').checked = !!c.aiAuto;
  $('#chatRemindInput').value = c.remindAt ? msToDatetimeLocalValue(c.remindAt) : '';
  $('#chatNotesInput').value = c.notes || '';
  $('#chatNotesSaved').classList.remove('show');
  $('#chatPinBtn').classList.toggle('active', !!c.pinned);
  renderAll();
}

function pushOutgoing(c, { text = '', photo = null, audio = null, replyToId = null, replySnippet = null }){
  const entry = { from:'out', text, photo, audio, at: Date.now(), reply_to_id: replyToId, reply_to_snippet: replySnippet };
  c.history.push(entry);
  c.lastMsg = text || (audio ? '🎤 Голосовое сообщение' : (photo ? '📷 Фото' : ''));
  c.updatedAt = Date.now();
  let bubbleEl = null;
  if (activeChatId === c.id){
    const body = $('#chatBody');
    bubbleEl = buildBubble(entry, c);
    body.appendChild(bubbleEl);
    body.scrollTop = body.scrollHeight;
  }
  renderAll();

  if (!isRealMode) return Promise.resolve();

  let sendPromise;
  if (c.channel.name === 'Instagram' && c.channelId){
    sendPromise = apiFetch('backend/api/instagram-private-send.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ client_id: c.id, text: text || undefined, photo_url: photo || undefined, audio_url: audio || undefined })
    }).then(async r => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Instagram не принял сообщение');
    });
  } else if (c.channel.name === 'Telegram' && c.channelId){
    sendPromise = apiFetch('backend/api/telegram-send.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ client_id: c.id, text: text || undefined, photo_url: photo || undefined, audio_url: audio || undefined })
    }).then(async r => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Telegram не принял сообщение');
    });
  } else {
    sendPromise = apiFetch('backend/api/messages.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ client_id: c.id, direction:'out', text: text || undefined, photo_url: photo || undefined, audio_url: audio || undefined, reply_to_id: replyToId || undefined })
    }).then(async r => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Не удалось сохранить сообщение');
      if (data.id) entry.id = data.id;
    });
  }
  return sendPromise.catch(err => {
    // Раньше при ошибке отправки пузырь оставался в чате как обычное
    // сообщение (и просто молча пропадал при следующем поллинге, потому что
    // на сервере его нет) — продавец видел свой ответ в переписке и считал,
    // что клиент его получил. Теперь помечаем пузырь видимым индикатором.
    entry.failed = true;
    if (bubbleEl && bubbleEl.isConnected){
      bubbleEl.classList.add('bubble-failed');
      const mark = document.createElement('span');
      mark.className = 'bubble-failed-mark';
      mark.textContent = '⚠ не доставлено';
      bubbleEl.appendChild(mark);
    }
    showToast('Не удалось отправить: ' + (err.message || 'ошибка сервера'), 'error');
    throw err;
  });
}
$('#chatClose').addEventListener('click', () => $('#chatOverlay').classList.remove('active'));
$('#chatOverlay').addEventListener('click', e => { if (e.target.id === 'chatOverlay') $('#chatOverlay').classList.remove('active'); });

$('#chatStageSelect').addEventListener('change', e => {
  const c = clients.find(x => x.id === activeChatId);
  if (!c) return;
  const wasDone = c.col === 'done';
  const prevCol = c.col;
  c.col = e.target.value;
  renderAll();
  if (c.col === 'done' && !wasDone){
    const r = e.target.getBoundingClientRect();
    fireConfetti(r.left + r.width/2, r.top);
  }
  if (isRealMode){
    apiUpdateClientStage(c.id, c.col).catch(() => {
      c.col = prevCol;
      renderAll();
      alert('Не удалось сохранить изменение на сервере — попробуйте ещё раз');
    });
  }
});

$('#chatAiToggle').addEventListener('change', e => {
  const c = clients.find(x => x.id === activeChatId);
  if (!c) return;
  c.aiAuto = e.target.checked;
  if (isRealMode){

    apiFetch(`backend/api/clients.php?id=${c.id}`, {
      method:'PATCH', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ ai_auto: c.aiAuto ? 1 : 0 })
    }).then(r => {
      if (!r.ok) throw new Error();
      showToast(c.aiAuto ? 'Автоответчик ИИ включён — бот будет отвечать этому клиенту сам' : 'Автоответчик ИИ выключен', 'ok');
    }).catch(() => {
      c.aiAuto = !c.aiAuto;
      e.target.checked = c.aiAuto;
      showToast('Не удалось сохранить настройку автоответчика', 'error');
    });
  }
});

$('#chatPinBtn').addEventListener('click', () => {
  const c = clients.find(x => x.id === activeChatId);
  if (!c) return;
  c.pinned = !c.pinned;
  $('#chatPinBtn').classList.toggle('active', c.pinned);
  clients.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  renderAll();
  showToast(c.pinned ? 'Заявка закреплена сверху' : 'Заявка откреплена', 'ok');
  if (isRealMode){
    apiFetch(`backend/api/clients.php?id=${c.id}`, {
      method:'PATCH', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ pinned: c.pinned ? 1 : 0 })
    }).then(r => { if (!r.ok) throw new Error(); }).catch(() => {
      c.pinned = !c.pinned;
      $('#chatPinBtn').classList.toggle('active', c.pinned);
      clients.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
      renderAll();
      showToast('Не удалось сохранить закрепление', 'error');
    });
  }
});

// «ИИ: извлечь заказ» — разбирает переписку с открытым клиентом и предлагает
// готовую строку для заметки (и, по желанию продавца, сумму сделки).
// Ничего не применяется автоматически — только по кнопке в модалке.
let orderExtractData = null;
function renderOrderExtractResult(data){
  orderExtractData = data;
  const body = $('#orderExtractBody');
  const applyBtn = $('#orderExtractApply');
  $('#orderExtractRetry').style.display = 'inline-flex';
  if (!data || !data.found){
    body.innerHTML = `<p style="color:var(--muted);font-size:13.5px;">Не нашли конкретных деталей заказа в переписке — возможно, клиент их ещё не назвал</p>`;
    applyBtn.style.display = 'none';
    return;
  }
  const rows = [];
  if (data.item) rows.push(['Товар', data.item]);
  if (data.variant) rows.push(['Вариант', data.variant]);
  if (data.city) rows.push(['Город', data.city]);
  if (data.budget) rows.push(['Сумма', `${data.budget} ${data.budget_currency || 'сомони'}`]);
  body.innerHTML = `
    <div class="pay-req">${rows.map(([k, v]) => `<div class="pay-req-row"><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b></div>`).join('')}</div>
    ${data.summary ? `<p style="margin-top:12px;font-size:13px;color:var(--forest-900);">«${escapeHtml(data.summary)}»</p>` : ''}
    ${data.budget ? `<label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:12.5px;color:var(--forest-900);cursor:pointer;"><input type="checkbox" id="orderExtractSetValue"> Также поставить сумму сделки: ${data.budget} ${escapeHtml(data.budget_currency || 'сомони')}</label>` : ''}
  `;
  applyBtn.style.display = 'inline-flex';
}

async function runOrderExtract(){
  const c = clients.find(x => x.id === activeChatId);
  if (!c) return;
  $('#orderExtractApply').style.display = 'none';
  $('#orderExtractRetry').style.display = 'none';
  $('#orderExtractBody').innerHTML = `<p style="color:var(--muted);font-size:13.5px;">Анализирую переписку…</p>`;
  try{
    const r = await apiFetch('backend/api/ai-extract-order.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ client_id: c.id })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Не удалось разобрать переписку');
    renderOrderExtractResult(data);
  } catch(e){
    $('#orderExtractBody').innerHTML = `<p style="color:var(--danger);font-size:13.5px;">${escapeHtml(e.message || 'Ошибка')}</p>`;
    $('#orderExtractRetry').style.display = 'inline-flex';
  }
}

$('#chatExtractOrderBtn')?.addEventListener('click', () => {
  if (!activeChatId || !isRealMode){
    if (!isRealMode) showToast('Доступно после входа в аккаунт', 'info');
    return;
  }
  $('#orderExtractModal').classList.add('active');
  runOrderExtract();
});
$('#orderExtractClose')?.addEventListener('click', () => $('#orderExtractModal').classList.remove('active'));
$('#orderExtractModal')?.addEventListener('click', e => { if (e.target.id === 'orderExtractModal') $('#orderExtractModal').classList.remove('active'); });
$('#orderExtractRetry')?.addEventListener('click', runOrderExtract);
$('#orderExtractApply')?.addEventListener('click', () => {
  const c = clients.find(x => x.id === activeChatId);
  if (!c || !orderExtractData) return;

  const line = orderExtractData.summary || [
    orderExtractData.item, orderExtractData.variant, orderExtractData.city,
    orderExtractData.budget ? `${orderExtractData.budget} ${orderExtractData.budget_currency || 'сомони'}` : null,
  ].filter(Boolean).join(', ');
  if (line){
    const existing = (c.notes || '').trim();
    c.notes = (existing ? `${existing}\n${line}` : line).slice(0, 2000);
    $('#chatNotesInput').value = c.notes;
    // Дальше идёт той же дорогой, что и ручной ввод — debounce-сохранение
    // уже подписано на 'input' (см. ниже), лишний PATCH тут не нужен.
    $('#chatNotesInput').dispatchEvent(new Event('input'));
  }

  const setValueBox = $('#orderExtractSetValue');
  if (setValueBox && setValueBox.checked && orderExtractData.budget){
    const prevValue = c.value;
    c.value = orderExtractData.budget;
    renderAll();
    if (isRealMode){
      apiFetch(`backend/api/clients.php?id=${c.id}`, {
        method:'PATCH', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ value: c.value })
      }).then(r => {
        if (!r.ok) throw new Error();
        showToast('Сумма сделки обновлена', 'ok');
      }).catch(() => {
        c.value = prevValue;
        renderAll();
        showToast('Не удалось обновить сумму сделки', 'error');
      });
    }
  }

  $('#orderExtractModal').classList.remove('active');
  showToast('Добавлено в заметку', 'ok');
});

function saveClientRemind(c, ms, note){
  const prevAt = c.remindAt, prevNote = c.remindNote;
  c.remindAt = ms;
  c.remindNote = note;
  renderAll();
  if (!isRealMode) return;
  apiFetch(`backend/api/clients.php?id=${c.id}`, {
    method:'PATCH', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ remind_at: ms ? new Date(ms).toISOString() : '', remind_note: note })
  }).then(r => {
    if (!r.ok) throw new Error();
    showToast(ms ? 'Напоминание сохранено' : 'Напоминание убрано', 'ok');
  }).catch(() => {
    c.remindAt = prevAt; c.remindNote = prevNote;
    if (activeChatId === c.id) $('#chatRemindInput').value = prevAt ? msToDatetimeLocalValue(prevAt) : '';
    renderAll();
    showToast('Не удалось сохранить напоминание', 'error');
  });
}
$('#chatRemindInput')?.addEventListener('change', e => {
  const c = clients.find(x => x.id === activeChatId);
  if (!c) return;
  const val = e.target.value;
  const ms = val ? new Date(val).getTime() : null;
  if (val && isNaN(ms)){ e.target.value = ''; return; }
  saveClientRemind(c, ms, c.remindNote || '');
});
$('#chatRemindClear')?.addEventListener('click', () => {
  const c = clients.find(x => x.id === activeChatId);
  if (!c) return;
  $('#chatRemindInput').value = '';
  if (!c.remindAt) return;
  saveClientRemind(c, null, '');
});

let chatNotesSaveTimer = null;
$('#chatNotesInput').addEventListener('input', e => {
  const c = clients.find(x => x.id === activeChatId);
  if (!c) return;
  c.notes = e.target.value;
  $('#chatNotesSaved').classList.remove('show');
  clearTimeout(chatNotesSaveTimer);
  chatNotesSaveTimer = setTimeout(() => {
    if (!isRealMode) { $('#chatNotesSaved').classList.add('show'); return; }
    apiFetch(`backend/api/clients.php?id=${c.id}`, {
      method:'PATCH', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ notes: c.notes })
    }).then(r => {
      if (!r.ok) throw new Error();
      $('#chatNotesSaved').classList.add('show');
    }).catch(() => showToast('Не удалось сохранить заметку', 'error'));
  }, 700);
});

// Удаление заявки — раньше тут стоял голый confirm() и, что важнее, карточка
// пропадала ТОЛЬКО из локального состояния: backend/api/clients.php DELETE
// вообще не вызывался, так что после обновления страницы (или обычного
// поллинга) «удалённый» клиент просто появлялся снова. Заодно с починкой —
// причина удаления, чтобы потом было видно, почему вообще теряются клиенты.
let deleteReasonTargetId = null;
$('#chatDelete').addEventListener('click', () => {
  const c = clients.find(x => x.id === activeChatId);
  if (!c) return;
  deleteReasonTargetId = c.id;
  $('#deleteReasonClientName').textContent = c.name;
  $('#deleteReasonSelect').value = '';
  $('#deleteReasonNote').value = '';
  $('#deleteReasonNoteWrap').style.display = 'none';
  $('#deleteReasonModal').classList.add('active');
});
$('#deleteReasonClose')?.addEventListener('click', () => $('#deleteReasonModal').classList.remove('active'));
$('#deleteReasonCancel')?.addEventListener('click', () => $('#deleteReasonModal').classList.remove('active'));
$('#deleteReasonModal')?.addEventListener('click', e => { if (e.target.id === 'deleteReasonModal') $('#deleteReasonModal').classList.remove('active'); });
$('#deleteReasonSelect')?.addEventListener('change', e => {
  $('#deleteReasonNoteWrap').style.display = e.target.value === 'other' ? 'block' : 'none';
});
$('#deleteReasonForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const id = deleteReasonTargetId;
  const c = clients.find(x => x.id === id);
  if (!c) { $('#deleteReasonModal').classList.remove('active'); return; }
  const reason = $('#deleteReasonSelect').value;
  const reasonNote = $('#deleteReasonNote').value.trim();
  const btn = $('#deleteReasonSubmit');
  if (btn.disabled) return;
  btn.disabled = true;
  try{
    if (isRealMode){
      const r = await apiFetch(`backend/api/clients.php?id=${id}`, {
        method:'DELETE', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ reason, reason_note: reasonNote }),
      });
      if (!r.ok){
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || 'Не удалось удалить заявку');
      }
    }
    clients = clients.filter(x => x.id !== id);
    $('#deleteReasonModal').classList.remove('active');
    $('#chatOverlay').classList.remove('active');
    if (activeChatId === id) activeChatId = null;
    renderAll();
    showToast('Заявка удалена', 'info');
  } catch(err){
    showToast(err.message || 'Не удалось удалить заявку', 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#btnAttachPhoto').addEventListener('click', () => $('#chatPhotoInput').click());
$('#chatPhotoInput').addEventListener('change', async () => {
  const file = $('#chatPhotoInput').files[0];
  $('#chatPhotoInput').value = '';
  if (!file) return;
  const c = clients.find(x => x.id === activeChatId);
  if (!c) return;

  const btn = $('#btnAttachPhoto');
  btn.classList.add('busy');
  try{
    let url;
    if (isRealMode){
      const fd = new FormData();
      fd.append('photo', file);
      const r = await apiFetch('backend/api/upload.php', { method:'POST', credentials:'include', body: fd });
      const raw = await r.text();
      let data;
      try{ data = JSON.parse(raw); } catch(e){ throw new Error('Сервер вернул не JSON — проверьте, что сайт запущен через PHP.'); }
      if (!r.ok || !data.url) throw new Error(data.error || 'Не удалось загрузить фото');
      url = data.url;
    } else {
      url = URL.createObjectURL(file);
    }
    await pushOutgoing(c, { photo: url });
    showToast('Фото отправлено', 'ok');
  } catch(e){
    showToast(e.message || 'Не удалось отправить фото', 'error');
  } finally {
    btn.classList.remove('busy');
  }
});

$('#chatReplyForm').addEventListener('submit', e => {
  e.preventDefault();
  const c = clients.find(x => x.id === activeChatId);
  const input = $('#chatReplyInput');
  const text = input.value.trim();
  if (!c || !text) return;
  input.value = '';
  Draft.clear('client', c.id);
  const replyTarget = chatReplyBar.get();
  chatReplyBar.clear();
  pushOutgoing(c, { text, replyToId: replyTarget ? replyTarget.id : null, replySnippet: replyTarget ? replyTarget.snippet : null }).catch(() => {});

  if (c.aiAuto && !isRealMode){
    setTimeout(() => {
      if (!clients.find(x => x.id === c.id)) return;
      const reply = SAMPLE_MSGS[Math.floor(Math.random()*SAMPLE_MSGS.length)];
      c.history.push({ from:'in', text: reply, at: Date.now() });
      c.lastMsg = reply;
      c.sentiment = computeSentiment(reply);
      c.updatedAt = Date.now();
      if (activeChatId === c.id){
        const body = $('#chatBody');
        body.appendChild(buildBubble({ from:'in', text: reply, at: Date.now() }, c));
        body.scrollTop = body.scrollHeight;
        updateChatStatus(c);
      }
      renderAll();
    }, 2600);
  }
});

let aiReplyBusy = false;
$('#btnAiReply').addEventListener('click', async () => {
  const c = clients.find(x => x.id === activeChatId);
  if (!c || aiReplyBusy) return;
  aiReplyBusy = true;
  const btn = $('#btnAiReply');
  btn.disabled = true;
  const body = $('#chatBody');
  const thinking = document.createElement('div');
  thinking.className = 'ai-block ai-block-typing';
  thinking.innerHTML = `<div class="ai-tag"><span class="dot"></span>ИИ подбирает ответ…</div><span class="typing-dots"><span></span><span></span><span></span></span>`;
  body.appendChild(thinking);
  body.scrollTop = body.scrollHeight;

  const lastIn = c.history.slice().reverse().find(m => m.from === 'in');
  const aiRes = await askAI('reply', (lastIn && lastIn.text) || c.lastMsg || 'Здравствуйте', c.name);
  const reply = (aiRes && aiRes.reply)
    || 'Здравствуйте! Да, есть в наличии. Уточните, пожалуйста, размер и город доставки — подготовим заказ сегодня же.';
  const isDemo = !aiRes || aiRes.source === 'demo';

  thinking.remove();
  if (isDemo) showToast('Демо-ответ — ИИ не подключён', 'info');

  pushOutgoing(c, { text: reply }).catch(() => {}).finally(() => {
    aiReplyBusy = false;
    btn.disabled = false;
  });
});

let aiMessages = [];
let aiPending = false;

const AI_DEMO_ANSWERS = {
  'конверси': 'Обычно застревание на «Консультации» — это долгий ответ. Попробуйте: 1) отвечать в первые 15 минут, 2) сразу спрашивать размер/город, чтобы не было лишнего круга переписки, 3) включить авто-ответ ИИ на тарифе «Бизнес» для ночных заявок.',
  'скидк': 'Вот черновик: «Здравствуйте! Сейчас фиксированная цена без скидки, но при заказе от 2 вещей — бесплатная доставка по городу. Оформляем?» — уточните размер и цвет перед отправкой.',
  'whatsapp': 'WhatsApp обычно приносит меньше заявок, если номер не указан в шапке Instagram-профиля и в описании Telegram-канала. Проверьте, что ссылка на WhatsApp видна клиенту с первого экрана.',
};
function aiDemoAnswer(q){
  const lower = q.toLowerCase();
  for (const key in AI_DEMO_ANSWERS){
    if (lower.includes(key)) return AI_DEMO_ANSWERS[key];
  }
  return 'Хороший вопрос! Пока у меня нет доступа к Groq API в демо-режиме, но в обычной работе я анализирую именно ваши заявки и подсказываю, где теряются клиенты, как ускорить ответы и что писать в сложных диалогах.';
}

function aiWelcome(){
  aiAppendBubble('assistant', 'Здравствуйте! Я помощник MySavdo — подскажу по воронке, аналитике или помогу составить ответ клиенту. С чего начнём?');
}

function aiSetPending(state, label){
  aiPending = state;
  const input = $('#aiInput');
  const submit = $('#aiForm button[type="submit"]');
  input.disabled = state;
  if (submit) submit.disabled = state;
  input.placeholder = state ? (label || 'ИИ отвечает — подождите…') : 'Напишите вопрос помощнику… (# — команды)';
  $$('.ai-chip').forEach(ch => ch.classList.toggle('disabled', state));
  if (!state) input.focus();
}

// Оценка ответа ИИ — лайк/дизлайк (дизлайк можно снабдить коротким
// комментарием), уходит на backend/api/ai-feedback.php и видна админу во
// вкладке «ИИ-чат».
function attachAiRating(bubble, msgId, replyText){
  if (!msgId) return;
  const row = document.createElement('div');
  row.className = 'ai-rate-row';
  row.innerHTML = `
    <button type="button" class="ai-rate-btn" data-a="copy" title="Копировать"><svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-copy"/></svg></button>
    <button type="button" class="ai-rate-btn" data-a="up" title="Хороший ответ"><svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-thumb-up"/></svg></button>
    <button type="button" class="ai-rate-btn" data-a="down" title="Плохой ответ"><svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-thumb-down"/></svg></button>`;
  bubble.appendChild(row);

  async function sendRating(rating, comment){
    try{
      const r = await apiFetch('backend/api/ai-feedback.php', {
        method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ message_id: msgId, rating, comment: comment || undefined }),
      });
      if (!r.ok){ const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Не удалось сохранить оценку'); }
      row.querySelector('[data-a="up"]').classList.toggle('active', rating === 1);
      row.querySelector('[data-a="down"]').classList.toggle('active', rating === -1);
      if (rating) showToast('Спасибо за оценку!', 'ok');
    } catch(e){ showToast(e.message || 'Не удалось сохранить оценку', 'error'); }
  }

  row.querySelector('[data-a="copy"]').addEventListener('click', () => MsgActions.copyTexts([replyText]));
  row.querySelector('[data-a="up"]').addEventListener('click', () => {
    sendRating(row.querySelector('[data-a="up"]').classList.contains('active') ? null : 1);
  });
  row.querySelector('[data-a="down"]').addEventListener('click', () => {
    if (row.querySelector('[data-a="down"]').classList.contains('active')){ sendRating(null); return; }
    let form = row.querySelector('.ai-rate-comment');
    if (form){ form.querySelector('input').focus(); return; }
    form = document.createElement('form');
    form.className = 'ai-rate-comment';
    form.innerHTML = `<input type="text" maxlength="500" placeholder="Что не так? (необязательно)"><button type="submit" class="btn btn-primary btn-sm">Отправить</button>`;
    form.addEventListener('submit', e => {
      e.preventDefault();
      const val = form.querySelector('input').value.trim();
      form.remove();
      sendRating(-1, val);
    });
    row.appendChild(form);
    form.querySelector('input').focus();
  });
}

function aiAppendBubble(role, text){
  aiMessages.push({ role, content: text });
  const body = $('#aiChatBody');
  const row = document.createElement('div');
  row.className = 'ai-msg-row ' + (role === 'user' ? 'user' : 'assistant');
  const bubble = document.createElement('div');
  bubble.className = 'bubble ai-bubble ' + (role === 'user' ? 'out' : 'in');
  const txt = document.createElement('span');
  txt.className = 'bubble-text';
  txt.textContent = text;
  bubble.appendChild(txt);
  const time = document.createElement('span');
  time.className = 'bubble-time';
  time.textContent = fmtTime(Date.now());
  bubble.appendChild(time);
  if (role !== 'user'){
    const av = document.createElement('div');
    av.className = 'ai-msg-avatar';
    av.innerHTML = '<svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-sparkle"/></svg>';
    row.appendChild(av);
  }
  row.appendChild(bubble);
  body.appendChild(row);
  body.scrollTop = body.scrollHeight;
  return bubble;
}

function aiAppendThinking(text){
  const body = $('#aiChatBody');
  const block = document.createElement('div');
  block.className = 'ai-think';
  block.innerHTML = `
    <button class="ai-think-head" type="button">
      <span class="ai-think-icon">🧠</span>
      <span class="ai-think-label">Размышления</span>
      <svg class="icon icon-sm ai-think-chevron" viewBox="0 0 24 24"><use href="#icon-chevron-down"/></svg>
    </button>
    <div class="ai-think-body"></div>`;
  block.querySelector('.ai-think-body').textContent = text;
  block.querySelector('.ai-think-head').addEventListener('click', () => block.classList.toggle('open'));
  body.appendChild(block);
  body.scrollTop = body.scrollHeight;
  return block;
}

async function aiAsk(question){
  if (aiPending) return;
  if (!userFeatures.ai_chat){
    showToast('Чат ИИ недоступен на вашем тарифе', 'error');
    return;
  }

  if (aiUsage.limit > 0 && aiUsage.used >= aiUsage.limit){
    aiAppendBubble('assistant', `Дневной лимит чата ИИ исчерпан (${aiUsage.limit} сообщений). Новые сообщения будут доступны завтра — или перейдите на тариф «Бизнес», там лимитов нет.`);
    updateAiLimitBadge();
    return;
  }
  aiSetPending(true);
  aiAppendBubble('user', question);
  $('#aiInput').value = '';

  const body = $('#aiChatBody');

  const pending = document.createElement('div');
  pending.className = 'ai-think ai-think-pending';
  pending.innerHTML = `
    <div class="ai-think-head">
      <span class="ai-think-icon">🧠</span>
      <span class="ai-think-label">ИИ размышляет<span class="ai-dots"><span>.</span><span>.</span><span>.</span></span></span>
    </div>`;
  body.appendChild(pending);
  body.scrollTop = body.scrollHeight;

  let thinking = '';
  let reply = null;
  let limitHit = false;
  let source = 'demo';
  let assistantMsgId = null;
  try{

    const history = aiMessages.slice(0, -1).slice(-10);
    const res = await askGrokBackend('assistant', question, null, history);
    reply = res.reply;
    thinking = res.thinking || '';
    source = res.source || 'groq';
    assistantMsgId = res.assistant_message_id || null;
    if (res.ai_usage) aiUsage = res.ai_usage;
    else bumpLocalAiUsage();
    updateAiLimitBadge();
  } catch(e){
    console.warn('[MySavdo AI] backend не смог:', e.message);
    if (e.code === 'limit_reached' || e.code === 'feature_off'){
      if (e.ai_usage) aiUsage = e.ai_usage;
      reply = e.message;
      limitHit = true;
      updateAiLimitBadge();
    }
  }
  if (!reply){
    reply = aiDemoAnswer(question);
    bumpLocalAiUsage();
  }
  const isDemo = !limitHit && source === 'demo';

  pending.remove();
  if (thinking){
    aiAppendThinking(thinking);
  }

  const bubble = aiAppendBubble('assistant', '');
  const txtEl = bubble.querySelector('.bubble-text');
  aiMessages[aiMessages.length - 1].content = reply;
  let i = 0;
  const step = Math.max(1, Math.round(reply.length / 90));
  const typer = setInterval(() => {
    i = Math.min(reply.length, i + step);
    txtEl.textContent = reply.slice(0, i);
    body.scrollTop = body.scrollHeight;
    if (i >= reply.length){
      clearInterval(typer);
      aiSetPending(false);
      if (isDemo){
        const badge = document.createElement('span');
        badge.className = 'ai-demo-badge';
        badge.textContent = 'демо-ответ, ИИ не подключён';
        bubble.appendChild(badge);
      }
      if (!limitHit) attachAiRating(bubble, assistantMsgId, reply);
    }
  }, 16);
}

// --- # -команды в чате ИИ ---------------------------------------------
// Список легко расширяется: добавьте новый объект в AI_HASH_COMMANDS — он
// сразу появится в выпадающем меню по вводу "#" и в списке #help.
const AI_HASH_COMMANDS = [
  {
    id: 'add_telegram',
    title: 'Подключить Telegram-бота',
    desc: 'Свяжет бота с CRM автоматически по токену',
    usage: 'токен_бота',
    icon: 'icon-plus',
    needsArg: true,
    argHint: 'Вставьте токен, который выдал @BotFather в Telegram, например:\n#add_telegram 123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    run: async (arg) => {
      const token = arg.trim();
      if (!token.includes(':')) {
        return { ok:false, text:'Похоже, это не токен бота. Токен выглядит так: 123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx — получите его у @BotFather в Telegram.' };
      }
      try{
        const r = await apiFetch('backend/api/telegram-bot-settings.php', {
          method:'POST', credentials:'include',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ bot_token: token })
        });
        const data = await r.json();
        if (!r.ok) return { ok:false, text: data.error || 'Не удалось подключить бота' };
        refreshTelegramStatus();
        return { ok:true, text: `Готово! Telegram-бот @${data.bot_username} подключён и уже принимает заявки в CRM.` };
      } catch(e){
        return { ok:false, text:'Не удалось связаться с сервером. Попробуйте ещё раз.' };
      }
    }
  },
  {
    id: 'telegram_status',
    title: 'Статус Telegram-бота',
    desc: 'Подключён ли бот прямо сейчас',
    icon: 'icon-message',
    needsArg: false,
    run: async () => {
      try{
        const r = await apiFetch('backend/api/telegram-bot-settings.php', { credentials:'include' });
        const data = await r.json();
        if (data.connected) return { ok:true, text: `Telegram подключён: @${data.bot_username}.` };
        return { ok:true, text: 'Telegram ещё не подключён. Наберите #add_telegram и вставьте токен бота от @BotFather.' };
      } catch(e){
        return { ok:false, text:'Не удалось проверить статус Telegram.' };
      }
    }
  },
  {
    id: 'remove_telegram',
    title: 'Отключить Telegram-бота',
    desc: 'Снимет вебхук и отвяжет бота от CRM',
    icon: 'icon-trash',
    needsArg: false,
    run: async () => {
      if (!confirm('Отключить Telegram-бота? Заявки, которые уже пришли, останутся в CRM.')) {
        return { ok:true, text: 'Отменено.' };
      }
      try{
        await apiFetch('backend/api/telegram-bot-settings.php', { method:'DELETE', credentials:'include' });
        refreshTelegramStatus();
        return { ok:true, text: 'Telegram-бот отключён.' };
      } catch(e){
        return { ok:false, text:'Не удалось отключить бота.' };
      }
    }
  },
  {
    id: 'connect_instagram',
    title: 'Подключить Instagram',
    desc: 'Откроет авторизацию Meta для Instagram Direct',
    icon: 'icon-camera',
    needsArg: false,
    run: async () => {
      setTimeout(() => { location.href = 'backend/api/instagram-oauth-start.php'; }, 900);
      return { ok:true, text: 'Открываю окно авторизации Instagram…' };
    }
  },
  {
    id: 'disconnect_instagram',
    title: 'Отключить Instagram',
    desc: 'Отвяжет Instagram Direct от CRM',
    icon: 'icon-trash',
    needsArg: false,
    run: async () => {
      if (!confirm('Отключить Instagram? Заявки, которые уже пришли, останутся в CRM.')) {
        return { ok:true, text: 'Отменено.' };
      }
      try{
        await apiFetch('backend/api/instagram-status.php', { method:'DELETE', credentials:'include' });
        igState = null;
        refreshInstagramStatus();
        return { ok:true, text: 'Instagram отключён.' };
      } catch(e){
        return { ok:false, text:'Не удалось отключить Instagram.' };
      }
    }
  },
  {
    id: 'clear',
    title: 'Очистить чат',
    desc: 'Стереть историю переписки с помощником',
    icon: 'icon-x',
    needsArg: false,
    run: async () => null
  },
  {
    id: 'help',
    title: 'Список команд',
    desc: 'Показать все доступные команды',
    icon: 'icon-command',
    needsArg: false,
    run: async () => {
      const lines = AI_HASH_COMMANDS.map(c => `#${c.id}${c.needsArg ? ' <' + (c.usage || 'значение') + '>' : ''} — ${c.desc}`);
      return { ok:true, text: 'Доступные команды:\n' + lines.join('\n') };
    }
  },
];

let aiCmdOpen = false;
let aiCmdActive = 0;
let aiCmdList = [];

function aiCmdFilter(query){
  const q = query.toLowerCase();
  if (!q) return AI_HASH_COMMANDS;
  return AI_HASH_COMMANDS.filter(c => c.id.includes(q) || c.title.toLowerCase().includes(q));
}

function positionAiCmdMenu(){
  const rect = $('#aiInput').getBoundingClientRect();
  const menu = $('#aiCmdMenu');
  menu.style.left = rect.left + 'px';
  menu.style.width = rect.width + 'px';
  menu.style.bottom = (window.innerHeight - rect.top + 10) + 'px';
}

function updateAiCmdActive(){
  const menu = $('#aiCmdMenu');
  $$('.ai-cmd-item', menu).forEach((el, i) => el.classList.toggle('active', i === aiCmdActive));
  const activeEl = $(`.ai-cmd-item[data-idx="${aiCmdActive}"]`, menu);
  if (activeEl) activeEl.scrollIntoView({ block:'nearest' });
}

function aiCmdApply(cmd){
  const input = $('#aiInput');
  input.value = '#' + cmd.id + (cmd.needsArg ? ' ' : '');
  closeAiCmdMenu();
  input.focus();
}

function renderAiCmdMenu(query){
  aiCmdList = aiCmdFilter(query);
  aiCmdActive = 0;
  const menu = $('#aiCmdMenu');
  if (!aiCmdList.length){
    menu.innerHTML = '<div class="ai-cmd-empty">Команда не найдена</div>';
  } else {
    menu.innerHTML = aiCmdList.map((c, i) => `
      <div class="ai-cmd-item ${i === 0 ? 'active' : ''}" data-idx="${i}">
        <svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#${c.icon}"/></svg>
        <span class="ai-cmd-main">
          <span class="ai-cmd-title">#${c.id}</span>
          <span class="ai-cmd-desc">${c.desc}</span>
        </span>
        ${c.needsArg ? '<span class="ai-cmd-usage">нужен аргумент</span>' : ''}
      </div>`).join('');
    $$('.ai-cmd-item', menu).forEach((el, i) => {
      el.addEventListener('mousedown', e => { e.preventDefault(); aiCmdApply(aiCmdList[i]); });
      el.addEventListener('mouseenter', () => { aiCmdActive = i; updateAiCmdActive(); });
    });
  }
  positionAiCmdMenu();
  aiCmdOpen = true;
  menu.classList.add('show');
}

function closeAiCmdMenu(){
  aiCmdOpen = false;
  $('#aiCmdMenu').classList.remove('show');
}

async function aiRunCommand(raw){
  const spaceIdx = raw.indexOf(' ');
  const name = (spaceIdx === -1 ? raw.slice(1) : raw.slice(1, spaceIdx)).toLowerCase();
  const argStr = spaceIdx === -1 ? '' : raw.slice(spaceIdx + 1).trim();
  const cmd = AI_HASH_COMMANDS.find(c => c.id === name);
  $('#aiInput').value = '';

  if (cmd && cmd.id === 'clear'){
    aiMessages = [];
    $('#aiChatBody').innerHTML = '';
    aiWelcome();
    return;
  }

  aiAppendBubble('user', raw);

  if (!cmd){
    aiAppendBubble('assistant', `Не знаю команду «#${name}». Наберите # в поле ввода, чтобы увидеть список доступных команд.`);
    return;
  }
  if (cmd.needsArg && !argStr){
    aiAppendBubble('assistant', cmd.argHint || `Укажите аргумент: #${cmd.id} <${cmd.usage || 'значение'}>`);
    return;
  }

  aiSetPending(true, 'Выполняю команду…');
  const body = $('#aiChatBody');
  const pending = document.createElement('div');
  pending.className = 'ai-think ai-think-pending';
  pending.innerHTML = `
    <div class="ai-think-head">
      <span class="ai-think-icon">⚙️</span>
      <span class="ai-think-label">Выполняю команду<span class="ai-dots"><span>.</span><span>.</span><span>.</span></span></span>
    </div>`;
  body.appendChild(pending);
  body.scrollTop = body.scrollHeight;

  let result;
  try{
    result = await cmd.run(argStr);
  } catch(e){
    result = { ok:false, text: 'Команда завершилась с ошибкой: ' + (e.message || e) };
  }
  pending.remove();
  aiSetPending(false);

  if (result && result.text){
    const bubble = aiAppendBubble('assistant', result.text);
    const badge = document.createElement('span');
    badge.className = 'ai-cmd-badge ' + (result.ok === false ? 'fail' : 'ok');
    badge.textContent = result.ok === false ? 'команда · ошибка' : 'команда · готово';
    bubble.appendChild(badge);
  }
}

$('#aiInput').addEventListener('input', e => {
  const m = e.target.value.match(/^#([a-zA-Z0-9_]*)$/);
  if (m) renderAiCmdMenu(m[1]);
  else closeAiCmdMenu();
});
$('#aiInput').addEventListener('focus', e => {
  const m = e.target.value.match(/^#([a-zA-Z0-9_]*)$/);
  if (m) renderAiCmdMenu(m[1]);
});
$('#aiInput').addEventListener('blur', () => setTimeout(closeAiCmdMenu, 120));
$('#aiInput').addEventListener('keydown', e => {
  if (!aiCmdOpen) return;
  if (e.key === 'ArrowDown'){ e.preventDefault(); aiCmdActive = Math.min(aiCmdList.length - 1, aiCmdActive + 1); updateAiCmdActive(); }
  else if (e.key === 'ArrowUp'){ e.preventDefault(); aiCmdActive = Math.max(0, aiCmdActive - 1); updateAiCmdActive(); }
  else if (e.key === 'Tab'){
    if (aiCmdList[aiCmdActive]){ e.preventDefault(); aiCmdApply(aiCmdList[aiCmdActive]); }
  }
  else if (e.key === 'Enter'){
    const active = aiCmdList[aiCmdActive];
    if (active){
      const expected = '#' + active.id + (active.needsArg ? ' ' : '');
      if (e.target.value === expected){
        // команда уже полностью набрана — закрываем меню и даём форме отправиться
        closeAiCmdMenu();
      } else {
        e.preventDefault();
        aiCmdApply(active);
      }
    }
  }
  else if (e.key === 'Escape'){ closeAiCmdMenu(); }
});
window.addEventListener('resize', () => { if (aiCmdOpen) positionAiCmdMenu(); });
window.addEventListener('scroll', () => { if (aiCmdOpen) positionAiCmdMenu(); }, true);

$('#aiForm').addEventListener('submit', e => {
  e.preventDefault();
  if (aiPending) return;
  const val = $('#aiInput').value.trim();
  if (!val) return;
  closeAiCmdMenu();
  if (val.startsWith('#')){
    aiRunCommand(val);
    return;
  }
  aiAsk(val);
});
$$('.ai-chip').forEach(chip => {
  chip.addEventListener('click', () => { if (!aiPending) aiAsk(chip.textContent); });
});

const revealTargets = $$('.pain-card, .feature-row, .step-card, .price-card, .faq-item, .stats-band, .section-head');
revealTargets.forEach(el => el.classList.add('reveal'));
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting){
      entry.target.classList.add('revealed');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.15 });
revealTargets.forEach(el => revealObserver.observe(el));

const statObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    $$('.stat-num', entry.target).forEach(el => {
      const raw = el.textContent.trim();
      const match = raw.match(/[\d.]+/);
      if (!match) return;
      const target = parseFloat(match[0]);
      const suffix = raw.replace(match[0], '');
      const isFloat = match[0].includes('.');
      let cur = 0;
      const steps = 36;
      const inc = target / steps;
      const t = setInterval(() => {
        cur += inc;
        if (cur >= target){ cur = target; clearInterval(t); }
        el.textContent = (isFloat ? cur.toFixed(1) : Math.round(cur)) + suffix;
      }, 28);
    });
    statObserver.unobserve(entry.target);
  });
}, { threshold: 0.4 });
$$('.stats-band').forEach(el => statObserver.observe(el));

function fireConfetti(x, y){
  const colors = ['#B8902B', '#D9AE4E', '#123626', '#0a2118', '#F3E8CC'];
  const count = 26;
  const wrap = document.createElement('div');
  wrap.className = 'confetti-wrap';
  document.body.appendChild(wrap);
  for (let i = 0; i < count; i++){
    const p = document.createElement('span');
    p.className = 'confetti-piece';
    const angle = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 90;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - 40;
    p.style.left = x + 'px';
    p.style.top = y + 'px';
    p.style.background = colors[Math.floor(Math.random()*colors.length)];
    p.style.setProperty('--dx', dx + 'px');
    p.style.setProperty('--dy', dy + 'px');
    p.style.setProperty('--rot', (Math.random()*520 - 260) + 'deg');
    p.style.animationDelay = (Math.random()*0.08) + 's';
    wrap.appendChild(p);
  }
  setTimeout(() => wrap.remove(), 1100);
}

const voiceRec = { recorder:null, chunks:[], stream:null, startAt:0, timer:null, cancelled:false, starting:false };

function voicePickMime(){
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const m of candidates){
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

function voiceUpdateTimer(){
  const el = $('#recTimer');
  if (!el) return;
  const sec = Math.floor((Date.now() - voiceRec.startAt) / 1000);
  el.textContent = `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
}

function voiceSetUI(recording){
  $('#btnVoice').classList.toggle('recording', recording);
  $('#recIndicator').classList.toggle('active', recording);
  $('#chatReplyInput').style.visibility = recording ? 'hidden' : 'visible';
}

async function voiceStart(){
  // voiceRec.recorder остаётся null, пока не отработает getUserMedia — без
  // этого флага второй тап по кнопке (или второй клик, пока висит запрос
  // разрешения на микрофон) успевал повторно войти сюда и запускал вторую
  // запись поверх первой: первый stream/interval никогда не останавливался
  // (микрофон оставался включён), второй тихо перезаписывал ссылки на них.
  if (voiceRec.starting || voiceRec.recorder) return;
  voiceRec.starting = true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder){
    showToast('Запись голоса не поддерживается в этом браузере', 'error');
    voiceRec.starting = false;
    return;
  }
  try{
    voiceRec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch(e){
    showToast('Нет доступа к микрофону — разрешите его в настройках браузера', 'error');
    voiceRec.starting = false;
    return;
  }
  voiceRec.chunks = [];
  voiceRec.cancelled = false;
  const mime = voicePickMime();
  voiceRec.recorder = new MediaRecorder(voiceRec.stream, mime ? { mimeType: mime } : undefined);
  voiceRec.recorder.ondataavailable = e => { if (e.data && e.data.size) voiceRec.chunks.push(e.data); };
  voiceRec.recorder.onstop = onVoiceStopped;
  voiceRec.recorder.start();
  voiceRec.startAt = Date.now();
  voiceUpdateTimer();
  voiceRec.timer = setInterval(voiceUpdateTimer, 300);
  voiceSetUI(true);
  voiceRec.starting = false;
  if (navigator.vibrate) navigator.vibrate(10);
}

function voiceStop(cancel = false){
  if (!voiceRec.recorder) return;
  voiceRec.cancelled = cancel;
  clearInterval(voiceRec.timer);
  try{ voiceRec.recorder.stop(); } catch(e){}
  if (voiceRec.stream) voiceRec.stream.getTracks().forEach(t => t.stop());
  voiceSetUI(false);
}

async function onVoiceStopped(){
  const chunks = voiceRec.chunks;
  const mime = voiceRec.recorder && voiceRec.recorder.mimeType || 'audio/webm';
  voiceRec.recorder = null;
  voiceRec.stream = null;
  if (voiceRec.cancelled || !chunks.length) return;

  const durMs = Date.now() - voiceRec.startAt;
  if (durMs < 600){
    showToast('Слишком короткая запись — удерживайте чуть дольше', 'info');
    return;
  }

  const blob = new Blob(chunks, { type: mime });
  const c = clients.find(x => x.id === activeChatId);
  if (!c) return;

  const btn = $('#btnVoice');
  btn.classList.add('busy');
  try{
    let url;
    if (isRealMode){
      const ext = mime.includes('mp4') ? 'm4a' : (mime.includes('ogg') ? 'ogg' : 'webm');
      const fd = new FormData();
      fd.append('audio', blob, 'voice.' + ext);
      const r = await apiFetch('backend/api/upload.php', { method:'POST', credentials:'include', body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.url) throw new Error(data.error || 'Не удалось загрузить голосовое');
      url = data.url;
    } else {
      url = URL.createObjectURL(blob);
    }
    await pushOutgoing(c, { audio: url });
    showToast('Голосовое отправлено', 'ok');
  } catch(e){
    showToast(e.message || 'Не удалось отправить голосовое', 'error');
  } finally {
    btn.classList.remove('busy');
  }
}

$('#btnVoice').addEventListener('click', () => {
  if (voiceRec.recorder) voiceStop(false);
  else voiceStart();
});
$('#recCancel')?.addEventListener('click', () => voiceStop(true));

$('#chatClose').addEventListener('click', () => { if (voiceRec.recorder) voiceStop(true); });

function buildCmdkActions(){
  const actions = [
    { icon:'icon-home', label:'Перейти на Главную', run:() => switchDashView('home') },
    { icon:'icon-users', label:'Открыть Мои клиенты', run:() => switchDashView('clients') },
    { icon:'icon-funnel', label:'Открыть Воронку продаж', run:() => switchDashView('funnel') },
    { icon:'icon-chart', label:'Открыть Аналитику', run:() => switchDashView('analytics') },
    { icon:'icon-message', label:'Открыть Помощь ИИ', run:() => switchDashView('ai') },
    { icon:'icon-logout', label:'Выйти из аккаунта', run:() => $('#btnLogout').click() },
  ];
  clients.slice(0, 30).forEach(c => {
    actions.push({
      icon:'icon-message', label:`Открыть чат: ${c.name}`, hint: c.channel.name,
      run:() => { switchDashView('funnel'); openChat(c.id); }
    });
  });
  return actions;
}

let cmdkActive = -1;
function openCmdk(){
  $('#cmdkOverlay').classList.add('active');
  const input = $('#cmdkInput');
  input.value = '';
  renderCmdk('');
  setTimeout(() => input.focus(), 50);
}
function closeCmdk(){ $('#cmdkOverlay').classList.remove('active'); }
function renderCmdk(query){
  const all = buildCmdkActions();
  const q = query.trim().toLowerCase();
  const filtered = q ? all.filter(a => a.label.toLowerCase().includes(q)) : all;
  cmdkActive = filtered.length ? 0 : -1;
  const list = $('#cmdkList');
  if (!filtered.length){
    list.innerHTML = '<div class="cmdk-empty">Ничего не найдено</div>';
    return;
  }
  list.innerHTML = filtered.map((a, i) => `
    <div class="cmdk-item ${i===0?'active':''}" data-idx="${i}">
      <svg class="icon" viewBox="0 0 24 24"><use href="#${a.icon}"/></svg>
      <b>${a.label}</b>
      ${a.hint ? `<span class="hint">${a.hint}</span>` : ''}
    </div>`).join('');
  $$('.cmdk-item', list).forEach((el, i) => {
    el.addEventListener('click', () => { filtered[i].run(); closeCmdk(); });
    el.addEventListener('mouseenter', () => { cmdkActive = i; updateCmdkActive(); });
  });
  renderCmdk._filtered = filtered;
}
function updateCmdkActive(){
  $$('.cmdk-item').forEach((el, i) => el.classList.toggle('active', i === cmdkActive));
  const activeEl = $(`.cmdk-item[data-idx="${cmdkActive}"]`);
  if (activeEl) activeEl.scrollIntoView({ block:'nearest' });
}

$('#btnCmdk').addEventListener('click', openCmdk);
$('#cmdkInput').addEventListener('input', e => renderCmdk(e.target.value));
$('#cmdkOverlay').addEventListener('click', e => { if (e.target.id === 'cmdkOverlay') closeCmdk(); });

document.addEventListener('keydown', e => {
  if (!e || typeof e.key !== 'string') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'){
    e.preventDefault();
    const dash = $('#screen-dashboard');
    if (dash && dash.classList.contains('active')){
      $('#cmdkOverlay').classList.contains('active') ? closeCmdk() : openCmdk();
    }
    return;
  }
  if (!$('#cmdkOverlay').classList.contains('active')) return;
  const filtered = renderCmdk._filtered || [];
  if (e.key === 'Escape'){ closeCmdk(); }
  else if (e.key === 'ArrowDown'){ e.preventDefault(); cmdkActive = Math.min(filtered.length-1, cmdkActive+1); updateCmdkActive(); }
  else if (e.key === 'ArrowUp'){ e.preventDefault(); cmdkActive = Math.max(0, cmdkActive-1); updateCmdkActive(); }
  else if (e.key === 'Enter'){ e.preventDefault(); if (filtered[cmdkActive]){ filtered[cmdkActive].run(); closeCmdk(); } }
});

const heroSection = $('#heroSection');

(async function loadSiteLogo(){
  try{
    const r = await apiFetch('backend/api/admin.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'public_settings' }),
    });
    const data = await r.json();
    const logo = data.settings && data.settings.logo;
    if (logo && logo !== 'assets/img/logo.png'){
      $$('.js-logo-mark').forEach(el => { el.innerHTML = `<img src="${escapeHtml(logo)}" alt="Логотип" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`; });
    }
  } catch(e){  }
})();
if (heroSection){
  heroSection.addEventListener('mousemove', e => {
    const r = heroSection.getBoundingClientRect();
    heroSection.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    heroSection.style.setProperty('--my', (e.clientY - r.top) + 'px');
  });
}

const LANDING_TOUR = [
  {
    target: 'logo',
    title: 'Это MySavdo',
    text: 'Логотип всегда возвращает вас на главный экран сайта — на него можно нажать в любой момент.',
  },
  {
    target: 'nav',
    title: 'Разделы сайта',
    text: 'Здесь — «Возможности», «Тарифы», «Как это работает» и «Вопросы». Клик по любому пункту сразу проскроллит к нужному блоку.',
  },
  {
    target: 'replay',
    title: 'Обучалка заново',
    text: 'Если захотите ещё раз посмотреть, зачем нужен MySavdo — эта кнопка запускает вступление сначала.',
  },
  {
    target: 'register',
    title: 'Регистрация',
    text: 'Здесь вы создаёте аккаунт продавца — email и пароль, займёт меньше минуты. После регистрации я покажу вам сам кабинет.',
    askable: true,
  },
  {
    target: 'hero-start',
    title: 'Или начните прямо здесь',
    text: 'Эта кнопка делает то же самое, что и «Регистрация» в шапке — так короче, если вы уже пролистали до низа.',
    askable: true,
    last: true,
  },
];

const DASHBOARD_TOUR = [
  {
    target: 'nav-home',
    title: 'Главная',
    text: 'Здесь — сводка дня: сколько заявок, что срочно нужно сделать, и лента последних сообщений.',
  },
  {
    target: 'nav-funnel',
    title: 'Воронка продаж',
    text: 'Канбан-доска с этапами сделки. Перетаскивайте карточку клиента вправо по мере продвижения — от «Нового запроса» до «Доставлено».',
    askable: true,
  },
  {
    target: 'nav-analytics',
    title: 'Аналитика',
    text: 'Конверсия, средний чек и график заявок за неделю — три цифры, на которые стоит смотреть каждое утро.',
  },
  {
    target: 'cmdk',
    title: 'Быстрые действия',
    text: 'Нажмите Ctrl (или ⌘) + K в любой момент — откроется быстрый поиск клиента и переход между разделами без мыши.',
  },
  {
    target: 'notif',
    title: 'Уведомления',
    text: 'Колокольчик подсвечивается, когда клиент долго ждёт ответа или пишет что-то важное — не пропустите красную точку.',
  },
  {
    target: 'account',
    title: 'Ваш аккаунт',
    text: 'Здесь — «Мои клиенты» (полный список с поиском), «Помощь ИИ» (чат с помощником-аналитиком) и выход из аккаунта.',
    askable: true,
    last: true,
  },
];

let tourSteps = [];
let tourStepIndex = 0;
let tourDoneFlag = null;
let tourResizeHandler = null;

function findTourTarget(name){
  return document.querySelector(`[data-tour="${name}"]`);
}

function startTour(steps, doneFlagKey){
  const usable = steps.filter(s => findTourTarget(s.target));
  if (usable.length === 0) return;
  tourSteps = usable;
  tourStepIndex = 0;
  tourDoneFlag = doneFlagKey;
  $('#tourOverlay').classList.add('active');
  renderTourStep();
  tourResizeHandler = () => positionTourStep();
  window.addEventListener('resize', tourResizeHandler);
  window.addEventListener('scroll', tourResizeHandler, true);
}

function endTour(){
  $('#tourOverlay').classList.remove('active');
  if (tourDoneFlag) localStorage.setItem(tourDoneFlag, '1');
  if (tourResizeHandler){
    window.removeEventListener('resize', tourResizeHandler);
    window.removeEventListener('scroll', tourResizeHandler, true);
    tourResizeHandler = null;
  }
  $('#tourAskBody').classList.remove('open');
  $('#tourChat').innerHTML = '';
}

function renderTourStep(){
  const step = tourSteps[tourStepIndex];
  const target = findTourTarget(step.target);
  if (!target){ tourNext(); return; }
  target.scrollIntoView && target.scrollIntoView({ block:'center', behavior:'smooth' });

  $('#tourStepLabel').textContent = `${tourStepIndex + 1}/${tourSteps.length}`;
  $('#tourTitle').textContent = step.title;
  $('#tourText').textContent = step.text;
  $('#tourAskWrap').style.display = step.askable ? 'block' : 'none';
  $('#tourAskBody').classList.remove('open');
  $('#tourChat').innerHTML = '';
  $('#tourAskToggleLabel').textContent = 'Спросить Лайма';
  $('#tourAskInput').placeholder = 'Например: а как подключить Instagram?';

  const prevBtn = $('#tourPrev'), nextBtn = $('#tourNext'), skipBtn = $('#tourSkip');
  prevBtn.style.visibility = tourStepIndex === 0 ? 'hidden' : 'visible';
  nextBtn.textContent = step.last ? 'Понятно, спасибо!' : 'Дальше →';
  skipBtn.textContent = 'Пропустить тур ✕';

  const dots = $('#tourDots');
  dots.innerHTML = '';
  tourSteps.forEach((_, i) => {
    const d = document.createElement('span');
    d.className = 'tour-dot' + (i === tourStepIndex ? ' active' : '');
    dots.appendChild(d);
  });

  setTimeout(positionTourStep, 60);
}

function positionTourStep(){
  if (!$('#tourOverlay').classList.contains('active')) return;
  const step = tourSteps[tourStepIndex];
  if (!step) return;
  const target = findTourTarget(step.target);
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const pad = 8;
  const spot = $('#tourSpotlight');
  spot.style.top = (rect.top - pad) + 'px';
  spot.style.left = (rect.left - pad) + 'px';
  spot.style.width = (rect.width + pad*2) + 'px';
  spot.style.height = (rect.height + pad*2) + 'px';

  const card = $('#tourCard');
  const cardW = Math.min(340, window.innerWidth - 32);
  card.style.width = cardW + 'px';
  const spaceBelow = window.innerHeight - rect.bottom;
  const putBelow = spaceBelow > 220 || rect.top < 220;
  let cardTop = putBelow ? rect.bottom + 26 : rect.top - 26;
  if (!putBelow) cardTop = Math.max(16, rect.top - 300);
  let cardLeft = rect.left + rect.width/2 - cardW/2;
  cardLeft = Math.max(14, Math.min(cardLeft, window.innerWidth - cardW - 14));
  card.style.top = cardTop + 'px';
  card.style.left = cardLeft + 'px';

  const arrow = $('#tourArrow');
  const arrowLeft = Math.max(rect.left + rect.width/2 - 13, 10);
  if (putBelow){
    arrow.style.top = (rect.bottom + 4) + 'px';
    arrow.style.left = arrowLeft + 'px';
    arrow.style.transform = 'rotate(0deg)';
  } else {
    arrow.style.top = (rect.top - 30) + 'px';
    arrow.style.left = arrowLeft + 'px';
    arrow.style.transform = 'rotate(180deg)';
  }
}

function tourNext(){
  const step = tourSteps[tourStepIndex];
  if (step && step.last){ endTour(); return; }
  if (tourStepIndex < tourSteps.length - 1){
    tourStepIndex++;
    renderTourStep();
  } else {
    endTour();
  }
}
function tourPrev(){
  if (tourStepIndex > 0){
    tourStepIndex--;
    renderTourStep();
  }
}

$('#tourNext').addEventListener('click', tourNext);
$('#tourPrev').addEventListener('click', tourPrev);
$('#tourSkip').addEventListener('click', endTour);
$('#tourAskToggle').addEventListener('click', () => {
  $('#tourAskBody').classList.toggle('open');
  if ($('#tourAskBody').classList.contains('open')) $('#tourAskInput').focus();
});

function limeAvatarHtml(){
  return `<span class="lime-avatar"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-lime"/></svg></span>`;
}

const LIME_DEMO_ANSWERS = [
  'Хороший вопрос! Загляните в раздел «Интеграции» в личном кабинете — там подключаются Instagram, Telegram и WhatsApp за пару кликов.',
  'Я — Лайм, слежу за порядком внутри MySavdo 🍋 В демо-режиме я отвечаю заготовленными подсказками, а в рабочем аккаунте — разбираю именно ваши заявки.',
  'Начните с бесплатного тарифа «Демо» — карта не нужна, а перейти на «Стандарт» можно в любой момент из раздела «Тарифы».',
];
function limeDemoAnswer(){
  return LIME_DEMO_ANSWERS[Math.floor(Math.random() * LIME_DEMO_ANSWERS.length)];
}

$('#tourAskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#tourAskInput');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  const chat = $('#tourChat');
  const userBubble = document.createElement('div');
  userBubble.className = 'tour-chat-bubble user';
  userBubble.textContent = q;
  chat.appendChild(userBubble);

  const typing = document.createElement('div');
  typing.className = 'tour-chat-bubble lime';
  typing.innerHTML = limeAvatarHtml() + '<span class="typing-dots"><span></span><span></span><span></span></span>';
  chat.appendChild(typing);
  chat.scrollTop = chat.scrollHeight;

  const aiRes = await askAI('guide', q);
  const reply = (aiRes && aiRes.reply) || limeDemoAnswer();
  const isDemo = !aiRes || aiRes.source === 'demo';
  typing.remove();
  const limeBubble = document.createElement('div');
  limeBubble.className = 'tour-chat-bubble lime';
  limeBubble.innerHTML = limeAvatarHtml();
  const replySpan = document.createElement('span');
  replySpan.textContent = reply;
  limeBubble.appendChild(replySpan);
  if (isDemo){
    const badge = document.createElement('span');
    badge.className = 'ai-demo-badge';
    badge.textContent = 'демо-ответ, ИИ не подключён';
    limeBubble.appendChild(badge);
  }
  chat.appendChild(limeBubble);
  chat.scrollTop = chat.scrollHeight;
});

(function initBurgerMenu(){
  const burger = document.getElementById('btnBurger');
  const menu = document.getElementById('mobileMenu');
  if (!burger || !menu) return;

  function setMenu(open){
    menu.classList.toggle('open', open);
    burger.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.classList.toggle('menu-locked', open);
  }
  burger.addEventListener('click', () => setMenu(!menu.classList.contains('open')));

  $$('.mobile-menu-links a', menu).forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      setMenu(false);
      const target = document.querySelector(a.getAttribute('href'));
      if (target) setTimeout(() => target.scrollIntoView && target.scrollIntoView({ behavior:'smooth' }), 80);
    });
  });

  const replayM = document.getElementById('btnReplayMobile');
  if (replayM) replayM.addEventListener('click', () => { setMenu(false); showScreen('screen-welcome'); });

  const authM = document.getElementById('btnOpenAuthMobile');
  if (authM) authM.addEventListener('click', () => {
    setMenu(false);
    const user = Auth.current();
    if (user) openDashboard(); else openAuth('register');
  });

  document.addEventListener('click', e => {
    if (!menu.classList.contains('open')) return;
    if (!menu.contains(e.target) && !burger.contains(e.target)) setMenu(false);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && menu.classList.contains('open')) setMenu(false);
  });
})();

const touchDragState = {
  active: false,
  justDragged: false,
};

function attachTouchDrag(el, client){
  let pressTimer = null;
  let startX = 0, startY = 0;
  let ghost = null;
  let lastHoverWrap = null;

  function cleanup(){
    clearTimeout(pressTimer); pressTimer = null;
    if (ghost){ ghost.remove(); ghost = null; }
    el.classList.remove('drag-origin');
    if (lastHoverWrap){ lastHoverWrap.classList.remove('drag-over'); lastHoverWrap = null; }
    touchDragState.active = false;
  }

  function makeGhost(x, y){
    const r = el.getBoundingClientRect();
    ghost = el.cloneNode(true);
    ghost.className = 'kcard kcard-ghost';
    ghost.style.width = r.width + 'px';
    document.body.appendChild(ghost);
    moveGhost(x, y);
  }
  function moveGhost(x, y){
    if (!ghost) return;
    ghost.style.left = x + 'px';
    ghost.style.top = y + 'px';
  }

  function hoverColumnAt(x, y){
    if (ghost) ghost.style.pointerEvents = 'none';
    const under = document.elementFromPoint(x, y);
    const wrap = under ? under.closest('.kcards') : null;
    if (wrap !== lastHoverWrap){
      if (lastHoverWrap) lastHoverWrap.classList.remove('drag-over');
      if (wrap) wrap.classList.add('drag-over');
      lastHoverWrap = wrap;
    }
    return wrap;
  }

  function edgeScroll(x){
    const board = document.getElementById('kanban');
    if (!board) return;
    const EDGE = 56, SPEED = 14;
    if (x < EDGE) board.scrollLeft -= SPEED;
    else if (x > window.innerWidth - EDGE) board.scrollLeft += SPEED;
  }

  el.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    startX = e.clientX; startY = e.clientY;
    pressTimer = setTimeout(() => {
      touchDragState.active = true;
      el.classList.add('drag-origin');
      makeGhost(startX, startY);
      if (navigator.vibrate) navigator.vibrate(12);
    }, 300);
  });

  el.addEventListener('pointermove', e => {
    if (e.pointerType !== 'touch') return;
    if (!touchDragState.active){

      if (pressTimer && (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8)){
        clearTimeout(pressTimer); pressTimer = null;
      }
      return;
    }
    moveGhost(e.clientX, e.clientY);
    hoverColumnAt(e.clientX, e.clientY);
    edgeScroll(e.clientX);
  });

  function onRelease(e){
    if (e.pointerType !== 'touch'){ return; }
    if (touchDragState.active){
      const wrap = hoverColumnAt(e.clientX, e.clientY);
      const colId = wrap ? wrap.dataset.col : null;
      cleanup();
      touchDragState.justDragged = true;
      setTimeout(() => { touchDragState.justDragged = false; }, 350);
      if (colId) moveClientToCol(client, colId, e.clientX, e.clientY);
    } else {
      cleanup();
    }
  }
  el.addEventListener('pointerup', onRelease);
  el.addEventListener('pointercancel', e => { if (e.pointerType === 'touch') cleanup(); });
}

document.addEventListener('touchmove', e => {
  if (touchDragState.active) e.preventDefault();
}, { passive: false });

(function initObSwipe(){
  const track = document.querySelector('.ob-track');
  if (!track) return;
  let sx = 0, sy = 0, tracking = false;
  track.addEventListener('touchstart', e => {
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
  }, { passive: true });
  track.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    if (dx < 0 && obIndex < obSlides.length - 1){ obIndex++; renderOb(); }
    else if (dx > 0 && obIndex > 0){ obIndex--; renderOb(); }
  }, { passive: true });
})();

let profilePendingAvatar = null;

// «С нами N дней» и копирование ссылки на публичный профиль — тонкий слой
// поверх того, что уже приходит в объекте пользователя (created_at/username).
function updateAccountMenuMeta(user){
  const daysEl = $('#accountMenuDaysWithUs');
  if (daysEl){
    const created = user.created_at ? parseServerTime(user.created_at) : null;
    if (created && !isNaN(created)){
      const days = Math.max(0, Math.floor((Date.now() - created) / 86400000));
      daysEl.textContent = days === 0 ? 'С нами сегодня 🎉' : `С нами ${days} ${pluralDays(days)}`;
      daysEl.style.display = '';
    } else {
      daysEl.style.display = 'none';
    }
  }
  const linkBtn = $('#accountMenuCopyLink');
  if (linkBtn){
    if (user.username){
      $('#accountMenuUsername').textContent = user.username;
      linkBtn.style.display = '';
      linkBtn.dataset.username = user.username;
    } else {
      linkBtn.style.display = 'none';
    }
  }
}
function pluralDays(n){
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return 'день';
  if ([2,3,4].includes(n10) && ![12,13,14].includes(n100)) return 'дня';
  return 'дней';
}
$('#accountMenuCopyLink')?.addEventListener('click', e => {
  e.stopPropagation();
  const username = e.currentTarget.dataset.username;
  if (!username) return;
  // Публичной страницы профиля в приложении пока нет, зато поиск по
  // юзернейму (шапка → лупа) уже отлично работает — делимся хендлом,
  // чтобы по нему нашли и написали, а не мёртвой ссылкой.
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText('@' + username)
      .then(() => showToast('Юзернейм скопирован — по нему вас найдут через поиск в MySavdo', 'ok'))
      .catch(() => showToast('Не удалось скопировать', 'error'));
  } else {
    showToast('Копирование недоступно в этом браузере', 'error');
  }
});

function applyUserAvatarEverywhere(user){
  const initial = escapeHtml(((user.shop_name || user.email || '?')[0] || '?').toUpperCase());
  const html = user.avatar
    ? `<img src="${escapeHtml(user.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
    : initial;
  const dash = $('#dashAvatar'), menu = $('#accountMenuAvatar');
  if (dash) dash.innerHTML = html;
  if (menu) menu.innerHTML = html;
  const name = $('#accountMenuName'), email = $('#accountMenuEmail');
  if (name) name.textContent = user.shop_name || 'Продавец';
  if (email) email.textContent = displayEmail(user.email);
  updateAccountMenuMeta(user);
}

async function openProfileModal(){
  $('#accountMenu').classList.remove('open');
  const modal = $('#profileModal');
  modal.classList.add('active');
  $('#profileError').classList.remove('show');
  profilePendingAvatar = null;

  const user = Auth.current() || {};
  $('#profileShopName').value = user.shop_name || '';
  $('#profileUsername').value = user.username || '';
  $('#profilePhone').value = user.phone || '';
  $('#profileSalesGoal').value = user.sales_goal || '';
  $('#profileEmail').value = user.is_guest ? '' : (user.email || '');
  $('#profileCurrentPass').value = '';
  $('#profileNewPass').value = '';
  const initial = escapeHtml(((user.shop_name || user.email || '?')[0] || '?').toUpperCase());
  $('#profileAvatarPreview').innerHTML = user.avatar
    ? `<img src="${escapeHtml(user.avatar)}" alt="">`
    : `<span>${initial}</span>`;

  const head = $('#profileModal .modal-head');
  if (head){
    head.querySelector('h3').textContent = user.is_guest ? 'Завершите регистрацию' : 'Профиль и настройки';
    head.querySelector('p').textContent = user.is_guest
      ? 'Укажите почту и пароль, чтобы открыть создание магазина, соцсети и тарифы'
      : 'Фото, название магазина, почта и пароль';
  }
  $('#profileEmail').placeholder = user.is_guest ? 'Укажите вашу почту' : 'pochta@primer.ru';
  $('#profileNewPass').placeholder = user.is_guest ? 'Придумайте пароль, минимум 6 символов' : 'Оставьте пустым, если не меняете';

  try{
    const r = await apiFetch('backend/api/profile.php', { credentials:'include' });
    if (r.ok){
      const data = await r.json();
      if (data.user){
        $('#profileShopName').value = data.user.shop_name || '';
        $('#profileUsername').value = data.user.username || '';
        $('#profilePhone').value = data.user.phone || '';
        $('#profileSalesGoal').value = data.user.sales_goal || '';
        if (!data.user.is_guest) $('#profileEmail').value = data.user.email || '';
        $('#profileCurrentPassField').style.display = data.user.has_password ? 'block' : 'none';
        $('#profilePassHint').textContent = data.user.has_password
          ? 'Для смены почты или пароля укажите текущий пароль'
          : 'Можно задать первый пароль без текущего';
      }
    }
  } catch(e){  }
}

$('#btnOpenProfile')?.addEventListener('click', openProfileModal);
$('#profileClose')?.addEventListener('click', () => $('#profileModal').classList.remove('active'));
$('#profileModal')?.addEventListener('click', e => { if (e.target.id === 'profileModal') $('#profileModal').classList.remove('active'); });

$('#profileAvatarBtn')?.addEventListener('click', () => $('#profileAvatarInput').click());
$('#profileAvatarInput')?.addEventListener('change', async () => {
  const file = $('#profileAvatarInput').files[0];
  $('#profileAvatarInput').value = '';
  if (!file) return;
  const preview = $('#profileAvatarPreview');
  preview.classList.add('busy');
  try{
    const fd = new FormData();
    fd.append('photo', file);
    const r = await apiFetch('backend/api/upload.php', { method:'POST', credentials:'include', body: fd });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.url) throw new Error(data.error || 'Не удалось загрузить фото');
    profilePendingAvatar = data.url;
    preview.innerHTML = `<img src="${escapeHtml(data.url)}" alt="">`;
    showToast('Фото загружено — нажмите «Сохранить», чтобы применить', 'info');
  } catch(e){
    showToast(e.message || 'Не удалось загрузить фото', 'error');
  } finally {
    preview.classList.remove('busy');
  }
});

$('#profileForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const errBox = $('#profileError');
  errBox.classList.remove('show');
  const btn = $('#profileSubmit');
  btn.disabled = true;
  btn.textContent = 'Сохраняем…';

  const payload = {
    shop_name: $('#profileShopName').value.trim(),
    username: $('#profileUsername').value.trim(),
    phone: $('#profilePhone').value.trim(),
    sales_goal: $('#profileSalesGoal').value.trim(),
  };
  const emailVal = $('#profileEmail').value.trim();
  if (emailVal) payload.email = emailVal;
  const newPass = $('#profileNewPass').value;
  const curPass = $('#profileCurrentPass').value;
  if (newPass) payload.new_password = newPass;
  if (curPass) payload.current_password = curPass;
  if (profilePendingAvatar) payload.avatar_url = profilePendingAvatar;

  try{
    const r = await apiFetch('backend/api/profile.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Не удалось сохранить настройки');

    const u = data.user;
    const wasGuest = !!(Auth.current() || {}).is_guest;
    const cur = Object.assign({}, Auth.current(), {
      shop_name: u.shop_name, email: u.email, avatar: u.avatar,
      username: u.username, phone: u.phone, is_guest: u.is_guest,
      sales_goal: u.sales_goal,
    });
    Auth.setUser(cur);
    applyUserAvatarEverywhere(cur);
    const greet = $('#dashGreeting');
    if (greet) greet.textContent = `С возвращением, ${cur.shop_name || 'продавец'}!`;
    if (wasGuest && !u.is_guest){
      refreshShopMenuUI();
      showToast('Регистрация завершена — теперь доступны все функции', 'ok');
    }

    $('#profileModal').classList.remove('active');
    showToast('Настройки профиля сохранены', 'ok');
  } catch(err){
    errBox.textContent = err.message || 'Не удалось сохранить настройки';
    errBox.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Сохранить';
  }
});

$$('.price-card .btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (Auth.current()){ openDashboard(); switchDashView('plan'); }
    else openAuth('register');
  });
});

let supportOpen = false;
let supportLastId = 0;
let supportPollTimer = null;
let supportAvailable = null;
let supportPollInFlight = false;

async function deleteSupportMessage(m){
  if (!confirm('Удалить это сообщение?')) return;
  try{
    const r = await apiFetch('backend/api/support.php', {
      method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'delete', id: m.id }),
    });
    if (!r.ok){ const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Не удалось удалить'); }
    $(`#supportBody .sup-bubble[data-msg-id="${m.id}"]`)?.closest('.sup-bubble-row')?.remove();
  } catch(e){ showToast(e.message || 'Не удалось удалить сообщение', 'error'); }
}

const supportReplyBar = MsgActions.createReplyBar($('#supportForm'));
const supportSelection = MsgActions.createSelection({
  mountBeforeEl: $('#supportBody'),
  onCopy: ids => {
    MsgActions.copyTexts(ids.map(id => $(`#supportBody .sup-bubble[data-msg-id="${id}"]`)?.dataset.msgText || ''));
  },
  onDelete: async ids => {
    await Promise.all(ids.map(id =>
      apiFetch('backend/api/support.php', {
        method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'delete', id: Number(id) }),
      }).catch(() => {})
    ));
    ids.forEach(id => $(`#supportBody .sup-bubble[data-msg-id="${id}"]`)?.closest('.sup-bubble-row')?.remove());
  },
});

// Цитата истории над сообщением — личный ответ на историю (см. #storyReplyForm)
// приходит как обычное сообщение в поддержку, просто с привязкой story_id.
function renderStoryQuoteChip(bubbleEl, story){
  if (!story) return;
  const chip = document.createElement('div');
  chip.className = 'msg-story-quote';
  chip.innerHTML = `<svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-video"/></svg><span>${escapeHtml(story.caption || 'Видео-история')}</span>`;
  chip.addEventListener('click', e => {
    e.stopPropagation();
    const idx = storyList.findIndex(s => s.id === story.id);
    if (idx >= 0) openStoryViewer(idx);
    else showToast('Эта история уже недоступна', 'info');
  });
  bubbleEl.insertBefore(chip, bubbleEl.firstChild);
}

function buildSupportBubble(m){
  const mine = m.direction === 'user';
  const row = document.createElement('div');
  row.className = 'sup-bubble-row' + (mine ? ' own' : '');
  if (!mine){
    const ava = document.createElement('div');
    ava.className = 'sup-admin-ava';
    ava.innerHTML = '<svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-message"/></svg>';
    row.appendChild(ava);
  }
  const bubble = document.createElement('div');
  bubble.className = 'sup-bubble' + (mine ? ' own' : '');
  bubble.dataset.msgId = String(m.id);
  bubble.dataset.msgText = m.text || '';

  const doReact = emoji => reactToMessage('support', m, emoji, data => MsgActions.renderReactions(bubble, data, doReact));

  renderStoryQuoteChip(bubble, m.story || null);
  MsgActions.renderReplyPreview(bubble, m.reply_to_snippet || null);
  bubble.appendChild(document.createTextNode(m.text || ''));
  const time = document.createElement('span');
  time.className = 'sup-bubble-time';
  time.textContent = fmtTime(parseServerTime(m.created_at));
  bubble.appendChild(time);
  MsgActions.renderReactions(bubble, m.reactions, doReact);

  MsgActions.attachTrigger(bubble, () => {
    if (supportSelection.isActive()){ supportSelection.toggle(m.id, bubble); return; }
    const actions = [
      { icon:'copy', label:'Копировать', onClick: () => MsgActions.copyTexts([m.text || '']) },
      { icon:'reply', label:'Ответить', onClick: () => supportReplyBar.set(m.id, (m.text || '').slice(0, 120)) },
      { type:'reactions', onPick: doReact },
      { icon:'checkbox', label:'Выбрать', onClick: () => { supportSelection.start(); supportSelection.toggle(m.id, bubble); } },
    ];
    if (mine) actions.push({ icon:'trash', label:'Удалить', danger:true, onClick: () => deleteSupportMessage(m) });
    MsgActions.showPopover(bubble, actions);
  });
  bubble.addEventListener('click', () => { if (supportSelection.isActive()) supportSelection.toggle(m.id, bubble); });

  row.appendChild(bubble);
  return row;
}

function renderSupportMessages(msgs, append = false){
  const body = $('#supportBody');
  if (!body) return;
  if (!append){
    const welcome = $('#supportWelcome');
    body.innerHTML = '';
    if (welcome) body.appendChild(welcome);
  }
  (msgs || []).forEach(m => body.appendChild(buildSupportBubble(m)));
  if (msgs && msgs.length){
    supportLastId = Math.max(supportLastId, ...msgs.map(m => m.id));
    const w = $('#supportWelcome');
    if (w) w.classList.add('compact');
  }
  body.scrollTop = body.scrollHeight;
}

function setSupportUnread(n){
  const badge = $('#supportFabBadge');
  if (!badge) return;
  badge.style.display = n > 0 ? 'flex' : 'none';
  badge.textContent = n > 9 ? '9+' : n;
  const fab = $('#supportFab');
  if (fab) fab.classList.toggle('has-unread', n > 0);
}

async function supportFetch(sinceId = 0){
  const url = 'backend/api/support.php' + (sinceId ? `?since_id=${sinceId}` : '');
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error('нет сервера');
  return r.json();
}

async function initSupportWidget(){
  const fab = $('#supportFab');
  if (!fab || !Auth.current()) { if (fab) fab.style.display = 'none'; return; }
  try{
    const data = await supportFetch();
    supportAvailable = true;
    fab.style.display = 'flex';
    renderSupportMessages(data.messages);
    setSupportUnread(supportOpen ? 0 : data.unread);
    startSupportPolling();
  } catch(_){

    supportAvailable = false;
    fab.style.display = 'none';
  }
}

function startSupportPolling(){
  clearInterval(supportPollTimer);
  supportPollTimer = setInterval(async () => {
    if (!Auth.current() || supportAvailable === false){ clearInterval(supportPollTimer); return; }
    if (document.hidden || supportPollInFlight) return;
    supportPollInFlight = true;
    try{
      const data = await supportFetch(supportLastId);
      supportPollInFlight = false;
      if (data.messages && data.messages.length){
        renderSupportMessages(data.messages, true);
        if (!supportOpen){
          setSupportUnread(data.unread);
          const hasAdmin = data.messages.some(m => m.direction === 'admin');
          if (hasAdmin){ showToast('Новый ответ от поддержки 💬', 'ok'); playNotifSound(); }
        } else {
          markSupportRead();
        }
      } else if (!supportOpen){
        setSupportUnread(data.unread || 0);
      }
    } catch(_){ supportPollInFlight = false; }
  }, 10000);
}

async function markSupportRead(){
  setSupportUnread(0);
  try{
    await apiFetch('backend/api/support.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'read' }),
    });
  } catch(_){}
}

function toggleSupportPanel(open){
  supportOpen = open;
  const panel = $('#supportPanel');
  const fab = $('#supportFab');
  if (!panel) return;
  panel.classList.toggle('open', open);
  panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (fab) fab.classList.toggle('hidden', open);
  if (open){
    markSupportRead();
    const body = $('#supportBody');
    if (body) body.scrollTop = body.scrollHeight;
    const input = $('#supportInput');
    if (input && !input.value) input.value = Draft.load('support');
    setTimeout(() => $('#supportInput')?.focus(), 250);
  }
}

Draft.bind($('#supportInput'), 'support', () => null);
$('#supportFab')?.addEventListener('click', () => toggleSupportPanel(true));
$('#supportClose')?.addEventListener('click', () => toggleSupportPanel(false));

$('#supportForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#supportInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  Draft.clear('support');
  const replyTarget = supportReplyBar.get();
  supportReplyBar.clear();

  const pendingMsg = { id: 'pending_' + Date.now(), direction:'user', text, created_at: null, via:'web', reply_to_snippet: replyTarget ? replyTarget.snippet : null };
  renderSupportMessages([pendingMsg], true);
  const body = $('#supportBody');
  const lastRow = body ? body.lastElementChild : null;
  if (lastRow) lastRow.classList.add('sending');
  try{
    const r = await apiFetch('backend/api/support.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'send', text, reply_to_id: replyTarget ? replyTarget.id : undefined }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Не удалось отправить');
    if (lastRow){
      lastRow.classList.remove('sending');
      const bEl = lastRow.querySelector('.sup-bubble');
      if (bEl && data.message){ bEl.dataset.msgId = String(data.message.id); pendingMsg.id = data.message.id; }
      const t = lastRow.querySelector('.sup-bubble-time');
      if (t && data.message) t.textContent = fmtTime(parseServerTime(data.message.created_at));
    }
    if (data.message) supportLastId = Math.max(supportLastId, data.message.id);
  } catch(err){
    if (lastRow) lastRow.remove();
    input.value = text;
    showToast(err.message, 'info');
  }
});

/* ============================================================
   Истории — видео от админа на главном экране (как в Telegram/
   Instagram). Тап на эмодзи под видео — мини-коммент (реакция),
   он остаётся при истории и никуда, кроме счётчика у админа, не
   уходит. Текст в поле «Ответить…» — личный ответ, обычное
   сообщение в чат поддержки с цитатой истории (см. support.php).
   ============================================================ */

let storyList = [];
let storyIndex = 0;
let storyRafId = null;
let storyElapsed = 0;
let storyDuration = 15000;
let storyLastTick = 0;
let storyPaused = false;
let storyHoldTimer = null;

function seenStoryIds(){
  try{ return new Set(JSON.parse(localStorage.getItem('mysavdo_seen_stories') || '[]')); }
  catch(_){ return new Set(); }
}
function markStorySeen(id){
  const seen = seenStoryIds();
  seen.add(id);
  localStorage.setItem('mysavdo_seen_stories', JSON.stringify([...seen].slice(-200)));
}
function storyTimeLabel(createdAt){
  const min = Math.round((Date.now() - parseServerTime(createdAt)) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

async function loadStories(){
  const rail = $('#storyRail');
  if (!rail) return;
  // Не проверяем isRealMode: он выставляется асинхронно чуть позже, внутри
  // того же openDashboard() (см. tryLoadRealClients) — на момент этого вызова
  // ещё false. Как и виджет поддержки, просто пробуем запрос и тихо прячем
  // блок, если бэкенда нет.
  if (!Auth.current()){ rail.style.display = 'none'; return; }
  try{
    const r = await fetch('backend/api/stories.php', { credentials:'include' });
    if (!r.ok) throw new Error();
    const data = await r.json();
    storyList = data.stories || [];
    renderStoryRail();
  } catch(_){
    rail.style.display = 'none';
  }
}

function renderStoryRail(){
  const rail = $('#storyRail');
  if (!rail) return;
  if (!storyList.length){ rail.style.display = 'none'; rail.innerHTML = ''; return; }
  rail.style.display = 'flex';
  const seen = seenStoryIds();
  rail.innerHTML = storyList.map((s, i) => `
    <button class="story-circle ${seen.has(s.id) ? 'seen' : ''}" type="button" data-i="${i}">
      <span class="story-circle-ring"><span class="story-circle-inner"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-play"/></svg></span></span>
      <span class="story-circle-label">${escapeHtml((s.caption || 'Новости').slice(0, 14))}</span>
    </button>`).join('');
  $$('.story-circle', rail).forEach(btn => {
    btn.addEventListener('click', () => openStoryViewer(Number(btn.dataset.i)));
  });
}

function openStoryViewer(index){
  if (!storyList.length) return;
  const viewer = $('#storyViewer');
  if (!viewer) return;
  viewer.classList.add('open');
  viewer.setAttribute('aria-hidden', 'false');
  const wrap = $('#storyProgress');
  if (wrap){
    wrap.innerHTML = storyList.map(() => `<span class="story-progress-seg"><i></i></span>`).join('');
  }
  showStory(Math.max(0, Math.min(storyList.length - 1, index)));
}

function closeStoryViewer(){
  const viewer = $('#storyViewer');
  if (viewer){ viewer.classList.remove('open'); viewer.setAttribute('aria-hidden', 'true'); }
  const video = $('#storyVideo');
  if (video){ video.pause(); video.removeAttribute('src'); video.load(); }
  cancelAnimationFrame(storyRafId);
  renderStoryRail();
}

function showStory(i){
  const s = storyList[i];
  if (!s){ closeStoryViewer(); return; }
  storyIndex = i;
  markStorySeen(s.id);

  $$('#storyProgress .story-progress-seg').forEach((seg, idx) => {
    const bar = seg.querySelector('i');
    if (bar) bar.style.width = idx < i ? '100%' : '0%';
  });

  const timeEl = $('#storyViewerTime');
  if (timeEl) timeEl.textContent = storyTimeLabel(s.created_at);
  const capEl = $('#storyCaption');
  if (capEl){ capEl.textContent = s.caption || ''; capEl.style.display = s.caption ? '' : 'none'; }

  const video = $('#storyVideo');
  if (video){
    video.pause();
    video.src = s.video_url;
    video.currentTime = 0;
    video.muted = true;
    video.play().catch(() => {});
    video.onloadedmetadata = () => {
      if (isFinite(video.duration) && video.duration > 0) storyDuration = video.duration * 1000;
    };
    video.onended = () => nextStory();
  }
  $('#storyMuteBtn').textContent = '🔇';

  storyElapsed = 0;
  storyDuration = 15000;
  storyLastTick = 0;
  storyPaused = false;

  renderStoryReactions(s);
  const replyInput = $('#storyReplyInput');
  if (replyInput) replyInput.value = '';

  cancelAnimationFrame(storyRafId);
  storyRafId = requestAnimationFrame(tickStoryProgress);
}

function tickStoryProgress(ts){
  if (!storyLastTick) storyLastTick = ts;
  if (!storyPaused){
    storyElapsed += ts - storyLastTick;
    const pct = Math.min(100, (storyElapsed / storyDuration) * 100);
    const bar = $(`#storyProgress .story-progress-seg:nth-child(${storyIndex + 1}) i`);
    if (bar) bar.style.width = pct + '%';
    if (pct >= 100){ nextStory(); return; }
  }
  storyLastTick = ts;
  storyRafId = requestAnimationFrame(tickStoryProgress);
}

function nextStory(){
  if (storyIndex >= storyList.length - 1){ closeStoryViewer(); return; }
  showStory(storyIndex + 1);
}
function prevStory(){
  showStory(Math.max(0, storyIndex - 1));
}

function setStoryPaused(p){
  storyPaused = p;
  const video = $('#storyVideo');
  if (!video) return;
  if (p) video.pause(); else video.play().catch(() => {});
}

// Мини-коммент — постоянный ряд эмодзи под видео (не попап), тап переключает
// свою реакцию через тот же reactToMessage(), что и в остальных чатах.
function renderStoryReactions(s){
  const wrap = $('#storyReactions');
  if (!wrap) return;
  const counts = (s.reactions && s.reactions.counts) || {};
  const mine = s.reactions ? s.reactions.mine : null;
  const total = Object.values(counts).reduce((a, b) => a + Number(b || 0), 0);
  wrap.innerHTML = `
    <div class="story-reactions-row">
      ${MsgActions.REACTIONS.map(em => `<button type="button" class="story-emoji-btn${mine === em ? ' mine' : ''}" data-em="${em}">${em}${counts[em] ? `<b>${counts[em]}</b>` : ''}</button>`).join('')}
    </div>
    ${total ? `<span class="story-reactions-total">❤ ${total}</span>` : ''}`;
  $$('.story-emoji-btn', wrap).forEach(btn => {
    btn.addEventListener('click', () => {
      reactToMessage('story', s, btn.dataset.em, data => { s.reactions = data; renderStoryReactions(s); });
    });
  });
}

$('#storyViewerClose')?.addEventListener('click', closeStoryViewer);
$('#storyViewer')?.addEventListener('click', e => { if (e.target.id === 'storyViewer') closeStoryViewer(); });
$('#storyTapPrev')?.addEventListener('click', e => { e.stopPropagation(); prevStory(); });
$('#storyTapNext')?.addEventListener('click', e => { e.stopPropagation(); nextStory(); });
$('#storyMuteBtn')?.addEventListener('click', () => {
  const video = $('#storyVideo');
  if (!video) return;
  video.muted = !video.muted;
  $('#storyMuteBtn').textContent = video.muted ? '🔇' : '🔊';
});
document.addEventListener('keydown', e => {
  if (!$('#storyViewer')?.classList.contains('open')) return;
  if (e.key === 'Escape') closeStoryViewer();
  else if (e.key === 'ArrowLeft') prevStory();
  else if (e.key === 'ArrowRight') nextStory();
});
(() => {
  const media = $('#storyViewerMedia');
  if (!media) return;
  const start = () => { storyHoldTimer = setTimeout(() => setStoryPaused(true), 180); };
  const end = () => { clearTimeout(storyHoldTimer); setStoryPaused(false); };
  media.addEventListener('pointerdown', start);
  media.addEventListener('pointerup', end);
  media.addEventListener('pointerleave', end);
  media.addEventListener('pointercancel', end);
})();
$('#storyReplyInput')?.addEventListener('focus', () => setStoryPaused(true));
$('#storyReplyInput')?.addEventListener('blur', () => setStoryPaused(false));

$('#storyReplyForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#storyReplyInput');
  const text = input.value.trim();
  const s = storyList[storyIndex];
  if (!text || !s) return;
  input.value = '';
  try{
    const r = await apiFetch('backend/api/support.php', {
      method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'send', text, story_id: s.id }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Не удалось отправить');
    showToast('Ответ отправлен администратору 💬', 'ok');
    if (data.message){
      supportLastId = Math.max(supportLastId, data.message.id);
      if (supportOpen) renderSupportMessages([data.message], true);
    }
  } catch(err){
    input.value = text;
    showToast(err.message || 'Не удалось отправить ответ', 'error');
  }
});

/* ============================================================
   AI-гид «Лайм»: ходит по сайту, подсказывает по наведению,
   реагирует на бездействие и выполняет голосовые/текстовые команды
   ============================================================ */

function isLandingActive(){
  const el = document.getElementById('screen-landing');
  return !!el && el.classList.contains('active');
}

const aiGuideEl = $('#aiGuide');
const aiGuideBubbleEl = $('#aiGuideBubble');
const aiGuidePanelEl = $('#aiGuidePanel');
const aiGuideChatEl = $('#aiGuideChat');

let aiChatOpen = false;
let aiChatSeeded = false;
let bubbleHideTimer = null;

function showAiBubble(text, duration = 6000){
  if (!aiGuideBubbleEl || aiChatOpen) return;
  aiGuideBubbleEl.textContent = text;
  aiGuideBubbleEl.classList.add('show');
  clearTimeout(bubbleHideTimer);
  bubbleHideTimer = setTimeout(() => aiGuideBubbleEl.classList.remove('show'), duration);
}
function hideAiBubbleSoon(delay = 250){
  clearTimeout(bubbleHideTimer);
  bubbleHideTimer = setTimeout(() => aiGuideBubbleEl && aiGuideBubbleEl.classList.remove('show'), delay);
}

/* --- лёгкое «блуждание» аватарки вдоль нижнего края --- */
let aiWanderTimer = null;
function scheduleAiWander(){
  clearTimeout(aiWanderTimer);
  aiWanderTimer = setTimeout(() => {
    if (isLandingActive() && aiGuideEl && !aiChatOpen && !(aiGuideBubbleEl && aiGuideBubbleEl.classList.contains('show'))){
      const shift = Math.round(Math.random() * 130);
      aiGuideEl.style.setProperty('--ai-shift', shift + 'px');
    }
    scheduleAiWander();
  }, 7000 + Math.random() * 6000);
}
scheduleAiWander();

/* --- контекстные факты по наведению --- */
const AI_HINTS = [
  { sel:'#btnHeroStart, #btnCtaStart, #btnOpenAuth, #btnOpenAuthMobile', text:'Регистрация занимает меньше минуты — банковская карта не нужна.' },
  { sel:'a[href="#pricing"]', text:'Тариф «Демо» бесплатен и не ограничен по времени — только по лимитам.' },
  { sel:'.price-card.popular', text:'Это самый популярный тариф: безлимит заявок и до 3 сотрудников.' },
  { sel:'.price-card:not(.popular)', text:'С этого тарифа можно начать и перейти на другой в любой момент.' },
  { sel:'#gsiButtonContainer', text:'Google-вход — самый быстрый способ начать, обычно 5 секунд.' },
  { sel:'#btnFacebookLogin', text:'Вход через Facebook подтянет ваше имя и фото автоматически.' },
  { sel:'#btnOpenReview', text:'Ваш отзыв увидят другие продавцы — это помогает им выбрать сервис.' },
  { sel:'.review-card', text:'Это реальная оценка от продавца, который уже пользуется MySavdo.' },
  { sel:'.faq-q', text:'Нажмите, чтобы развернуть ответ на этот вопрос.' },
  { sel:'.step-card', text:'Все 4 шага обычно занимают около 10 минут в сумме.' },
  { sel:'.pain-card', text:'Именно с этой проблемы чаще всего начинают те, кто переходит на MySavdo.' },
  { sel:'#siteRatingBadge', text:'Это средняя оценка сайта по отзывам всех продавцов.' },
  { sel:'#btnMagnifier', text:'Включите лупу, если текст мелковат — наведите на него, и я увеличу.' },
  { sel:'.logo-mark', text:'MySavdo — CRM для продавцов, которые принимают заявки в соцсетях.' },
];

let aiHintTimer = null;
let aiHintCurrentEl = null;
document.addEventListener('mouseover', (e) => {
  if (!isLandingActive() || aiChatOpen) return;
  if (e.target.closest && e.target.closest('.floating-tools')) return;
  for (const rule of AI_HINTS){
    const target = e.target.closest(rule.sel);
    if (target){
      if (target === aiHintCurrentEl) return;
      aiHintCurrentEl = target;
      clearTimeout(aiHintTimer);
      aiHintTimer = setTimeout(() => showAiBubble(rule.text), 550);
      return;
    }
  }
});
document.addEventListener('mouseout', (e) => {
  if (aiHintCurrentEl && e.target === aiHintCurrentEl){
    clearTimeout(aiHintTimer);
    aiHintCurrentEl = null;
    hideAiBubbleSoon();
  }
});

/* --- бездействие: «застряли»? --- */
let aiLastActivityAt = Date.now();
let aiIdleNudgeCount = 0;
let aiLastIdleNudgeAt = 0;
['mousemove','scroll','keydown','click','touchstart'].forEach(ev => {
  window.addEventListener(ev, () => { aiLastActivityAt = Date.now(); }, { passive:true });
});

const AI_SECTION_HINTS = {
  heroSection: ['Не уверены, для вас ли это? Пролистайте вниз — там 4 простых шага подключения.', 'MySavdo решает одну проблему: заявки из соцсетей, которые теряются в чатах.'],
  features: ['Каждая карточка ниже уже работает прямо сейчас, без доплат за интеграции.'],
  steps: ['Подключение соцсетей — пара кликов. Нажмите на меня, если хотите подробнее.'],
  pricing: ['Затрудняетесь с выбором тарифа? «Демо» бесплатен — можно попробовать без риска.'],
  reviews: ['Можете почитать, что говорят другие продавцы, или сами оставить отзыв.'],
  faq: ['Не нашли ответ здесь? Ссылка на поддержку есть внизу страницы.'],
};
const AI_SECTION_ORDER = ['heroSection','features','steps','pricing','reviews','faq'];

function aiCurrentSectionId(){
  const centerY = window.innerHeight * 0.4;
  for (const id of AI_SECTION_ORDER){
    const el = document.getElementById(id);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.top <= centerY && r.bottom >= centerY) return id;
  }
  return null;
}

setInterval(() => {
  if (!isLandingActive() || aiChatOpen || document.hidden) return;
  const idleFor = Date.now() - aiLastActivityAt;
  const sinceLastNudge = Date.now() - aiLastIdleNudgeAt;
  if (idleFor > 16000 && sinceLastNudge > 45000 && aiIdleNudgeCount < 4){
    const sectionId = aiCurrentSectionId() || 'heroSection';
    const pool = AI_SECTION_HINTS[sectionId] || AI_SECTION_HINTS.heroSection;
    showAiBubble(pool[Math.floor(Math.random() * pool.length)], 7000);
    aiLastIdleNudgeAt = Date.now();
    aiIdleNudgeCount++;
  }
}, 4000);

/* --- чат-панель: команды переключения по сайту --- */
function aiChatPush(who, text){
  if (!aiGuideChatEl) return;
  const div = document.createElement('div');
  div.className = 'ai-guide-msg ' + (who === 'user' ? 'user' : 'lime');
  div.textContent = text;
  aiGuideChatEl.appendChild(div);
  aiGuideChatEl.scrollTop = aiGuideChatEl.scrollHeight;
}

function aiScrollToSection(id){
  showScreen('screen-landing');
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior:'smooth', block:'start' });
  });
}

const AI_COMMANDS = [
  { kws:['тариф','цена','стоимост','сколько сто'], run: () => { aiScrollToSection('pricing'); return 'Показываю тарифы 👇'; } },
  { kws:['отзыв','рейтинг'], run: () => { aiScrollToSection('reviews'); return 'Вот отзывы других продавцов 👇'; } },
  { kws:['вопрос','faq','не понял','не понятно'], run: () => { aiScrollToSection('faq'); return 'Собрал частые вопросы здесь 👇'; } },
  { kws:['возможност','функ','что умеет'], run: () => { aiScrollToSection('features'); return 'Вот что умеет MySavdo 👇'; } },
  { kws:['как работает','шаг','подключ'], run: () => { aiScrollToSection('steps'); return 'Вот как всё устроено по шагам 👇'; } },
  { kws:['кабинет','дашборд','войти','вход','аккаунт','регистрац'], run: () => {
      const u = Auth.current();
      if (u){ openDashboard(); return 'Открываю ваш личный кабинет 👇'; }
      openAuth('register'); return 'Открываю окно входа и регистрации 👇';
    } },
  { kws:['наверх','вверх','к началу'], run: () => { showScreen('screen-landing'); window.scrollTo({ top:0, behavior:'smooth' }); return 'Поднимаю в начало страницы ⬆️'; } },
  { kws:['лупа','увелич','плохо вижу','крупн'], run: () => { setMagnifierActive(true); return 'Включил лупу — наведите курсор на текст или кнопку, чтобы увеличить 🔍'; } },
  { kws:['привет','здрав'], run: () => 'Привет! Чем помочь — тарифы, отзывы, вопросы или личный кабинет?' },
  { kws:['спасибо','благодар'], run: () => 'Пожалуйста! Если что — я тут 🙂' },
];

function handleAiCommand(raw){
  const text = raw.toLowerCase();
  for (const cmd of AI_COMMANDS){
    if (cmd.kws.some(k => text.includes(k))) return cmd.run();
  }
  return 'Пока не понял 🙈 Попробуйте: «покажи тарифы», «открой отзывы», «где вопросы» или «личный кабинет».';
}

function toggleAiPanel(force){
  const next = typeof force === 'boolean' ? force : !aiChatOpen;
  if (next === aiChatOpen) return;
  aiChatOpen = next;
  if (aiGuidePanelEl) aiGuidePanelEl.classList.toggle('open', aiChatOpen);
  if (aiGuideBubbleEl) aiGuideBubbleEl.classList.remove('show');
  if (aiChatOpen){
    if (!aiChatSeeded){
      aiChatSeeded = true;
      aiChatPush('lime', 'Привет! Я Лайм 👋 Спросите меня, например: «покажи тарифы», «открой отзывы» или «личный кабинет».');
    }
    setTimeout(() => { const inp = $('#aiGuideInput'); if (inp) inp.focus(); }, 150);
  }
}

const aiGuideAvatarBtn = $('#aiGuideAvatarBtn');
if (aiGuideAvatarBtn) aiGuideAvatarBtn.addEventListener('click', () => toggleAiPanel());
const aiGuideCloseBtn = $('#aiGuideClose');
if (aiGuideCloseBtn) aiGuideCloseBtn.addEventListener('click', () => toggleAiPanel(false));

const aiGuideFormEl = $('#aiGuideForm');
if (aiGuideFormEl) aiGuideFormEl.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#aiGuideInput');
  const text = input.value.trim();
  if (!text) return;
  aiChatPush('user', text);
  input.value = '';
  const reply = handleAiCommand(text);
  setTimeout(() => aiChatPush('lime', reply), 300);
});

/* --- голосовые команды --- */
const AiSpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const aiGuideMicBtn = $('#aiGuideMic');
if (aiGuideMicBtn){
  if (!AiSpeechRec){
    aiGuideMicBtn.style.display = 'none';
  } else {
    let aiRecognizer = null;
    let aiListening = false;
    aiGuideMicBtn.addEventListener('click', () => {
      if (aiListening){ aiRecognizer && aiRecognizer.stop(); return; }
      aiRecognizer = new AiSpeechRec();
      aiRecognizer.lang = 'ru-RU';
      aiRecognizer.interimResults = false;
      aiRecognizer.maxAlternatives = 1;
      aiRecognizer.onstart = () => { aiListening = true; aiGuideMicBtn.classList.add('listening'); };
      aiRecognizer.onend = () => { aiListening = false; aiGuideMicBtn.classList.remove('listening'); };
      aiRecognizer.onerror = () => { aiListening = false; aiGuideMicBtn.classList.remove('listening'); };
      aiRecognizer.onresult = (ev) => {
        const said = ev.results[0][0].transcript;
        aiChatPush('user', said);
        const reply = handleAiCommand(said);
        setTimeout(() => aiChatPush('lime', reply), 300);
      };
      try{ aiRecognizer.start(); } catch(e){}
    });
  }
}

/* ============================================================
   Лупа: наведение увеличивает текст/кнопку под курсором
   ============================================================ */

let magnifierActive = false;
let magTargetEl = null;
const magnifierRingEl = $('#magnifierRing');
const btnMagnifierEl = $('#btnMagnifier');

function clearMagTarget(){
  if (magTargetEl){
    magTargetEl.classList.remove('mag-target');
    magTargetEl = null;
  }
}

function setMagnifierActive(active){
  if (magnifierActive === active) return;
  magnifierActive = active;
  document.body.classList.toggle('magnifier-mode', active);
  if (btnMagnifierEl) btnMagnifierEl.classList.toggle('active', active);
  if (magnifierRingEl) magnifierRingEl.classList.toggle('show', active);
  if (!active) clearMagTarget();
}



const MAG_SELECTOR = 'p,h1,h2,h3,h4,h5,li,a,button,label,span,small,b,strong,td,th';

function findMagTarget(el){
  while (el && el !== document.body){
    if (el.nodeType === 1 && el.matches && el.matches(MAG_SELECTOR) && !el.closest('.floating-tools')) return el;
    el = el.parentElement;
  }
  return null;
}

document.addEventListener('mousemove', (e) => {
  if (magnifierRingEl && magnifierActive){
    magnifierRingEl.style.left = e.clientX + 'px';
    magnifierRingEl.style.top = e.clientY + 'px';
  }
  if (!magnifierActive) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const target = findMagTarget(el);
  if (target !== magTargetEl){
    clearMagTarget();
    if (target){
      target.classList.add('mag-target');
      magTargetEl = target;
    }
  }
  if (magTargetEl){
    const rect = magTargetEl.getBoundingClientRect();
    const ox = Math.min(90, Math.max(10, ((e.clientX - rect.left) / rect.width) * 100));
    const oy = Math.min(90, Math.max(10, ((e.clientY - rect.top) / rect.height) * 100));
    magTargetEl.style.setProperty('--mag-ox', ox + '%');
    magTargetEl.style.setProperty('--mag-oy', oy + '%');
  }
}, { passive:true });

if (btnMagnifierEl) btnMagnifierEl.addEventListener('click', () => setMagnifierActive(!magnifierActive));
window.addEventListener('blur', () => setMagnifierActive(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && magnifierActive) setMagnifierActive(false); });

document.body.classList.toggle('on-landing', isLandingActive());

/* ============================================================
   Магазины и сотрудники
   ============================================================ */

function refreshShopMenuUI(){
  const emp = Auth.currentEmployee();
  const user = Auth.current();
  const badge = $('#accountMenuEmployeeBadge');
  const btnCreate = $('#btnCreateShop');
  const btnEmployees = $('#btnOpenEmployees');
  const btnJoin = $('#btnJoinShop');
  const menuPlan = $('#menuPlanBtn');
  const btnTg = $('#btnOpenTelegramModal');
  const btnIg = $('#btnOpenInstagramModal');
  const btnProfile = $('#btnOpenProfile');

  if (!user) return;

  if (emp){
    if (badge){ badge.style.display = 'block'; badge.textContent = `Сотрудник: ${emp.display_name}`; }
    [btnCreate, btnEmployees, btnJoin, menuPlan, btnTg, btnIg, btnProfile].forEach(b => { if (b) b.style.display = 'none'; });
    return;
  }
  if (user.is_guest){
    if (badge){
      badge.style.display = 'block';
      badge.innerHTML = 'Гостевой доступ — поиск и сообщения доступны. <button type="button" id="btnGuestUpgrade" class="muted-link">Завершить регистрацию →</button>';
      $('#btnGuestUpgrade')?.addEventListener('click', () => { $('#accountMenu').classList.remove('open'); openProfileModal(); });
    }
    [btnCreate, btnEmployees, btnJoin, menuPlan, btnTg, btnIg].forEach(b => { if (b) b.style.display = 'none'; });
    if (btnProfile) btnProfile.style.display = '';
    return;
  }

  if (badge) badge.style.display = 'none';
  [menuPlan, btnTg, btnIg, btnProfile].forEach(b => { if (b) b.style.display = ''; });

  if (user.is_shop){
    if (btnCreate) btnCreate.style.display = 'none';
    if (btnEmployees) btnEmployees.style.display = '';
    if (btnJoin) btnJoin.style.display = 'none';
  } else {
    if (btnCreate) btnCreate.style.display = '';
    if (btnEmployees) btnEmployees.style.display = 'none';
    if (btnJoin) btnJoin.style.display = '';
  }
}

/* --- вход сотрудника по ID+паролю --- */
function openEmployeeLoginModal(){
  $('#employeeLoginError').classList.remove('show');
  $('#employeeLoginForm').reset();
  $('#employeeLoginModal').classList.add('active');
}
function closeEmployeeLoginModal(){ $('#employeeLoginModal').classList.remove('active'); }
$('#btnOpenEmployeeLogin')?.addEventListener('click', () => { closeAuth(); openEmployeeLoginModal(); });

$('#btnGuestLogin')?.addEventListener('click', async () => {
  const btn = $('#btnGuestLogin');
  btn.disabled = true;
  try{
    await Auth.guestLogin();
    afterAuthSuccess();
  } catch(e){
    $('#authError').textContent = e.message;
    $('#authError').classList.add('show');
  }
  btn.disabled = false;
});
$('#employeeLoginClose')?.addEventListener('click', closeEmployeeLoginModal);
$('#employeeLoginModal')?.addEventListener('click', e => { if (e.target.id === 'employeeLoginModal') closeEmployeeLoginModal(); });
$('#employeeLoginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = $('#employeeLoginError');
  errBox.classList.remove('show');
  const loginId = $('#employeeLoginId').value.trim();
  const pass = $('#employeeLoginPass').value;
  try{
    await Auth.loginWithEmployee(loginId, pass);
    closeEmployeeLoginModal();
    afterAuthSuccess();
  } catch(err){
    errBox.textContent = err.message;
    errBox.classList.add('show');
  }
});

/* --- создание магазина --- */
let shopUsernameCheckTimer = null;
function openCreateShopModal(){
  $('#createShopError').classList.remove('show');
  $('#createShopForm').reset();
  $('#createShopHint').textContent = '';
  $('#createShopModal').classList.add('active');
}
function closeCreateShopModal(){ $('#createShopModal').classList.remove('active'); }
$('#btnCreateShop')?.addEventListener('click', () => { $('#accountMenu').classList.remove('open'); openCreateShopModal(); });
$('#createShopClose')?.addEventListener('click', closeCreateShopModal);
$('#createShopModal')?.addEventListener('click', e => { if (e.target.id === 'createShopModal') closeCreateShopModal(); });

$('#createShopUsername')?.addEventListener('input', (e) => {
  const hint = $('#createShopHint');
  const val = e.target.value.trim().toLowerCase();
  clearTimeout(shopUsernameCheckTimer);
  if (!hint) return;
  if (!val){ hint.textContent = ''; return; }
  if (!/^[a-z0-9_]{3,24}$/.test(val)){
    hint.textContent = 'Только латиница, цифры и «_», 3–24 символа';
    hint.style.color = 'var(--danger)';
    return;
  }
  hint.textContent = 'Проверяем…';
  hint.style.color = '';
  shopUsernameCheckTimer = setTimeout(async () => {
    try{
      const r = await apiFetch('backend/api/shop.php?search=' + encodeURIComponent(val), { credentials:'include' });
      const data = await r.json();
      if (data.shop){
        hint.textContent = 'Этот юзернейм уже занят';
        hint.style.color = 'var(--danger)';
      } else {
        hint.textContent = 'Свободен ✓';
        hint.style.color = 'var(--success)';
      }
    } catch(err){}
  }, 400);
});

$('#createShopForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = $('#createShopError');
  errBox.classList.remove('show');
  const username = $('#createShopUsername').value.trim().toLowerCase();
  try{
    const r = await apiFetch('backend/api/shop.php', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'create', username })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Не удалось создать магазин');
    await Auth.syncSession();
    closeCreateShopModal();
    refreshShopMenuUI();
    showToast('Магазин создан!', 'success');
  } catch(err){
    errBox.textContent = err.message;
    errBox.classList.add('show');
  }
});

/* --- управление сотрудниками --- */
function showEmployeeCred(title, loginId, password){
  const box = $('#newEmployeeReveal');
  if (!box) return;
  box.style.display = 'block';
  box.innerHTML = `
    <b>${escapeHtml(title)}</b>
    ${loginId ? `<div class="cred-row"><span>ID</span><code>${escapeHtml(loginId)}</code></div>` : ''}
    <div class="cred-row"><span>Пароль</span><code>${escapeHtml(password)}</code></div>
    <p class="pay-hint">Сохраните эти данные — пароль больше не будет показан. Передайте их сотруднику.</p>
  `;
}

async function loadEmployeesState(){
  try{
    const r = await apiFetch('backend/api/shop.php', { credentials:'include' });
    const data = await r.json();
    if (!r.ok || !data.shop) return;
    const shop = data.shop;
    $('#employeesShopUsername').textContent = shop.shop_username || '';
    const pct = shop.slots_total ? Math.min(100, (shop.slots_used / shop.slots_total) * 100) : 0;
    $('#slotsFill').style.width = pct + '%';
    $('#slotsLabel').textContent = `${shop.slots_used} / ${shop.slots_total} мест занято`;

    const activeList = $('#employeesActiveList');
    activeList.innerHTML = (shop.employees || []).map(emp => `
      <div class="admin-user-row admin-user-row-compact">
        <div class="admin-user-info"><b>${escapeHtml(emp.display_name)}</b><span>ID: ${escapeHtml(emp.login_id)}</span></div>
        <button type="button" class="admin-user-icon-btn emp-reset-btn" data-id="${emp.id}" title="Сменить пароль"><svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-key"/></svg></button>
        <button type="button" class="admin-user-del emp-revoke-btn" data-id="${emp.id}" title="Уволить"><svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-trash"/></svg></button>
      </div>
    `).join('') || '<p class="table-empty">Пока нет сотрудников</p>';

    const pendingList = $('#employeesPendingList');
    pendingList.innerHTML = (shop.pending_applications || []).map(app => `
      <div class="admin-user-row">
        <div class="admin-user-info"><b>${escapeHtml(app.display_name)}</b><span>Заявка от ${fmtReviewDate(app.created_at)}</span></div>
        <button type="button" class="btn btn-primary btn-sm emp-approve-btn" data-id="${app.id}">Одобрить</button>
        <button type="button" class="admin-user-del emp-reject-btn" data-id="${app.id}" title="Отклонить"><svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-x"/></svg></button>
      </div>
    `).join('') || '<p class="table-empty">Нет заявок</p>';
  } catch(err){}
}

async function openEmployeesModal(){
  $('#employeesModal').classList.add('active');
  $('#newEmployeeReveal').style.display = 'none';
  $('#buySlotsPanel').style.display = 'none';
  await loadEmployeesState();
}
function closeEmployeesModal(){ $('#employeesModal').classList.remove('active'); }
$('#btnOpenEmployees')?.addEventListener('click', () => { $('#accountMenu').classList.remove('open'); openEmployeesModal(); });
$('#employeesClose')?.addEventListener('click', closeEmployeesModal);

$('#employeesModal')?.addEventListener('click', async (e) => {
  if (e.target.id === 'employeesModal'){ closeEmployeesModal(); return; }

  const resetBtn = e.target.closest('.emp-reset-btn');
  const revokeBtn = e.target.closest('.emp-revoke-btn');
  const approveBtn = e.target.closest('.emp-approve-btn');
  const rejectBtn = e.target.closest('.emp-reject-btn');

  if (resetBtn){
    try{
      const r = await apiFetch('backend/api/shop.php', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'reset_password', id: Number(resetBtn.dataset.id) }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Не удалось сбросить пароль');
      showEmployeeCred('Новый пароль сотрудника', null, data.password);
      showToast('Пароль обновлён', 'success');
    } catch(err){ showToast(err.message, 'error'); }
  }
  if (revokeBtn){
    try{
      const r = await apiFetch('backend/api/shop.php', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'revoke', id: Number(revokeBtn.dataset.id) }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Не удалось уволить сотрудника');
      showToast('Сотрудник уволен', 'info');
      loadEmployeesState();
    } catch(err){ showToast(err.message, 'error'); }
  }
  if (approveBtn){
    try{
      const r = await apiFetch('backend/api/shop.php', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'approve', id: Number(approveBtn.dataset.id) }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Не удалось одобрить заявку');
      showEmployeeCred('Заявка одобрена', data.login_id, data.password);
      showToast('Заявка одобрена', 'success');
      loadEmployeesState();
    } catch(err){ showToast(err.message, 'error'); }
  }
  if (rejectBtn){
    try{
      const r = await apiFetch('backend/api/shop.php', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'reject', id: Number(rejectBtn.dataset.id) }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Не удалось отклонить заявку');
      showToast('Заявка отклонена', 'info');
      loadEmployeesState();
    } catch(err){ showToast(err.message, 'error'); }
  }
});

$('#btnAddEmployee')?.addEventListener('click', async () => {
  const displayName = (prompt('Имя сотрудника (необязательно):') || '').trim();
  try{
    const r = await apiFetch('backend/api/shop.php', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'add_employee', display_name: displayName }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Не удалось добавить сотрудника');
    showEmployeeCred('Новый сотрудник добавлен', data.login_id, data.password);
    showToast('Сотрудник добавлен', 'success');
    loadEmployeesState();
  } catch(err){ showToast(err.message, 'error'); }
});

$('#btnBuySlots')?.addEventListener('click', async () => {
  const panel = $('#buySlotsPanel');
  const willShow = panel.style.display === 'none';
  panel.style.display = willShow ? 'block' : 'none';
  if (willShow){
    try{
      const r = await apiFetch('backend/api/plan.php', { credentials:'include' });
      const data = await r.json();
      const req = data.payment_requisites || {};
      const configured = !!req.card && req.card !== '0000 0000 0000 0000';
      $('#slotsStepsWrap').style.display = configured ? '' : 'none';
      $('#slotsNotConfigured').style.display = configured ? 'none' : 'block';
      $('#slotsReqCard').textContent = req.card || '—';
      $('#slotsReqHolder').textContent = req.holder || '—';
      $('#slotsReqBank').textContent = req.bank || '—';
      $('#slotsReqComment').textContent = req.comment || 'MYSAVDO';
    } catch(err){}
  }
});
$('#buySlotsForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try{
    const r = await apiFetch('backend/api/shop.php', {
      method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'purchase_slots', payer_name: $('#slotsPayerName').value.trim(), payer_digits: $('#slotsPayerDigits').value.trim() })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Не удалось отправить заявку');
    showToast('Заявка отправлена — места добавятся после подтверждения', 'success');
    $('#buySlotsPanel').style.display = 'none';
    $('#buySlotsForm').reset();
  } catch(err){ showToast(err.message, 'error'); }
});

/* --- поиск магазина и заявка на трудоустройство --- */
let joinShopSearchTimer = null;

async function loadMyApplications(){
  try{
    const r = await apiFetch('backend/api/shop.php?mine=applications', { credentials:'include' });
    const data = await r.json();
    const list = $('#myApplicationsList');
    if (!list) return;
    const statusLabel = { pending:'На рассмотрении', active:'Одобрено', rejected:'Отклонено' };
    const statusClass = { pending:'sent-neu', active:'sent-pos', rejected:'sent-neg' };
    list.innerHTML = (data.applications || []).map(app => `
      <div class="admin-user-row">
        <div class="admin-user-info">
          <b>@${escapeHtml(app.shop_username)} — ${escapeHtml(app.shop_name)}</b>
          <span class="sent-tag ${statusClass[app.status] || 'sent-neu'}"><span class="sent-dot"></span>${statusLabel[app.status] || app.status}</span>
          ${app.login_id ? `<span>ID для входа: <code>${escapeHtml(app.login_id)}</code> — пароль спросите у владельца</span>` : ''}
        </div>
      </div>
    `).join('') || '<p class="table-empty">Заявок пока нет</p>';
  } catch(err){}
}

async function openJoinShopModal(){
  $('#joinShopError').classList.remove('show');
  $('#joinShopSearch').value = '';
  $('#joinShopResult').style.display = 'none';
  $('#joinShopModal').classList.add('active');
  await loadMyApplications();
}
function closeJoinShopModal(){ $('#joinShopModal').classList.remove('active'); }
$('#btnJoinShop')?.addEventListener('click', () => { $('#accountMenu').classList.remove('open'); openJoinShopModal(); });
$('#joinShopClose')?.addEventListener('click', closeJoinShopModal);

$('#joinShopModal')?.addEventListener('click', async (e) => {
  if (e.target.id === 'joinShopModal'){ closeJoinShopModal(); return; }
  const applyBtn = e.target.closest('#joinShopApplyBtn');
  if (applyBtn){
    const username = applyBtn.dataset.username;
    const errBox = $('#joinShopError');
    errBox.classList.remove('show');
    try{
      const r = await apiFetch('backend/api/shop.php', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'apply', shop_username: username }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Не удалось подать заявку');
      showToast('Заявка отправлена владельцу магазина', 'success');
      $('#joinShopResult').style.display = 'none';
      $('#joinShopSearch').value = '';
      loadMyApplications();
    } catch(err){
      errBox.textContent = err.message;
      errBox.classList.add('show');
    }
  }
});

$('#joinShopSearch')?.addEventListener('input', (e) => {
  clearTimeout(joinShopSearchTimer);
  const q = e.target.value.trim().toLowerCase();
  const resultBox = $('#joinShopResult');
  if (!resultBox) return;
  if (!q){ resultBox.style.display = 'none'; return; }
  joinShopSearchTimer = setTimeout(async () => {
    try{
      const r = await apiFetch('backend/api/shop.php?search=' + encodeURIComponent(q), { credentials:'include' });
      const data = await r.json();
      if (data.shop){
        resultBox.style.display = 'flex';
        resultBox.innerHTML = `
          <div class="review-avatar">${data.shop.avatar ? `<img src="${escapeHtml(data.shop.avatar)}" alt="">` : escapeHtml((data.shop.shop_name||'?')[0].toUpperCase())}</div>
          <div style="flex:1;"><b>${escapeHtml(data.shop.shop_name)}</b><span style="display:block;color:var(--muted);font-size:12px;">@${escapeHtml(data.shop.shop_username)}</span></div>
          <button type="button" class="btn btn-primary btn-sm" id="joinShopApplyBtn" data-username="${escapeHtml(data.shop.shop_username)}">Подать заявку</button>
        `;
      } else {
        resultBox.style.display = 'flex';
        resultBox.innerHTML = '<span style="color:var(--muted);">Магазин не найден</span>';
      }
    } catch(err){}
  }, 400);
});

/* ============================================================
   Поиск людей/магазинов и личные сообщения (ЛС)
   ============================================================ */

function avatarHtmlFor(u){
  return u.avatar
    ? `<img src="${escapeHtml(u.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
    : escapeHtml(((u.display_name || u.shop_name || '?')[0] || '?').toUpperCase());
}

async function dmApiGet(qs = ''){
  const r = await apiFetch('backend/api/dm.php' + qs, { credentials:'include' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Не удалось загрузить сообщения');
  return data;
}
async function dmApiPost(payload){
  const r = await apiFetch('backend/api/dm.php', {
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Не удалось отправить сообщение');
  return data;
}

function openSearchPanel(){
  $('#searchModal').classList.add('active');
  $('#globalSearchInput').value = '';
  $('#globalSearchResults').innerHTML = '<div class="notif-empty">Начните вводить имя или юзернейм</div>';
  setTimeout(() => $('#globalSearchInput')?.focus(), 50);
}
function closeSearchModal(){ $('#searchModal').classList.remove('active'); }
$('#searchModalClose')?.addEventListener('click', closeSearchModal);
$('#searchModal')?.addEventListener('click', e => { if (e.target.id === 'searchModal') closeSearchModal(); });
$('#btnHeaderSearch')?.addEventListener('click', openSearchPanel);
$('#btnDashSearch')?.addEventListener('click', openSearchPanel);

let globalSearchTimer = null;
$('#globalSearchInput')?.addEventListener('input', () => {
  clearTimeout(globalSearchTimer);
  const q = $('#globalSearchInput').value;
  globalSearchTimer = setTimeout(() => runGlobalSearch(q), 300);
});

async function runGlobalSearch(q){
  const wrap = $('#globalSearchResults');
  if (!wrap) return;
  if (q.trim().length < 2){ wrap.innerHTML = '<div class="notif-empty">Введите минимум 2 символа</div>'; return; }
  wrap.innerHTML = '<div class="notif-empty">Ищем…</div>';
  try{
    const r = await apiFetch('backend/api/search.php?q=' + encodeURIComponent(q.trim()), { credentials:'include' });
    const data = await r.json().catch(() => ({}));
    const results = data.results || [];
    if (!results.length){ wrap.innerHTML = '<div class="notif-empty">Никого не нашли</div>'; return; }
    wrap.innerHTML = results.map(u => `
      <button type="button" class="dm-item" data-username="${escapeHtml(u.username)}">
        <div class="kcard-avatar">${avatarHtmlFor(u)}</div>
        <div class="dm-item-info">
          <b>${escapeHtml(u.display_name)}${u.is_shop ? ' <span class="dm-shop-tag">Магазин</span>' : ''}</b>
          <span>@${escapeHtml(u.username)}</span>
        </div>
      </button>`).join('');
    $$('.dm-item', wrap).forEach(btn => {
      btn.addEventListener('click', () => openDmWith(btn.dataset.username));
    });
  } catch(e){ wrap.innerHTML = `<div class="notif-empty">${escapeHtml(e.message)}</div>`; }
}

function showDmView(mode){
  $('#dmListView').style.display = mode === 'list' ? 'flex' : 'none';
  $('#dmThreadView').style.display = mode === 'thread' ? 'flex' : 'none';
}

function closeDm(){
  $('#dmOverlay').classList.remove('active');
  clearInterval(dmThreadPollTimer);
  dmThreadCurrent = null;
}
$('#dmClose')?.addEventListener('click', closeDm);
$('#dmThreadClose')?.addEventListener('click', closeDm);
$('#dmOverlay')?.addEventListener('click', e => { if (e.target.id === 'dmOverlay') closeDm(); });
$('#dmNewChatBtn')?.addEventListener('click', () => { closeDm(); openSearchPanel(); });
$('#dmMarkAllReadBtn')?.addEventListener('click', async () => {
  try{
    await dmApiPost({ action:'mark_all_read' });
    _dmPrevUnread = 0;
    updateDmBadge([]);
    loadDmList();
    showToast('Все диалоги отмечены прочитанными', 'ok');
  } catch(e){ showToast(e.message || 'Не удалось отметить прочитанным', 'error'); }
});
$('#dmThreadBack')?.addEventListener('click', () => {
  clearInterval(dmThreadPollTimer);
  dmThreadCurrent = null;
  showDmView('list');
  loadDmList();
});

async function openDmPanel(){
  if (!Auth.current()) return;
  $('#dmOverlay').classList.add('active');
  showDmView('list');
  await loadDmList();
}
$('#btnDmOpen')?.addEventListener('click', openDmPanel);

async function openDmWith(who){
  closeSearchModal();
  if (!Auth.current()){
    try{
      await Auth.guestLogin();
      applyAuthUI();
      refreshShopMenuUI();
      showToast('Вы вошли как гость — можно переписываться', 'info');
    } catch(e){ showToast(e.message, 'info'); return; }
  }
  $('#dmOverlay').classList.add('active');
  await openDmThreadView(who);
}

function updateDmBadge(conversations){
  const total = (conversations || []).reduce((sum, c) => sum + (Number(c.unread) || 0), 0);
  const badge = $('#dmBadge');
  if (!badge) return;
  badge.style.display = total ? 'flex' : 'none';
  badge.textContent = total > 99 ? '99+' : String(total);
}

let _dmPrevUnread = null;
async function refreshDmBadge(){
  if (!Auth.current()) return;
  try{
    const data = await dmApiGet('');
    const convos = data.conversations || [];
    const total = convos.reduce((sum, c) => sum + (Number(c.unread) || 0), 0);
    if (_dmPrevUnread !== null && total > _dmPrevUnread && !$('#dmOverlay')?.classList.contains('active')){
      playNotifSound();
    }
    _dmPrevUnread = total;
    updateDmBadge(convos);
  } catch(e){}
}
setInterval(refreshDmBadge, 25000);

async function loadDmList(){
  const wrap = $('#dmList');
  if (!wrap) return;
  wrap.innerHTML = '<div class="notif-empty">Загрузка…</div>';
  try{
    const data = await dmApiGet('');
    const convos = data.conversations || [];
    updateDmBadge(convos);
    if (!convos.length){
      wrap.innerHTML = '<div class="dm-empty-cta"><p class="notif-empty" style="padding:6px 0;">Пока нет диалогов</p><button type="button" class="btn btn-outline btn-sm" id="dmEmptyFindBtn">Найти магазин или человека</button></div>';
      $('#dmEmptyFindBtn')?.addEventListener('click', () => { closeDm(); openSearchPanel(); });
      return;
    }
    wrap.innerHTML = convos.map(c => `
      <button type="button" class="dm-item ${c.unread ? 'has-unread' : ''}" data-username="${escapeHtml(c.username)}">
        <div class="kcard-avatar">${avatarHtmlFor(c)}</div>
        <div class="dm-item-info">
          <b>${escapeHtml(c.display_name)}${c.is_shop ? ' <span class="dm-shop-tag">Магазин</span>' : ''}</b>
          <span>${c.last_mine ? 'Вы: ' : ''}${escapeHtml(c.last_text || '')}</span>
        </div>
        <div class="dm-item-meta">
          <span class="dm-item-time">${c.last_at ? fmtTime(parseServerTime(c.last_at)) : ''}</span>
          ${c.unread ? `<span class="dm-item-unread">${c.unread}</span>` : ''}
        </div>
      </button>`).join('');
    $$('.dm-item', wrap).forEach(btn => {
      btn.addEventListener('click', () => openDmThreadView(btn.dataset.username));
    });
  } catch(e){ wrap.innerHTML = `<div class="notif-empty">${escapeHtml(e.message)}</div>`; }
}

let dmThreadPollTimer = null;
let dmThreadCurrent = null;
let dmThreadInFlight = false;

Draft.bind($('#dmReplyInput'), 'dm', () => dmThreadCurrent);
const dmReplyBar = MsgActions.createReplyBar($('#dmReplyForm'));
const dmSelection = MsgActions.createSelection({
  mountBeforeEl: $('#dmThreadBody'),
  onCopy: ids => {
    MsgActions.copyTexts(ids.map(id => $(`#dmThreadBody .bubble[data-msg-id="${id}"]`)?.dataset.msgText || ''));
  },
  onDelete: async ids => {
    await Promise.all(ids.map(id => dmApiPost({ action:'delete', id: Number(id) }).catch(() => {})));
    ids.forEach(id => $(`#dmThreadBody .bubble[data-msg-id="${id}"]`)?.remove());
  },
});

async function deleteDmMessage(m){
  if (!confirm('Удалить это сообщение?')) return;
  try{
    await dmApiPost({ action:'delete', id: m.id });
    $(`#dmThreadBody .bubble[data-msg-id="${m.id}"]`)?.remove();
  } catch(e){ showToast(e.message || 'Не удалось удалить сообщение', 'error'); }
}

function buildDmBubble(m){
  const row = document.createElement('div');
  row.className = 'bubble ' + (m.mine ? 'out' : 'in');
  row.dataset.msgId = String(m.id);
  row.dataset.msgText = m.text || '';

  const doReact = emoji => reactToMessage('dm', m, emoji, data => MsgActions.renderReactions(row, data, doReact));

  MsgActions.renderReplyPreview(row, m.reply_to_snippet || null);
  const textEl = document.createElement('div');
  textEl.textContent = m.text;
  row.appendChild(textEl);
  const timeEl = document.createElement('span');
  timeEl.style.cssText = 'display:flex;align-items:center;font-size:10.5px;opacity:.6;margin-top:4px;';
  timeEl.textContent = fmtTime(parseServerTime(m.created_at));
  if (m.mine){
    // Галочки прочтения — как в мессенджерах: серые «отправлено», цветные
    // «прочитано» (dm_messages.read_at выставляется при открытии треда).
    const ticks = document.createElement('span');
    ticks.className = 'dm-read-ticks' + (m.read ? ' read' : '');
    ticks.title = m.read ? 'Прочитано' : 'Отправлено';
    ticks.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><use href="#icon-check"/></svg><svg class="icon" viewBox="0 0 24 24"><use href="#icon-check"/></svg>';
    timeEl.appendChild(ticks);
  }
  row.appendChild(timeEl);
  MsgActions.renderReactions(row, m.reactions, doReact);

  MsgActions.attachTrigger(row, () => {
    if (dmSelection.isActive()){ dmSelection.toggle(m.id, row); return; }
    const actions = [
      { icon:'copy', label:'Копировать', onClick: () => MsgActions.copyTexts([m.text || '']) },
      { icon:'reply', label:'Ответить', onClick: () => dmReplyBar.set(m.id, (m.text || '').slice(0, 120)) },
      { type:'reactions', onPick: doReact },
      { icon:'checkbox', label:'Выбрать', onClick: () => { dmSelection.start(); dmSelection.toggle(m.id, row); } },
    ];
    if (m.mine) actions.push({ icon:'trash', label:'Удалить', danger:true, onClick: () => deleteDmMessage(m) });
    MsgActions.showPopover(row, actions);
  });
  row.addEventListener('click', () => { if (dmSelection.isActive()) dmSelection.toggle(m.id, row); });

  return row;
}

function renderDmMessages(msgs){
  const body = $('#dmThreadBody');
  if (!body) return;
  const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  if (!msgs.length){
    body.innerHTML = '<div class="notif-empty">Сообщений пока нет — напишите первым</div>';
    return;
  }
  body.innerHTML = '';
  msgs.forEach(m => body.appendChild(buildDmBubble(m)));
  if (stick) body.scrollTop = body.scrollHeight;
}

// Тот же порог "в сети", что и у админки (last_active_at обновляется на
// каждый авторизованный запрос — см. touch_presence() в store.php).
function userOnlineInfo(lastActiveAt){
  if (!lastActiveAt) return { online:false, label:'не в сети' };
  const min = (Date.now() - parseServerTime(lastActiveAt)) / 60000;
  if (min < 2) return { online:true, label:'в сети' };
  if (min < 60) return { online:false, label:`был(а) ${Math.round(min)} мин назад` };
  const h = Math.floor(min / 60);
  if (h < 24) return { online:false, label:`был(а) ${h} ч назад` };
  return { online:false, label:`был(а) ${Math.floor(h / 24)} дн назад` };
}

async function loadDmThread(who, silent = false){
  try{
    const data = await dmApiGet('?with=' + encodeURIComponent(who));
    const u = data.user;
    $('#dmThreadName').textContent = u.display_name;
    if (data.typing){
      $('#dmThreadSub').innerHTML = `<span class="dm-typing-label">печатает<span class="typing-dots"><span></span><span></span><span></span></span></span>`;
    } else {
      const info = userOnlineInfo(u.last_active_at);
      $('#dmThreadSub').innerHTML = `<span class="online-dot ${info.online ? 'on' : ''}"></span>@${escapeHtml(u.username || '')}${u.is_shop ? ' · Магазин' : ''} · ${escapeHtml(info.label)}`;
    }
    $('#dmThreadAvatar').innerHTML = avatarHtmlFor(u);
    renderDmMessages(data.messages || []);
    dmThreadCurrent = String(u.id);
  } catch(e){
    if (!silent) $('#dmThreadBody').innerHTML = `<div class="notif-empty">${escapeHtml(e.message)}</div>`;
  }
}

// Пинг "печатает…" — не чаще раза в 2.5с, пока в поле есть текст. Собеседник
// увидит его на своём обычном поллинге треда (см. data.typing в loadDmThread).
let dmLastTypingPing = 0;
$('#dmReplyInput')?.addEventListener('input', e => {
  if (!dmThreadCurrent || !e.target.value.trim()) return;
  const now = Date.now();
  if (now - dmLastTypingPing < 2500) return;
  dmLastTypingPing = now;
  dmApiPost({ action:'typing', to: dmThreadCurrent }).catch(() => {});
});

async function openDmThreadView(who){
  dmThreadCurrent = who;
  showDmView('thread');
  $('#dmThreadBody').innerHTML = '<div class="notif-empty">Загрузка…</div>';
  $('#dmReplyInput').value = Draft.load('dm', who);
  await loadDmThread(who);
  clearInterval(dmThreadPollTimer);
  dmThreadPollTimer = setInterval(async () => {
    if (!dmThreadCurrent || !$('#dmOverlay').classList.contains('active') || document.hidden || dmThreadInFlight) return;
    dmThreadInFlight = true;
    try{ await loadDmThread(dmThreadCurrent, true); } catch(_){}
    dmThreadInFlight = false;
  }, 6000);
}

$('#dmReplyForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#dmReplyInput');
  const text = input.value.trim();
  if (!text || !dmThreadCurrent) return;
  input.value = '';
  Draft.clear('dm', dmThreadCurrent);
  const replyTarget = dmReplyBar.get();
  dmReplyBar.clear();
  try{
    await dmApiPost({ action:'send', to: dmThreadCurrent, text, reply_to_id: replyTarget ? replyTarget.id : undefined });
    await loadDmThread(dmThreadCurrent, true);
  } catch(err){
    showToast(err.message, 'info');
    input.value = text;
  }
});

// --- Telegram-группы: свои Telegram-группы владельца магазина (бот должен
// быть в них участником/админом) — отдельная лента от 1:1 переписки с
// клиентами, т.к. у группы много отправителей. См. backend/api/telegram-groups.php.
let tgGroups = [];
let tgGroupCurrent = null;
let tgGroupPollTimer = null;
let tgGroupThreadInFlight = false;
let tgGroupMediaLoaded = false;
let tgGroupMembersLoaded = false;
let tgStoryPendingMedia = null; // { url, type }

const TG_SENDER_COLORS = ['#c0392b','#8e44ad','#2980b9','#16a085','#d35400','#2c3e50','#c2185b','#00796b'];
function tgSenderColor(id){
  const s = String(id || '0');
  let h = 0;
  for (let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) >>> 0;
  return TG_SENDER_COLORS[h % TG_SENDER_COLORS.length];
}

async function tggApiGet(qs = ''){
  const r = await apiFetch('backend/api/telegram-groups.php' + qs, { credentials:'include' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Не удалось загрузить данные');
  return data;
}
async function tggApiPost(payload){
  const r = await apiFetch('backend/api/telegram-groups.php', {
    method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Не удалось выполнить действие');
  return data;
}

function showTgGroupsView(mode){
  $('#tgGroupsListView').style.display = mode === 'list' ? 'flex' : 'none';
  $('#tgGroupThreadView').style.display = mode === 'thread' ? 'flex' : 'none';
}

function closeTgGroups(){
  $('#tgGroupsOverlay').classList.remove('active');
  clearInterval(tgGroupPollTimer);
  tgGroupCurrent = null;
}
$('#tgGroupsClose')?.addEventListener('click', closeTgGroups);
$('#tgGroupThreadClose')?.addEventListener('click', closeTgGroups);
$('#tgGroupsOverlay')?.addEventListener('click', e => { if (e.target.id === 'tgGroupsOverlay') closeTgGroups(); });
$('#tgGroupThreadBack')?.addEventListener('click', () => {
  clearInterval(tgGroupPollTimer);
  tgGroupCurrent = null;
  showTgGroupsView('list');
  loadTgGroupsList();
});
$('#tgGroupsHintClose')?.addEventListener('click', () => {
  localStorage.setItem('mysavdo_tg_hint_dismissed', '1');
  $('#tgGroupsHint').style.display = 'none';
});

function updateTgGroupsBadge(){
  const total = (tgGroups || []).reduce((sum, g) => sum + (Number(g.unread) || 0), 0);
  const badge = $('#tgGroupsBadge');
  if (!badge) return;
  badge.style.display = total ? 'flex' : 'none';
  badge.textContent = total > 99 ? '99+' : String(total);
}

let _tgGroupsPrevUnread = null;
async function refreshTgGroupsBadge(){
  if (!Auth.current()) return;
  try{
    const data = await tggApiGet('?action=list');
    tgGroups = data.groups || [];
    const total = tgGroups.reduce((sum, g) => sum + (Number(g.unread) || 0), 0);
    if (_tgGroupsPrevUnread !== null && total > _tgGroupsPrevUnread && !$('#tgGroupsOverlay')?.classList.contains('active')){
      playNotifSound();
    }
    _tgGroupsPrevUnread = total;
    updateTgGroupsBadge();
  } catch(e){}
}
setInterval(refreshTgGroupsBadge, 25000);

async function loadTgGroupsList(){
  const wrap = $('#tgGroupsList');
  if (!wrap) return;
  wrap.innerHTML = '<div class="notif-empty">Загрузка…</div>';
  try{
    const data = await tggApiGet('?action=list');
    tgGroups = data.groups || [];
    updateTgGroupsBadge();
    if (!tgGroups.length){
      wrap.innerHTML = '<div class="dm-empty-cta"><p class="notif-empty" style="padding:6px 0;">Пока нет подключённых групп — следуйте подсказке выше</p></div>';
      return;
    }
    wrap.innerHTML = tgGroups.map(g => `
      <button type="button" class="dm-item ${g.unread ? 'has-unread' : ''}" data-id="${g.id}">
        <div class="kcard-avatar tg-group-avatar">${g.photo_url ? `<img src="${escapeHtml(g.photo_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">` : escapeHtml((g.title || '?')[0].toUpperCase())}</div>
        <div class="dm-item-info">
          <b>${escapeHtml(g.title)}</b>
          <span>${g.last_mine ? 'Вы: ' : (g.last_sender ? escapeHtml(g.last_sender) + ': ' : '')}${escapeHtml(g.last_text || (g.last_has_media ? '📷 Медиа' : 'Сообщений пока нет'))}</span>
        </div>
        <div class="dm-item-meta">
          <span class="dm-item-time">${g.last_at ? fmtTime(parseServerTime(g.last_at)) : ''}</span>
          ${g.unread ? `<span class="dm-item-unread">${g.unread}</span>` : ''}
        </div>
      </button>`).join('');
    $$('.dm-item', wrap).forEach(btn => {
      btn.addEventListener('click', () => openTgGroupThread(Number(btn.dataset.id)));
    });
  } catch(e){ wrap.innerHTML = `<div class="notif-empty">${escapeHtml(e.message)}</div>`; }
}

async function openTgGroupsPanel(){
  if (!Auth.current()) return;
  $('#accountMenu').classList.remove('open');
  $('#tgGroupsOverlay').classList.add('active');
  showTgGroupsView('list');
  $('#tgGroupsHint').style.display = localStorage.getItem('mysavdo_tg_hint_dismissed') ? 'none' : 'flex';
  await loadTgGroupsList();
}
$('#btnOpenTgGroups')?.addEventListener('click', openTgGroupsPanel);

function renderTgGroupPinned(pinned){
  const box = $('#tgGroupPinned');
  if (!box) return;
  if (!pinned){ box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'flex';
  const snippet = pinned.text || (pinned.photo_url ? '📷 Фото' : (pinned.video_url ? '🎬 Видео' : ''));
  box.innerHTML = `
    <span class="tg-group-pinned-icon"><svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-pin"/></svg></span>
    <div class="tg-group-pinned-body"><b>Закреплено</b><span>${escapeHtml((pinned.sender_name ? pinned.sender_name + ': ' : '') + snippet)}</span></div>
    <button type="button" class="tg-group-pinned-unpin" id="tgGroupUnpinBtn">Открепить</button>`;
  $('#tgGroupUnpinBtn')?.addEventListener('click', async e => {
    e.stopPropagation();
    try{ await tggApiPost({ action:'unpin', group_id: tgGroupCurrent }); await loadTgGroupThread(true); }
    catch(err){ showToast(err.message, 'error'); }
  });
}

async function pinTgGroupMessage(id){
  try{
    await tggApiPost({ action:'pin', group_id: tgGroupCurrent, message_id: id });
    await loadTgGroupThread(true);
    showToast('Закреплено', 'ok');
  } catch(e){ showToast(e.message || 'Не удалось закрепить', 'error'); }
}
async function deleteTgGroupMessage(m){
  if (!confirm('Удалить это сообщение?')) return;
  try{
    await tggApiPost({ action:'delete', group_id: tgGroupCurrent, message_id: m.id });
    $(`#tgGroupChatBody .bubble[data-msg-id="${m.id}"]`)?.remove();
  } catch(e){ showToast(e.message || 'Не удалось удалить сообщение', 'error'); }
}

function buildTgGroupBubble(m){
  const row = document.createElement('div');
  row.className = 'bubble ' + (m.direction === 'out' ? 'out' : 'in');
  row.dataset.msgId = String(m.id);

  MsgActions.renderReplyPreview(row, m.reply_to_snippet ? ((m.reply_to_sender ? m.reply_to_sender + ': ' : '') + m.reply_to_snippet) : null);

  if (m.direction === 'in' && m.sender_name){
    const nameEl = document.createElement('span');
    nameEl.className = 'tg-sender-name';
    nameEl.style.color = tgSenderColor(m.sender_tg_id);
    nameEl.textContent = m.sender_name;
    row.appendChild(nameEl);
  }
  if (m.photo_url){
    const img = document.createElement('img');
    img.className = 'bubble-photo';
    img.src = m.photo_url;
    img.alt = 'Фото';
    img.loading = 'lazy';
    img.addEventListener('click', e => { e.stopPropagation(); openLightbox(m.photo_url); });
    row.appendChild(img);
  }
  if (m.video_url){
    const vid = document.createElement('video');
    vid.className = 'bubble-photo';
    vid.src = m.video_url;
    vid.controls = true;
    row.appendChild(vid);
  }
  if (m.audio_url){
    const wrap = document.createElement('div');
    wrap.className = 'bubble-audio';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = m.audio_url;
    wrap.appendChild(audio);
    row.appendChild(wrap);
  }
  if (m.text){
    const txt = document.createElement('span');
    txt.className = 'bubble-text';
    txt.textContent = m.text;
    row.appendChild(txt);
  }
  const time = document.createElement('span');
  time.className = 'bubble-time';
  time.textContent = fmtTime(parseServerTime(m.created_at));
  row.appendChild(time);

  MsgActions.attachTrigger(row, () => {
    const actions = [];
    if (m.text) actions.push({ icon:'copy', label:'Копировать', onClick: () => MsgActions.copyTexts([m.text || '']) });
    actions.push({ icon:'reply', label:'Ответить', onClick: () => tgGroupReplyBar.set(m.id, ((m.sender_name ? m.sender_name + ': ' : '') + (m.text || '')).slice(0, 120)) });
    actions.push({ icon:'pin', label:'Закрепить', onClick: () => pinTgGroupMessage(m.id) });
    if (m.direction === 'out') actions.push({ icon:'trash', label:'Удалить', danger:true, onClick: () => deleteTgGroupMessage(m) });
    MsgActions.showPopover(row, actions);
  });

  return row;
}

function renderTgGroupMessages(msgs){
  const body = $('#tgGroupChatBody');
  if (!body) return;
  const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  if (!msgs.length){
    body.innerHTML = '<div class="notif-empty">Сообщений пока нет</div>';
    return;
  }
  body.innerHTML = '';
  msgs.forEach(m => body.appendChild(buildTgGroupBubble(m)));
  if (stick) body.scrollTop = body.scrollHeight;
}

async function loadTgGroupThread(silent = false){
  if (!tgGroupCurrent) return;
  try{
    const data = await tggApiGet('?action=thread&group_id=' + tgGroupCurrent);
    const g = data.group;
    $('#tgGroupThreadName').textContent = g.title;
    $('#tgGroupThreadMeta').textContent = g.member_count ? `${g.member_count} участник(ов)` : '';
    $('#tgGroupThreadAvatar').innerHTML = g.photo_url
      ? `<img src="${escapeHtml(g.photo_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
      : escapeHtml((g.title || '?')[0].toUpperCase());
    renderTgGroupPinned(data.pinned);
    renderTgGroupMessages(data.messages || []);
  } catch(e){
    if (!silent) $('#tgGroupChatBody').innerHTML = `<div class="notif-empty">${escapeHtml(e.message)}</div>`;
  }
}

async function openTgGroupThread(id){
  tgGroupCurrent = id;
  showTgGroupsView('thread');
  $('#tgGroupChatBody').innerHTML = '<div class="notif-empty">Загрузка…</div>';
  switchTgGroupTab('chat');
  tgGroupMediaLoaded = false;
  tgGroupMembersLoaded = false;
  $('#tgGroupReplyInput').value = Draft.load('tggroup', id);
  await loadTgGroupThread(true);
  clearInterval(tgGroupPollTimer);
  tgGroupPollTimer = setInterval(async () => {
    if (tgGroupCurrent !== id || !$('#tgGroupsOverlay').classList.contains('active') || document.hidden || tgGroupThreadInFlight) return;
    tgGroupThreadInFlight = true;
    try{ await loadTgGroupThread(true); } catch(_){}
    tgGroupThreadInFlight = false;
  }, 6000);
}

function switchTgGroupTab(tab){
  $$('#tgGroupTabs .tg-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('#tgGroupChatBody').style.display = tab === 'chat' ? 'flex' : 'none';
  $('#tgGroupMediaGrid').style.display = tab === 'media' ? 'grid' : 'none';
  $('#tgGroupMembersList').style.display = tab === 'members' ? 'flex' : 'none';
  $('#tgGroupChatFoot').style.display = tab === 'chat' ? 'block' : 'none';
  if (tab === 'media' && !tgGroupMediaLoaded) loadTgGroupMedia();
  if (tab === 'members' && !tgGroupMembersLoaded) loadTgGroupMembers();
}
$$('#tgGroupTabs .tg-tab').forEach(tab => {
  tab.addEventListener('click', () => switchTgGroupTab(tab.dataset.tab));
});

async function loadTgGroupMedia(){
  const grid = $('#tgGroupMediaGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="notif-empty tg-media-empty">Загрузка…</div>';
  try{
    const data = await tggApiGet('?action=media&group_id=' + tgGroupCurrent);
    tgGroupMediaLoaded = true;
    const items = data.media || [];
    if (!items.length){ grid.innerHTML = '<div class="notif-empty tg-media-empty">Пока нет фото и видео</div>'; return; }
    grid.innerHTML = items.map(m => {
      const isVideo = !!m.video_url;
      const src = m.photo_url || m.video_url;
      return `<div class="tg-media-grid-item ${isVideo ? 'is-video' : ''}" data-src="${escapeHtml(src)}" data-video="${isVideo ? '1' : '0'}">
        ${isVideo ? `<video src="${escapeHtml(src)}" muted></video>` : `<img src="${escapeHtml(src)}" alt="" loading="lazy">`}
      </div>`;
    }).join('');
    $$('.tg-media-grid-item', grid).forEach(el => {
      el.addEventListener('click', () => {
        if (el.dataset.video === '1') window.open(el.dataset.src, '_blank');
        else openLightbox(el.dataset.src);
      });
    });
  } catch(e){ grid.innerHTML = `<div class="notif-empty tg-media-empty">${escapeHtml(e.message)}</div>`; }
}

async function loadTgGroupMembers(){
  const wrap = $('#tgGroupMembersList');
  if (!wrap) return;
  wrap.innerHTML = '<div class="notif-empty">Загрузка…</div>';
  try{
    const data = await tggApiGet('?action=members&group_id=' + tgGroupCurrent);
    tgGroupMembersLoaded = true;
    const members = data.members || [];
    if (!members.length){ wrap.innerHTML = '<div class="notif-empty">Пока никто не писал в группу — участники появятся здесь по мере переписки</div>'; return; }
    const roleLabel = { creator:'Создатель', administrator:'Админ', member:'Участник' };
    wrap.innerHTML = members.map(m => `
      <div class="tg-member-item">
        <div class="kcard-avatar" style="background:${tgSenderColor(m.tg_user_id)};">${escapeHtml((m.name || '?')[0].toUpperCase())}</div>
        <div class="tg-member-item-info">
          <b>${escapeHtml(m.name || 'Без имени')}</b>
          ${m.username ? `<span>@${escapeHtml(m.username)}</span>` : ''}
        </div>
        <span class="tg-role-badge ${escapeHtml(m.role)}">${escapeHtml(roleLabel[m.role] || m.role)}</span>
      </div>`).join('');
  } catch(e){ wrap.innerHTML = `<div class="notif-empty">${escapeHtml(e.message)}</div>`; }
}

Draft.bind($('#tgGroupReplyInput'), 'tggroup', () => tgGroupCurrent);
const tgGroupReplyBar = MsgActions.createReplyBar($('#tgGroupReplyForm'));

$('#tgGroupReplyForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#tgGroupReplyInput');
  const text = input.value.trim();
  if (!text || !tgGroupCurrent) return;
  input.value = '';
  Draft.clear('tggroup', tgGroupCurrent);
  const replyTarget = tgGroupReplyBar.get();
  tgGroupReplyBar.clear();
  try{
    await tggApiPost({ action:'send', group_id: tgGroupCurrent, text, reply_to_id: replyTarget ? replyTarget.id : undefined });
    await loadTgGroupThread(true);
  } catch(err){
    showToast(err.message, 'error');
    input.value = text;
  }
});

// --- Модалка "Опубликовать в Telegram" — пост (текст/фото/видео) от бота
// сразу в несколько выбранных групп, отдельно от обычной переписки.
function renderTgStoryGroupPicker(preselectId){
  const wrap = $('#tgStoryGroupPicker');
  if (!wrap) return;
  if (!tgGroups.length){
    wrap.innerHTML = '<p class="notif-empty" style="padding:6px 0;">Нет подключённых групп</p>';
    return;
  }
  wrap.innerHTML = tgGroups.map(g => `
    <label class="tg-story-group-chip" data-id="${g.id}">
      <input type="checkbox" value="${g.id}" ${(!preselectId || g.id === preselectId) ? 'checked' : ''}>
      <span>${escapeHtml(g.title)}</span>
    </label>`).join('');
  $$('.tg-story-group-chip', wrap).forEach(chip => {
    const cb = chip.querySelector('input');
    chip.classList.toggle('checked', cb.checked);
    cb.addEventListener('change', () => chip.classList.toggle('checked', cb.checked));
  });
}

function openTgStoryModal(preselectId){
  $('#tgStoryModal').classList.add('active');
  $('#tgStoryError').classList.remove('show');
  $('#tgStoryForm').reset();
  $('#tgStoryPreviewBox').style.display = 'none';
  $('#tgStoryPreviewBox').innerHTML = '';
  tgStoryPendingMedia = null;
  renderTgStoryGroupPicker(preselectId);
}
$('#tgStoryBtn')?.addEventListener('click', () => openTgStoryModal(null));
$('#tgGroupStoryBtn')?.addEventListener('click', () => openTgStoryModal(tgGroupCurrent));
$('#tgStoryModalClose')?.addEventListener('click', () => $('#tgStoryModal').classList.remove('active'));
$('#tgStoryModal')?.addEventListener('click', e => { if (e.target.id === 'tgStoryModal') $('#tgStoryModal').classList.remove('active'); });

$('#tgStoryAttachBtn')?.addEventListener('click', () => $('#tgStoryFileInput').click());
$('#tgStoryFileInput')?.addEventListener('change', async () => {
  const file = $('#tgStoryFileInput').files[0];
  $('#tgStoryFileInput').value = '';
  if (!file) return;
  const isVideo = file.type.startsWith('video/');
  const preview = $('#tgStoryPreviewBox');
  preview.style.display = 'flex';
  preview.innerHTML = '<div class="notif-empty">Загружаем…</div>';
  try{
    const fd = new FormData();
    fd.append(isVideo ? 'video' : 'photo', file);
    const r = await apiFetch('backend/api/upload.php', { method:'POST', credentials:'include', body: fd });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.url) throw new Error(data.error || 'Не удалось загрузить файл');
    tgStoryPendingMedia = { url: data.url, type: isVideo ? 'video' : 'photo' };
    preview.innerHTML = `
      ${isVideo ? `<video src="${escapeHtml(data.url)}" controls></video>` : `<img src="${escapeHtml(data.url)}" alt="">`}
      <button type="button" class="tg-story-preview-remove" id="tgStoryPreviewRemove">✕</button>`;
    $('#tgStoryPreviewRemove').addEventListener('click', () => {
      tgStoryPendingMedia = null;
      preview.style.display = 'none';
      preview.innerHTML = '';
    });
  } catch(e){
    preview.style.display = 'none';
    showToast(e.message || 'Не удалось загрузить файл', 'error');
  }
});

$('#tgStoryForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const errBox = $('#tgStoryError');
  errBox.classList.remove('show');
  const caption = $('#tgStoryCaption').value.trim();
  const groupIds = $$('.tg-story-group-chip input:checked', $('#tgStoryGroupPicker')).map(cb => Number(cb.value));
  if (!groupIds.length){ errBox.textContent = 'Выберите хотя бы одну группу'; errBox.classList.add('show'); return; }
  if (!caption && !tgStoryPendingMedia){ errBox.textContent = 'Добавьте текст или фото/видео'; errBox.classList.add('show'); return; }

  const btn = $('#tgStorySubmit');
  btn.disabled = true;
  btn.textContent = 'Публикуем…';
  try{
    const payload = { action:'post_story', group_ids: groupIds, caption };
    if (tgStoryPendingMedia){ payload.media_url = tgStoryPendingMedia.url; payload.media_type = tgStoryPendingMedia.type; }
    await tggApiPost(payload);
    $('#tgStoryModal').classList.remove('active');
    showToast('Опубликовано в Telegram', 'ok');
    if (tgGroupCurrent && groupIds.includes(tgGroupCurrent)) loadTgGroupThread(true);
    loadTgGroupsList();
  } catch(err){
    errBox.textContent = err.message || 'Не удалось опубликовать';
    errBox.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Опубликовать';
  }
});

// --- Переключатель аккаунтов: свой аккаунт + 1 бесплатный дополнительный
// (итого 2), дальше — платный слот (см. backend/api/account-switch.php).
// Токены для мгновенного переключения без пароля хранятся только в этом
// браузере (localStorage) — на новом устройстве нужно один раз войти заново.
let linkedAccounts = [];
let accountSlotsInfo = { used: 0, total: 1, price: 25 };

function acsTokens(){
  try{
    const v = JSON.parse(localStorage.getItem('mysavdo_account_tokens') || '{}');
    return (v && typeof v === 'object') ? v : {};
  } catch(_){ return {}; }
}
function acsSaveToken(userId, token){
  const t = acsTokens();
  t[String(userId)] = token;
  localStorage.setItem('mysavdo_account_tokens', JSON.stringify(t));
}
function acsRemoveToken(userId){
  const t = acsTokens();
  delete t[String(userId)];
  localStorage.setItem('mysavdo_account_tokens', JSON.stringify(t));
}

async function acsApiGet(){
  const r = await apiFetch('backend/api/account-switch.php', { credentials:'include' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Не удалось загрузить аккаунты');
  return data;
}
async function acsApiPost(payload){
  const r = await apiFetch('backend/api/account-switch.php', {
    method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Не удалось выполнить действие');
  return data;
}

async function loadLinkedAccounts(){
  try{
    const data = await acsApiGet();
    linkedAccounts = data.linked || [];
    accountSlotsInfo = { used: data.slots_used || 0, total: data.slots_total || 1, price: data.slot_price || 25 };
  } catch(e){  }
  return linkedAccounts;
}

function acsAvatarHtml(acc){
  const initial = escapeHtml(((acc && (acc.shop_name || acc.email) || '?')[0] || '?').toUpperCase());
  return (acc && acc.avatar) ? `<img src="${escapeHtml(acc.avatar)}" alt="">` : initial;
}

async function renderAccountSwitcherRow(){
  const row = $('#accountSwitcherRow');
  const wrap = $('#accountSwitcher');
  if (!row || !wrap) return;
  const cur = Auth.current();
  if (!cur || cur.is_guest){ wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  await loadLinkedAccounts();

  let html = `<div class="account-switcher-avatar current" title="${escapeHtml(cur.shop_name || cur.email || '')}">${acsAvatarHtml(cur)}</div>`;
  linkedAccounts.forEach(acc => {
    html += `<button type="button" class="account-switcher-avatar" data-id="${acc.user_id}" title="${escapeHtml(acc.shop_name || acc.email || '')}">${acsAvatarHtml(acc)}</button>`;
  });
  html += `<button type="button" class="account-switcher-add" id="btnQuickAddAccount" title="Добавить аккаунт">+</button>`;
  row.innerHTML = html;

  $$('.account-switcher-avatar[data-id]', row).forEach(btn => {
    btn.addEventListener('click', () => switchAccount(Number(btn.dataset.id)));
  });
  $('#btnQuickAddAccount')?.addEventListener('click', () => { closeAccountMenu(); openAccountsModal(); });
}

async function switchAccount(userId){
  let token = acsTokens()[String(userId)];
  if (!token){
    // Может не быть токена на этом устройстве, если связь появилась с
    // другой стороны (нас кто-то добавил к себе) — перевыпускаем без
    // пароля, раз мы уже вошли в аккаунт, к которому эта связь относится.
    try{
      const data = await acsApiPost({ action:'claim', user_id: userId });
      token = data.account.token;
      acsSaveToken(userId, token);
    } catch(e){
      showToast('Нет сохранённого входа для этого аккаунта на этом устройстве — добавьте его заново', 'error');
      openAccountsModal();
      return;
    }
  }
  try{
    await acsApiPost({ action:'switch', user_id: userId, token });
    showToast('Переключаемся…', 'ok');
    window.location.reload();
  } catch(e){
    acsRemoveToken(userId);
    showToast(e.message || 'Не удалось переключиться', 'error');
  }
}

function renderAccountsList(){
  const wrap = $('#accountsModalList');
  if (!wrap) return;
  const cur = Auth.current() || {};
  let html = `
    <div class="accounts-list-item current">
      <div class="kcard-avatar">${acsAvatarHtml(cur)}</div>
      <div class="accounts-list-item-info"><b>${escapeHtml(cur.shop_name || cur.email || '')}</b><span>${escapeHtml(cur.email || '')}</span></div>
      <span class="accounts-list-item-tag">Сейчас</span>
    </div>`;
  linkedAccounts.forEach(acc => {
    html += `
      <div class="accounts-list-item" data-id="${acc.user_id}">
        <div class="kcard-avatar">${acsAvatarHtml(acc)}</div>
        <div class="accounts-list-item-info"><b>${escapeHtml(acc.shop_name || acc.email || '')}</b><span>${escapeHtml(acc.email || '')}</span></div>
        <div class="accounts-list-item-actions">
          <button type="button" class="btn btn-outline btn-sm" data-a="switch">Войти</button>
          <button type="button" class="icon-btn danger" data-a="unlink" title="Отключить"><svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-trash"/></svg></button>
        </div>
      </div>`;
  });
  wrap.innerHTML = html;

  $$('.accounts-list-item[data-id]', wrap).forEach(item => {
    const id = Number(item.dataset.id);
    item.querySelector('[data-a="switch"]')?.addEventListener('click', () => switchAccount(id));
    item.querySelector('[data-a="unlink"]')?.addEventListener('click', () => unlinkAccount(id));
  });
}

async function unlinkAccount(userId){
  if (!confirm('Отключить этот аккаунт от переключателя?')) return;
  try{
    await acsApiPost({ action:'unlink', user_id: userId });
    acsRemoveToken(userId);
    await loadLinkedAccounts();
    renderAccountsList();
    renderAccountsSlotsMeter();
    showToast('Аккаунт отключён', 'info');
  } catch(e){ showToast(e.message || 'Не удалось отключить', 'error'); }
}

function renderAccountsSlotsMeter(){
  const used = accountSlotsInfo.used + 1; // + сам текущий аккаунт
  const total = accountSlotsInfo.total + 1;
  const fill = $('#accSlotsFill');
  if (fill) fill.style.width = Math.min(100, (used / total) * 100) + '%';
  const label = $('#accSlotsLabel');
  if (label) label.textContent = `${used} / ${total} аккаунтов подключено`;
  const priceLabel = $('#accSlotPriceLabel');
  if (priceLabel) priceLabel.textContent = accountSlotsInfo.price;
  const atLimit = accountSlotsInfo.used >= accountSlotsInfo.total;
  $('#accountsLimitBlock').style.display = atLimit ? 'block' : 'none';
  $('#accountsAddBlock').style.display = atLimit ? 'none' : 'block';
}

async function openAccountsModal(){
  $('#accountsModal').classList.add('active');
  $('#accountsModalError').classList.remove('show');
  $('#addAccountForm').style.display = 'none';
  $('#addAccountForm').reset();
  $('#buyAccountSlotPanel').style.display = 'none';
  $('#accountsModalList').innerHTML = '<div class="notif-empty">Загрузка…</div>';
  await loadLinkedAccounts();
  renderAccountsList();
  renderAccountsSlotsMeter();
}
$('#btnManageAccounts')?.addEventListener('click', () => { closeAccountMenu(); openAccountsModal(); });
$('#accountsModalClose')?.addEventListener('click', () => $('#accountsModal').classList.remove('active'));
$('#accountsModal')?.addEventListener('click', e => { if (e.target.id === 'accountsModal') $('#accountsModal').classList.remove('active'); });

$('#btnShowAddAccountForm')?.addEventListener('click', () => {
  const form = $('#addAccountForm');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
});

$('#addAccountForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const errBox = $('#accountsModalError');
  errBox.classList.remove('show');
  const email = $('#addAccEmail').value.trim();
  const password = $('#addAccPass').value;
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Проверяем…';
  try{
    const data = await acsApiPost({ action:'link', email, password });
    acsSaveToken(data.account.user_id, data.account.token);
    $('#addAccountForm').reset();
    $('#addAccountForm').style.display = 'none';
    await loadLinkedAccounts();
    renderAccountsList();
    renderAccountsSlotsMeter();
    showToast('Аккаунт добавлен', 'ok');
  } catch(err){
    errBox.textContent = err.message || 'Не удалось добавить аккаунт';
    errBox.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Войти и добавить';
  }
});

$('#btnBuyAccountSlot')?.addEventListener('click', async () => {
  const panel = $('#buyAccountSlotPanel');
  const willShow = panel.style.display === 'none';
  panel.style.display = willShow ? 'block' : 'none';
  if (willShow){
    try{
      const r = await apiFetch('backend/api/plan.php', { credentials:'include' });
      const data = await r.json();
      const req = data.payment_requisites || {};
      const configured = !!req.card && req.card !== '0000 0000 0000 0000';
      $('#accSlotStepsWrap').style.display = configured ? '' : 'none';
      $('#accSlotNotConfigured').style.display = configured ? 'none' : 'block';
      $('#accSlotReqCard').textContent = req.card || '—';
      $('#accSlotReqHolder').textContent = req.holder || '—';
      $('#accSlotReqBank').textContent = req.bank || '—';
      $('#accSlotReqComment').textContent = req.comment || 'MYSAVDO';
    } catch(err){}
  }
});
$('#buyAccountSlotForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  try{
    await acsApiPost({ action:'purchase_slot', payer_name: $('#accSlotPayerName').value.trim(), payer_digits: $('#accSlotPayerDigits').value.trim() });
    showToast('Заявка отправлена — слот откроется после подтверждения', 'success');
    $('#buyAccountSlotPanel').style.display = 'none';
    $('#buyAccountSlotForm').reset();
  } catch(err){ showToast(err.message || 'Не удалось отправить заявку', 'error'); }
});

// --- «Путь продавца»: геймификация роста магазина ачивками и уровнями.
// Условия ачивок считаются на бэкенде живыми данными (achievements.php),
// тут только рендер и лёгкая обёртка над fetch.
const JOURNEY_RING_CIRCUMFERENCE = 2 * Math.PI * 28;

async function journeyFetch(){
  const r = await apiFetch('backend/api/achievements.php', { credentials:'include' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Не удалось загрузить путь продавца');
  return data;
}

function journeyFmtDate(iso){
  if (!iso) return '';
  const d = new Date(parseServerTime(iso));
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ru-RU', { day:'numeric', month:'short' });
}

function journeyCelebrate(data){
  (data.achievements || []).filter(a => a.just_unlocked).forEach(a => {
    showToast(`🎉 Новая ачивка: «${a.title}» (+${a.xp} XP)`, 'success');
  });
}

function renderJourney(data){
  const lvl = data.level;
  const idxEl = $('#journeyLevelIndex'); if (idxEl) idxEl.textContent = lvl.index;
  const ofEl = $('#journeyLevelOf'); if (ofEl) ofEl.textContent = `${lvl.index} / ${lvl.count}`;
  const titleEl = $('#journeyLevelTitle'); if (titleEl) titleEl.textContent = lvl.title;
  const subEl = $('#journeyLevelSub');
  if (subEl){
    subEl.textContent = lvl.next_title
      ? `${lvl.xp} XP · до «${lvl.next_title}» ещё ${lvl.next_min - lvl.xp} XP`
      : `${lvl.xp} XP · вы достигли максимального уровня`;
  }

  const ring = $('#journeyRingFill');
  if (ring){
    const offset = JOURNEY_RING_CIRCUMFERENCE - (Math.min(100, lvl.progress) / 100) * JOURNEY_RING_CIRCUMFERENCE;
    ring.style.strokeDasharray = String(JOURNEY_RING_CIRCUMFERENCE);
    ring.style.strokeDashoffset = String(JOURNEY_RING_CIRCUMFERENCE);
    requestAnimationFrame(() => { ring.style.strokeDashoffset = String(offset); });
  }

  const wrap = $('#journeyPath');
  if (wrap){
    wrap.innerHTML = (data.achievements || []).map((a, i) => {
      const side = i % 2 === 0 ? 'side-left' : 'side-right';
      const state = a.unlocked ? 'unlocked' : 'locked';
      const justNew = a.just_unlocked ? ' just-unlocked' : '';
      const badge = a.unlocked
        ? `<span class="journey-node-check"><svg class="icon" viewBox="0 0 24 24"><use href="#icon-check"/></svg></span>`
        : `<span class="journey-node-lock">🔒</span>`;
      const meta = a.unlocked ? `+${a.xp} XP · ${journeyFmtDate(a.unlocked_at)}` : `Заблокировано · +${a.xp} XP`;
      const newBadge = a.just_unlocked ? '<span class="journey-new-badge">Новое</span>' : '';
      return `
        <div class="journey-node-row ${side} ${state}${justNew}">
          <div class="journey-node">
            <div class="journey-node-circle">
              <svg class="icon" viewBox="0 0 24 24"><use href="#${a.icon}"/></svg>
              ${badge}
            </div>
            <div class="journey-node-card">
              <b>${escapeHtml(a.title)}${newBadge}</b>
              <p>${escapeHtml(a.desc)}</p>
              <em>${meta}</em>
            </div>
          </div>
        </div>`;
    }).join('');
  }
}

function updateJourneyMenuBadge(data){
  const badge = $('#journeyMenuBadge');
  if (!badge) return;
  badge.style.display = 'flex';
  badge.textContent = data.level.index;
}

async function refreshJourneyBadge(){
  if (!Auth.current()) return;
  try{
    const data = await journeyFetch();
    updateJourneyMenuBadge(data);
    journeyCelebrate(data);
  } catch(e){  }
}

async function openJourneyModal(){
  $('#accountMenu')?.classList.remove('open');
  $('#journeyModal').classList.add('active');
  try{
    const data = await journeyFetch();
    renderJourney(data);
    updateJourneyMenuBadge(data);
    journeyCelebrate(data);
  } catch(e){ showToast(e.message || 'Не удалось загрузить путь продавца', 'error'); }
}
$('#btnOpenJourney')?.addEventListener('click', openJourneyModal);
$('#journeyClose')?.addEventListener('click', () => $('#journeyModal').classList.remove('active'));
$('#journeyModal')?.addEventListener('click', e => { if (e.target.id === 'journeyModal') $('#journeyModal').classList.remove('active'); });

// --- Свои колонки воронки: кнопка «Все колонки» перед стандартными этапами
// (см. kanbanAllColumnsBtn выше) открывает эту модалку — тут и полный
// список, и добавление/переименование/удаление своих колонок.
async function fsApiPost(payload){
  const r = await apiFetch('backend/api/funnel-stages.php', {
    method:'POST', credentials:'include', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Не удалось выполнить действие');
  return data;
}
// Каждый POST (add/rename/delete/reorder/toggle) возвращает актуальные
// stages/order/hidden — применяем их и пересобираем COLUMNS одним и тем же
// способом, вместо того чтобы дублировать пересборку в каждом обработчике.
function applyFunnelStateResponse(data){
  customFunnelStages = data.stages || [];
  funnelColumnOrder = data.order || [];
  funnelHiddenKeys = data.hidden || [];
  applyColumnPrefs();
}

function renderFunnelStagesList(){
  const wrap = $('#funnelStagesList');
  if (!wrap) return;
  const visibleCount = COLUMNS.filter(c => !c.hidden).length;
  wrap.innerHTML = COLUMNS.map((col, i) => {
    const isBuiltin = BUILTIN_COLUMN_IDS.has(col.id);
    const lockChecked = !col.hidden && visibleCount <= 1; // последняя видимая — нельзя выключить
    return `
    <div class="funnel-stage-row${isBuiltin ? ' builtin' : ''}${col.hidden ? ' is-hidden' : ''}" data-key="${col.id}">
      <span class="funnel-stage-drag" draggable="true" title="Перетащите, чтобы изменить порядок">⠿</span>
      <span class="stage-dot"></span>
      <span class="funnel-stage-row-title">${escapeHtml(col.title)}</span>
      ${isBuiltin ? '<span class="funnel-stage-row-tag">Стандартная</span>' : ''}
      <div class="funnel-stage-row-actions">
        <button type="button" class="icon-btn" data-a="up" title="Переместить выше"${i === 0 ? ' disabled' : ''}>↑</button>
        <button type="button" class="icon-btn" data-a="down" title="Переместить ниже"${i === COLUMNS.length - 1 ? ' disabled' : ''}>↓</button>
        ${!isBuiltin ? `
        <button type="button" class="icon-btn" data-a="rename" title="Переименовать">✎</button>
        <button type="button" class="icon-btn danger" data-a="delete" title="Удалить"><svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-trash"/></svg></button>` : ''}
        <label class="switch" title="${col.hidden ? 'Включить колонку' : 'Скрыть колонку'}">
          <input type="checkbox" data-a="toggle" ${!col.hidden ? 'checked' : ''}${lockChecked ? ' disabled' : ''}>
          <span class="switch-track"></span>
        </label>
      </div>
    </div>`;
  }).join('');

  $$('.funnel-stage-row', wrap).forEach(row => {
    const key = row.dataset.key;
    row.querySelector('[data-a="rename"]')?.addEventListener('click', () => renameFunnelStage(key, row));
    row.querySelector('[data-a="delete"]')?.addEventListener('click', () => deleteFunnelStage(key));
    row.querySelector('[data-a="up"]')?.addEventListener('click', () => moveFunnelColumn(key, -1));
    row.querySelector('[data-a="down"]')?.addEventListener('click', () => moveFunnelColumn(key, 1));
    row.querySelector('[data-a="toggle"]')?.addEventListener('change', e => {
      const checked = e.target.checked;
      if (!checked && COLUMNS.filter(c => !c.hidden).length <= 1){
        e.target.checked = true;
        showToast('Нужна хотя бы одна активная колонка', 'error');
        return;
      }
      toggleFunnelColumn(key, !checked);
    });
  });
  attachFunnelStageDnD(wrap);
}

// Перетаскивание за ручку ⠿ (не за всю строку — иначе клики по кнопкам
// ↑/↓/✎/✕ и по переключателю то и дело срывались бы в drag). Порядок
// сохраняется по drop — как только строки на экране расставлены как нужно.
function attachFunnelStageDnD(wrap){
  $$('.funnel-stage-row', wrap).forEach(row => {
    const handle = row.querySelector('.funnel-stage-drag');
    handle?.addEventListener('dragstart', e => {
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.key);
    });
    handle?.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', e => {
      e.preventDefault();
      const dragging = wrap.querySelector('.funnel-stage-row.dragging');
      if (!dragging || dragging === row) return;
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      wrap.insertBefore(dragging, before ? row : row.nextSibling);
    });
    row.addEventListener('drop', e => {
      e.preventDefault();
      const keys = $$('.funnel-stage-row', wrap).map(r => r.dataset.key);
      reorderFunnelColumns(keys);
    });
  });
}

async function openFunnelStagesModal(){
  $('#funnelStagesModal').classList.add('active');
  $('#funnelStagesError').classList.remove('show');
  renderFunnelStagesList();
  await loadFunnelStages();
  renderFunnelStagesList();
}
$('#funnelStagesClose')?.addEventListener('click', () => $('#funnelStagesModal').classList.remove('active'));
$('#funnelStagesModal')?.addEventListener('click', e => { if (e.target.id === 'funnelStagesModal') $('#funnelStagesModal').classList.remove('active'); });

$('#addFunnelStageForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#newFunnelStageTitle');
  const errBox = $('#funnelStagesError');
  errBox.classList.remove('show');
  try{
    const data = await fsApiPost({ action:'add', title: input.value.trim() });
    applyFunnelStateResponse(data);
    input.value = '';
    renderFunnelStagesList();
    renderKanban();
    showToast('Колонка добавлена', 'success');
  } catch(err){
    errBox.textContent = err.message || 'Не удалось добавить колонку';
    errBox.classList.add('show');
  }
});

async function renameFunnelStage(key, row){
  const current = row.querySelector('.funnel-stage-row-title')?.textContent || '';
  const title = (prompt('Новое название колонки:', current) || '').trim();
  if (!title || title === current) return;
  try{
    const data = await fsApiPost({ action:'rename', key, title });
    applyFunnelStateResponse(data);
    renderFunnelStagesList();
    renderAll();
  } catch(err){ showToast(err.message || 'Не удалось переименовать колонку', 'error'); }
}

async function deleteFunnelStage(key){
  if (!confirm('Удалить колонку? Карточки из неё переедут в «Новый запрос».')) return;
  try{
    const data = await fsApiPost({ action:'delete', key });
    applyFunnelStateResponse(data);
    await loadDashboardClients();
    renderFunnelStagesList();
    renderAll();
    showToast('Колонка удалена', 'info');
  } catch(err){ showToast(err.message || 'Не удалось удалить колонку', 'error'); }
}

async function reorderFunnelColumns(keys){
  try{
    const data = await fsApiPost({ action:'reorder', keys });
    applyFunnelStateResponse(data);
    renderFunnelStagesList();
    renderAll();
  } catch(err){
    showToast(err.message || 'Не удалось изменить порядок колонок', 'error');
    renderFunnelStagesList();
  }
}

function moveFunnelColumn(key, dir){
  const keys = COLUMNS.map(c => c.id);
  const i = keys.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= keys.length) return;
  [keys[i], keys[j]] = [keys[j], keys[i]];
  reorderFunnelColumns(keys);
}

async function toggleFunnelColumn(key, hidden){
  try{
    const data = await fsApiPost({ action:'toggle', key, hidden });
    applyFunnelStateResponse(data);
    renderFunnelStagesList();
    renderAll();
  } catch(err){
    showToast(err.message || 'Не удалось изменить колонку', 'error');
    renderFunnelStagesList();
  }
}
