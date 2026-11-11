import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDeploymentUrl, deploymentConfigUrl, readDeployment, saveDeployment,
  fetchDeploymentConfigText, deploymentChoice, DEPLOY_KEY, DEPLOY_CACHE_KEY,
} from '../src/deployment.js';
import { loadConfig, setConfig, setConfigSource } from '../src/config.js';

function memStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

const VALID = JSON.stringify({ mqttUrl: 'wss://b.example/ws', resolveUrl: 'https://cs.example/api/nodes/resolve' });

test('a deployment URL is normalized to the folder that holds config.json', () => {
  assert.equal(normalizeDeploymentUrl('https://rx.on8ar.eu'), 'https://rx.on8ar.eu/');
  assert.equal(normalizeDeploymentUrl('rx.on8ar.eu'), 'https://rx.on8ar.eu/', 'no scheme means https');
  assert.equal(normalizeDeploymentUrl('  https://rx.on8ar.eu/staging  '), 'https://rx.on8ar.eu/staging/');
  assert.equal(normalizeDeploymentUrl('https://rx.on8ar.eu/staging/index.html?x=1#y'), 'https://rx.on8ar.eu/staging/');
  assert.equal(normalizeDeploymentUrl('https://rx.on8ar.eu/config.json'), 'https://rx.on8ar.eu/');
  assert.equal(normalizeDeploymentUrl('HTTPS://RX.on8ar.EU/'), 'https://rx.on8ar.eu/');
});

test('anything that is not an https URL is refused', () => {
  // config.json carries the broker login, so it never travels over plain http.
  for (const bad of ['', '   ', 'http://rx.on8ar.eu', 'ftp://x.example', 'https://', 'not a url at all', null, undefined]) {
    assert.equal(normalizeDeploymentUrl(bad), '', String(bad));
  }
});

test('deploymentConfigUrl points at config.json inside the deployment', () => {
  assert.equal(deploymentConfigUrl('https://rx.on8ar.eu/staging/'), 'https://rx.on8ar.eu/staging/config.json');
});

test('saving a different deployment drops the config cached for the old one', () => {
  const s = memStorage();
  saveDeployment(s, 'https://a.example/');
  s.setItem(DEPLOY_CACHE_KEY, JSON.stringify({ base: 'https://a.example/', text: VALID }));
  saveDeployment(s, 'https://a.example/');
  assert.ok(s.getItem(DEPLOY_CACHE_KEY), 'same deployment keeps its cache');
  saveDeployment(s, 'https://b.example/');
  assert.equal(readDeployment(s), 'https://b.example/');
  assert.equal(s.getItem(DEPLOY_CACHE_KEY), null);
});

test('readDeployment ignores a stored value that is not a usable URL', () => {
  const s = memStorage();
  s.setItem(DEPLOY_KEY, 'http://plain.example/');
  assert.equal(readDeployment(s), '');
});

test('a fetched config is validated, cached and returned', async () => {
  const s = memStorage();
  const urls = [];
  const r = await fetchDeploymentConfigText({
    base: 'https://rx.example/', storage: s,
    httpGet: async (u) => { urls.push(u); return { status: 200, data: VALID }; },
  });
  assert.deepEqual(urls, ['https://rx.example/config.json']);
  assert.equal(r.cached, false);
  assert.equal(r.text, VALID);
  assert.equal(JSON.parse(s.getItem(DEPLOY_CACHE_KEY)).text, VALID);
});

test('a JSON body the native HTTP layer already parsed is accepted', async () => {
  // Android's CapacitorHttp hands back an object when the server says application/json.
  const r = await fetchDeploymentConfigText({
    base: 'https://rx.example/', storage: memStorage(),
    httpGet: async () => ({ status: 200, data: JSON.parse(VALID) }),
  });
  assert.equal(JSON.parse(r.text).mqttUrl, 'wss://b.example/ws');
});

test('offline at startup: the last good config of the SAME deployment is used', async () => {
  const s = memStorage();
  await fetchDeploymentConfigText({ base: 'https://rx.example/', storage: s, httpGet: async () => ({ status: 200, data: VALID }) });
  const r = await fetchDeploymentConfigText({
    base: 'https://rx.example/', storage: s,
    httpGet: async () => { throw new Error('offline'); },
  });
  assert.equal(r.cached, true);
  assert.equal(r.text, VALID);
  assert.match(r.error.message, /offline/);
});

test('no cache, or a cache of another deployment, makes a failed fetch throw', async () => {
  const s = memStorage();
  s.setItem(DEPLOY_CACHE_KEY, JSON.stringify({ base: 'https://other.example/', text: VALID }));
  await assert.rejects(fetchDeploymentConfigText({
    base: 'https://rx.example/', storage: s, httpGet: async () => ({ status: 404, data: '' }),
  }), /HTTP 404/);
});

test('an invalid config is never cached and falls back to the last good one', async () => {
  const s = memStorage();
  await fetchDeploymentConfigText({ base: 'https://rx.example/', storage: s, httpGet: async () => ({ status: 200, data: VALID }) });
  const r = await fetchDeploymentConfigText({
    base: 'https://rx.example/', storage: s,
    httpGet: async () => ({ status: 200, data: '<!doctype html><html></html>' }),
  });
  assert.equal(r.cached, true);
  assert.match(r.error.message, /HTML page instead of JSON/);
  assert.equal(JSON.parse(s.getItem(DEPLOY_CACHE_KEY)).text, VALID);
});

test('loadConfig reads from a config source when one is set', async () => {
  setConfig(null);
  let n = 0;
  setConfigSource(async () => { n++; return VALID; });
  try {
    const c = await loadConfig();
    assert.equal(c.mqttUrl, 'wss://b.example/ws');
    assert.equal(c.corescopeUrl, 'https://cs.example');
    assert.equal(n, 1);
  } finally {
    setConfigSource(null);
    setConfig(null);
  }
});

// Scanning the QR code of the deployment already in use restarted the app, which dropped
// the companion link and cleared the debug log (seen on a phone, 2026-11-11).
test('choosing the deployment already in use changes nothing', () => {
  assert.equal(deploymentChoice('https://rx.on8ar.eu/', 'https://rx.on8ar.eu/', true), 'same');
  assert.equal(deploymentChoice('https://rx.on8ar.eu/', 'https://rx.example.org/', true), 'confirm');
  assert.equal(deploymentChoice('https://rx.on8ar.eu/', 'https://rx.example.org/', false), 'switch');
  assert.equal(deploymentChoice('', 'https://rx.on8ar.eu/', false), 'switch'); // first choice
});
