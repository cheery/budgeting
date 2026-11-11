// Offline support: serve the app shell from cache, refresh it in the background.
// Bump on every change to a shell file, or installed apps keep the old version.
const CACHE = 'budget-v8';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'core.js', 'drive.js', 'cloud.js', 'learn.js', 'i18n.js',
  'privacy.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  // cache: 'reload' bypasses the HTTP cache (GitHub Pages sends max-age=600),
  // so a new version never gets pre-cached with stale files.
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;   // cloud storage API: always the network
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; });
    return cached ? (fresh.catch(() => {}), cached) : fresh;
  }));
});
