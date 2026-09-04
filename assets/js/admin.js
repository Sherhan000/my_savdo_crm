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

function esc(str){
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

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
  el.innerHTML = `<div class="toast-txt"><span>${esc(text)}</span></div>`;
  _toastWrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, 3400);
}

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
$$('input[type="password"]').forEach(attachPasswordToggle);

async function adminApi(action, payload = {}){
  const r = await apiFetch('backend/api/admin.php', {
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action, ...payload }),
  });
  const raw = await r.text();
  let data;
  try{ data = JSON.parse(raw); } catch(e){ throw new Error('Сервер вернул не JSON — проверьте, что сайт запущен через PHP.'); }
  if (!r.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

function showLoginScreen(){
  $('#adminLoginScreen').style.display = 'flex';
  $('#adminAppScreen').style.display = 'none';
  $('#adminPageWho').style.display = 'none';
  clearInterval(adminSupPollTimer);
  setTimeout(() => $('#adminLoginUsername')?.focus(), 50);
}

async function showAdminApp(username){
  $('#adminLoginScreen').style.display = 'none';
  $('#adminAppScreen').style.display = 'block';
  $('#adminPageWho').style.display = 'flex';
  $('#adminWhoName').textContent = username || '';
  try{
    const data = await refreshAdminUsers();
    const logo = (data.settings && data.settings.logo) || 'assets/img/logo.png';
    $('#adminLogoPreview').src = logo;
    applyPaymentSettings(data.settings || {});
    loadAdminOverview();
    loadAdminPayments();
    loadAdminSupportThreads(true);
    loadAdminSupportBot();
    loadAdminAiBadge();
  } catch(e){
    showToast(e.message, 'info');
  }
}

async function initAdmin(){
  try{
    const who = await adminApi('whoami');
    showAdminApp(who.username);
  } catch(e){
    showLoginScreen();
  }
}

$('#adminLoginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = $('#adminLoginError');
  errEl.textContent = '';
  const username = $('#adminLoginUsername').value.trim();
  const password = $('#adminLoginPassword').value;
  try{
    const data = await adminApi('login', { username, password });
    $('#adminLoginPassword').value = '';
    showAdminApp(data.username);
  } catch(err){
    errEl.textContent = err.message || 'Неверный логин или пароль';
  }
});

$('#btnAdminLogout').addEventListener('click', async () => {
  try{ await adminApi('logout_admin'); } catch(_){}
  showLoginScreen();
});

$('#adminChangePassForm').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = $('#adminChangePassError');
  errEl.textContent = '';
  const current_password = $('#adminCurPass').value;
  const new_password = $('#adminNewOwnPass').value;
  try{
    await adminApi('change_password', { current_password, new_password });
    $('#adminChangePassForm').reset();
    showToast('Пароль администратора изменён', 'ok');
  } catch(err){
    errEl.textContent = err.message;
  }
});

async function loadAdminPayments(){
  const list = $('#adminPaymentsList');
  try{
    const data = await adminApi('list_payments');
    const pays = data.payments || [];
    const pending = pays.filter(p => p.status === 'pending');
    const badge = $('#adminPayBadge');
    badge.style.display = pending.length ? 'inline-flex' : 'none';
    badge.textContent = pending.length;
    if (!pays.length){
      list.innerHTML = '<div class="notif-empty">Платежей пока нет</div>';
      return;
    }
    const PLAN_T = { demo:'Демо', standard:'Стандарт', business:'Бизнес' };
    const STATUS = { pending:['Ожидает','wait'], approved:['Подтверждён','ok'], rejected:['Отклонён','bad'] };
    list.innerHTML = pays.map(p => {
      const [label, cls] = STATUS[p.status] || [p.status, ''];
      return `
      <div class="admin-pay-row" data-id="${p.id}">
        <div class="admin-pay-info">
          <b>${esc(p.shop_name || p.email)} → «${esc(PLAN_T[p.plan] || p.plan)}» · ${Number(p.amount)} сомони</b>
          <span>Отправитель: ${esc(p.payer_name || '—')} · карта *${esc(p.payer_digits || '····')} · ${fmtTime(parseServerTime(p.created_at))}</span>
        </div>
        ${p.status === 'pending'
          ? `<div class="admin-pay-actions">
               <button class="btn btn-primary btn-sm" data-decide="1">Подтвердить</button>
               <button class="btn btn-ghost btn-sm" data-decide="0">Отклонить</button>
             </div>`
          : `<span class="payment-status ${cls}">${label}</span>`}
      </div>`;
    }).join('');
    $$('.admin-pay-row [data-decide]', list).forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.closest('.admin-pay-row').dataset.id);
        const approve = btn.dataset.decide === '1';
        if (!approve && !confirm('Отклонить этот платёж?')) return;
        // Отключаем обе кнопки строки сразу — без этого быстрый двойной клик
        // по «Подтвердить» уходил на сервер двумя запросами подряд, пока первый
        // ещё не ответил (см. защиту от гонки на бэкенде, admin.php).
        const row = btn.closest('.admin-pay-row');
        $$('[data-decide]', row).forEach(b => b.disabled = true);
        try{
          await adminApi('decide_payment', { payment_id: id, approve });
          showToast(approve ? 'Платёж подтверждён — тариф активирован' : 'Платёж отклонён', approve ? 'ok' : 'info');
          loadAdminPayments();
          await refreshAdminUsers();
        } catch(e){
          showToast(e.message, 'info');
          $$('[data-decide]', row).forEach(b => b.disabled = false);
        }
      });
    });
  } catch(e){
    list.innerHTML = `<div class="notif-empty">${esc(e.message)}</div>`;
  }
}
$('#adminPayRefresh')?.addEventListener('click', loadAdminPayments);

const ADMIN_FEATURE_DEFS = [
  { key:'panel_funnel',    label:'Раздел «Воронка»',      type:'bool' },
  { key:'panel_analytics', label:'Раздел «Аналитика»',    type:'bool' },
  { key:'panel_clients',   label:'Раздел «Клиенты»',      type:'bool' },
  { key:'panel_plan',      label:'Раздел «Тариф»',        type:'bool' },
  { key:'ai_chat',        label:'Чат ИИ',                 type:'bool' },
  { key:'ai_reply',       label:'ИИ-подсказки в чатах',   type:'bool' },
  { key:'ai_auto',        label:'ИИ-автоответчик',        type:'bool' },
  { key:'analytics_full', label:'Полная аналитика',       type:'bool' },
  { key:'can_send',       label:'Отправка сообщений',     type:'bool' },
  { key:'ai_daily_limit', label:'Лимит чата ИИ в день (пусто = безлимит, 0 = запрет)', type:'int_or_null' },
  { key:'socials_limit',  label:'Лимит соцсетей (1 = Instagram или Telegram, 2 = оба одновременно)', type:'int' },
  { key:'clients_limit',  label:'Лимит заявок (пусто = безлимит)', type:'int_or_null' },
];
const ADMIN_PLAN_TITLES = { none:'Без тарифа', demo:'Демо', standard:'Стандарт', business:'Бизнес', employee_slots:'Места сотрудников', account_slots:'Слот переключения аккаунтов' };

// Кэш последнего списка пользователей — поиск/фильтр по тарифу работают по
// уже загруженным данным, без похода на сервер на каждое нажатие клавиши.
let _adminUsersCache = [];
let adminUsersSearch = '';
let adminUsersPlanFilter = 'all';

async function refreshAdminUsers(){
  const data = await adminApi('list_users');
  _adminUsersCache = data.users || [];
  renderFilteredAdminUsers();
  return data;
}
function renderFilteredAdminUsers(){
  let users = _adminUsersCache;
  if (adminUsersPlanFilter !== 'all') users = users.filter(u => (u.active_plan || 'none') === adminUsersPlanFilter);
  if (adminUsersSearch){
    const q = adminUsersSearch.toLowerCase();
    users = users.filter(u => (u.shop_name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q));
  }
  renderAdminUsers(users, _adminUsersCache.length ? 'Ничего не найдено' : 'Пока нет пользователей');
}
let _adminUsersSearchTimer = null;
$('#adminUsersSearch')?.addEventListener('input', e => {
  clearTimeout(_adminUsersSearchTimer);
  const val = e.target.value.trim();
  _adminUsersSearchTimer = setTimeout(() => { adminUsersSearch = val; renderFilteredAdminUsers(); }, 150);
});
$('#adminUsersPlanFilter')?.addEventListener('change', e => {
  adminUsersPlanFilter = e.target.value;
  renderFilteredAdminUsers();
});

$('#adminExportUsersBtn')?.addEventListener('click', async () => {
  try{
    const data = await adminApi('export_users_csv');
    const blob = new Blob(['\uFEFF' + data.csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mysavdo-users-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch(e){ showToast(e.message, 'info'); }
});

function renderAdminUsers(users, emptyMessage = 'Пока нет пользователей'){
  const list = $('#adminUsersList');
  if (!users.length){ list.innerHTML = `<div class="notif-empty">${esc(emptyMessage)}</div>`; return; }
  list.innerHTML = users.map(u => {
    const plan = u.active_plan || 'none';
    const hasOverrides = u.feature_overrides && Object.keys(u.feature_overrides).length > 0;
    const displayName = u.shop_name || 'Без названия';
    const pres = presenceInfo(u.last_active_at);
    return `
    <div class="admin-user-block" data-id="${u.id}">
      <div class="admin-user-row">
        <div class="kcard-avatar">${esc((u.shop_name || u.email || '?')[0].toUpperCase())}</div>
        <div class="admin-user-info">
          <b><span class="online-dot ${pres.online ? 'on' : ''}" title="${esc(pres.label)}"></span> ${esc(displayName)}</b>
          <span>${esc(u.email)} · тариф: ${esc(ADMIN_PLAN_TITLES[plan] || plan)}${hasOverrides ? ' · <i>изменены функции</i>' : ''} · ${esc(pres.label)}</span>
        </div>
        <button class="btn btn-ghost btn-sm admin-user-expand" type="button">Управлять</button>
        <button class="admin-user-del" title="Удалить"><svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-trash"/></svg></button>
      </div>
      <div class="admin-user-manage" style="display:none;">
        <div class="admin-manage-row">
          <label>Выдать тариф бесплатно</label>
          <div class="admin-manage-inline">
            <select class="admin-plan-select">
              <option value="demo">Демо</option>
              <option value="standard">Стандарт</option>
              <option value="business">Бизнес</option>
            </select>
            <button class="btn btn-primary btn-sm admin-grant-btn" type="button">Выдать</button>
          </div>
        </div>
        <div class="admin-manage-row">
          <label>Бонусные сообщения ИИ <span class="admin-bonus-cur">(сейчас: ${Number(u.ai_bonus ?? 0)})</span></label>
          <div class="admin-manage-inline">
            <input type="number" class="admin-bonus-input" value="5" min="-1000" max="1000" title="Сколько начислить (можно с минусом, чтобы списать)">
            <button class="btn btn-primary btn-sm admin-bonus-btn" type="button">Начислить</button>
          </div>
        </div>
        <div class="admin-manage-label">Индивидуальные функции <span>(переопределяют тариф именно для этого пользователя)</span></div>
        <div class="admin-features-grid">
          ${ADMIN_FEATURE_DEFS.map(def => {
            const eff = (u.features || {})[def.key];
            if (def.type === 'bool'){
              return `<label class="admin-feat-row"><span>${esc(def.label)}</span>
                <label class="switch"><input type="checkbox" data-feat="${def.key}" ${eff ? 'checked' : ''}><span class="switch-track"></span></label></label>`;
            }
            const val = (eff === null || eff === undefined) ? '' : eff;
            return `<label class="admin-feat-row"><span>${esc(def.label)}</span>
              <input type="number" min="0" class="admin-feat-num" data-feat="${def.key}" value="${esc(val)}" placeholder="${def.type==='int_or_null'?'∞':''}"></label>`;
          }).join('')}
        </div>
        <div class="admin-manage-actions">
          <button class="btn btn-ghost btn-sm admin-feat-reset" type="button">Сбросить к тарифу</button>
          <button class="btn btn-primary btn-sm admin-feat-save" type="button">Сохранить функции</button>
        </div>
      </div>
    </div>`;
  }).join('');

  $$('.admin-user-expand', list).forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = btn.closest('.admin-user-block').querySelector('.admin-user-manage');
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
      btn.textContent = open ? 'Управлять' : 'Свернуть';
    });
  });
  $$('.admin-grant-btn', list).forEach(btn => {
    btn.addEventListener('click', async () => {
      const block = btn.closest('.admin-user-block');
      const id = Number(block.dataset.id);
      const plan = block.querySelector('.admin-plan-select').value;
      try{
        await adminApi('grant_plan', { user_id: id, plan });
        showToast('Тариф выдан пользователю', 'ok');
        await refreshAdminUsers();
      } catch(e){ showToast(e.message, 'info'); }
    });
  });
  $$('.admin-bonus-btn', list).forEach(btn => {
    btn.addEventListener('click', async () => {
      const block = btn.closest('.admin-user-block');
      const id = Number(block.dataset.id);
      const amount = Number(block.querySelector('.admin-bonus-input').value || 0);
      if (!amount) return;
      try{
        const r = await adminApi('grant_bonus', { user_id: id, amount });
        block.querySelector('.admin-bonus-cur').textContent = `(сейчас: ${r.ai_bonus})`;
        showToast(amount > 0 ? `Начислено ${amount} бонусных сообщений ИИ` : 'Бонус списан', 'ok');
      } catch(e){ showToast(e.message, 'info'); }
    });
  });
  $$('.admin-feat-save', list).forEach(btn => {
    btn.addEventListener('click', async () => {
      const block = btn.closest('.admin-user-block');
      const id = Number(block.dataset.id);
      const overrides = {};
      $$('.admin-features-grid [data-feat]', block).forEach(inp => {
        const key = inp.dataset.feat;
        if (inp.type === 'checkbox') overrides[key] = inp.checked;
        else overrides[key] = inp.value === '' ? null : Number(inp.value);
      });
      try{
        await adminApi('set_features', { user_id: id, overrides });
        showToast('Функции пользователя сохранены', 'ok');
      } catch(e){ showToast(e.message, 'info'); }
    });
  });
  $$('.admin-feat-reset', list).forEach(btn => {
    btn.addEventListener('click', async () => {
      const block = btn.closest('.admin-user-block');
      const id = Number(block.dataset.id);
      try{
        await adminApi('set_features', { user_id: id, overrides: {} });
        showToast('Функции сброшены к настройкам тарифа', 'ok');
        await refreshAdminUsers();
      } catch(e){ showToast(e.message, 'info'); }
    });
  });
  $$('.admin-user-del', list).forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('.admin-user-block');
      const id = Number(row.dataset.id);
      if (!confirm('Удалить этого пользователя?')) return;
      try{
        await adminApi('delete_user', { id });
        await refreshAdminUsers();
      } catch(e){ showToast(e.message, 'info'); }
    });
  });
}

$('#adminAddUserBtn').addEventListener('click', () => {
  $('#adminAddUserForm').style.display = $('#adminAddUserForm').style.display === 'none' ? 'block' : 'none';
});
$('#adminAddUserCancel').addEventListener('click', () => { $('#adminAddUserForm').style.display = 'none'; });
$('#adminAddUserForm').addEventListener('submit', async e => {
  e.preventDefault();
  try{
    await adminApi('add_user', {
      shop_name: $('#adminNewShop').value.trim(),
      email: $('#adminNewEmail').value.trim(),
      password: $('#adminNewPass').value,
    });
    await refreshAdminUsers();
    $('#adminAddUserForm').reset();
    $('#adminAddUserForm').style.display = 'none';
  } catch(e){ showToast(e.message, 'info'); }
});

$('#adminLogoUploadBtn').addEventListener('click', () => $('#adminLogoInput').click());
$('#adminLogoInput').addEventListener('change', async () => {
  const file = $('#adminLogoInput').files[0];
  $('#adminLogoInput').value = '';
  if (!file) return;
  try{
    const fd = new FormData();
    fd.append('photo', file);
    const r = await apiFetch('backend/api/upload.php', { method:'POST', credentials:'include', body: fd });
    const raw = await r.text();
    let data;
    try{ data = JSON.parse(raw); } catch(e){ throw new Error('Сервер вернул не JSON.'); }
    if (!r.ok || !data.url) throw new Error(data.error || 'Не удалось загрузить логотип');
    const res = await adminApi('set_logo', { logo: data.url });
    $('#adminLogoPreview').src = res.settings.logo;
  } catch(e){ showToast(e.message, 'info'); }
});
$('#adminLogoResetBtn').addEventListener('click', async () => {
  try{
    const res = await adminApi('set_logo', { logo: 'assets/img/logo.png' });
    $('#adminLogoPreview').src = res.settings.logo;
  } catch(e){ showToast(e.message, 'info'); }
});

function applyPaymentSettings(settings){
  $('#adminPayCard').value = settings.payment_card || '';
  $('#adminPayHolder').value = settings.payment_holder || '';
  $('#adminPayBank').value = settings.payment_bank || '';
  $('#adminPayComment').value = settings.payment_comment || '';
  if (settings.payment_qr){
    $('#adminPayQrPreview').src = settings.payment_qr;
    $('#adminPayQrPreview').style.display = '';
  } else {
    $('#adminPayQrPreview').style.display = 'none';
  }
}

$('#adminPaySaveBtn').addEventListener('click', async () => {
  try{
    const res = await adminApi('set_payment_requisites', {
      card: $('#adminPayCard').value.trim(),
      holder: $('#adminPayHolder').value.trim(),
      bank: $('#adminPayBank').value.trim(),
      comment: $('#adminPayComment').value.trim(),
    });
    applyPaymentSettings(res.settings);
    showToast('Реквизиты сохранены', 'ok');
  } catch(e){ showToast(e.message, 'info'); }
});

$('#adminPayQrUploadBtn').addEventListener('click', () => $('#adminPayQrInput').click());
$('#adminPayQrInput').addEventListener('change', async () => {
  const file = $('#adminPayQrInput').files[0];
  $('#adminPayQrInput').value = '';
  if (!file) return;
  try{
    const fd = new FormData();
    fd.append('photo', file);
    const r = await apiFetch('backend/api/upload.php', { method:'POST', credentials:'include', body: fd });
    const raw = await r.text();
    let data;
    try{ data = JSON.parse(raw); } catch(e){ throw new Error('Сервер вернул не JSON.'); }
    if (!r.ok || !data.url) throw new Error(data.error || 'Не удалось загрузить QR-код');
    const res = await adminApi('set_payment_requisites', { qr: data.url });
    applyPaymentSettings(res.settings);
  } catch(e){ showToast(e.message, 'info'); }
});
$('#adminPayQrResetBtn').addEventListener('click', async () => {
  try{
    const res = await adminApi('set_payment_requisites', { qr: '' });
    applyPaymentSettings(res.settings);
  } catch(e){ showToast(e.message, 'info'); }
});

function switchAdminTab(tab){
  const btn = $(`#adminTabs .admin-tab[data-atab="${tab}"]`);
  if (!btn) return;
  $$('#adminTabs .admin-tab').forEach(b => b.classList.toggle('active', b === btn));
  $$('.admin-tab-view').forEach(v => v.classList.toggle('active', v.dataset.aview === tab));
  if (tab === 'support'){ loadAdminSupportThreads(); }
  else { clearInterval(adminSupPollTimer); }
  if (tab === 'payments'){ loadAdminPayments(); }
  if (tab === 'settings'){ loadAdminSupportBot(); }
  if (tab === 'stats'){ loadAdminStats(); }
  if (tab === 'ai'){ loadAdminAiFeedback(); }
  if (tab === 'stories'){ loadAdminStories(); }
  if (tab === 'overview'){ loadAdminOverview(); }
}
$$('#adminTabs .admin-tab').forEach(btn => {
  btn.addEventListener('click', () => switchAdminTab(btn.dataset.atab));
});

/* ============================================================
   Обзор — стартовая вкладка: ключевые цифры и быстрые ссылки,
   чтобы не листать все вкладки, чтобы понять, что происходит.
   ============================================================ */

async function loadAdminOverview(){
  const cards = $('#adminOverviewCards');
  const ru = $('#adminOverviewRecentUsers');
  const rp = $('#adminOverviewRecentPayments');
  try{
    const data = await adminApi('overview');
    cards.innerHTML = [
      statCard('Всего пользователей', String(data.total_users)),
      statCard('Сейчас в сети', String(data.online_now)),
      statCard('Активны сегодня', String(data.active_today)),
      statCard('Новых за 7 дней', String(data.new_users_7d)),
      statCard('Платежи в ожидании', String(data.payments_pending)),
      statCard('Непрочитано в поддержке', String(data.support_unread)),
      statCard('Плохих оценок ИИ', String(data.ai_down)),
    ].join('');

    const users = data.recent_users || [];
    ru.innerHTML = users.length ? users.map(u => `
      <div class="admin-pay-row">
        <div class="admin-pay-info"><b>${esc(u.shop_name || u.email)}</b><span>${esc(u.email)} · ${fmtTime(parseServerTime(u.created_at))}</span></div>
      </div>`).join('') : '<div class="notif-empty">Пока нет пользователей</div>';

    const pays = data.recent_payments || [];
    rp.innerHTML = pays.length ? pays.map(p => `
      <div class="admin-pay-row">
        <div class="admin-pay-info"><b>${esc(p.shop_name || p.email)} → «${esc(ADMIN_PLAN_TITLES[p.plan] || p.plan)}»</b><span>${Number(p.amount)} сомони · ${fmtTime(parseServerTime(p.created_at))}</span></div>
      </div>`).join('') : '<div class="notif-empty">Нет платежей в ожидании</div>';

    renderAdminBusinessMetrics(data.business);
  } catch(e){
    cards.innerHTML = `<div class="notif-empty">${esc(e.message)}</div>`;
    ru.innerHTML = ''; rp.innerHTML = '';
  }
}

function renderAdminBusinessMetrics(b){
  if (!b) return;

  $('#adminBizCards').innerHTML = [
    statCard('Выручка за месяц', `${b.revenue_month} сомони`),
    statCard('Выручка всего', `${b.revenue_total} сомони`),
    statCard('Платят сейчас', String(b.paid_users_now)),
    statCard('Средний чек / мес (ARPU)', `${b.arpu_month} сомони`),
    statCard('Конверсия по всей платформе', `${b.platform_conversion_pct}%`),
    statCard('Сделок закрыто за месяц', `${b.deals_done_month} · ${b.deals_value_month} сомони`),
  ].join('');

  renderRevenueChart($('#adminRevenueChart'), b.revenue_trend_30d || []);

  const mix = b.plan_mix || {};
  const totalMix = Object.values(mix).reduce((s, n) => s + n, 0) || 1;
  const mixOrder = ['business', 'standard', 'demo', 'none'];
  $('#adminPlanMix').innerHTML = mixOrder.filter(k => mix[k]).map(k => {
    const n = mix[k];
    const pct = Math.round(n / totalMix * 100);
    return `<div class="admin-pay-row">
      <div class="admin-pay-info"><b>${esc(ADMIN_PLAN_TITLES[k] || k)}</b><span>${n} польз. · ${pct}%</span></div>
    </div>`;
  }).join('') || '<div class="notif-empty">Нет данных</div>';

  const a = b.adoption || {};
  $('#adminAdoption').innerHTML = [
    ['Есть свой магазин (мульти-переключение)', a.shops_pct],
    ['Подключён Telegram', a.telegram_pct],
    ['Подключён Instagram', a.instagram_pct],
  ].map(([label, pct]) => `<div class="admin-pay-row">
      <div class="admin-pay-info"><b>${esc(label)}</b><span>${pct}% пользователей</span></div>
    </div>`).join('')
    + `<div class="admin-pay-row"><div class="admin-pay-info"><b>Заявок с ИИ-автоответом</b><span>${a.ai_auto_clients || 0}</span></div></div>`
    + `<div class="admin-pay-row"><div class="admin-pay-info"><b>Активных сотрудников по всем магазинам</b><span>${a.employees_active || 0}</span></div></div>`;

  const r = b.retention || {};
  $('#adminRetentionCards').innerHTML = [
    statCard('Когорта 7–30 дней', String(r.cohort_7_30d || 0)),
    statCard('Из них ещё активны', String(r.cohort_retained || 0), null),
    statCard('Удержание', `${r.cohort_retained_pct || 0}%`),
    statCard('Риск оттока (14+ дней тишины)', String(r.at_risk_users || 0)),
  ].join('');
}
$('#adminOverviewRefresh')?.addEventListener('click', loadAdminOverview);
$('#adminOverviewGoUsers')?.addEventListener('click', () => switchAdminTab('users'));
$('#adminOverviewGoPayments')?.addEventListener('click', () => switchAdminTab('payments'));

$('#adminStatsRefresh')?.addEventListener('click', () => loadAdminStats());

function fmtDuration(ms){
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin} мин`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

async function loadAdminStats(){
  const clicksBox = $('#adminStatsClicks');
  const screensBox = $('#adminStatsScreens');
  try{
    const data = await adminApi('track_stats');
    $('#adminStatsUsers').textContent = `Отслежено пользователей: ${data.users_tracked || 0}`;

    const clicks = data.clicks || [];
    clicksBox.innerHTML = clicks.length
      ? clicks.map(c => `
        <div class="admin-pay-row">
          <div class="admin-pay-info"><b>${esc(c.target)}</b><span>${c.count} кликов</span></div>
        </div>`).join('')
      : '<div class="notif-empty">Пока нет данных</div>';

    const screens = data.screens || [];
    screensBox.innerHTML = screens.length
      ? screens.map(s => `
        <div class="admin-pay-row">
          <div class="admin-pay-info"><b>${esc(screenLabel(s.screen))}</b><span>${fmtDuration(s.total_ms)}</span></div>
        </div>`).join('')
      : '<div class="notif-empty">Пока нет данных</div>';
  } catch(e){
    clicksBox.innerHTML = '<div class="notif-empty">Не удалось загрузить</div>';
    screensBox.innerHTML = '';
    showToast(e.message, 'info');
  }
  loadAdminActivityOverview();
  loadAdminActivityUsers();
}

/* ============================================================
   Активность пользователей: онлайн/оффлайн, "был(а) в сети",
   клики/время по дням, фильтр периода, сравнение сегодня/вчера.
   ============================================================ */

const ADMIN_RANGE_LABELS = { '24h':'за 24 часа', '48h':'за 48 часов', '7d':'за неделю', '30d':'за месяц', '6m':'за 6 месяцев', '1y':'за год' };
let adminActivityRange = '7d';

function pluralDays(n){
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return 'день';
  if ([2,3,4].includes(n10) && ![12,13,14].includes(n100)) return 'дня';
  return 'дней';
}
// Тот же принцип, что и presence-метки для клиентов в основном приложении:
// "в сети" / "был(а) N назад" / "не был(а) N дней" — считаем на клиенте по
// last_active_at, которое пишет backend/config/store.php::touch_presence().
function presenceInfo(lastActiveAt){
  if (!lastActiveAt) return { online:false, label:'ещё не заходил(а)' };
  const ts = parseServerTime(lastActiveAt);
  const min = (Date.now() - ts) / 60000;
  if (min < 2) return { online:true, label:'в сети' };
  if (min < 60) return { online:false, label:`был(а) ${Math.round(min)} мин назад` };
  const h = Math.floor(min / 60);
  if (h < 24) return { online:false, label:`был(а) ${h} ч назад` };
  const days = Math.floor(h / 24);
  return { online:false, label:`не был(а) ${days} ${pluralDays(days)}` };
}

function statCard(label, value, deltaPct){
  const hasDelta = typeof deltaPct === 'number';
  const up = hasDelta && deltaPct >= 0;
  const delta = hasDelta
    ? `<span class="admin-stat-delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(deltaPct)}%</span>`
    : '';
  return `<div class="admin-stat-card"><span class="admin-stat-label">${esc(label)}</span><b class="admin-stat-value">${esc(value)}</b>${delta}</div>`;
}

// Для длинных периодов (полгода/год) дневные бары нечитаемы — сворачиваем в месяцы.
function bucketSeries(series, range){
  if (range !== '6m' && range !== '1y') return series;
  const map = new Map();
  series.forEach(d => {
    const key = d.date.slice(0, 7);
    const cur = map.get(key) || { date: key, active_ms:0, clicks:0 };
    cur.active_ms += d.active_ms;
    cur.clicks += d.clicks;
    map.set(key, cur);
  });
  return [...map.values()];
}

let _chartTooltipEl = null;
function chartTooltip(){
  if (!_chartTooltipEl){
    _chartTooltipEl = document.createElement('div');
    _chartTooltipEl.className = 'admin-chart-tooltip';
    document.body.appendChild(_chartTooltipEl);
  }
  return _chartTooltipEl;
}
function showChartTooltip(evt, title, value){
  const tip = chartTooltip();
  tip.innerHTML = '';
  const b = document.createElement('b'); b.textContent = value;
  const s = document.createElement('span'); s.textContent = title;
  tip.appendChild(b); tip.appendChild(s);
  tip.style.display = 'flex';
  tip.style.left = Math.min(window.innerWidth - 160, evt.clientX + 14) + 'px';
  tip.style.top = Math.max(8, evt.clientY - 44) + 'px';
}
function hideChartTooltip(){ if (_chartTooltipEl) _chartTooltipEl.style.display = 'none'; }

// Простой столбчатый график на инлайн-SVG — без внешних библиотек, как и
// весь остальной проект. Один ряд (время в мс), подпись и значение — в
// тултипе по наведению/фокусу на столбец (сам столбец — область наведения).
// valueOf по умолчанию — active_ms, чтобы не трогать существующий вызов
// (график активности); revenue-график ниже передаёт свой аксессор.
function buildBarChart(container, series, { dateLabel, valueLabel, valueOf, ariaLabel }){
  const getValue = valueOf || (d => d.active_ms);
  container.innerHTML = '';
  if (!series.length){ container.innerHTML = '<div class="notif-empty">Пока нет данных</div>'; return; }
  const W = Math.max(240, container.clientWidth || 560);
  const H = 150, padT = 10, padB = 20;
  const n = series.length;
  const gap = n > 40 ? 1 : 4;
  const bw = Math.max(2, Math.min(26, (W - gap * (n - 1)) / n));
  const usedW = bw * n + gap * (n - 1);
  const startX = Math.max(0, (W - usedW) / 2);
  const max = Math.max(1, ...series.map(getValue));
  const baseY = H - padB;

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'admin-chart-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', ariaLabel || 'Время в приложении по дням');

  const base = document.createElementNS(svgNs, 'line');
  base.setAttribute('x1', '0'); base.setAttribute('x2', String(W));
  base.setAttribute('y1', String(baseY)); base.setAttribute('y2', String(baseY));
  base.setAttribute('class', 'admin-chart-axis');
  svg.appendChild(base);

  series.forEach((d, i) => {
    const v = getValue(d);
    const h = max > 0 ? Math.round((v / max) * (baseY - padT)) : 0;
    const x = startX + i * (bw + gap);
    const y = baseY - Math.max(h, v > 0 ? 2 : 0);
    const rect = document.createElementNS(svgNs, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(bw));
    rect.setAttribute('height', String(Math.max(h, v > 0 ? 2 : 0.5)));
    rect.setAttribute('rx', String(Math.min(4, bw / 2)));
    rect.setAttribute('class', 'admin-chart-bar');
    rect.setAttribute('tabindex', '0');
    const title = dateLabel(d);
    const value = valueLabel(d);
    rect.addEventListener('pointerenter', () => rect.classList.add('hover'));
    rect.addEventListener('pointerleave', () => { rect.classList.remove('hover'); hideChartTooltip(); });
    rect.addEventListener('pointermove', e => showChartTooltip(e, title, value));
    rect.addEventListener('focus', e => showChartTooltip(e, title, value));
    rect.addEventListener('blur', hideChartTooltip);
    svg.appendChild(rect);
    if (i === 0 || i === n - 1 || i === Math.floor(n / 2)){
      const t = document.createElementNS(svgNs, 'text');
      t.setAttribute('x', String(x + bw / 2));
      t.setAttribute('y', String(H - 5));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('class', 'admin-chart-xlabel');
      t.textContent = title;
      svg.appendChild(t);
    }
  });

  container.appendChild(svg);
}

function renderActivityChart(container, series, range){
  const bucketed = bucketSeries(series, range);
  const monthly = range === '6m' || range === '1y';
  buildBarChart(container, bucketed, {
    dateLabel: d => monthly ? d.date : d.date.slice(5),
    valueLabel: d => `${fmtDuration(d.active_ms)} · ${d.clicks} кликов`,
  });
}

function renderRevenueChart(container, series){
  buildBarChart(container, series, {
    dateLabel: d => d.date.slice(5),
    valueLabel: d => `${d.amount} сомони`,
    valueOf: d => d.amount,
    ariaLabel: 'Выручка по дням',
  });
}

async function loadAdminActivityOverview(){
  try{
    const data = await adminApi('activity_overview', { range: adminActivityRange });
    $('#adminStatCards').innerHTML = [
      statCard('Сейчас в сети', String(data.online_now)),
      statCard('Время сегодня', fmtDuration(data.today.active_ms), data.delta_active_ms_pct),
      statCard('Клики сегодня', String(data.today.clicks), data.delta_clicks_pct),
      statCard('Активных за период', String(data.active_users)),
    ].join('');
    $('#adminChartRangeLabel').textContent = ADMIN_RANGE_LABELS[adminActivityRange] || '';
    renderActivityChart($('#adminActivityChart'), data.series, adminActivityRange);
  } catch(e){ showToast(e.message, 'info'); }
}

// Экраны приложения — те же id, что и data-view в index.html/Track.enterScreen,
// человекочитаемые подписи для админки.
const ADMIN_SCREEN_LABELS = { home:'Главная', funnel:'Воронка', clients:'Клиенты', analytics:'Аналитика', plan:'Тариф', ai:'ИИ' };
function screenLabel(screen){
  if (!screen) return '';
  const key = String(screen).replace(/^view:/, '');
  return ADMIN_SCREEN_LABELS[key] || key;
}

let _adminActivityUsersCache = [];
let adminActivitySearch = '';
let adminActivityOnlineOnly = false;

function renderAdminActivityUsers(){
  const box = $('#adminActivityUsers');
  let users = _adminActivityUsersCache;
  if (adminActivityOnlineOnly) users = users.filter(u => presenceInfo(u.last_active_at).online);
  if (adminActivitySearch){
    const q = adminActivitySearch.toLowerCase();
    users = users.filter(u => (u.shop_name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q));
  }
  if (!users.length){ box.innerHTML = `<div class="notif-empty">${_adminActivityUsersCache.length ? 'Ничего не найдено' : 'Пока нет данных активности'}</div>`; return; }
  box.innerHTML = users.map(u => {
    const name = u.shop_name || u.email || `Пользователь #${u.id}`;
    const pres = presenceInfo(u.last_active_at);
    const nowDoing = pres.online && u.current_screen ? ` · сейчас: <span class="admin-current-screen">${esc(screenLabel(u.current_screen))}</span>` : '';
    return `
    <button class="admin-sup-thread" data-uid="${u.id}" type="button">
      <div class="kcard-avatar">${esc(name[0].toUpperCase())}</div>
      <div class="admin-sup-thread-info">
        <b><span class="online-dot ${pres.online ? 'on' : ''}"></span> ${esc(name)}</b>
        <span>${esc(pres.label)} · ${fmtDuration(u.active_ms)} · ${u.clicks} кликов за период${nowDoing}</span>
      </div>
    </button>`;
  }).join('');
  $$('.admin-sup-thread', box).forEach(btn => {
    btn.addEventListener('click', () => openAdminActivityDetail(Number(btn.dataset.uid)));
  });
}

async function loadAdminActivityUsers(){
  const box = $('#adminActivityUsers');
  try{
    const data = await adminApi('activity_users', { range: adminActivityRange });
    _adminActivityUsersCache = data.users || [];
    renderAdminActivityUsers();
  } catch(e){
    box.innerHTML = `<div class="notif-empty">${esc(e.message)}</div>`;
  }
}

let _adminActivitySearchTimer = null;
$('#adminActivitySearch')?.addEventListener('input', e => {
  clearTimeout(_adminActivitySearchTimer);
  const val = e.target.value.trim();
  _adminActivitySearchTimer = setTimeout(() => { adminActivitySearch = val; renderAdminActivityUsers(); }, 150);
});
$('#adminActivityOnlineOnly')?.addEventListener('change', e => {
  adminActivityOnlineOnly = e.target.checked;
  renderAdminActivityUsers();
});

async function openAdminActivityDetail(uid){
  $('#adminActivityListWrap').style.display = 'none';
  $('#adminActivityDetailWrap').style.display = 'block';
  try{
    const data = await adminApi('activity_user_detail', { user_id: uid, range: adminActivityRange });
    const u = data.user;
    const name = u.shop_name || u.email || `Пользователь #${uid}`;
    $('#adminActivityDetailName').textContent = name;
    $('#adminActivityDetailEmail').textContent = u.email || '';
    $('#adminActivityDetailAvatar').textContent = name[0].toUpperCase();
    const pres = presenceInfo(u.last_active_at);
    const nowValue = pres.online ? (u.last_screen ? `в сети · ${screenLabel(u.last_screen)}` : 'в сети') : 'не в сети';
    $('#adminActivityDetailCards').innerHTML = [
      statCard('Сейчас', nowValue),
      statCard(`Время ${ADMIN_RANGE_LABELS[adminActivityRange] || ''}`, fmtDuration(data.total_active_ms)),
      statCard('Кликов за период', String(data.total_clicks)),
    ].join('');
    renderActivityChart($('#adminActivityDetailChart'), data.series, adminActivityRange);

    const clicks = data.clicks || [];
    $('#adminActivityDetailClicks').innerHTML = clicks.length
      ? clicks.map(c => `
        <div class="admin-pay-row">
          <div class="admin-pay-info"><b>${esc(c.target)}</b><span>${c.count} кликов</span></div>
        </div>`).join('')
      : '<div class="notif-empty">Пока нет данных</div>';

    const screens = data.screens || [];
    $('#adminActivityDetailScreens').innerHTML = screens.length
      ? screens.map(s => `
        <div class="admin-pay-row">
          <div class="admin-pay-info"><b>${esc(screenLabel(s.screen))}</b><span>${fmtDuration(s.total_ms)}</span></div>
        </div>`).join('')
      : '<div class="notif-empty">Пока нет данных</div>';
  } catch(e){ showToast(e.message, 'info'); }
}
$('#adminActivityBack')?.addEventListener('click', () => {
  $('#adminActivityDetailWrap').style.display = 'none';
  $('#adminActivityListWrap').style.display = 'block';
});

$$('#adminRangeChips .chip').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('active')) return;
    $$('#adminRangeChips .chip').forEach(b => b.classList.toggle('active', b === btn));
    adminActivityRange = btn.dataset.range;
    loadAdminActivityOverview();
    loadAdminActivityUsers();
  });
});

/* ============================================================
   Оценки ответов ИИ (лайк/дизлайк) — видно всем администраторам.
   ============================================================ */

let adminAiRatingFilter = 'all';

async function loadAdminAiBadge(){
  try{
    const data = await adminApi('ai_feedback_list', { rating: 'all' });
    const down = (data.counts && data.counts.down) || 0;
    const badge = $('#adminAiBadge');
    if (badge){ badge.style.display = down ? 'inline-flex' : 'none'; badge.textContent = down; }
    return data;
  } catch(_){ return null; }
}

async function loadAdminAiFeedback(){
  const box = $('#adminAiList');
  try{
    const data = await adminApi('ai_feedback_list', { rating: adminAiRatingFilter });
    const badge = $('#adminAiBadge');
    if (badge){
      const down = (data.counts && data.counts.down) || 0;
      badge.style.display = down ? 'inline-flex' : 'none';
      badge.textContent = down;
    }
    $('#adminAiCounts').textContent = `👍 ${((data.counts||{}).up)||0} хороших · 👎 ${((data.counts||{}).down)||0} плохих`;
    const items = data.items || [];
    if (!items.length){ box.innerHTML = '<div class="notif-empty">Пока нет оценённых ответов</div>'; return; }
    box.innerHTML = items.map(it => {
      const name = it.shop_name || it.email || `Пользователь #${it.user_id}`;
      const emoji = Number(it.rating) === 1 ? '👍' : '👎';
      return `
      <button class="admin-sup-thread admin-ai-row" data-uid="${it.user_id}" type="button">
        <div class="kcard-avatar">${esc(name[0].toUpperCase())}</div>
        <div class="admin-sup-thread-info">
          <b>${emoji} ${esc(name)} <span class="admin-ai-time">${fmtTime(parseServerTime(it.created_at))}</span></b>
          ${it.question ? `<span class="admin-ai-q">Вопрос: ${esc(it.question)}</span>` : ''}
          <span class="admin-ai-a">Ответ: ${esc(it.answer)}</span>
          ${it.rating_comment ? `<span class="admin-ai-comment">Комментарий: ${esc(it.rating_comment)}</span>` : ''}
        </div>
      </button>`;
    }).join('');
    $$('.admin-ai-row', box).forEach(btn => {
      btn.addEventListener('click', () => openAdminAiThread(Number(btn.dataset.uid)));
    });
  } catch(e){
    box.innerHTML = `<div class="notif-empty">${esc(e.message)}</div>`;
  }
}
$('#adminAiRefresh')?.addEventListener('click', () => loadAdminAiFeedback());
$$('#adminAiChips .chip').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('active')) return;
    $$('#adminAiChips .chip').forEach(b => b.classList.toggle('active', b === btn));
    adminAiRatingFilter = btn.dataset.rating;
    loadAdminAiFeedback();
  });
});

async function openAdminAiThread(uid){
  $('#adminAiListWrap').style.display = 'none';
  $('#adminAiThreadWrap').style.display = 'flex';
  try{
    const data = await adminApi('ai_chat_thread', { user_id: uid });
    const u = data.user || {};
    const name = u.shop_name || u.email || `Пользователь #${uid}`;
    $('#adminAiThreadName').textContent = name;
    $('#adminAiThreadEmail').textContent = u.email || '';
    $('#adminAiThreadAvatar').textContent = name[0].toUpperCase();
    const body = $('#adminAiThreadBody');
    body.innerHTML = (data.messages || []).map(m => {
      const mine = m.role === 'user';
      const rating = Number(m.rating) === 1 ? ' 👍' : (Number(m.rating) === -1 ? ' 👎' : '');
      return `
      <div class="sup-bubble-row ${mine ? 'own' : ''}">
        <div class="sup-bubble ${mine ? 'own' : ''}">
          ${esc(m.content)}${rating}
          <span class="sup-bubble-time">${fmtTime(parseServerTime(m.created_at))}</span>
        </div>
      </div>`;
    }).join('') || '<div class="notif-empty">Сообщений пока нет</div>';
    body.scrollTop = body.scrollHeight;
  } catch(e){ showToast(e.message, 'info'); }
}
$('#adminAiBack')?.addEventListener('click', () => {
  $('#adminAiThreadWrap').style.display = 'none';
  $('#adminAiListWrap').style.display = 'block';
});

/* ============================================================
   Истории — видео от админа на главном экране пользователей.
   ============================================================ */

let adminStoryDuration = 24;
$$('#adminStoryDurationChips .chip').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('#adminStoryDurationChips .chip').forEach(b => b.classList.toggle('active', b === btn));
    adminStoryDuration = Number(btn.dataset.duration) || 24;
  });
});

function fmtStoryCounts(s){
  const parts = Object.entries(s.reaction_counts || {}).filter(([, n]) => Number(n) > 0)
    .map(([em, n]) => `${em} ${n}`);
  const total = parts.length ? parts.join(' · ') : 'реакций пока нет';
  return `${total} · ${s.reply_count || 0} ${s.reply_count === 1 ? 'ответ' : 'ответов'}`;
}

async function loadAdminStories(){
  const list = $('#adminStoriesList');
  if (!list) return;
  try{
    const data = await adminApi('story_list');
    const stories = data.stories || [];
    if (!stories.length){
      list.innerHTML = '<div class="notif-empty">Пока нет опубликованных историй</div>';
      return;
    }
    const now = Date.now();
    list.innerHTML = stories.map(s => {
      const expired = parseServerTime(s.expires_at) < now;
      return `
      <div class="admin-pay-row" data-id="${s.id}">
        <div class="admin-pay-info">
          <b>${esc(s.caption || 'Без подписи')} ${expired ? '<span class="payment-status bad">истекла</span>' : '<span class="payment-status ok">активна</span>'}</b>
          <span>Опубликована ${fmtTime(parseServerTime(s.created_at))} · до ${fmtTime(parseServerTime(s.expires_at))} (${s.duration_h} ч) · ${fmtStoryCounts(s)}</span>
        </div>
        <div class="admin-pay-actions">
          <button class="admin-user-del" data-del="1" title="Удалить"><svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-trash"/></svg></button>
        </div>
      </div>`;
    }).join('');
    $$('.admin-pay-row [data-del]', list).forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.closest('.admin-pay-row').dataset.id);
        if (!confirm('Удалить эту историю? Она сразу пропадёт у пользователей.')) return;
        try{
          await adminApi('story_delete', { id });
          showToast('История удалена', 'ok');
          loadAdminStories();
        } catch(e){ showToast(e.message, 'info'); }
      });
    });
  } catch(e){
    list.innerHTML = `<div class="notif-empty">${esc(e.message)}</div>`;
  }
}
$('#adminStoriesRefresh')?.addEventListener('click', () => loadAdminStories());

$('#adminStoryForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const fileInput = $('#adminStoryVideo');
  const file = fileInput.files[0];
  if (!file){ showToast('Выберите видео', 'info'); return; }
  if (file.size > 40 * 1024 * 1024){ showToast('Видео слишком большое — максимум 40 МБ', 'info'); return; }
  const btn = $('#adminStoryPublish');
  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = 'Загружаем видео…';
  try{
    const fd = new FormData();
    fd.append('video', file);
    const r = await apiFetch('backend/api/upload.php', { method:'POST', credentials:'include', body: fd });
    const raw = await r.text();
    let up;
    try{ up = JSON.parse(raw); } catch(_){ throw new Error('Сервер вернул не JSON — проверьте, что сайт запущен через PHP.'); }
    if (!r.ok || !up.url) throw new Error(up.error || 'Не удалось загрузить видео');

    btn.textContent = 'Публикуем…';
    await adminApi('story_create', {
      video_url: up.url,
      caption: $('#adminStoryCaption').value.trim(),
      duration_h: adminStoryDuration,
    });
    showToast('История опубликована', 'ok');
    $('#adminStoryForm').reset();
    $$('#adminStoryDurationChips .chip').forEach(b => b.classList.toggle('active', b.dataset.duration === '24'));
    adminStoryDuration = 24;
    loadAdminStories();
  } catch(e){
    showToast(e.message || 'Не удалось опубликовать историю', 'info');
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
});

let adminSupCurrentUser = null;
let adminSupPollTimer = null;
let adminSupInFlight = false;

async function loadAdminSupportThreads(badgeOnly = false){
  try{
    const data = await adminApi('support_threads');
    const badge = $('#adminSupBadge');
    if (badge){
      badge.style.display = data.total_unread ? 'inline-flex' : 'none';
      badge.textContent = data.total_unread;
    }
    if (badgeOnly) return;
    const list = $('#adminSupThreads');
    if (!list) return;
    const threads = data.threads || [];
    if (!threads.length){
      list.innerHTML = '<div class="notif-empty">Пока никто не писал в поддержку.<br>Сообщения пользователей появятся здесь.</div>';
      return;
    }
    list.innerHTML = threads.map(t => {
      const name = t.shop_name || t.email || 'Пользователь';
      const preview = (t.last_direction === 'admin' ? 'Вы: ' : '') + (t.last_text || '');
      return `
      <button class="admin-sup-thread ${Number(t.unread) ? 'has-unread' : ''}" data-uid="${t.id}" type="button">
        <div class="kcard-avatar">${esc(name[0].toUpperCase())}</div>
        <div class="admin-sup-thread-info">
          <b>${esc(name)}</b>
          <span>${esc(preview).slice(0, 90)}</span>
        </div>
        <div class="admin-sup-thread-meta">
          <span class="admin-sup-time">${t.last_at ? fmtTime(parseServerTime(t.last_at)) : ''}</span>
          ${Number(t.unread) ? `<span class="admin-sup-unread">${t.unread}</span>` : ''}
        </div>
      </button>`;
    }).join('');
    $$('.admin-sup-thread', list).forEach(btn => {
      btn.addEventListener('click', () => openAdminSupportChat(Number(btn.dataset.uid)));
    });
  } catch(e){
    const list = $('#adminSupThreads');
    if (list && !badgeOnly) list.innerHTML = `<div class="notif-empty">${esc(e.message)}</div>`;
  }
}
$('#adminSupRefresh')?.addEventListener('click', () => loadAdminSupportThreads());

function renderAdminSupportMessages(msgs){
  const body = $('#adminSupChatBody');
  if (!body) return;
  const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  body.innerHTML = (msgs || []).map(m => `
    <div class="sup-bubble-row ${m.direction === 'admin' ? 'own' : ''}">
      <div class="sup-bubble ${m.direction === 'admin' ? 'own' : ''}">
        ${m.story ? `<div class="msg-story-quote"><svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#icon-video"/></svg><span>${esc(m.story.caption || 'Видео-история')}</span></div>` : ''}
        ${esc(m.text)}
        <span class="sup-bubble-time">${fmtTime(parseServerTime(m.created_at))}${m.via === 'telegram' ? ' · из Telegram' : ''}</span>
      </div>
    </div>`).join('') || '<div class="notif-empty">Сообщений пока нет</div>';
  if (stick) body.scrollTop = body.scrollHeight;
}

async function openAdminSupportChat(uid){
  adminSupCurrentUser = uid;
  $('#adminSupThreadsWrap').style.display = 'none';
  $('#adminSupChatWrap').style.display = 'flex';
  // На десктопе список диалогов остаётся видимым слева (см. CSS), а справа
  // заглушка "выберите диалог" уступает место открытой переписке.
  if ($('#adminSupEmpty')) $('#adminSupEmpty').style.display = 'none';
  try{
    const data = await adminApi('support_thread', { user_id: uid });
    const u = data.user || {};
    const name = u.shop_name || u.email || `Пользователь #${uid}`;
    $('#adminSupChatName').textContent = name;
    $('#adminSupChatEmail').textContent = u.email || '';
    $('#adminSupChatAvatar').textContent = name[0].toUpperCase();
    renderAdminSupportMessages(data.messages);
    loadAdminSupportThreads(true);
  } catch(e){ showToast(e.message, 'info'); }

  clearInterval(adminSupPollTimer);
  adminSupPollTimer = setInterval(async () => {
    if (!adminSupCurrentUser || $('#adminAppScreen').style.display === 'none' || document.hidden){ return; }
    if (adminSupInFlight) return;
    adminSupInFlight = true;
    try{
      const data = await adminApi('support_thread', { user_id: adminSupCurrentUser });
      renderAdminSupportMessages(data.messages);
    } catch(_){}
    adminSupInFlight = false;
  }, 8000);
}

$('#adminSupBack')?.addEventListener('click', () => {
  adminSupCurrentUser = null;
  clearInterval(adminSupPollTimer);
  $('#adminSupChatWrap').style.display = 'none';
  $('#adminSupThreadsWrap').style.display = 'block';
  if ($('#adminSupEmpty')) $('#adminSupEmpty').style.display = '';
  loadAdminSupportThreads();
});

$('#adminSupReplyForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#adminSupReplyInput');
  const text = input.value.trim();
  if (!text || !adminSupCurrentUser) return;
  input.value = '';
  try{
    await adminApi('support_reply', { user_id: adminSupCurrentUser, text });
    const data = await adminApi('support_thread', { user_id: adminSupCurrentUser });
    renderAdminSupportMessages(data.messages);
  } catch(err){ showToast(err.message, 'info'); input.value = text; }
});

async function loadAdminSupportBot(){
  const off = $('#adminSupBotOff'), on = $('#adminSupBotOn');
  if (!off || !on) return;
  try{
    const data = await adminApi('support_bot_get');
    off.style.display = data.connected ? 'none' : 'block';
    on.style.display = data.connected ? 'block' : 'none';
    if (data.connected){
      $('#adminSupBotName').textContent = data.bot_username ? '@' + data.bot_username : 'бот';
      $('#adminSupBotChatState').textContent = data.chat_bound
        ? '✅ Чат привязан — сообщения приходят в Telegram'
        : 'Чат не привязан: отправьте боту код ниже';
      const bindWrap = $('#adminSupBindWrap');
      bindWrap.style.display = data.chat_bound ? 'none' : 'block';
      if (!data.chat_bound) $('#adminSupBindCode').textContent = data.bind_code || '······';
    }
  } catch(_){}
}

$('#adminSupBotConnect')?.addEventListener('click', async () => {
  const btn = $('#adminSupBotConnect');
  const token = $('#adminSupBotToken').value.trim();
  if (!token) { showToast('Вставьте токен бота из @BotFather', 'info'); return; }
  btn.disabled = true; btn.textContent = 'Подключаем…';
  try{
    await adminApi('support_bot_set', { bot_token: token });
    $('#adminSupBotToken').value = '';
    showToast('Бот поддержки подключён — привяжите чат кодом', 'ok');
    loadAdminSupportBot();
  } catch(e){ showToast(e.message, 'info'); }
  btn.disabled = false; btn.textContent = 'Подключить бота';
});

$('#adminSupBotDisconnect')?.addEventListener('click', async () => {
  if (!confirm('Отключить Telegram-бота поддержки?')) return;
  try{
    await adminApi('support_bot_delete');
    showToast('Бот поддержки отключён', 'info');
    loadAdminSupportBot();
  } catch(e){ showToast(e.message, 'info'); }
});

initAdmin();
