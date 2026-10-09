// CoreScope account: discovery (the gate), the device token bound to its origin, the
// hold flag, login/logout, and the auto-link flow. fetch, storage and timers are fakes.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import {
  createAccount, TOKEN_KEY, REQUIRE_KEY, linkMessage, deviceNameFrom,
  loadSession, loadRequireLinked,
} from '../src/account.js';

const ORIGIN = 'https://corescope.example';
const PK = 'ab'.repeat(32);

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

// res builds the slice of a fetch Response that account.js reads.
function res(status, json, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => { if (json === undefined) throw new SyntaxError('Unexpected end of JSON input'); return json; },
    headers: { get: (k) => (k in headers ? headers[k] : null) },
  };
}

// fakeServer routes 'METHOD /path' to a handler(req) returning res(...). A handler that
// throws makes fetch reject, which is what a network error or CORS block looks like.
function fakeServer(routes) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const req = { url, method, headers: opts.headers || {}, credentials: opts.credentials, body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(req);
    const h = routes[method + ' ' + new URL(url).pathname];
    if (!h) return res(404, { error: 'not found' });
    return h(req);
  };
  return { fetch, calls };
}

function make({ routes = {}, storage = memStorage(), ...rest } = {}) {
  const server = fakeServer(routes);
  const logs = [];
  let changes = 0;
  const account = createAccount({
    baseUrl: ORIGIN, fetch: server.fetch, storage,
    log: (m) => logs.push(m), onChange: () => { changes++; }, ...rest,
  });
  return { account, server, storage, logs, changes: () => changes };
}

const ENABLED = { 'GET /api/config/client': () => res(200, { userManagement: { enabled: true } }) };
const session = (extra = {}) => ({
  [TOKEN_KEY]: JSON.stringify({ origin: ORIGIN, token: 'tok-secret', displayName: 'Erwin', companions: [], ...extra }),
});

// --- pure helpers ------------------------------------------------------------

test('linkMessage is the UTF-8 of "corescope-link:" + host + ":" + challenge', () => {
  const b = linkMessage('corescope.example', 'abc123');
  assert.ok(b instanceof Uint8Array);
  assert.strictEqual(new TextDecoder().decode(b), 'corescope-link:corescope.example:abc123');
});

test('deviceNameFrom names the platform and browser', () => {
  assert.strictEqual(deviceNameFrom('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'), 'Android · Chrome');
  assert.strictEqual(deviceNameFrom('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), 'iOS · Safari');
  assert.strictEqual(deviceNameFrom('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0'), 'Windows · Edge');
  assert.strictEqual(deviceNameFrom(''), 'Unknown · Browser');
});

// --- session storage: bound to one origin ------------------------------------

test('a stored session for this origin is loaded', () => {
  const s = loadSession(memStorage(session({ companions: [{ pubkey: PK.toUpperCase(), name: 'obs' }] })), ORIGIN);
  assert.strictEqual(s.token, 'tok-secret');
  assert.strictEqual(s.displayName, 'Erwin');
  assert.deepStrictEqual(s.companions, [{ pubkey: PK, name: 'obs' }]);
});

test('a session stored for another origin is ignored AND dropped', () => {
  const storage = memStorage({ [TOKEN_KEY]: JSON.stringify({ origin: 'https://old.example', token: 't' }) });
  assert.strictEqual(loadSession(storage, ORIGIN), null);
  assert.strictEqual(storage.getItem(TOKEN_KEY), null);
});

test('a corrupt stored session reads as logged out', () => {
  assert.strictEqual(loadSession(memStorage({ [TOKEN_KEY]: '{not json' }), ORIGIN), null);
});

test('an account built over another origin\'s token starts logged out', () => {
  const t = make({ storage: memStorage({ [TOKEN_KEY]: JSON.stringify({ origin: 'https://old.example', token: 't' }) }) });
  assert.strictEqual(t.account.loggedIn, false);
});

// --- discovery: only userManagement.enabled === true turns the feature on -----

test('discovery: userManagement.enabled true turns the feature on', async () => {
  const t = make({ routes: ENABLED });
  const r = await t.account.discover();
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(t.account.enabled, true);
  assert.strictEqual(t.account.discovered, true);
  assert.strictEqual(t.server.calls[0].url, ORIGIN + '/api/config/client');
  assert.strictEqual(t.logs.length, 1, 'exactly one log line');
});

test('discovery: a missing userManagement block means off', async () => {
  const t = make({ routes: { 'GET /api/config/client': () => res(200, { clientRxCoverage: true }) } });
  assert.strictEqual((await t.account.discover()).enabled, false);
  assert.match(t.logs[0], /no userManagement/);
});

test('discovery: enabled false means off', async () => {
  const t = make({ routes: { 'GET /api/config/client': () => res(200, { userManagement: { enabled: false } }) } });
  assert.strictEqual((await t.account.discover()).enabled, false);
});

test('discovery: a non-200 answer means off', async () => {
  const t = make({ routes: { 'GET /api/config/client': () => res(500, { error: 'boom' }) } });
  assert.strictEqual((await t.account.discover()).enabled, false);
  assert.match(t.logs[0], /HTTP 500/);
});

test('discovery: a network error or CORS block means off, and the log names corsAllowedOrigins', async () => {
  const t = make({ routes: { 'GET /api/config/client': () => { throw new TypeError('Failed to fetch'); } } });
  assert.strictEqual((await t.account.discover()).enabled, false);
  assert.strictEqual(t.account.discovered, false);
  assert.strictEqual(t.logs.length, 1);
  assert.match(t.logs[0], /Failed to fetch/);
  assert.match(t.logs[0], /corsAllowedOrigins/);
});

test('discovery: a timeout means off', async () => {
  const t = make({
    routes: { 'GET /api/config/client': () => new Promise(() => {}) },
    setTimeout: (fn) => { queueMicrotask(fn); return 0; },
    clearTimeout: () => {},
  });
  const r = await t.account.discover();
  assert.strictEqual(r.enabled, false);
  assert.match(r.reason, /timed out/);
});

// --- the hold flag: clientRxRequireLinkedCompanion ---------------------------

test('discovery reads clientRxRequireLinkedCompanion and remembers it for this origin', async () => {
  const t = make({ routes: { 'GET /api/config/client': () => res(200, { userManagement: { enabled: true }, clientRxRequireLinkedCompanion: true }) } });
  await t.account.discover();
  assert.strictEqual(t.account.requireLinked, true);
  assert.strictEqual(loadRequireLinked(t.storage, ORIGIN), true);
});

test('a failed discovery keeps the last known flag', async () => {
  const storage = memStorage({ [REQUIRE_KEY]: JSON.stringify({ origin: ORIGIN, value: true }) });
  const t = make({ storage, routes: { 'GET /api/config/client': () => { throw new TypeError('Failed to fetch'); } } });
  assert.strictEqual(t.account.requireLinked, true, 'known before discovery even runs');
  await t.account.discover();
  assert.strictEqual(t.account.requireLinked, true);
});

test('a deployment that never answered counts as "not required"', async () => {
  const t = make({ routes: { 'GET /api/config/client': () => { throw new TypeError('Failed to fetch'); } } });
  await t.account.discover();
  assert.strictEqual(t.account.requireLinked, false);
});

test('a flag remembered for another origin does not apply', () => {
  const storage = memStorage({ [REQUIRE_KEY]: JSON.stringify({ origin: 'https://old.example', value: true }) });
  assert.strictEqual(make({ storage }).account.requireLinked, false);
});

test('an answer without the field clears a remembered flag', async () => {
  const storage = memStorage({ [REQUIRE_KEY]: JSON.stringify({ origin: ORIGIN, value: true }) });
  const t = make({ storage, routes: ENABLED });
  await t.account.discover();
  assert.strictEqual(t.account.requireLinked, false);
  assert.strictEqual(loadRequireLinked(storage, ORIGIN), false);
});

test('shouldHold only when the flag is on and the companion is not in the linked cache', async () => {
  const flagOn = { 'GET /api/config/client': () => res(200, { userManagement: { enabled: true }, clientRxRequireLinkedCompanion: true }) };
  const linked = make({ routes: flagOn, storage: memStorage(session({ companions: [{ pubkey: PK, name: 'obs' }] })) });
  await linked.account.discover();
  assert.strictEqual(linked.account.shouldHold(PK), false);
  assert.strictEqual(linked.account.shouldHold(PK.toUpperCase()), false, 'pubkeys compare case-insensitively');
  assert.strictEqual(linked.account.shouldHold('cd'.repeat(32)), true);

  const loggedOut = make({ routes: flagOn });
  await loggedOut.account.discover();
  assert.strictEqual(loggedOut.account.shouldHold(PK), true);

  const flagOff = make({ routes: ENABLED });
  await flagOff.account.discover();
  assert.strictEqual(flagOff.account.shouldHold(PK), false, 'flag off never holds, logged in or not');
});

// --- login, logout, 401 ------------------------------------------------------

test('login posts email, password and deviceName without a bearer, then keeps only the token', async () => {
  const t = make({ routes: {
    ...ENABLED,
    'POST /api/auth/device-token': () => res(200, { token: 'tok-new', expiresAt: '2027-01-06T12:00:00Z', user: { id: 3, displayName: 'Erwin' } }),
    'GET /api/account/companions': () => res(200, [{ pubkey: PK.toUpperCase(), name: 'obs', linkedAt: 1, lastSeenAt: 2 }]),
  } });
  await t.account.discover();
  const r = await t.account.login(' e@x.be ', 'pw-123', 'Android · Chrome');
  assert.deepStrictEqual(r, { ok: true, message: '' });
  const post = t.server.calls.find((c) => c.method === 'POST');
  assert.strictEqual(post.url, ORIGIN + '/api/auth/device-token');
  assert.deepStrictEqual(post.body, { email: 'e@x.be', password: 'pw-123', deviceName: 'Android · Chrome' });
  assert.strictEqual(post.headers.Authorization, undefined);
  assert.strictEqual(t.account.loggedIn, true);
  assert.strictEqual(t.account.displayName, 'Erwin');
  const stored = t.storage.getItem(TOKEN_KEY);
  assert.ok(!stored.includes('pw-123'), 'the password is never stored');
  assert.strictEqual(JSON.parse(stored).origin, ORIGIN);
  assert.deepStrictEqual(t.account.companions, [{ pubkey: PK, name: 'obs' }]);
  const get = t.server.calls.find((c) => c.method === 'GET' && c.url === ORIGIN + '/api/account/companions');
  assert.strictEqual(get.headers.Authorization, 'Bearer tok-new');
});

test('a wrong password shows the server\'s own 401 message and stays logged out', async () => {
  const t = make({ routes: { ...ENABLED, 'POST /api/auth/device-token': () => res(401, { error: 'invalid email or password' }) } });
  await t.account.discover();
  const r = await t.account.login('e@x.be', 'nope', 'x');
  assert.deepStrictEqual(r, { ok: false, message: 'invalid email or password' });
  assert.strictEqual(t.account.loggedIn, false);
  assert.strictEqual(t.storage.getItem(TOKEN_KEY), null);
});

test('a rate-limited login says how long to wait', async () => {
  const t = make({ routes: { ...ENABLED, 'POST /api/auth/device-token': () => res(429, { error: 'too many attempts, try again later' }, { 'Retry-After': '12' }) } });
  await t.account.discover();
  assert.deepStrictEqual(await t.account.login('e@x.be', 'pw', 'x'), { ok: false, message: 'Try again in 12 s.' });
});

test('a rate-limited login whose Retry-After CORS hides still says to wait', async () => {
  const t = make({ routes: { ...ENABLED, 'POST /api/auth/device-token': () => res(429, { error: 'too many attempts, try again later' }) } });
  await t.account.discover();
  const r = await t.account.login('e@x.be', 'pw', 'x');
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /Try again later/);
});

test('an unreachable CoreScope fails the login without throwing', async () => {
  const t = make({ routes: { ...ENABLED, 'POST /api/auth/device-token': () => { throw new TypeError('Failed to fetch'); } } });
  await t.account.discover();
  const r = await t.account.login('e@x.be', 'pw', 'x');
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /unreachable/);
});

test('logout revokes on the server without waiting, and forgets the token at once', () => {
  const calls = [];
  const storage = memStorage(session());
  const account = createAccount({
    baseUrl: ORIGIN, storage,
    fetch: (url, opts) => { calls.push({ url, opts }); return new Promise(() => {}); },
    setTimeout: () => 0, clearTimeout: () => {},
  });
  account.logout();
  assert.strictEqual(account.loggedIn, false);
  assert.strictEqual(storage.getItem(TOKEN_KEY), null);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, ORIGIN + '/api/auth/logout');
  assert.strictEqual(calls[0].opts.method, 'POST');
  assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer tok-secret');
});

test('a 401 on any account call clears the token and shows logged out', async () => {
  const t = make({ storage: memStorage(session()), routes: { ...ENABLED, 'GET /api/account/companions': () => res(401, { error: 'session expired' }) } });
  await t.account.discover();
  const before = t.changes();
  assert.deepStrictEqual(await t.account.refreshCompanions(), []);
  assert.strictEqual(t.account.loggedIn, false);
  assert.strictEqual(t.storage.getItem(TOKEN_KEY), null);
  assert.ok(t.changes() > before, 'the card is told to re-render');
  assert.ok(t.logs.some((l) => /logged out/.test(l)));
});

test('the token never reaches the log', async () => {
  const t = make({ routes: {
    ...ENABLED,
    'POST /api/auth/device-token': () => res(200, { token: 'tok-very-secret', user: { displayName: 'Erwin' } }),
    'GET /api/account/companions': () => res(200, []),
  } });
  await t.account.discover();
  await t.account.login('e@x.be', 'pw', 'x');
  await t.account.refreshCompanions();
  t.account.logout();
  assert.ok(t.logs.length > 0);
  assert.ok(t.logs.every((l) => !l.includes('tok-very-secret')));
});

// CoreScope judges a request with its session cookie on the cookie alone (the bearer
// header then does not count), so RX never sends cookies: on the same origin as a
// logged-in CoreScope tab the browser would otherwise attach cs_session.
test('every CoreScope request goes without cookies', async () => {
  const t = make({ routes: {
    ...ENABLED,
    'POST /api/auth/device-token': () => res(200, { token: 'tok-new', user: { displayName: 'Erwin' } }),
    'GET /api/account/companions': () => res(200, []),
  } });
  await t.account.discover();
  await t.account.login('e@x.be', 'pw', 'x');
  await t.account.refreshCompanions();
  t.account.logout();
  assert.ok(t.server.calls.length >= 4);
  for (const c of t.server.calls) assert.strictEqual(c.credentials, 'omit', c.method + ' ' + c.url);
});
