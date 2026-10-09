// Tests for public/sw.js. The service worker is a classic (non-module) script, so
// it is loaded into a fake ServiceWorkerGlobalScope with node:vm rather than
// imported — this tests the file that actually ships, not a copy of its logic.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

// loadSw runs sw.js in a sandbox and returns the captured listeners plus the fakes,
// so a test can drive one event and inspect what the worker did.
function loadSw({ fetchImpl, cacheEntries = {} } = {}) {
  const listeners = {};
  const cache = {
    store: { ...cacheEntries },
    put(req, res) { this.store[keyOf(req)] = res; return Promise.resolve(); },
  };
  const caches = {
    open: () => Promise.resolve(cache),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(true),
    match: (req) => Promise.resolve(cache.store[keyOf(req)]),
  };
  const sandbox = {
    self: {
      addEventListener: (t, fn) => { listeners[t] = fn; },
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() },
    },
    caches,
    fetch: fetchImpl ?? (() => Promise.reject(new Error('offline'))),
    Response: { error: () => ({ kind: 'network-error' }) },
    URL,
    console,
  };
  vm.runInNewContext(SRC, sandbox);
  return { listeners, cache, sandbox };
}

const keyOf = (req) => (typeof req === 'string' ? req : req.url);

// makeReq builds the minimal Request shape sw.js reads.
const makeReq = (url, { method = 'GET', mode = 'no-cors' } = {}) => ({ url, method, mode });

// fire dispatches one fetch event and resolves what the worker responded with,
// or the sentinel PASSTHROUGH when it declined to call respondWith (letting the
// browser do its normal thing).
const PASSTHROUGH = Symbol('passthrough');
async function fire(listeners, request) {
  let responded = PASSTHROUGH;
  await listeners.fetch({ request, respondWith: (p) => { responded = p; } });
  return responded === PASSTHROUGH ? PASSTHROUGH : await responded;
}

test('config.json bypasses the worker entirely — a stale cached config must never be served', async () => {
  // A config cached in an earlier era silently disables every flag added since
  // (observed in the field: fullRfLog on, rfSampler/regionDiscovery absent →
  // both features dead with no error anywhere). No config is recoverable; a
  // stale one is invisible. So config.json never enters or leaves this cache.
  const { listeners } = loadSw({ cacheEntries: { 'https://x/config.json': { kind: 'stale-config' } } });
  const res = await fire(listeners, makeReq('https://x/config.json'));
  assert.strictEqual(res, PASSTHROUGH, 'config.json must go straight to the network');
});

test('a successful config.json fetch is not written to the cache either', async () => {
  const fresh = { kind: 'fresh', clone: () => ({ kind: 'fresh-copy' }) };
  const { listeners, cache } = loadSw({ fetchImpl: () => Promise.resolve(fresh) });
  await fire(listeners, makeReq('https://x/config.json'));
  assert.deepStrictEqual(Object.keys(cache.store), [], 'config.json must not be cached');
});

test('offline navigation with an empty cache falls back to the app shell', async () => {
  const shell = { kind: 'shell' };
  const { listeners } = loadSw({ cacheEntries: { '/': shell } });
  const res = await fire(listeners, makeReq('https://x/some/page', { mode: 'navigate' }));
  assert.strictEqual(res, shell);
});

test('offline asset request with an empty cache yields a network error, NOT the app shell', async () => {
  // Returning index.html for a non-navigation request turns a clean network
  // failure into a baffling parse error downstream — this is exactly how a
  // failed config fetch surfaced as "invalid JSON: Unexpected token '<'".
  const { listeners } = loadSw({ cacheEntries: { '/': { kind: 'shell' } } });
  const res = await fire(listeners, makeReq('https://x/assets/index-abc.js'));
  assert.deepStrictEqual(res, { kind: 'network-error' });
});

test('offline asset request still prefers its own cached copy when there is one', async () => {
  const cached = { kind: 'cached-asset' };
  const { listeners } = loadSw({ cacheEntries: { 'https://x/assets/index-abc.js': cached, '/': { kind: 'shell' } } });
  const res = await fire(listeners, makeReq('https://x/assets/index-abc.js'));
  assert.strictEqual(res, cached);
});

test('non-GET requests are left alone', async () => {
  const { listeners } = loadSw();
  const res = await fire(listeners, makeReq('https://x/anything', { method: 'POST' }));
  assert.strictEqual(res, PASSTHROUGH);
});

test('a successful asset fetch is cached for offline use', async () => {
  const fresh = { kind: 'fresh', clone: () => ({ kind: 'fresh-copy' }) };
  const { listeners, cache } = loadSw({ fetchImpl: () => Promise.resolve(fresh) });
  const res = await fire(listeners, makeReq('https://x/assets/index-abc.js'));
  assert.strictEqual(res, fresh);
  assert.deepStrictEqual(cache.store['https://x/assets/index-abc.js'], { kind: 'fresh-copy' });
});

test('CoreScope account and config endpoints bypass the worker on any origin', async () => {
  const { listeners } = loadSw();
  for (const u of [
    'https://cs.example/api/config/client',
    'https://cs.example/api/account/companions',
    'https://x/api/auth/me',
  ]) {
    assert.strictEqual(await fire(listeners, makeReq(u, { mode: 'cors' })), PASSTHROUGH, u);
  }
  // Names still go through the worker (offline fallback unchanged).
  assert.notStrictEqual(await fire(listeners, makeReq('https://cs.example/api/nodes/resolve?prefix=ab', { mode: 'cors' })), PASSTHROUGH);
});
