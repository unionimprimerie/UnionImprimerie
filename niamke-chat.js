/* niamke-chat.js — tchat de groupe SenPrint (chargé automatiquement par niamke-acces.js)
   Panneau à droite de la page, comme un groupe WhatsApp : messages, personnes en ligne (point vert),
   "X vient de se connecter" / "X est parti". La page des reçus n'est pas modifiée. */
(function () {
  'use strict';
  var N = window.__niamke;
  if (!N || window.__nlChat) return;
  window.__nlChat = true;
  var S = N.S, CFG = window.NIAMKE_CFG || {}, W = 340;
  var explicit = false, lastId = 0, known = {}, prev = null, online = [], unread = 0, open = false, sending = false, failed = false, lastSend = 0;
  var ui = {};

  function first(n) { return String(n || 'Client').trim().split(/\s+/)[0]; }
  function color(id) { var h = 0, s = String(id), i; for (i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return 'hsl(' + h + ',55%,42%)'; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function hhmm(t) { var d = new Date(t); return isNaN(d) ? '' : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }

  /* ---------- données : Supabase ou démo (plusieurs onglets du même navigateur) ---------- */
  function dLoad() { try { return JSON.parse(localStorage.getItem('nl_demo_chat') || 'null') || { msgs: [], pres: {} }; } catch (e) { return { msgs: [], pres: {} }; } }
  function dSave(d) { try { localStorage.setItem('nl_demo_chat', JSON.stringify(d)); } catch (e) {} }
  var demo = {
    beat: function () { var d = dLoad(); d.pres[S.id] = { nom: S.nom, ts: Date.now() }; dSave(d); return Promise.resolve(); },
    online: function () { var d = dLoad(), n = Date.now(); return Promise.resolve(Object.keys(d.pres).filter(function (k) { return n - d.pres[k].ts < 75000; }).map(function (k) { return { id: k, nom: d.pres[k].nom }; })); },
    last: function () { return Promise.resolve(dLoad().msgs.slice(-60)); },
    after: function (id) { return Promise.resolve(dLoad().msgs.filter(function (m) { return m.id > id; })); },
    send: function (t) { var d = dLoad(), m = { id: (d.msgs.length ? d.msgs[d.msgs.length - 1].id : 0) + 1, sender: S.id, nom: S.nom, text: t, created_at: new Date().toISOString() }; d.msgs.push(m); d.msgs = d.msgs.slice(-300); dSave(d); return Promise.resolve(m); },
    leave: function () { var d = dLoad(); delete d.pres[S.id]; dSave(d); }
  };
  var COLS = 'chat?select=id,sender,nom,text,created_at';
  var sb = {
    beat: function () { return N.sbCall('POST', 'presence?on_conflict=id', { id: S.id, nom: S.nom || 'Client' }, 'resolution=merge-duplicates,return=minimal'); },
    online: function () { return N.sbCall('POST', 'rpc/chat_online', {}).then(function (r) { return r || []; }); },
    last: function () { return N.sbCall('GET', COLS + '&order=id.desc&limit=60').then(function (r) { return (r || []).reverse(); }); },
    after: function (id) { return N.sbCall('GET', COLS + '&id=gt.' + id + '&order=id.asc&limit=100').then(function (r) { return r || []; }); },
    send: function (t) { return N.sbCall('POST', 'chat', { sender: S.id, nom: S.nom || 'Client', text: t }, 'return=representation').then(function (r) { return r && r[0]; }); },
    leave: function () {
      try { fetch(CFG.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/rpc/chat_leave', { method: 'POST', keepalive: true, headers: { apikey: CFG.supabaseKey, Authorization: 'Bearer ' + S.token, 'Content-Type': 'application/json' }, body: '{}' }).catch(function () {}); } catch (e) {}
    }
  };
  var B = N.DEMO ? demo : sb;

  /* ---------- interface ---------- */
  var CSS = '#nl-chat,#nl-chat *{box-sizing:border-box}' +
    '#nl-chat{position:fixed;top:0;right:0;bottom:0;width:' + W + 'px;max-width:100%;z-index:2147482000;background:#fff;border-left:1px solid #e2e8f0;display:none;flex-direction:column;font-family:"Segoe UI",Arial,sans-serif;color:#0f172a;box-shadow:-8px 0 30px rgba(15,23,42,.08)}' +
    '#nl-chat .h{background:#0f172a;color:#fff;padding:12px 14px calc(10px)}#nl-chat .h1{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
    '#nl-chat .t{font-weight:900;font-size:16px}#nl-chat .x{border:0;background:rgba(255,255,255,.14);color:#fff;width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:16px}' +
    '#nl-chat .sub{font-size:12px;font-weight:700;opacity:.9;margin-top:3px}#nl-chat .dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#22c55e;margin-right:6px;box-shadow:0 0 0 2px rgba(34,197,94,.25)}' +
    '#nl-chat .on{display:flex;gap:10px;overflow-x:auto;padding:10px 12px;border-bottom:1px solid #e2e8f0;background:#f8fafc;min-height:62px}' +
    '#nl-chat .m{flex:0 0 auto;text-align:center;width:52px;font-size:10px;font-weight:700;color:#475569}#nl-chat .m div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#nl-chat .av{position:relative;width:36px;height:36px;border-radius:50%;margin:0 auto 3px;color:#fff;font-weight:900;font-size:14px;display:flex;align-items:center;justify-content:center}' +
    '#nl-chat .av i{position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;border-radius:50%;background:#22c55e;border:2px solid #f8fafc}' +
    '#nl-chat .msgs{flex:1;overflow-y:auto;padding:12px;background:#eef1f5;display:flex;flex-direction:column;gap:6px}' +
    '#nl-chat .b{max-width:82%;padding:7px 10px 5px;border-radius:14px;background:#fff;border:1px solid #e2e8f0;align-self:flex-start;font-size:14px;line-height:1.35;word-wrap:break-word;overflow-wrap:anywhere;white-space:pre-wrap}' +
    '#nl-chat .b.me{align-self:flex-end;background:#f43f5e;border-color:#f43f5e;color:#fff}#nl-chat .b .n{font-size:11px;font-weight:900;margin-bottom:1px}' +
    '#nl-chat .b .d{font-size:10px;opacity:.6;text-align:right;margin-top:2px}#nl-chat .sys{align-self:center;font-size:11px;font-weight:700;color:#64748b;background:rgba(255,255,255,.75);border-radius:20px;padding:3px 10px}' +
    '#nl-chat .sys.in:before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:#22c55e;margin-right:6px}' +
    '#nl-chat .empty{align-self:center;text-align:center;color:#64748b;font-size:13px;font-weight:600;margin:auto;padding:10px}' +
    '#nl-chat form{display:flex;gap:6px;padding:10px;border-top:1px solid #e2e8f0;background:#fff;padding-bottom:calc(10px + env(safe-area-inset-bottom,0px))}' +
    '#nl-chat form input{flex:1;min-width:0;padding:11px 12px;border:1.5px solid #e2e8f0;border-radius:20px;font-size:16px;outline:none;font-family:inherit}#nl-chat form input:focus{border-color:#f43f5e}' +
    '#nl-chat form button{border:0;border-radius:50%;width:42px;height:42px;font-size:18px;cursor:pointer;background:#f1f5f9}#nl-chat form button.go{background:#f43f5e;color:#fff;font-weight:900}#nl-chat form button:disabled{opacity:.5}' +
    '#nl-chat .err{color:#dc2626;font-size:12px;font-weight:700;padding:0 12px 6px;background:#fff}' +
    '#nl-fab{position:fixed;right:14px;bottom:14px;z-index:2147482000;width:56px;height:56px;border-radius:50%;border:0;background:#f43f5e;color:#fff;font-size:24px;cursor:pointer;display:none;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(244,63,94,.45);padding:0}' +
    '#nl-fab b{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;border-radius:10px;background:#0f172a;color:#fff;font-size:11px;display:none;align-items:center;justify-content:center;padding:0 5px;border:2px solid #fff}' +
    '@media print{#nl-chat,#nl-fab{display:none!important}}';

  function build() {
    var st = el('style'); st.textContent = CSS; document.head.appendChild(st);
    document.body.classList.add('nl-has-chat');
    var p = el('div'); p.id = 'nl-chat'; ui.p = p;
    var h = el('div', 'h'), h1 = el('div', 'h1'), x = el('button', 'x', '✕'); x.type = 'button'; x.title = 'Réduire'; x.onclick = function () { setOpen(false, true); };
    var out = el('button', 'x', '🚪'); out.type = 'button'; out.title = 'Se déconnecter';
    out.onclick = function () { if (confirm('Se déconnecter de ' + (S.nom || 'ce compte') + ' ?')) { B.leave(); if (N.forget) N.forget(); location.reload(); } };
    var bt = el('div'); bt.style.cssText = 'display:flex;gap:6px'; bt.appendChild(out); bt.appendChild(x);
    h1.appendChild(el('div', 't', '💬 Groupe UNION IMPRIMERIE')); h1.appendChild(bt); h.appendChild(h1);
    ui.sub = el('div', 'sub'); h.appendChild(ui.sub);
    ui.on = el('div', 'on'); ui.msgs = el('div', 'msgs');
    ui.msgs.appendChild(ui.empty = el('div', 'empty', 'Dis bonjour 👋\nTous les membres voient les messages.'));
    ui.err = el('div', 'err'); ui.err.style.display = 'none';
    var f = el('form'), inp = el('input'), wave = el('button', '', '👋'), go = el('button', 'go', '➤');
    inp.type = 'text'; inp.maxLength = 500; inp.placeholder = 'Écris un message…'; inp.autocomplete = 'off';
    wave.type = 'button'; wave.title = 'Saluer tout le monde'; go.type = 'submit'; ui.inp = inp; ui.go = go;
    wave.onclick = function () { send('👋 Salut tout le monde !'); };
    f.onsubmit = function (e) { e.preventDefault(); var t = inp.value.trim(); if (t) send(t, true); };
    f.appendChild(wave); f.appendChild(inp); f.appendChild(go);
    p.appendChild(h); p.appendChild(ui.on); p.appendChild(ui.msgs); p.appendChild(ui.err); p.appendChild(f);
    document.body.appendChild(p);
    var fab = el('button', '', '💬'); fab.id = 'nl-fab'; fab.type = 'button'; fab.title = 'Ouvrir le tchat';
    ui.badge = el('b'); fab.appendChild(ui.badge); fab.onclick = function () { setOpen(true, true); }; ui.fab = fab; document.body.appendChild(fab);
    window.addEventListener('resize', function () { if (!explicit) open = wide(); layout(); });
  }
  function wide() { return window.innerWidth >= 1280; }
  function layout() {
    ui.p.style.display = open ? 'flex' : 'none';
    ui.fab.style.display = open ? 'none' : 'flex';
    document.body.classList.toggle('nl-chat-open', open);
    var root = document.getElementById('root');
    if (root) root.style.paddingRight = (open && wide()) ? W + 'px' : '';
  }
  function setOpen(v, save) {
    open = v; if (save) { explicit = true; try { localStorage.setItem('nl_chat_open', v ? '1' : '0'); } catch (e) {} }
    if (v) { unread = 0; showBadge(); scrollEnd(true); }
    layout(); schedule(0);
  }
  function showBadge() { ui.badge.textContent = unread > 9 ? '9+' : unread; ui.badge.style.display = unread ? 'flex' : 'none'; }
  function scrollEnd(force) { var m = ui.msgs; if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 90) m.scrollTop = m.scrollHeight; }
  function trim() { while (ui.msgs.children.length > 300) ui.msgs.removeChild(ui.msgs.firstChild); }

  function addMsg(m) {
    if (known[m.id]) return; known[m.id] = 1; if (m.id > lastId) lastId = m.id;
    if (ui.empty.parentNode) ui.msgs.removeChild(ui.empty);
    var mine = m.sender === S.id, b = el('div', 'b' + (mine ? ' me' : ''));
    if (!mine) { var n = el('div', 'n', m.nom || 'Client'); n.style.color = color(m.sender); b.appendChild(n); }
    b.appendChild(el('span', '', m.text)); b.appendChild(el('div', 'd', hhmm(m.created_at)));
    var near = ui.msgs.scrollHeight - ui.msgs.scrollTop - ui.msgs.clientHeight < 90;
    ui.msgs.appendChild(b); trim(); if (mine || near) scrollEnd(true);
    if (!mine && !open) { unread++; showBadge(); }
  }
  function addSys(text, cls) {
    if (ui.empty.parentNode) ui.msgs.removeChild(ui.empty);
    ui.msgs.appendChild(el('div', 'sys' + (cls ? ' ' + cls : ''), text)); trim(); scrollEnd(false);
  }
  function renderOnline(list) {
    online = list;
    ui.sub.innerHTML = ''; var d = el('span', 'dot'); ui.sub.appendChild(d);
    ui.sub.appendChild(document.createTextNode(list.length + (list.length > 1 ? ' personnes en ligne' : ' personne en ligne')));
    ui.on.innerHTML = '';
    list.forEach(function (u) {
      var m = el('div', 'm'), a = el('div', 'av', first(u.nom).charAt(0).toUpperCase()); a.style.background = color(u.id); a.appendChild(el('i'));
      m.appendChild(a); m.appendChild(el('div', '', u.id === S.id ? 'Moi' : first(u.nom))); ui.on.appendChild(m);
    });
  }
  function diffPresence(list) {
    var now = {}; list.forEach(function (u) { now[u.id] = u; });
    if (prev) {
      list.forEach(function (u) { if (!prev[u.id] && u.id !== S.id) addSys(first(u.nom) + ' vient de se connecter', 'in'); });
      Object.keys(prev).forEach(function (id) { if (!now[id] && id !== S.id) addSys(first(prev[id].nom) + ' est parti'); });
    }
    prev = now;
  }

  /* ---------- envoi ---------- */
  function send(text, clear) {
    if (sending || Date.now() - lastSend < 700) return;
    sending = true; lastSend = Date.now(); ui.go.disabled = true; setErr('');
    B.send(text.slice(0, 500)).then(function (m) {
      if (clear) ui.inp.value = '';
      if (m) addMsg(m); scrollEnd(true);
    }).catch(function () { setErr('Message non envoyé. Réessaie.'); }).then(function () { sending = false; ui.go.disabled = false; if (clear) ui.inp.focus(); });
  }
  function setErr(t) { ui.err.textContent = t; ui.err.style.display = t ? 'block' : 'none'; }

  /* ---------- boucle de mise à jour ---------- */
  var timer = null, lastBeat = 0, busy = false;
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(tick, ms); }
  function tick() {
    if (busy) return schedule(1000);
    if (N.blocked) return schedule(5000);
    busy = true;
    var jobs = [];
    if (Date.now() - lastBeat > 25000) { lastBeat = Date.now(); jobs.push(B.beat()); }
    var step = Promise.all(jobs).then(function () { return B.online(); }).then(function (list) { diffPresence(list); renderOnline(list); })
      .then(function () { return B.after(lastId); }).then(function (rows) { rows.forEach(addMsg); if (failed) { setErr(''); failed = false; } });
    step.catch(function (e) {
      failed = true;
      var m = (e && e.message) || '';
      setErr(/404|PGRST|does not exist/i.test(m) ? 'Tchat non installé : exécute supabase-chat.sql dans Supabase.' : 'Connexion au tchat perdue… nouvelle tentative.');
    }).then(function () { busy = false; schedule(document.hidden ? 30000 : (open ? 4000 : 10000)); });
  }

  function init() {
    build();
    var pref = null; try { pref = localStorage.getItem('nl_chat_open'); } catch (e) {}
    explicit = pref !== null; open = explicit ? pref === '1' : wide();
    layout();
    B.beat().catch(function () {}).then(function () { lastBeat = Date.now(); return B.online(); }).then(function (list) { prev = null; diffPresence(list); renderOnline(list); })
      .then(function () { return B.last(); }).then(function (rows) { rows.forEach(addMsg); scrollEnd(true); })
      .catch(function (e) { var m = (e && e.message) || ''; setErr(/404|PGRST|does not exist/i.test(m) ? 'Tchat non installé : exécute supabase-chat.sql dans Supabase.' : 'Connexion au tchat perdue… nouvelle tentative.'); })
      .then(function () { schedule(open ? 4000 : 10000); });
    window.addEventListener('pagehide', function () { B.leave(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { lastBeat = 0; schedule(0); } });
  }
  init();
})();
