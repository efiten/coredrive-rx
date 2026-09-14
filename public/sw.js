// Minimal service worker: makes the app installable and lets the shell load
// offline. Network-first (always fresh online), cache fallback (offline).
// Only the static app assets go through fetch; MQTT runs over WSS (not cached).
const CACHE = 'coredrive-rx-v50';

// config.json is deliberately NEVER cached, in either direction. It is
// per-deployment runtime config, and a stale copy is worse than none: flags added
// after the copy was taken normalize to false, silently disabling those features
// with no error anywhere. Observed in the field as a device reporting
// `fullRfLog: on` while rfSampler and regionDiscovery were both dead, which looked
// identical to the features being broken. "No config" is a state the app can
// detect, warn about and retry (see loadConfig retries in src/app.js); "quietly
// out-of-date config" is not.
const NEVER_CACHED = ['/config.json'];

function neverCached(url) {
  try { return NEVER_CACHED.includes(new URL(url).pathname); } catch { return false; }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  // Drop stale caches from older builds so a fresh index.html is never shadowed.
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (neverCached(e.request.url)) return; // straight to the network — the app handles failure
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((m) => {
        if (m) return m;
        // Only a NAVIGATION may fall back to the app shell. Handing index.html to an
        // asset or JSON request converts a clean network error into a misleading
        // parse error further down — that is how a failed config fetch surfaced as
        // `config.json: invalid JSON — Unexpected token '<'` instead of "offline".
        return e.request.mode === 'navigate' ? caches.match('/') : Response.error();
      }))
  );
});
