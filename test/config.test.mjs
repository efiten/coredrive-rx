// Unit tests for the runtime config loader's pure validation/normalization.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeConfig, featureEnabled } from '../src/config.js';
import {
  DEFAULT_ASK_GAP_MS, DEFAULT_TARGET_GAP_MS, DEFAULT_MAX_ASKS, DEFAULT_FORGET_MS,
  DEFAULT_BONUS_SNR_DB,
} from '../src/regionsched.js';

test('normalizeConfig requires mqttUrl', () => {
  assert.throws(() => normalizeConfig({ mqttUsername: 'x' }), /mqttUrl/);
});

test('normalizeConfig trims fields and defaults resolveUrl to empty', () => {
  const c = normalizeConfig({ mqttUrl: '  wss://b:8084/ws  ', mqttUsername: ' u ' });
  assert.strictEqual(c.mqttUrl, 'wss://b:8084/ws');
  assert.strictEqual(c.mqttUsername, 'u');
  assert.strictEqual(c.resolveUrl, '');
});

test('normalizeConfig keeps resolveUrl when provided', () => {
  const c = normalizeConfig({ mqttUrl: 'wss://b/ws', resolveUrl: 'https://x/api/nodes/resolve' });
  assert.strictEqual(c.resolveUrl, 'https://x/api/nodes/resolve');
});

test('normalizeConfig rejects a non-object', () => {
  assert.throws(() => normalizeConfig(null), /JSON object/);
});

test('normalizeConfig does not trim mqttPassword', () => {
  const c = normalizeConfig({ mqttUrl: 'wss://b/ws', mqttPassword: '  s3cr3t  ' });
  assert.strictEqual(c.mqttPassword, '  s3cr3t  ');
});

test('normalizeConfig defaults mqttPassword to empty string when absent', () => {
  const c = normalizeConfig({ mqttUrl: 'wss://b/ws' });
  assert.strictEqual(c.mqttPassword, '');
});

// The two LOGGING features default ON when the key is absent. A config written
// before they existed used to turn them off silently, which is indistinguishable
// from the feature being broken — and data not collected during that window is
// gone for good, whereas data collected and discarded server-side costs only
// bandwidth. An explicit `false` still wins; only silence is read as "collect".
test('fullRfLog defaults to ON when absent, and an explicit false still wins', () => {
  const base = { mqttUrl: 'wss://b.example/ws' };
  assert.equal(normalizeConfig(base).fullRfLog, true);
  assert.equal(normalizeConfig({ ...base, fullRfLog: true }).fullRfLog, true);
  assert.equal(normalizeConfig({ ...base, fullRfLog: false }).fullRfLog, false);
  // Anything non-boolean that IS present is coerced, never left undefined.
  assert.equal(normalizeConfig({ ...base, fullRfLog: 'yes' }).fullRfLog, true);
  assert.equal(normalizeConfig({ ...base, fullRfLog: 0 }).fullRfLog, false);
  assert.equal(normalizeConfig({ ...base, fullRfLog: null }).fullRfLog, false);
});

test('rfSampler defaults to ON when absent, and an explicit false still wins', () => {
  const base = { mqttUrl: 'wss://b.example/ws' };
  assert.equal(normalizeConfig(base).rfSampler, true);
  assert.equal(normalizeConfig({ ...base, rfSampler: false }).rfSampler, false);
  assert.equal(normalizeConfig({ ...base, rfSampler: true }).rfSampler, true);
});

// --- featureEnabled: the case every gate in app.js used to get wrong ----------

test('featureEnabled treats a MISSING config as "collect anyway" for the logging features', () => {
  // `!cfg || !cfg.X` read "we do not know yet" as "off", so a config that failed to
  // load stopped data COLLECTION as well as uploading — and the collection window
  // is unrecoverable. Records queued now are published once config arrives.
  assert.equal(featureEnabled(null, 'fullRfLog'), true);
  assert.equal(featureEnabled(null, 'rfSampler'), true);
});

test('featureEnabled never transmits on a guess: no config means regionDiscovery off', () => {
  // With no config the app cannot know whose mesh it is on, and repeaters rate-limit
  // anonymous requests to 4 per 180s shared across every requester — one client
  // asking once a minute already claims most of that. Collecting costs bandwidth;
  // transmitting costs a stranger's airtime, so only the former is assumed.
  assert.equal(featureEnabled(null, 'regionDiscovery'), false);
  // ...but an existing config that merely omits the key does enable it.
  assert.equal(featureEnabled({ mqttUrl: 'wss://b/ws' }, 'regionDiscovery'), true);
});

test('featureEnabled honours a loaded config over the default, in both directions', () => {
  assert.equal(featureEnabled({ fullRfLog: false }, 'fullRfLog'), false);
  assert.equal(featureEnabled({ regionDiscovery: true }, 'regionDiscovery'), true);
});

// regionDiscovery is the one flag whose default differs by SOURCE, because it is
// the only feature that transmits. An existing config.json is a deployment whose
// operator owns the repeaters being asked, so an absent key there means on. No
// config at all means the app knows nothing about where it is, and guessing "on"
// would spend a stranger's rate-limited anon budget — see the no-config test below.
test('regionDiscovery defaults to ON when an existing config omits the key', () => {
  const base = { mqttUrl: 'wss://b.example/ws' };
  assert.equal(normalizeConfig(base).regionDiscovery, true);
  assert.equal(normalizeConfig({ ...base, regionDiscovery: false }).regionDiscovery, false);
  assert.equal(normalizeConfig({ ...base, regionDiscovery: true }).regionDiscovery, true);
});

// --- loadConfig: retry + dedupe + a readable error for an HTML body -----------
// Field failure this covers: the config fetch failed once at startup and the app
// ran the whole session without config (nothing published, three features off).
// loadConfig must therefore be safe to call repeatedly from several places.
import { loadConfig, setConfig } from '../src/config.js';

const VALID = { mqttUrl: 'wss://b.example/ws', regionDiscovery: true };

// stubFetch installs a fake global fetch and returns a call counter.
function stubFetch(handler) {
  const calls = { n: 0 };
  globalThis.fetch = async (url, opts) => { calls.n++; return handler(url, opts, calls.n); };
  return calls;
}

const jsonRes = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
const htmlRes = () => ({ ok: true, status: 200, text: async () => '<!doctype html>\n<html><body>app shell</body></html>' });

test('loadConfig retries after a failed load instead of caching the failure', async () => {
  setConfig(null);
  const calls = stubFetch(async (_u, _o, n) => {
    if (n === 1) throw new TypeError('Failed to fetch');
    return jsonRes(VALID);
  });
  await assert.rejects(() => loadConfig('config.json'), /Failed to fetch/);
  const c = await loadConfig('config.json'); // the retry the app now performs
  assert.strictEqual(c.mqttUrl, 'wss://b.example/ws');
  assert.strictEqual(calls.n, 2, 'the second call must actually re-fetch');
  setConfig(null);
});

test('loadConfig dedupes concurrent callers into one fetch', async () => {
  setConfig(null);
  const calls = stubFetch(async () => jsonRes(VALID));
  const [a, b, c] = await Promise.all([loadConfig('config.json'), loadConfig('config.json'), loadConfig('config.json')]);
  assert.strictEqual(calls.n, 1, 'startup + connect + online must not each issue their own fetch');
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
  setConfig(null);
});

test('loadConfig caches a successful load', async () => {
  setConfig(null);
  const calls = stubFetch(async () => jsonRes(VALID));
  await loadConfig('config.json');
  await loadConfig('config.json');
  assert.strictEqual(calls.n, 1);
  setConfig(null);
});

test('loadConfig names an HTML body for what it is instead of leaking a JSON parse error', async () => {
  // The service worker used to answer a failed config fetch with index.html, and
  // a web server with an SPA fallback does the same. Both produced
  // "invalid JSON — Unexpected token '<'", which reads like a corrupt config file.
  setConfig(null);
  stubFetch(async () => htmlRes());
  await assert.rejects(() => loadConfig('config.json'), /HTML page instead of JSON/);
  setConfig(null);
});

test('loadConfig still reports a non-OK status clearly', async () => {
  setConfig(null);
  stubFetch(async () => ({ ok: false, status: 404, text: async () => '' }));
  await assert.rejects(() => loadConfig('config.json'), /HTTP 404/);
  setConfig(null);
});

test('a failed load leaves getConfig() null — callers must be able to detect "no config"', async () => {
  setConfig(null);
  stubFetch(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(() => loadConfig('config.json'));
  const { getConfig } = await import('../src/config.js');
  assert.strictEqual(getConfig(), null);
  setConfig(null);
});

// verifyAdverts is the one flag whose absence means OFF. It changes what reaches
// CoreScope (a forged advert stops being recorded under its claimed identity), and a
// deployment should turn that on deliberately rather than discover it.
test('verifyAdverts stays off unless config.json turns it on', () => {
  assert.strictEqual(featureEnabled(null, 'verifyAdverts'), false);
  assert.strictEqual(featureEnabled({}, 'verifyAdverts'), false);
  assert.strictEqual(featureEnabled({ verifyAdverts: true }, 'verifyAdverts'), true);
});

// --- Region pacing defaults ---------------------------------------------------
// These were written out twice — once in src/regionsched.js and once here — and drifted
// apart: the scheduler said four asks per encounter, config.js said three, and since the
// app reads the config the shipped cap was three. A field log's "attempt 3 of 3" was the
// only thing that showed it. One source, and a test that says so.

test('the region pacing defaults are the scheduler\'s own, not a second copy', () => {
  const c = normalizeConfig({ mqttUrl: 'wss://x/ws' });
  assert.equal(c.regionAskGapSec, DEFAULT_ASK_GAP_MS / 1000);
  assert.equal(c.regionTargetGapSec, DEFAULT_TARGET_GAP_MS / 1000);
  assert.equal(c.regionMaxAsks, DEFAULT_MAX_ASKS);
  assert.equal(c.regionForgetMin, DEFAULT_FORGET_MS / 60000);
  assert.equal(c.regionBonusSnrDb, DEFAULT_BONUS_SNR_DB);
});

test('an explicit region pacing value still wins over the default', () => {
  const c = normalizeConfig({ mqttUrl: 'wss://x/ws', regionMaxAsks: 2, regionTargetGapSec: 15 });
  assert.equal(c.regionMaxAsks, 2);
  assert.equal(c.regionTargetGapSec, 15);
});

test('an unusable region pacing value falls back to the default, never to no limit', () => {
  const c = normalizeConfig({ mqttUrl: 'wss://x/ws', regionMaxAsks: 'lots', regionTargetGapSec: -5 });
  assert.equal(c.regionMaxAsks, DEFAULT_MAX_ASKS);
  assert.equal(c.regionTargetGapSec, DEFAULT_TARGET_GAP_MS / 1000);
});
