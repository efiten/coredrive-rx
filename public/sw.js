// Minimal service worker: makes the app installable and lets the shell load
// offline. Network-first (always fresh online), cache fallback (offline).
// Only the static app assets go through fetch; MQTT runs over WSS (not cached).
const CACHE = 'corescope-rx-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('/')))
  );
});
