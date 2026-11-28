/* sw.js — permet d'ouvrir UNION IMPRIMERIE sans connexion (après une 1re ouverture en ligne).
   Ne touche jamais aux envois de données (POST) ni à Supabase : seules les pages/fichiers de l'app sont gardés. */
var CACHE = 'ui-shell-v1';
var SHELL = ['./', 'index.html', 'niamke-config.js', 'niamke-acces.js', 'niamke-offline.js', 'niamke-chat.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.method !== 'GET') return;
  var u = new URL(r.url);
  var sameOrigin = u.origin === self.location.origin;
  var fonts = /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
  if (!sameOrigin && !fonts) return;                       /* Supabase, etc. : jamais touchés */
  if (sameOrigin && /(^|\/)(actions|admin-niamke\.html)(\?|$)/.test(u.pathname + u.search)) return;
  /* réseau d'abord (toujours la dernière version), cache si pas de connexion */
  e.respondWith(fetch(r).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(r, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(r, { ignoreSearch: true }).then(function (hit) {
      return hit || (r.mode === 'navigate' ? caches.match('index.html') : Response.error());
    });
  }));
});
