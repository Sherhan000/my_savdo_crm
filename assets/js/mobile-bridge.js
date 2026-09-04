// mobile-bridge.js — «клей» между сайтом MySavdo и нативной Android-оболочкой (Capacitor).
//
// В обычном браузере (в т.ч. на телефоне) window.Capacitor не существует —
// весь файл ничего не делает и не влияет на веб-версию.
// Внутри APK нативный рантайм Capacitor сам подставляет window.Capacitor
// ДО загрузки этого скрипта — методы плагинов регистрируются через
// Capacitor.registerPlugin(), без сборщика и npm-импортов (ванильный JS).
(function () {
  'use strict';

  var Cap = window.Capacitor;
  if (!Cap || typeof Cap.isNativePlatform !== 'function' || !Cap.isNativePlatform()) return;

  document.documentElement.classList.add('is-native-app');

  var Camera      = Cap.registerPlugin('Camera');
  var Browser     = Cap.registerPlugin('Browser');
  var AppPlugin   = Cap.registerPlugin('App');
  var SplashScreen= Cap.registerPlugin('SplashScreen');
  var StatusBar   = Cap.registerPlugin('StatusBar');
  var Network     = Cap.registerPlugin('Network');
  var Haptics     = Cap.registerPlugin('Haptics');

  function safe(promise){ return promise && promise.catch ? promise.catch(function(){}) : promise; }

  /* ---------- 1. Статус-бар в фирменных цветах ---------- */
  safe(StatusBar.setOverlaysWebView({ overlay: false }));
  safe(StatusBar.setBackgroundColor({ color: '#0a2118' }));
  safe(StatusBar.setStyle({ style: 'LIGHT' })); // светлые иконки — фон тёмный

  /* ---------- 2. Splash screen: прячем, когда страница реально готова ---------- */
  (function hideSplashWhenReady(){
    var hidden = false;
    function hide(){
      if (hidden) return;
      hidden = true;
      safe(SplashScreen.hide());
    }
    if (document.readyState === 'complete') hide();
    else window.addEventListener('load', hide);
    setTimeout(hide, 4000); // страховка: не держать сплэш вечно при медленной сети
  })();

  /* ---------- 3. Внешние ссылки (OAuth, соцсети, промо) — через системный браузер, а не во WebView ---------- */
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var isExternalScheme = /^(tel:|mailto:|https?:\/\/(www\.)?(wa\.me|t\.me|instagram\.com|facebook\.com|accounts\.google\.com))/i.test(href);
    var opensNewTab = a.target === '_blank';
    if (!isExternalScheme && !opensNewTab) return;
    if (href.indexOf(location.origin) === 0) return; // ссылки на сам сайт — оставляем WebView
    e.preventDefault();
    if (/^tel:|^mailto:/i.test(href)) { window.location.href = href; return; }
    safe(Browser.open({ url: href, presentationStyle: 'popover' }));
  }, true);

  var nativeWindowOpen = window.open;
  window.open = function (url, target, features) {
    if (url && typeof url === 'string' && !(url.indexOf(location.origin) === 0)) {
      safe(Browser.open({ url: url }));
      return null;
    }
    return nativeWindowOpen.call(window, url, target, features);
  };

  /* ---------- 4. Нативная камера/галерея вместо HTML <input type="file"> ---------- */
  function dataUrlToBlob(dataUrl) {
    var parts = dataUrl.split(',');
    var mime = (parts[0].match(/:(.*?);/) || [, 'image/jpeg'])[1];
    var bin = atob(parts[1]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function pickNativePhoto(inputId) {
    Camera.getPhoto({
      quality: 85,
      resultType: 'dataUrl',
      source: 'PROMPT',        // системный выбор: камера или галерея
      saveToGallery: false,
      correctOrientation: true
    }).then(function (photo) {
      var input = document.getElementById(inputId);
      if (!input || !photo || !photo.dataUrl) return;
      var blob = dataUrlToBlob(photo.dataUrl);
      var ext = (photo.format || 'jpeg').replace('jpg', 'jpeg');
      var file = new File([blob], 'photo.' + ext, { type: blob.type });
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      safe(Haptics.impact({ style: 'LIGHT' }));
    }).catch(function () { /* пользователь отменил выбор — молча выходим */ });
  }

  var PHOTO_TRIGGERS = { btnAttachPhoto: 'chatPhotoInput', profileAvatarBtn: 'profileAvatarInput' };
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('#btnAttachPhoto, #profileAvatarBtn') : null;
    if (!btn || !PHOTO_TRIGGERS[btn.id]) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    pickNativePhoto(PHOTO_TRIGGERS[btn.id]);
  }, true);

  /* ---------- 5. Индикатор офлайна ---------- */
  var banner = document.createElement('div');
  banner.id = 'nativeOfflineBanner';
  banner.textContent = 'Нет соединения с интернетом';
  banner.setAttribute('style', [
    'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:99999',
    'padding:calc(8px + env(safe-area-inset-top)) 12px 8px', 'text-align:center',
    'font:600 12.5px/1.4 system-ui,sans-serif', 'background:#bd5a2e', 'color:#fff',
    'transform:translateY(-100%)', 'transition:transform .25s ease', 'pointer-events:none'
  ].join(';'));
  document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(banner); });

  function setOffline(offline) { banner.style.transform = offline ? 'translateY(0)' : 'translateY(-100%)'; }
  Network.getStatus().then(function (s) { setOffline(!s.connected); }).catch(function(){});
  Network.addListener('networkStatusChange', function (s) { setOffline(!s.connected); });

  /* ---------- 6. Аппаратная кнопка «Назад» ---------- */
  var lastBackPress = 0;
  AppPlugin.addListener('backButton', function () {
    var openModal = document.querySelector('.modal-overlay.active');
    if (openModal) { openModal.classList.remove('active'); return; }

    var openPanels = ['#accountMenu.open', '#notifPanel.open', '#tourAskBody.open'];
    for (var i = 0; i < openPanels.length; i++) {
      var el = document.querySelector(openPanels[i]);
      if (el) { el.classList.remove('open'); return; }
    }
    var aiPanel = document.getElementById('aiGuidePanel');
    if (aiPanel && aiPanel.classList.contains('open')) {
      if (typeof window.toggleAiPanel === 'function') window.toggleAiPanel(false);
      else aiPanel.classList.remove('open');
      return;
    }

    var dashboard = document.getElementById('screen-dashboard');
    if (dashboard && dashboard.classList.contains('active')) {
      var activeTab = document.querySelector('.dash-tabbar button.active');
      var homeTab = document.querySelector('.dash-tabbar button');
      if (activeTab && homeTab && activeTab !== homeTab && typeof window.switchDashView === 'function') {
        window.switchDashView(homeTab.dataset.view);
        return;
      }
      // на главной вкладке дашборда — это корень приложения, дальше только выход
    } else {
      var landing = document.getElementById('screen-landing');
      if (landing && landing.classList.contains('active') && typeof window.showScreen === 'function') {
        window.showScreen('screen-welcome');
        return;
      }
    }

    var now = Date.now();
    if (now - lastBackPress < 2000) {
      AppPlugin.exitApp();
    } else {
      lastBackPress = now;
      if (typeof window.showToast === 'function') window.showToast('Нажмите «Назад» ещё раз для выхода', 'info');
    }
  });

  /* ---------- 7. Открытие приложения по ссылке (App Links) ---------- */
  AppPlugin.addListener('appUrlOpen', function (data) {
    if (data && data.url && data.url.indexOf(location.origin) === 0) {
      var path = data.url.slice(location.origin.length);
      if (path && path !== location.pathname + location.search) window.location.href = path;
    }
  });
})();
