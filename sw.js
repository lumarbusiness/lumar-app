// LUMAR service worker: app-bestanden offline beschikbaar, altijd eerst de nieuwste versie proberen.
const CACHE = 'lumar-v11';
const SHELL = ['./', './index.html', './styles.css', './app.js', './logic.js', './store.js', './config.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // database en CDN niet cachen
  // Altijd de nieuwste versie ophalen (zonder browsercache); offline valt hij terug op de opgeslagen kopie
  e.respondWith(fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => {
    const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html'))));
});
