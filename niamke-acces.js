/* niamke-acces.js — espace multi-clients pour SenPrint (Supabase)
   - Chaque client crée son espace (nom, entreprise, téléphone, adresse, photo, mot de passe) puis se connecte.
   - Les données de l'app sont séparées par client (/data/<téléphone>/...).
   - Le blocage / la validation faits depuis admin.html sont appliqués ici.
   Doit être chargé APRÈS niamke-config.js (c'est déjà le cas dans le HTML). */
(function () {
  'use strict';
  var CFG = window.NIAMKE_CFG || {};
  var SB = (CFG.supabaseUrl || '').replace(/\/+$/, '');
  var DEMO = !(SB && CFG.supabaseKey);
  var TEST = !!window.__NL_TEST;
  var MAIL = '@' + (CFG.mailDomain || 'gmail.com');
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  var S = { id: null, token: null, refresh: null, pw: '', nom: '', photo: '' };
  var started = false, openApp, ready = new Promise(function (r) { openApp = r; });
  var el = null, photoData = '', mode = '';

  function idOf(t) { return String(t || '').replace(/\D/g, ''); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }

  /* ---------- base de données (Supabase REST ou démo locale) ---------- */
  function demoLoad() { try { return JSON.parse(localStorage.getItem('nl_demo') || 'null') || {}; } catch (e) { return {}; } }
  function demoSave(d) { try { localStorage.setItem('nl_demo', JSON.stringify(d)); } catch (e) {} }
  function dbDemo(method, path, body) {
    var d = demoLoad(), parts = path.split('/').filter(Boolean), node = d, i;
    for (i = 0; i < parts.length - 1; i++) { node[parts[i]] = node[parts[i]] || {}; node = node[parts[i]]; }
    var last = parts[parts.length - 1];
    if (method === 'GET') { var v = parts.length ? node[last] : d; return Promise.resolve(v === undefined ? null : v); }
    if (method === 'DELETE') delete node[last]; else node[last] = JSON.parse(JSON.stringify(body));
    demoSave(d); return Promise.resolve(body || null);
  }
  function enc(x) { return encodeURIComponent(x); }
  function fromRow(t, r) {
    if (!r) return null;
    if (t === 'clients') return { nom: r.nom, entreprise: r.entreprise, tel: r.tel, adresse: r.adresse, photo: r.photo, createdAt: r.created_at, by: r.added_by };
    if (t === 'status') return { blocked: r.blocked, msg: r.msg, ts: r.ts };
    if (t === 'seen') return { nom: r.nom, ts: r.ts };
    if (t === 'config') return { approval: r.approval };
    return r;
  }
  function toRow(t, id, v) {
    v = v || {};
    if (t === 'clients') return { id: id, nom: v.nom, entreprise: v.entreprise, tel: v.tel, adresse: v.adresse, photo: v.photo, created_at: v.createdAt, added_by: v.by };
    if (t === 'status') return { id: id, blocked: !!v.blocked, msg: v.msg || '', ts: v.ts };
    if (t === 'seen') return { id: id, nom: v.nom, ts: v.ts };
    throw new Error('Table inconnue : ' + t);
  }
  function sbCall(method, rel, body, prefer, retried) {
    var h = { apikey: CFG.supabaseKey, 'Content-Type': 'application/json' };
    if (S.token) h.Authorization = 'Bearer ' + S.token;
    if (prefer) h.Prefer = prefer;
    return nativeFetch(SB + '/rest/v1/' + rel, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' }).then(function (r) {
      if (r.status === 401 && !retried && S.refresh) return refreshTok().then(function () { return sbCall(method, rel, body, prefer, true); });
      if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 160)); });
      return r.status === 204 ? null : r.text().then(function (t) { return t ? JSON.parse(t) : null; });
    });
  }
  /* mêmes chemins que l'ancienne base : /clients/<id>, /status/<id>, /seen/<id>, /config, /data/<id>/<collection>/<rid> */
  function db(method, path, body) {
    if (DEMO) return dbDemo(method, path, body);
    var p = path.split('/').filter(Boolean), t = p[0], id = p[1], up = 'resolution=merge-duplicates,return=minimal';
    if (t === 'data') {
      var q = 'client_id=eq.' + enc(p[1]) + '&col=eq.' + enc(p[2]), rid = p[3];
      if (method === 'GET') return sbCall('GET', 'records?select=rid,value&' + q + '&order=rid.asc').then(function (rows) {
        if (!rows || !rows.length) return null; var o = {}; rows.forEach(function (r) { o[r.rid] = r.value; }); return o;
      });
      if (method === 'DELETE') return sbCall('DELETE', 'records?' + q + '&rid=eq.' + enc(rid)).then(function () { return null; });
      return sbCall('POST', 'records?on_conflict=client_id,col,rid', { client_id: p[1], col: p[2], rid: rid, value: body }, up).then(function () { return body; });
    }
    if (t === 'config') return sbCall('GET', 'config?select=*&id=eq.1').then(function (rows) { return rows && rows[0] ? fromRow('config', rows[0]) : null; });
    if (method === 'GET') return sbCall('GET', t + '?select=*&id=eq.' + enc(id)).then(function (rows) { return rows && rows[0] ? fromRow(t, rows[0]) : null; });
    if (method === 'DELETE') return sbCall('DELETE', t + '?id=eq.' + enc(id)).then(function () { return null; });
    return sbCall('POST', t + '?on_conflict=id', toRow(t, id, body), up).then(function () { return body; });
  }

  /* ---------- comptes (Supabase Auth ou démo locale) ---------- */
  function hash(s) { var h = 5381, i; for (i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h); }
  function sbAuth(path, body, method, bearer) {
    var h = { apikey: CFG.supabaseKey, 'Content-Type': 'application/json' };
    if (bearer) h.Authorization = 'Bearer ' + bearer;
    return nativeFetch(SB + '/auth/v1/' + path, { method: method || 'POST', headers: h, body: JSON.stringify(body) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.error || j.error_code) throw new Error([j.error_code, j.error_description, j.msg, j.message, j.error].filter(Boolean).join(' | ') || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  function setTok(j) {
    if (!j.access_token) throw new Error('CONFIRM_EMAIL');
    S.token = j.access_token; S.refresh = j.refresh_token;
  }
  function sp(pw) { pw = String(pw == null ? '' : pw); return pw.length < 6 ? pw + '#sp-niamke' : pw; }
  function authSignUp(id, pw) {
    pw = sp(pw);
    if (DEMO) {
      var d = demoLoad(); d.pw = d.pw || {};
      if (d.pw[id]) return Promise.reject(new Error('user_already_exists'));
      if (pw.length < 6) return Promise.reject(new Error('weak_password'));
      d.pw[id] = hash(pw); demoSave(d); S.token = 'demo'; return Promise.resolve();
    }
    return sbAuth('signup', { email: id + MAIL, password: pw }).then(setTok);
  }
  function authSignIn(id, pw) {
    pw = sp(pw);
    if (DEMO) {
      var d = demoLoad();
      if (!d.pw || d.pw[id] !== hash(pw)) return Promise.reject(new Error('invalid_credentials'));
      S.token = 'demo'; return Promise.resolve();
    }
    return sbAuth('token?grant_type=password', { email: id + MAIL, password: pw }).then(setTok);
  }
  function authChangePw(pw) {
    pw = sp(pw);
    if (DEMO) { var d = demoLoad(); d.pw = d.pw || {}; d.pw[S.id] = hash(pw); demoSave(d); return Promise.resolve(); }
    return sbAuth('user', { password: pw }, 'PUT', S.token).then(function () {});
  }
  /* l'appareil se souvient du client : à la prochaine ouverture il entre directement (sans photo, nom, ni mot de passe) */
  function saveSess() { if (DEMO || !S.id || !S.refresh) return; try { localStorage.setItem('nl_sess', JSON.stringify({ id: S.id, refresh: S.refresh })); } catch (e) {} }
  function forget() { try { localStorage.removeItem('nl_sess'); } catch (e) {} }
  function resume() {
    var o = null; try { o = JSON.parse(localStorage.getItem('nl_sess') || 'null'); } catch (e) {}
    if (DEMO || !o || !o.id || !o.refresh) return Promise.reject(new Error('no session'));
    S.id = o.id; S.refresh = o.refresh;
    return refreshTok().then(function () {
      saveSess(); return db('GET', '/clients/' + S.id);
    }).then(function (c) {
      if (!c) throw new Error('no client');
      S.nom = c.nom || ''; S.photo = c.photo || '';
    });
  }
  function refreshTok() {
    if (DEMO || !S.refresh) return Promise.resolve();
    return sbAuth('token?grant_type=refresh_token', { refresh_token: S.refresh }).then(function (j) {
      if (!j.access_token) throw new Error('Session expirée, reconnecte-toi.');
      S.token = j.access_token; S.refresh = j.refresh_token || S.refresh; saveSess();
    });
  }
  function niceErr(e) {
    var m = (e && e.message) || '';
    if (/CONFIRM_EMAIL|email_not_confirmed/i.test(m)) return 'Réglage Supabase manquant : Authentication > Sign In / Providers > Email > désactiver « Confirm email ».';
    if (/user_already_exists|already registered|EMAIL_EXISTS/i.test(m)) return 'Ce numéro a déjà un espace. Va sur « Connexion ».';
    if (/invalid_credentials|Invalid login credentials|INVALID_LOGIN|INVALID_PASSWORD|EMAIL_NOT_FOUND/i.test(m)) return 'Numéro ou mot de passe incorrect.';
    if (/weak_password|at least 6|WEAK_PASSWORD/i.test(m)) return 'Mot de passe trop court (6 caractères minimum).';
    if (/rate_limit|too many|TOO_MANY/i.test(m)) return 'Trop d’essais. Réessaie dans quelques minutes.';
    if (/signup_disabled/i.test(m)) return 'Les inscriptions sont désactivées dans Supabase.';
    if (/email_address_invalid|invalid.*email/i.test(m)) return 'Supabase refuse le domaine e-mail interne : change « mailDomain » dans niamke-config.js (et dans le SQL).';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Pas de connexion internet.';
    if (/HTTP 401|HTTP 403|row-level security|42501/i.test(m)) return 'Accès refusé par la base : vérifie le script SQL (email admin, domaine).';
    if (/HTTP 404|PGRST205|does not exist/i.test(m)) return 'Tables introuvables : exécute le script supabase-setup.sql.';
    return m || 'Erreur, réessaie.';
  }

  /* ---------- émulation des données de l'app, par client ---------- */
  function colPath(col) { return '/data/' + S.id + '/' + String(col).replace(/[^a-zA-Z0-9_-]/g, ''); }
  function newId() { return ('0' + Date.now().toString(36)).slice(-9) + Math.random().toString(36).slice(2, 5); }
  function handleAction(a) {
    var args = a.args || {}, col = args.collection;
    return ready.then(function () {
      switch (a.action) {
        case 'records.list':
          return db('GET', colPath(col)).then(function (o) {
            o = o || {};
            return { records: Object.keys(o).sort().map(function (k) {
              var v = o[k];
              if (col === 'senprint_profile' && v && typeof v === 'object') v = Object.assign({}, v, { password: S.pw });
              return { id: k, value: v };
            }) };
          });
        case 'records.create': return saveRec(col, newId(), args.value).then(function (id) { return { id: id }; });
        case 'records.replace': return saveRec(col, args.id, args.value).then(function () { return {}; });
        case 'records.delete': return db('DELETE', colPath(col) + '/' + args.id).then(function () { return {}; });
        default: return Promise.reject(new Error('Action inconnue : ' + a.action));
      }
    });
  }
  function saveRec(col, id, value) {
    value = JSON.parse(JSON.stringify(value || {}));
    var step = Promise.resolve();
    if (col === 'senprint_profile') {
      var np = value.password; delete value.password;
      if (np && np !== S.pw) step = authChangePw(np).then(function () { S.pw = np; });
      if (value.nom) S.nom = value.nom;
    }
    return step.then(function () { return db('PUT', colPath(col) + '/' + id, value); }).then(function () { return id; });
  }
  if (nativeFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (init && String(init.method || 'GET').toUpperCase() === 'POST' && /(^|\/)actions(\?.*)?$/.test(url)) {
        var a; try { a = JSON.parse(init.body); } catch (e) { a = {}; }
        return handleAction(a).then(function (data) {
          return new Response(JSON.stringify({ data: data }), { status: 200, headers: { 'content-type': 'application/json' } });
        }, function (err) {
          return new Response(JSON.stringify({ error: niceErr(err) }), { status: 500, headers: { 'content-type': 'application/json' } });
        });
      }
      return nativeFetch(input, init);
    };
  }

  /* ---------- inscription / connexion ---------- */
  function doSignup(f) {
    var id = idOf(f.tel);
    if (!f.nom) f.nom = 'Client ' + id.slice(-4);
    return authSignUp(id, f.pw).then(function () {
      S.id = id; S.pw = f.pw; S.nom = f.nom; S.photo = f.photo;
      return db('PUT', '/clients/' + id, { nom: f.nom, entreprise: f.ent, tel: f.tel, adresse: f.adr, photo: f.photo, createdAt: Date.now() });
    }).then(function () {
      return db('PUT', '/data/' + id + '/senprint_profile/' + newId(), { nom: f.nom, entreprise: f.ent, telephone: idOf(f.tel), adresse: f.adr, photo: f.photo });
    }).then(function () { try { localStorage.setItem('nl_last_tel', f.tel); } catch (e) {} saveSess(); });
  }
  function doLogin(tel, pw) {
    var id = idOf(tel);
    return authSignIn(id, pw).then(function () {
      S.id = id; S.pw = pw;
      return db('GET', '/clients/' + id);
    }).then(function (c) {
      if (c) { S.nom = c.nom || ''; S.photo = c.photo || ''; return; }
      // compte existant mais fiche effacée par l'admin : on la recrée
      return db('GET', colPath('senprint_profile')).then(function (o) {
        var p = o ? o[Object.keys(o).sort()[0]] || {} : {};
        S.nom = p.nom || 'Client';
        return db('PUT', '/clients/' + id, { nom: S.nom, entreprise: p.entreprise || '', tel: tel, adresse: '', photo: '', createdAt: Date.now() });
      });
    }).then(function () { try { localStorage.setItem('nl_last_tel', tel); } catch (e) {} saveSess(); });
  }


  /* ---------- prix & produits propres à chaque espace ----------
     Les fonctions de l'app ne changent pas. Chaque client règle SES prix, SES noms de produits
     (et masque ceux qu'il n'utilise pas). Rien n'est partagé entre les espaces. */
  var PRIX_COL = 'senprint_prix', PRIX_RID = 'liste';
  window.__spFxKey = function () { return 'senprint_memoire_docs_' + (S.id || 'anon'); };
  function prods() { return window.__spProducts || null; }
  function snapDefaults() {
    var P = prods();
    if (P && !window.__spDefaults) window.__spDefaults = P.map(function (p) { return Object.assign({}, p); });
  }
  var PXICONS = [['papier', '📄', 'Papier', 1], ['sticker', '🏷️', 'Autocollant', 2], ['photo', '🖼️', 'Photo', 4], ['carton', '📦', 'Carton', 5], ['carte', '💳', 'Cartes', 9], ['bache', '🚩', 'Bâche', 10], ['vinyle', '🎞️', 'Vinyle', 11], ['dtf', '🧵', 'DTF', 15], ['tshirt', '👕', 'Textile', 16]];
  var PXVIEWS = [['cartes', 'Cartes'], ['liste', 'Liste'], ['compact', 'Compact']];
  var PXUNITS = ['/ page', '/ pièce', '/ m²', '/ A4', '/ 100 ex'];
  function pxBaseById(id) { var b = window.__spDefaults || [], i; for (i = 0; i < b.length; i++) if (b[i].id === id) return b[i]; return null; }
  function ikOf(p) {
    if (p.ik) return p.ik;
    var d = pxBaseById(p.id), i, r;
    if (d) for (i = 0; i < PXICONS.length; i++) { r = pxBaseById(PXICONS[i][3]); if (r && r.icon === d.icon) return PXICONS[i][0]; }
    return 'papier';
  }
  function emojiOf(k) { var i; for (i = 0; i < PXICONS.length; i++) if (PXICONS[i][0] === k) return PXICONS[i][1]; return '📄'; }
  function applyPrices(items) {
    var P = prods(); if (!P) return; snapDefaults();
    function iconFor(it) {
      var i, r;
      if (it.ik) for (i = 0; i < PXICONS.length; i++) if (PXICONS[i][0] === it.ik) { r = pxBaseById(PXICONS[i][3]); if (r) return r.icon; }
      r = pxBaseById(it.id); return r ? r.icon : window.__spDefaults[0].icon;
    }
    var next = items.map(function (it) { var d = Object.assign({}, it); d.icon = iconFor(it); return d; });
    var top = next.filter(function (x) { return x.star; }), rest = next.filter(function (x) { return !x.star; });
    P.length = 0; top.concat(rest).forEach(function (x) { P.push(x); });
  }
  function setView(v) {
    var ok = PXVIEWS.some(function (x) { return x[0] === v; });
    window.__spView = ok ? v : 'cartes';
    if (document.body) document.body.setAttribute('data-px-view', window.__spView);
  }
  function loadPrices() {
    return db('GET', colPath(PRIX_COL)).then(function (o) {
      var r = o && o[PRIX_RID];
      if (r && r.items && r.items.length) applyPrices(r.items);
      setView(r && r.view);
    }).catch(function () {});
  }
  function savePrices(items) { return db('PUT', colPath(PRIX_COL) + '/' + PRIX_RID, { items: items, view: window.__spView || 'cartes' }); }
  function plain(p) { return { id: p.id, name: p.name, desc: p.desc || '', detail: p.detail || '', unit: p.unit || '', price: p.price, hidden: !!p.hidden, ik: ikOf(p), star: !!p.star }; }

  /* la « Mémoire » des documents est gardée sur le téléphone : on la range par compte.
     Les anciens documents (sans compte) sont donnés au premier compte qui se connecte sur cet appareil. */
  function initFx() {
    try {
      var k = window.__spFxKey(), legacy = localStorage.getItem('senprint_memoire_docs');
      if (!localStorage.getItem(k) && legacy && !localStorage.getItem('nl_fx_claimed')) {
        localStorage.setItem(k, legacy); localStorage.setItem('nl_fx_claimed', S.id);
      }
    } catch (e) {}
    if (window.__spFxReload) window.__spFxReload();
  }
  function initSpace() { initFx(); pxCss(); return loadPrices(); }

  var PXCSS = '#nl-pxb{position:fixed;left:10px;bottom:10px;z-index:2147483000;height:44px;padding:0 16px;border-radius:22px;border:2px solid #fff;background:#0f172a;color:#fff;font-weight:800;font-size:14px;box-shadow:0 4px 14px rgba(0,0,0,.3);cursor:pointer;font-family:inherit}' +
    '#nl-px{position:fixed;inset:0;z-index:2147483645;background:rgba(15,23,42,.55);display:flex;align-items:flex-end;justify-content:center;font-family:"Segoe UI",Arial,sans-serif;color:#0f172a}' +
    '#nl-px *{box-sizing:border-box}.px-sheet{background:#fff;width:100%;max-width:560px;height:92vh;border-radius:22px 22px 0 0;display:flex;flex-direction:column;overflow:hidden}' +
    '.px-hd{padding:16px 18px 10px}.px-hd h3{margin:0;font-size:19px}.px-hd p{margin:4px 0 0;font-size:13px;color:#64748b}' +
    '.px-bd{overflow-y:auto;padding:4px 14px 14px;flex:1}.px-er{font-weight:700;font-size:13px;min-height:20px;padding:0 18px;color:#dc2626}.px-er.ok{color:#059669}' +
    '.px-add{display:block;width:calc(100% - 28px);margin:2px 14px 10px;padding:15px;border:0;border-radius:14px;background:#f43f5e;color:#fff;font-weight:800;font-size:16px;cursor:pointer;font-family:inherit}' +
    '.px-sr{display:block;width:calc(100% - 28px);margin:0 14px 10px;padding:11px 14px;border:1.5px solid #e2e8f0;border-radius:12px;font-size:15px;font-family:inherit}' +
    '.px-vw{display:flex;gap:6px;margin:0 14px 10px;align-items:center;font-size:12px;font-weight:700;color:#64748b}.px-vw button{flex:1;padding:9px 4px;border-radius:10px;border:1.5px solid #e2e8f0;background:#fff;font-weight:800;font-size:13px;color:#475569;cursor:pointer;font-family:inherit}.px-vw button.on{background:#0f172a;border-color:#0f172a;color:#fff}' +
    '.px-li{display:flex;align-items:center;gap:10px;border:1.5px solid #e2e8f0;border-radius:14px;padding:10px 12px;margin-bottom:8px;background:#f8fafc;cursor:pointer}.px-li.off{opacity:.5}.px-em{font-size:24px;width:34px;text-align:center}' +
    '.px-tx{flex:1;min-width:0}.px-tx b{display:block;font-size:15px;overflow-wrap:anywhere}.px-tx small{font-size:13px;color:#64748b;font-weight:700}.px-ch{color:#94a3b8;font-size:22px}' +
    '.px-sw{width:46px;height:26px;border-radius:13px;border:0;background:#cbd5e1;position:relative;cursor:pointer;flex:none}.px-sw:after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:left .15s}.px-sw.on{background:#10b981}.px-sw.on:after{left:23px}' +
    '.px-ft{padding:12px 14px;border-top:1px solid #e2e8f0;display:flex;gap:8px}.px-b{flex:1;padding:14px;border:0;border-radius:12px;font-weight:800;font-size:15px;cursor:pointer;font-family:inherit;background:#f43f5e;color:#fff}.px-b.g{background:#fff;border:1.5px solid #e2e8f0;color:#475569}.px-b.d{background:#fff;border:1.5px solid #fecaca;color:#dc2626}' +
    '.px-lb{font-size:12px;font-weight:800;color:#475569;display:block;margin:14px 0 5px}.px-in{width:100%;padding:13px;border:1.5px solid #e2e8f0;border-radius:12px;font-size:17px;font-family:inherit;background:#fff}.px-in:focus{outline:none;border-color:#f43f5e}' +
    '.px-ch2{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.px-ch2 button{padding:8px 12px;border-radius:999px;border:1.5px solid #e2e8f0;background:#fff;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;color:#475569}.px-ch2 button.on{border-color:#f43f5e;background:#fff1f2;color:#be123c}' +
    '.px-ic{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.px-ic button{padding:10px 4px;border-radius:12px;border:1.5px solid #e2e8f0;background:#fff;cursor:pointer;font-family:inherit;font-size:12px;font-weight:700;color:#475569}.px-ic button span{display:block;font-size:24px}.px-ic button.on{border-color:#f43f5e;background:#fff1f2;color:#be123c}' +
    '.px-row2{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:16px;font-size:14px;font-weight:700}.px-more{margin-top:14px;background:none;border:0;color:#64748b;font-weight:800;font-size:13px;cursor:pointer;padding:6px 0;font-family:inherit}' +
    'body[data-px-view="liste"] .grid.xl\\:grid-cols-4{grid-template-columns:minmax(0,1fr)!important;gap:8px!important}body[data-px-view="liste"] .grid.xl\\:grid-cols-4>button{flex-direction:row!important;align-items:center!important}body[data-px-view="liste"] .grid.xl\\:grid-cols-4>button>div:first-child{margin:8px 0 8px 12px!important;padding:0!important}' +
    'body[data-px-view="compact"] .grid.xl\\:grid-cols-4{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:8px!important}body[data-px-view="compact"] .grid.xl\\:grid-cols-4>button p{display:none!important}@media(min-width:768px){body[data-px-view="compact"] .grid.xl\\:grid-cols-4{grid-template-columns:repeat(4,minmax(0,1fr))!important}}';
  function pxCss() {
    if (!$('nl-pxcss')) { var st = document.createElement('style'); st.id = 'nl-pxcss'; st.textContent = PXCSS; document.head.appendChild(st); }
    if (!document.body.getAttribute('data-px-view')) setView(window.__spView);
  }
  function money(n) { return Number(n || 0).toLocaleString('fr-FR') + ' FCFA'; }

  function openPrices(startId) {
    if (typeof startId !== 'number') startId = null;
    var P = prods(); if (!P || $('nl-px')) return; snapDefaults(); pxCss();
    var cur = P.map(plain), maxDef = 0, q = '';
    (window.__spDefaults || []).forEach(function (d) { maxDef = Math.max(maxDef, d.id); });
    var w = document.createElement('div'); w.id = 'nl-px';
    w.innerHTML = '<div class="px-sheet" id="px-sh"></div>';
    document.body.appendChild(w);
    var sh = $('px-sh');
    function close() { w.remove(); }
    function say(msg, ok) { var e = $('px-er'); if (e) { e.textContent = msg || ''; e.className = 'px-er' + (ok ? ' ok' : ''); } }
    function persist() {
      return savePrices(cur).then(function () { applyPrices(cur); if (window.__spRefresh) window.__spRefresh(); });
    }
    function find(id) { var i; for (i = 0; i < cur.length; i++) if (cur[i].id === id) return cur[i]; return null; }

    function listView() {
      var rows = cur.filter(function (p) { return !q || (p.name + ' ' + p.desc + ' ' + p.detail).toLowerCase().indexOf(q) > -1; });
      sh.innerHTML = '<div class="px-hd"><h3>🛍️ Mes produits</h3><p>Touche un produit pour le modifier. Le bouton vert le montre ou le cache.</p></div>' +
        '<button class="px-add" id="px-add" type="button">+ Ajouter un produit</button>' +
        '<input class="px-sr" id="px-q" type="search" placeholder="🔍 Chercher un produit" value="' + esc(q) + '">' +
        '<div class="px-vw"><span>Affichage :</span>' + PXVIEWS.map(function (v) { return '<button type="button" data-v="' + v[0] + '" class="' + (window.__spView === v[0] ? 'on' : '') + '">' + v[1] + '</button>'; }).join('') + '</div>' +
        '<div class="px-er" id="px-er"></div>' +
        '<div class="px-bd" id="px-bd">' + (rows.length ? rows.map(function (p) {
          return '<div class="px-li' + (p.hidden ? ' off' : '') + '" data-id="' + p.id + '"><span class="px-em">' + emojiOf(p.ik) + '</span><div class="px-tx"><b>' + (p.star ? '⭐ ' : '') + esc(p.name) + '</b><small>' + money(p.price) + ' ' + esc(p.unit) + '</small></div>' +
            '<button type="button" class="px-sw' + (p.hidden ? '' : ' on') + '" data-sw="' + p.id + '" aria-label="Afficher ou cacher"></button><span class="px-ch">›</span></div>';
        }).join('') : '<p style="text-align:center;color:#64748b;font-weight:700;margin-top:24px">Aucun produit trouvé.</p>') +
        '<button class="px-more" id="px-rst" type="button">↺ Remettre les prix d’origine</button></div>' +
        '<div class="px-ft"><button class="px-b g" id="px-x" type="button">Fermer</button></div>';
      $('px-x').onclick = close;
      $('px-add').onclick = function () { editView(null); };
      $('px-q').oninput = function () { q = this.value.trim().toLowerCase(); var pos = this.selectionStart; listView(); var n = $('px-q'); n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {} };
      $('px-rst').onclick = function () {
        if (!confirm('Remettre tous les prix et noms d’origine ?')) return;
        cur = window.__spDefaults.map(plain); persist().then(function () { listView(); say('✓ Prix d’origine remis', true); }).catch(function (e) { say(niceErr(e)); });
      };
      Array.prototype.forEach.call(sh.querySelectorAll('.px-vw button'), function (b) {
        b.onclick = function () { setView(b.getAttribute('data-v')); persist().then(function () { listView(); say('✓ Affichage changé', true); }).catch(function (e) { say(niceErr(e)); }); };
      });
      Array.prototype.forEach.call(sh.querySelectorAll('.px-li'), function (r) {
        r.onclick = function (ev) {
          var id = Number(r.getAttribute('data-id'));
          if (ev.target.getAttribute && ev.target.getAttribute('data-sw')) {
            var p = find(id); p.hidden = !p.hidden;
            persist().then(function () { listView(); say(p.hidden ? '✓ Caché du catalogue' : '✓ Visible dans le catalogue', true); }).catch(function (e) { p.hidden = !p.hidden; listView(); say(niceErr(e)); });
            return;
          }
          editView(id);
        };
      });
    }

    function editView(id) {
      var isNew = id == null, p = isNew ? { id: 0, name: '', desc: '', detail: '', unit: '/ pièce', price: '', hidden: false, ik: 'papier', star: false } : Object.assign({}, find(id));
      if (isNew) { cur.forEach(function (x) { p.id = Math.max(p.id, x.id); }); p.id += 1; }
      sh.innerHTML = '<div class="px-hd"><h3>' + (isNew ? '➕ Nouveau produit' : '✏️ Modifier le produit') + '</h3></div>' +
        '<div class="px-bd"><label class="px-lb" style="margin-top:4px">Nom du produit</label><input class="px-in" id="e-name" type="text" placeholder="Ex : Flyers A5" value="' + esc(p.name) + '">' +
        '<label class="px-lb">Prix (FCFA)</label><input class="px-in" id="e-price" type="number" inputmode="numeric" min="0" placeholder="Ex : 500" value="' + esc(p.price) + '">' +
        '<label class="px-lb">Prix par…</label><input class="px-in" id="e-unit" type="text" value="' + esc(p.unit) + '"><div class="px-ch2" id="e-units">' + PXUNITS.map(function (u) { return '<button type="button" data-u="' + esc(u) + '">' + esc(u) + '</button>'; }).join('') + '</div>' +
        '<label class="px-lb">Image du produit</label><div class="px-ic" id="e-ic">' + PXICONS.map(function (i) { return '<button type="button" data-k="' + i[0] + '"><span>' + i[1] + '</span>' + i[2] + '</button>'; }).join('') + '</div>' +
        '<div class="px-row2"><span>⭐ Mettre en premier dans le catalogue</span><button type="button" class="px-sw" id="e-star"></button></div>' +
        '<div class="px-row2"><span>👁️ Visible dans le catalogue</span><button type="button" class="px-sw" id="e-show"></button></div>' +
        '<button class="px-more" id="e-more" type="button">+ Plus de détails (facultatif)</button>' +
        '<div id="e-det" style="display:none"><label class="px-lb" style="margin-top:4px">Description courte</label><input class="px-in" id="e-desc" type="text" value="' + esc(p.desc) + '"><label class="px-lb">Détail</label><input class="px-in" id="e-detail" type="text" value="' + esc(p.detail) + '"></div></div>' +
        '<div class="px-er" id="px-er"></div>' +
        '<div class="px-ft"><button class="px-b g" id="e-back" type="button">Retour</button>' + (!isNew && p.id > maxDef ? '<button class="px-b d" id="e-del" type="button">Supprimer</button>' : '') + '<button class="px-b" id="e-ok" type="button">Enregistrer</button></div>';
      function mark() {
        Array.prototype.forEach.call(sh.querySelectorAll('#e-ic button'), function (b) { b.className = b.getAttribute('data-k') === p.ik ? 'on' : ''; });
        Array.prototype.forEach.call(sh.querySelectorAll('#e-units button'), function (b) { b.className = b.getAttribute('data-u') === $('e-unit').value.trim() ? 'on' : ''; });
        $('e-star').className = 'px-sw' + (p.star ? ' on' : ''); $('e-show').className = 'px-sw' + (p.hidden ? '' : ' on');
      }
      mark();
      if (p.desc || p.detail) { $('e-det').style.display = 'block'; $('e-more').style.display = 'none'; }
      $('e-more').onclick = function () { $('e-det').style.display = 'block'; this.style.display = 'none'; };
      $('e-unit').oninput = mark;
      Array.prototype.forEach.call(sh.querySelectorAll('#e-units button'), function (b) { b.onclick = function () { $('e-unit').value = b.getAttribute('data-u'); mark(); }; });
      Array.prototype.forEach.call(sh.querySelectorAll('#e-ic button'), function (b) { b.onclick = function () { p.ik = b.getAttribute('data-k'); mark(); }; });
      $('e-star').onclick = function () { p.star = !p.star; mark(); };
      $('e-show').onclick = function () { p.hidden = !p.hidden; mark(); };
      $('e-back').onclick = listView;
      if ($('e-del')) $('e-del').onclick = function () {
        if (!confirm('Supprimer « ' + p.name + ' » ?')) return;
        var keep = cur; cur = cur.filter(function (x) { return x.id !== p.id; });
        persist().then(listView).catch(function (e) { cur = keep; say(niceErr(e)); });
      };
      $('e-ok').onclick = function () {
        var name = $('e-name').value.trim(), raw = String($('e-price').value).replace(/\s/g, '').replace(',', '.'), price = Math.round(Number(raw));
        if (!name) { say('Écris le nom du produit.'); return; }
        if (raw === '' || !isFinite(price) || price < 0) { say('Écris un prix valide (ex : 500).'); return; }
        p.name = name; p.price = price; p.unit = $('e-unit').value.trim(); p.desc = $('e-desc').value.trim(); p.detail = $('e-detail').value.trim();
        var keep = cur;
        cur = isNew ? [p].concat(cur) : cur.map(function (x) { return x.id === p.id ? p : x; });
        var b = $('e-ok'); b.disabled = true; b.textContent = 'Enregistrement…';
        persist().then(function () { q = ''; listView(); say('✓ ' + name + ' enregistré', true); }).catch(function (e) { cur = keep; b.disabled = false; b.textContent = 'Enregistrer'; say(niceErr(e)); });
      };
    }
    if (startId != null && find(startId)) editView(startId); else listView();
  }
  /* ---------- bouton ✏️ sur chaque carte produit du catalogue ---------- */
  var EDCSS = '.grid.xl\\:grid-cols-4>button{position:relative}' +
    '.grid.xl\\:grid-cols-4>button>div:first-child{padding-right:46px!important}' +
    '.px-ed{position:absolute;top:8px;right:8px;z-index:2;width:32px;height:32px;border-radius:50%;background:#fff;color:#0f172a;box-shadow:0 1px 6px rgba(0,0,0,.25);border:1px solid #e2e8f0;display:flex;align-items:center;justify-content:center;font-size:15px;line-height:1;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent}' +
    '.px-ed:active{transform:scale(.92)}';
  function fiberKey(el) {
    var k; for (k in el) if (k.indexOf('__reactFiber$') === 0) { var f = el[k]; return f && f.key != null ? Number(f.key) : null; }
    return null;
  }
  function decorateCards() {
    var cards = document.querySelectorAll('.grid.xl\\:grid-cols-4>button'), i;
    for (i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (c.querySelector('.px-ed')) continue;
      var id = fiberKey(c); if (id == null || isNaN(id)) continue;
      var e = document.createElement('span');
      e.className = 'px-ed'; e.setAttribute('role', 'button'); e.setAttribute('aria-label', 'Modifier le prix'); e.title = 'Modifier le prix';
      e.textContent = '✏️'; e.setAttribute('data-pid', id);
      e.onclick = function (ev) { ev.stopPropagation(); ev.preventDefault(); openPrices(Number(this.getAttribute('data-pid'))); };
      c.appendChild(e);
    }
  }
  function watchCards() {
    if (document.getElementById('nl-edcss')) return;
    var st = document.createElement('style'); st.id = 'nl-edcss'; st.textContent = EDCSS; document.head.appendChild(st);
    var t = null;
    new MutationObserver(function () { if (t) return; t = setTimeout(function () { t = null; decorateCards(); }, 60); }).observe(document.body, { childList: true, subtree: true });
    decorateCards();
  }
  function addPriceBtn() {
    if (TEST || $('nl-pxb')) return;
    pxCss();
    var b = document.createElement('button'); b.id = 'nl-pxb'; b.type = 'button'; b.textContent = '🛍️ Mes produits'; b.onclick = function () { openPrices(); };
    document.body.appendChild(b);
    watchCards();
  }

  /* ---------- contrôle d'accès (blocage / validation admin) ---------- */
  function access() {
    return Promise.all([db('GET', '/status/' + S.id), db('GET', '/config').catch(function () { return null; })]).then(function (r) {
      var st = r[0], cf = r[1] || {};
      if (st) return st.blocked ? { s: 'blocked', msg: st.msg } : { s: 'ok' };
      return cf.approval ? { s: 'pending' } : { s: 'ok' };
    });
  }
  function seen() { return db('PUT', '/seen/' + S.id, { ts: Date.now(), nom: S.nom }).catch(function () {}); }
  function apply(a) {
    if (window.__niamke) window.__niamke.blocked = a.s !== 'ok';
    if (a.s === 'blocked') { showBlocked(a.msg); return; }
    if (a.s === 'pending') { showPending(); return; }
    if (!started) {
      started = true; initSpace().then(openApp, openApp); seen(); addPriceBtn();
      setInterval(seen, 60000);
      setInterval(function () { if (S.token && !DEMO) refreshTok().catch(function () {}); }, 45 * 60 * 1000);
    }
    hideGate();
  }
  function enter() {
    return access().then(function (a) {
      apply(a);
      if (!TEST && !enter.w) {
        enter.w = setInterval(function () { access().then(apply).catch(function () {}); }, 15000);
        document.addEventListener('visibilitychange', function () { if (!document.hidden) access().then(apply).catch(function () {}); });
      }
    });
  }

  /* ---------- interface ---------- */
  var CSS = '#nl-gate{position:fixed;inset:0;z-index:2147483646;background:#eef1f5;display:none;align-items:flex-start;justify-content:center;overflow-y:auto;padding:20px 14px;font-family:"Segoe UI",Arial,sans-serif;color:#0f172a}' +
    '#nl-gate *{box-sizing:border-box}.nl-box{width:100%;max-width:400px;margin:auto;background:#fff;border:1px solid #e2e8f0;border-radius:22px;padding:26px 22px;box-shadow:0 20px 60px rgba(15,23,42,.1)}' +
    '.nl-logo{font-size:26px;font-weight:900;text-align:center}.nl-logo b:nth-child(1){color:#ef4444}.nl-logo b:nth-child(2){color:#facc15}.nl-logo b:nth-child(3){color:#3b82f6}' +
    '.nl-tabs{display:flex;gap:6px;margin:16px 0 4px}.nl-tab{flex:1;padding:10px;border:1.5px solid #e2e8f0;background:#fff;border-radius:12px;font-weight:800;font-size:13px;color:#64748b;cursor:pointer;font-family:inherit}' +
    '.nl-tab.on{background:#0f172a;color:#fff;border-color:#0f172a}.nl-box label{display:block;margin:12px 0 5px;font-size:12px;font-weight:700;color:#64748b}' +
    '.nl-box input[type=text],.nl-box input[type=tel],.nl-box input[type=password]{width:100%;padding:12px 13px;border:1.5px solid #e2e8f0;border-radius:12px;font-size:16px;outline:none;font-family:inherit}' +
    '.nl-box input:focus{border-color:#f43f5e}.nl-btn{width:100%;margin-top:16px;padding:13px;border:0;border-radius:12px;background:#f43f5e;color:#fff;font-weight:800;font-size:15px;cursor:pointer;font-family:inherit}' +
    '.nl-btn:disabled{opacity:.6}.nl-btn.ghost{background:#fff;border:1.5px solid #e2e8f0;color:#64748b}.nl-err{color:#dc2626;font-weight:700;font-size:13px;min-height:18px;margin-top:10px}' +
    '.nl-ph{display:block;width:96px;height:96px;margin:14px auto 0;border-radius:50%;background:#e2e8f0 center/cover no-repeat;border:2px dashed #94a3b8;cursor:pointer;text-align:center;font-size:12px;font-weight:800;color:#64748b;line-height:1.2;padding-top:30px}' +
    '.nl-ph.has{border:3px solid #f43f5e;padding:0;color:transparent}.nl-ph input{display:none}.nl-c{text-align:center}.nl-c h2{margin:10px 0 6px;font-size:22px}.nl-c p{color:#64748b;font-size:14px;line-height:1.5;margin:0}' +
    '#nl-chip{position:fixed;left:10px;bottom:10px;z-index:2147483000;width:42px;height:42px;border-radius:50%;border:2px solid #fff;background:#0f172a center/cover no-repeat;color:#fff;font-weight:900;box-shadow:0 4px 14px rgba(15,23,42,.35);cursor:pointer;font-size:16px;padding:0}';
  function buildUI() {
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    el = document.createElement('div'); el.id = 'nl-gate'; document.body.appendChild(el);
    el.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-m],[data-act]') : null; if (!t) return;
      if (t.hasAttribute('data-m')) showAuth(t.getAttribute('data-m'));
      else if (t.getAttribute('data-act') === 'forgot') {
        var tl = $('nl-tel') ? idOf($('nl-tel').value) : '';
        var msg = 'Bonjour, j’ai oublié mon mot de passe SenPrint.' + (tl ? ' Mon numéro est ' + tl + '.' : '');
        window.open('https://wa.me/221772919300?text=' + encodeURIComponent(msg), '_blank');
      }
      else if (t.getAttribute('data-act') === 'logout') { forget(); location.reload(); }
      else if (t.getAttribute('data-act') === 'retry') enter().catch(function () {});
    });
    el.addEventListener('change', function (e) {
      if (e.target.id !== 'nl-file' || !e.target.files[0]) return;
      readPhoto(e.target.files[0]).then(function (d) {
        photoData = d; var l = $('nl-phl'); l.style.backgroundImage = 'url(' + d + ')'; l.className = 'nl-ph has'; $('nl-err').textContent = '';
      }).catch(function (er) { $('nl-err').textContent = er.message; });
    });
    el.addEventListener('submit', function (e) {
      e.preventDefault(); var b = e.target.querySelector('button[type=submit]'), err = $('nl-err'); err.textContent = '';
      var run = e.target.id === 'nl-fu' ? submitUnified() : e.target.id === 'nl-fs' ? submitSignup() : submitLogin();
      if (typeof run === 'string') { err.textContent = run; return; }
      b.disabled = true;
      run.then(enter).then(function () { b.disabled = false; }).catch(function (er) { b.disabled = false; err.textContent = niceErr(er); });
    });
  }
  function submitSignup() {
    var f = { nom: $('nl-nom').value.trim(), ent: '', tel: $('nl-tel').value.trim(), adr: '', pw: $('nl-pw').value, photo: photoData };
    if (f.nom.length < 2) return 'Entre ton nom.';
    if (idOf(f.tel).length < 8) return 'Numéro de téléphone invalide.';
    if (!f.photo) return 'Ajoute ta photo.';
    if (f.pw.length < 6) return 'Mot de passe : 6 caractères minimum.';
    return doSignup(f);
  }
  function submitLogin() {
    var tel = $('nl-tel').value.trim(), pw = $('nl-pw').value;
    if (idOf(tel).length < 8) return 'Numéro de téléphone invalide.';
    if (!pw) return 'Entre ton mot de passe.';
    return doLogin(tel, pw);
  }
  /* photo de profil : toujours compressée à 80 Ko maximum (carré, JPEG) */
  var PHOTO_MAX = 80 * 1024;
  function bytesOf(d) { var i = d.indexOf(',') + 1, pad = /=+$/.exec(d); return Math.floor((d.length - i) * 3 / 4) - (pad ? pad[0].length : 0); }
  function compressPhoto(im) {
    var m = Math.min(im.width, im.height), side = Math.min(640, m), q = 0.86, out = '', n;
    for (n = 0; n < 24; n++) {
      var c = document.createElement('canvas'), x = c.getContext('2d');
      c.width = c.height = side;
      x.fillStyle = '#fff'; x.fillRect(0, 0, side, side);
      x.drawImage(im, (im.width - m) / 2, (im.height - m) / 2, m, m, 0, 0, side, side);
      out = c.toDataURL('image/jpeg', q);
      if (bytesOf(out) <= PHOTO_MAX) return out;
      if (q > 0.5) q = Math.max(0.5, q - 0.08); else side = Math.max(48, Math.round(side * 0.85));
    }
    return bytesOf(out) <= PHOTO_MAX ? out : '';
  }
  function readPhoto(file) {
    return new Promise(function (res, rej) {
      if (!/^image\//.test(file.type || '')) return rej(new Error('Choisis une image (JPG, PNG…).'));
      if (file.size > 25 * 1024 * 1024) return rej(new Error('Image trop volumineuse (25 Mo maximum avant compression).'));
      var fr = new FileReader();
      fr.onerror = function () { rej(new Error('Photo illisible.')); };
      fr.onload = function () {
        var im = new Image();
        im.onerror = function () { rej(new Error('Photo illisible.')); };
        im.onload = function () {
          var d = compressPhoto(im);
          if (!d) return rej(new Error('Impossible de réduire cette photo à 80 Ko. Essaie une autre image.'));
          res(d);
        };
        im.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }
  function logo() { return '<div class="nl-logo"><b>S</b><b>e</b><b>n</b>Print</div>'; }
  function showGate(html) { if (!el) return; el.innerHTML = '<div class="nl-box">' + logo() + html + '</div>'; el.style.display = 'flex'; }
  function hideGate() { if (el) el.style.display = 'none'; var h = $('nl-hide'); if (h) h.remove(); }
  function showAuth(m) {
    mode = 'unified'; photoData = '';
    var last = ''; try { last = localStorage.getItem('nl_last_tel') || ''; } catch (e) {}
    showGate('<form id="nl-fu" autocomplete="on">' +
      '<div id="nl-new" style="display:' + (last ? 'none' : 'block') + '"><label class="nl-ph" id="nl-phl" for="nl-file">Ajouter<br>ma photo<input type="file" id="nl-file" accept="image/*"></label>' +
      '<label>Nom</label><input type="text" id="nl-nom" autocomplete="name"></div>' +
      '<label>Numéro de téléphone</label><input type="tel" id="nl-tel" inputmode="tel" autocomplete="username" value="' + esc(last) + '">' +
      '<label>Mot de passe</label><input type="password" id="nl-pw" autocomplete="current-password">' +
      '<div class="nl-err" id="nl-err"></div>' +
      '<button class="nl-btn" type="submit">Entrer</button>' +
      '<button class="nl-btn ghost" type="button" data-act="forgot">Mot de passe oublié ?</button></form>');
  }
  /* un seul écran : photo, nom, numéro, mot de passe pour la 1re fois ; ensuite numéro + mot de passe suffisent.
     Le mot de passe est libre. S'il ne correspond pas au numéro à la connexion suivante, l'accès est refusé. */
  function submitUnified() {
    var tel = $('nl-tel').value.trim(), pw = $('nl-pw').value, box = $('nl-new'), shown = box.style.display !== 'none';
    if (idOf(tel).length < 8) return 'Numéro de téléphone invalide.';
    if (!pw) return 'Entre ton mot de passe.';
    return doLogin(tel, pw).catch(function (er) {
      if (!/invalid_credentials|Invalid login credentials|INVALID_LOGIN|INVALID_PASSWORD|EMAIL_NOT_FOUND/i.test((er && er.message) || '')) throw er;
      var nom = $('nl-nom').value.trim();
      if (!shown) { box.style.display = 'block'; throw new Error('Mot de passe incorrect. Si c’est la première fois, ajoute ta photo et ton nom, puis appuie sur Entrer.'); }
      if (nom.length < 2 || !photoData) throw new Error('Si c’est ta première fois : ajoute ta photo et ton nom. Sinon, mot de passe incorrect.');
      return doSignup({ nom: nom, ent: '', tel: tel, adr: '', pw: pw, photo: photoData }).catch(function (er2) {
        if (/user_already_exists|already registered|EMAIL_EXISTS/i.test((er2 && er2.message) || '')) throw new Error('Mot de passe incorrect pour ce numéro.');
        throw er2;
      });
    });
  }
  function showBlocked(msg) {
    showGate('<div class="nl-c"><h2>🔒 Accès bloqué</h2><p>' + esc(msg || CFG.blockMessage || 'Ton accès est suspendu. Contacte l’administrateur.') + '</p></div>' +
      '<button class="nl-btn" data-act="retry">Réessayer</button><button class="nl-btn ghost" data-act="logout">Changer de compte</button>');
  }
  function showPending() {
    showGate('<div class="nl-c"><h2>⏳ En attente de validation</h2><p>Ton espace est créé. L’administrateur doit l’activer, ça se met à jour tout seul.</p></div>' +
      '<button class="nl-btn" data-act="retry">Vérifier maintenant</button><button class="nl-btn ghost" data-act="logout">Se déconnecter</button>');
  }
  function addChip() {
    if (TEST || $('nl-chip')) return;
    var b = document.createElement('button'); b.id = 'nl-chip'; b.title = S.nom || 'Mon compte';
    if (S.photo) b.style.backgroundImage = 'url(' + S.photo + ')'; else b.textContent = (S.nom || '?').charAt(0).toUpperCase();
    b.onclick = function () { if (confirm('Se déconnecter de ' + (S.nom || 'ce compte') + ' ?')) { forget(); location.reload(); } };
    document.body.appendChild(b);
  }

  /* le mot de passe de l'app = celui du client : on le saisit à sa place pour qu'il ne le tape pas deux fois */
  function autoUnlock() {
    var tries = 0, filled = 0, t = setInterval(function () {
      if (++tries > 80 || filled > 2) { clearInterval(t); return; }
      var inp = document.querySelector('input[type=password][placeholder="Mot de passe"]');
      if (!inp || !inp.isConnected || !started) return;
      filled++;
      var set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(inp, S.pw); inp.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(function () { inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }, 60);
      setTimeout(function () { if (!document.querySelector('input[type=password][placeholder="Mot de passe"]')) clearInterval(t); }, 500);
    }, 250);
  }
  ready.then(function () { if (!TEST) autoUnlock(); });

  /* tchat de groupe : chargé une fois l'accès accordé */
  var API = window.__niamke = { S: S, DEMO: DEMO, sbCall: sbCall, ready: ready, blocked: false };
  ready.then(function () {
    if (TEST) return;
    var sc = document.createElement('script'); sc.src = 'niamke-chat.js'; sc.async = true; document.head.appendChild(sc);
  });

  if (TEST) { var h0 = $('nl-hide'); if (h0) h0.remove(); window.__nl = { S: S, doSignup: doSignup, doLogin: doLogin, access: access, handleAction: handleAction, ready: function () { return ready; }, enter: enter }; return; }
  function boot() { buildUI(); var hasSess = false; try { hasSess = !!localStorage.getItem('nl_sess'); } catch (e) {}
    if (!DEMO && hasSess) { showGate('<div class="nl-c"><p>Connexion…</p></div>'); resume().then(enter).catch(function (er) { if (/Failed to fetch|NetworkError|Load failed/i.test((er && er.message) || '')) { showGate('<div class="nl-c"><h2>Pas de connexion</h2><p>Vérifie ton internet.</p></div><button class="nl-btn" onclick="location.reload()">Réessayer</button>'); return; } forget(); showAuth('login'); }); return; } var last = ''; try { last = localStorage.getItem('nl_last_tel') || ''; } catch (e) {} showAuth(last ? 'login' : 'signup'); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
