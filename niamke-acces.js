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
  var LOGO_IMG = 'data:image/png;base64,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';
  window.__spLogo = LOGO_IMG;
  function logo() { return '<div class="nl-logo" style="display:flex;align-items:center;justify-content:center;gap:10px"><img src="' + LOGO_IMG + '" alt="" style="height:64px;width:auto"><span><b>S</b><b>e</b><b>n</b>Print</span></div>'; }
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
