// Service worker: keeps the app's OWN files (code only - never data) so it opens offline.
// It never touches any address except this app's own files.
// IMPORTANT: change this name on every new release so phones pick up the fix.
const CACHE = 'safetasks-v5';
const FILES = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/main.js', './js/ui.js', './js/dom.js', './js/keypad.js', './js/model.js', './js/vault.js', './js/crypto.js', './js/guard.js', './js/icons.js',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // never handle outside addresses
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
