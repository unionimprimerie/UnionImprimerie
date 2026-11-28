/* niamke-offline.js — bannière d'état (hors ligne / envoi en cours / synchronisé) + mode hors ligne (service worker) */
(function () {
  if (window.__NL_TEST) return;
  var bar, hideT, wasPending = false, lastTxt = '';
  function css() {
    var st = document.createElement('style');
    st.textContent = '#nl-net{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(64px + env(safe-area-inset-bottom,0px));z-index:2147483200;max-width:92vw;padding:9px 16px;border-radius:999px;font:800 13px/1.3 "Segoe UI",Arial,sans-serif;color:#fff;box-shadow:0 6px 20px rgba(15,23,42,.35);display:none;text-align:center}' +
      '#nl-net.off{background:#b45309}#nl-net.sync{background:#0f172a}#nl-net.ok{background:#047857}';
    document.head.appendChild(st);
    bar = document.createElement('div'); bar.id = 'nl-net'; bar.setAttribute('role', 'status'); bar.setAttribute('aria-live', 'polite');
    document.body.appendChild(bar);
  }
  function show(cls, txt) { if (!bar) return; if (txt !== lastTxt) { bar.textContent = txt; lastTxt = txt; } bar.className = cls; bar.style.display = 'block'; }
  function hide() { if (bar) { bar.style.display = 'none'; lastTxt = ''; } }
  function n() { try { return window.__uiPending ? window.__uiPending() : 0; } catch (e) { return 0; } }
  function plural(k) { return k + (k > 1 ? ' documents' : ' document'); }
  function tick() {
    var offline = navigator.onLine === false, k = n();
    clearTimeout(hideT);
    if (offline) { wasPending = true; show('off', k > 0 ? '📴 Hors ligne — ' + plural(k) + ' en attente (gardé sur cet appareil)' : '📴 Hors ligne — tes factures sont gardées sur cet appareil'); return; }
    if (k > 0) { wasPending = true; show('sync', '⏳ Envoi de ' + plural(k) + '…'); return; }
    if (wasPending) { wasPending = false; show('ok', '✅ Tout est synchronisé'); hideT = setTimeout(hide, 4000); return; }
    if (lastTxt && bar.className !== 'ok') hide();
  }
  function start() {
    css(); tick();
    setInterval(tick, 1500);
    window.addEventListener('offline', tick);
    window.addEventListener('online', function () { tick(); setTimeout(function () { if (window.__uiSyncNow) window.__uiSyncNow(); }, 800); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  /* mode hors ligne : l'app s'ouvre même sans internet après une première ouverture en ligne (nécessite https) */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
