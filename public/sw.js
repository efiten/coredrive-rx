// Minimal service worker: makes the app installable and lets the shell load
// offline. Network-first (always fresh online), cache fallback (offline).
// Only the static app assets go through fetch; MQTT runs over WSS (not cached).
const CACHE = 'coredrive-rx-v7';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  // Drop stale caches from older builds so a fresh index.html is never shadowed.
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
  await self.clients.claim();
})()));

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
