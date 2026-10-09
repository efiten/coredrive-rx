// CoreScope account: discovery (the gate), the device token bound to its origin, the
// hold flag, login/logout, and the auto-link flow. fetch, storage and timers are fakes.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import {
  createAccount, TOKEN_KEY, REQUIRE_KEY, linkMessage, deviceNameFrom,
  loadSession, loadRequireLinked, LINK_SETTLE_MS, signFailure, RETRY_DELAYS_MS,
} from '../src/account.js';
import { SignUnsupportedError } from '../src/companionsign.js';

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

const ENABLED = { 'GET /api/config/client': () => res(200, { userManagement: { enabled: true, companionLinking: true } }) };
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

test('discovery: user management without companion linking (an older CoreScope) means off', async () => {
  // Such a server answers POST /api/auth/device-token with its SPA page (HTTP 200,
  // HTML), so a login could only ever fail.
  const t = make({ routes: { 'GET /api/config/client': () => res(200, { userManagement: { enabled: true, channelProposals: true } }) } });
  assert.strictEqual((await t.account.discover()).enabled, false);
  assert.match(t.logs[0], /companion linking/);
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
  const t = make({ routes: { 'GET /api/config/client': () => res(200, { userManagement: { enabled: true, companionLinking: true }, clientRxRequireLinkedCompanion: true }) } });
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
  const flagOn = { 'GET /api/config/client': () => res(200, { userManagement: { enabled: true, companionLinking: true }, clientRxRequireLinkedCompanion: true }) };
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

// --- auto-link ---------------------------------------------------------------

const SIG64 = new Uint8Array(64).fill(7);

// signer records what it was asked to sign (as text) and answers via `impl`.
function signer(impl) {
  const s = async (bytes) => {
    s.calls.push(new TextDecoder().decode(bytes));
    return impl ? impl(bytes) : SIG64;
  };
  s.calls = [];
  return s;
}

// linkable: logged in, feature on, a server that hands out challenges c1, c2, ...
async function linkable({ companions = [], challenge, link, requireLinked = false } = {}) {
  let n = 0;
  const routes = {
    'GET /api/config/client': () => res(200, { userManagement: { enabled: true, companionLinking: true }, ...(requireLinked ? { clientRxRequireLinkedCompanion: true } : {}) }),
    'GET /api/account/companions': () => res(200, companions),
    'POST /api/account/companions/challenge': challenge || (() => { n++; return res(200, { challenge: 'c' + n, expiresAt: 0 }); }),
    'POST /api/account/companions': link || ((req) => res(200, { pubkey: req.body.pubkey, name: req.body.name, linkedAt: 1, myNodes: 'added' })),
  };
  const t = make({ routes, storage: memStorage(session()) });
  await t.account.discover();
  return t;
}
const count = (server, key) => server.calls.filter((c) => c.method + ' ' + new URL(c.url).pathname === key).length;

test('a companion already in the cache is linked without a single request', async () => {
  const t = make({ routes: ENABLED, storage: memStorage(session({ companions: [{ pubkey: PK, name: 'obs' }] })) });
  await t.account.discover();
  const before = t.server.calls.length;
  const s = signer();
  assert.strictEqual(await t.account.link({ pubkey: PK.toUpperCase(), name: 'obs', sign: s }), 'linked');
  assert.strictEqual(t.server.calls.length, before);
  assert.strictEqual(s.calls.length, 0);
});

test('a companion that is on the server list after a refresh is not signed again', async () => {
  const t = await linkable({ companions: [{ pubkey: PK, name: 'obs', linkedAt: 1, lastSeenAt: 2 }] });
  const s = signer();
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: s }), 'linked');
  assert.strictEqual(count(t.server, 'POST /api/account/companions/challenge'), 0);
  assert.strictEqual(s.calls.length, 0);
});

test('the full flow: challenge, sign the host-bound message, post, cache — and the hold lifts', async () => {
  const t = await linkable({ requireLinked: true });
  assert.strictEqual(t.account.shouldHold(PK), true);
  const s = signer();
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: s }), 'linked');
  assert.deepStrictEqual(s.calls, ['corescope-link:corescope.example:c1']);
  const ch = t.server.calls.find((c) => c.url === ORIGIN + '/api/account/companions/challenge');
  assert.deepStrictEqual(ch.body, { pubkey: PK });
  const post = t.server.calls.find((c) => c.method === 'POST' && c.url === ORIGIN + '/api/account/companions');
  assert.deepStrictEqual(post.body, { pubkey: PK, challenge: 'c1', signature: '07'.repeat(64), name: 'obs' });
  assert.strictEqual(post.headers.Authorization, 'Bearer tok-secret');
  assert.strictEqual(t.account.isLinked(PK), true);
  assert.strictEqual(t.account.shouldHold(PK), true, 'a fresh link holds a little longer (see the settle test)');
  assert.strictEqual(t.account.linkState.status, 'linked');
  assert.ok(JSON.parse(t.storage.getItem(TOKEN_KEY)).companions.some((c) => c.pubkey === PK), 'the cache survives a restart');
});

test('signs the host the challenge names, not the host the app reached CoreScope under', async () => {
  const t = await linkable({ challenge: () => res(200, { challenge: 'c1', expiresAt: 0, host: 'scope.public.example' }) });
  const s = signer();
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: s }), 'linked');
  assert.deepStrictEqual(s.calls, ['corescope-link:scope.public.example:c1']);
});

test('410 (challenge expired or used) is retried once with a new challenge', async () => {
  let posts = 0;
  const t = await linkable({ link: (req) => (++posts === 1 ? res(410, { error: 'challenge expired' }) : res(200, { pubkey: req.body.pubkey, name: 'obs' })) });
  const s = signer();
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: s }), 'linked');
  assert.strictEqual(count(t.server, 'POST /api/account/companions/challenge'), 2);
  assert.deepStrictEqual(s.calls, ['corescope-link:corescope.example:c1', 'corescope-link:corescope.example:c2']);
});

test('a second 410 is Failed, after exactly two challenges', async () => {
  const t = await linkable({ link: () => res(410, { error: 'challenge expired' }) });
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: signer() }), 'failed');
  assert.strictEqual(count(t.server, 'POST /api/account/companions/challenge'), 2);
});

test('400 (bad signature) is Failed with a log line and is not retried until Retry', async () => {
  const t = await linkable({ link: () => res(400, { error: 'bad signature' }) });
  const s = signer();
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: s }), 'failed');
  assert.match(t.account.linkState.reason, /signature/);
  assert.ok(t.logs.some((l) => /linking .* failed/.test(l)));
  const before = t.server.calls.length;
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: s }), 'failed', 'not retried within this connection');
  assert.strictEqual(t.server.calls.length, before);
  await t.account.link({ pubkey: PK, name: 'obs', sign: s, force: true });
  assert.ok(t.server.calls.length > before, 'the Retry button tries again');
});

test('firmware that cannot sign is not asked again until the next connect', async () => {
  const t = await linkable();
  const s = signer(() => { throw new SignUnsupportedError('no CMD_SIGN_START'); });
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: s }), 'unsupported');
  const before = t.server.calls.length;
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: s }), 'unsupported');
  assert.strictEqual(t.server.calls.length, before);
  t.account.newConnection();
  assert.strictEqual(t.account.linkState.status, 'idle');
  await t.account.link({ pubkey: PK, name: 'obs', sign: s });
  assert.ok(t.server.calls.length > before, 'a new connection asks again');
});

test('a BLE drop while signing waits and retries on the next attempt', async () => {
  const t = await linkable();
  let drop = true;
  const s = signer(() => {
    if (drop) { drop = false; const e = new Error('the companion link dropped while signing'); e.transient = true; throw e; }
    return SIG64;
  });
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: s }), 'waiting');
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: s }), 'linked', 'not blocked: the next connect retries');
});

test('a network failure waits and retries on the next attempt', async () => {
  let first = true;
  const t = await linkable({ challenge: () => {
    if (first) { first = false; throw new TypeError('Failed to fetch'); }
    return res(200, { challenge: 'c9' });
  } });
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: signer() }), 'waiting');
  assert.strictEqual(t.account.linkState.status, 'waiting');
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: signer() }), 'linked');
});

test('only one link attempt runs at a time', async () => {
  const t = await linkable();
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = signer(async () => { await gate; return SIG64; });
  const a = t.account.link({ pubkey: PK, name: 'obs', sign: s });
  const b = t.account.link({ pubkey: PK, name: 'obs', sign: s });
  assert.strictEqual(a, b);
  release();
  assert.strictEqual(await a, 'linked');
  assert.strictEqual(s.calls.length, 1);
});

test('a 401 during linking logs out and stops', async () => {
  const t = await linkable({ challenge: () => res(401, { error: 'revoked' }) });
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: signer() }), 'logged-out');
  assert.strictEqual(t.account.loggedIn, false);
});

test('myNodes "full" or "failed" is a note on a successful link, not a failure', async () => {
  for (const myNodes of ['full', 'failed']) {
    const t = await linkable({ link: (req) => res(200, { pubkey: req.body.pubkey, name: 'obs', linkedAt: '2026-10-08T10:00:00Z', myNodes }) });
    assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: signer() }), 'linked', myNodes);
    assert.strictEqual(t.account.isLinked(PK), true);
    assert.strictEqual(t.account.linkState.status, 'linked');
    assert.match(t.account.linkState.reason, /not added to My nodes/);
    assert.ok(t.logs.some((l) => /My nodes/.test(l)));
  }
  const ok = await linkable();
  await ok.account.link({ pubkey: PK, name: 'obs', sign: signer() });
  assert.strictEqual(ok.account.linkState.reason, '', '"added" carries no note');
});

test('429 (rate limited) waits for the next attempt instead of failing', async () => {
  const t = await linkable({ challenge: () => res(429, { error: 'too many requests' }) });
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: signer() }), 'waiting');
  const u = await linkable({ link: () => res(429, { error: 'too many requests' }) });
  assert.strictEqual(await u.account.link({ pubkey: PK, name: 'obs', sign: signer() }), 'waiting');
});

test('nothing is attempted when logged out or when the feature is off', async () => {
  const out = make({ routes: ENABLED });
  await out.account.discover();
  assert.strictEqual(await out.account.link({ pubkey: PK, name: 'obs', sign: signer() }), 'skipped');

  const off = make({ storage: memStorage(session()), routes: { 'GET /api/config/client': () => res(200, {}) } });
  await off.account.discover();
  const before = off.server.calls.length;
  assert.strictEqual(await off.account.link({ pubkey: PK, name: 'obs', sign: signer() }), 'skipped');
  assert.strictEqual(off.server.calls.length, before);
});

// CoreScope's ingestor re-reads its linked-companion list on a miss at most once per
// 5 s and drops (after the broker acked it) whatever arrives in between. So a fresh
// link keeps the queue held for LINK_SETTLE_MS before the first upload goes out.
test('a fresh link holds the queue until the ingestor can have seen it, then lifts and re-renders', async () => {
  let clock = 1000;
  const timers = [];
  const t = make({
    storage: memStorage(session()),
    now: () => clock,
    setTimeout: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length; },
    clearTimeout: () => {},
    routes: {
      'GET /api/config/client': () => res(200, { userManagement: { enabled: true, companionLinking: true }, clientRxRequireLinkedCompanion: true }),
      'GET /api/account/companions': () => res(200, []),
      'POST /api/account/companions/challenge': () => res(200, { challenge: 'c1' }),
      'POST /api/account/companions': (req) => res(200, { pubkey: req.body.pubkey, name: 'obs', myNodes: 'added' }),
    },
  });
  await t.account.discover();
  assert.ok(LINK_SETTLE_MS > 5000, 'longer than the 5 s miss gap of the ingestor');
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: signer() }), 'linked');
  assert.strictEqual(t.account.isLinked(PK), true);
  assert.strictEqual(t.account.shouldHold(PK), true, 'held right after the link');
  const settle = timers.find((x) => x.at === clock + LINK_SETTLE_MS);
  assert.ok(settle, 'a settle timer is armed');
  clock += LINK_SETTLE_MS;
  const before = t.changes();
  settle.fn();
  assert.strictEqual(t.account.shouldHold(PK), false, 'released once the gap has passed');
  assert.ok(t.changes() > before, 'the app is told, so it can drain');
});

test('a companion already on the server list is not held for the settle time', async () => {
  const t = make({
    storage: memStorage(session()),
    routes: {
      'GET /api/config/client': () => res(200, { userManagement: { enabled: true, companionLinking: true }, clientRxRequireLinkedCompanion: true }),
      'GET /api/account/companions': () => res(200, [{ pubkey: PK, name: 'obs' }]),
    },
  });
  await t.account.discover();
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: signer() }), 'linked');
  assert.strictEqual(t.account.shouldHold(PK), false);
});

// A link attempt belongs to one companion. One for the next companion waits for the
// running attempt and then runs its own; it never joins the other's promise.
test('a link for another companion waits for the running one, then runs its own', async () => {
  const t = await linkable();
  const OTHER = 'cd'.repeat(32);
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = [];
  const s = async (bytes, pk) => { seen.push(pk); if (pk === PK) await gate; return SIG64; };
  const a = t.account.link({ pubkey: PK, name: 'A', sign: s });
  const b = t.account.link({ pubkey: OTHER, name: 'B', sign: s });
  assert.notStrictEqual(a, b);
  release();
  assert.strictEqual(await a, 'linked');
  assert.strictEqual(await b, 'linked');
  assert.deepStrictEqual(seen, [PK, OTHER], 'each companion signs its own challenge, in turn');
});

test('sign is told which companion it signs for', async () => {
  const t = await linkable();
  const got = [];
  await t.account.link({ pubkey: PK.toUpperCase(), name: 'obs', sign: async (bytes, pk) => { got.push(pk); return SIG64; } });
  assert.deepStrictEqual(got, [PK]);
});

// A BLE drop mid-sign followed by a fast auto-reconnect: the step then times out with
// the link up again. That says nothing about the firmware or the companion.
test('a sign error after the BLE link changed, or with it down, is transient', () => {
  const unsupported = new SignUnsupportedError('no answer to CMD_SIGN_START');
  const refused = new Error('the companion refused sign data (error 3)');
  for (const e of [unsupported, refused]) {
    assert.strictEqual(signFailure(e, { linkUp: true, linkChanged: false }), e, 'a stable link keeps the verdict');
    for (const ctx of [{ linkUp: true, linkChanged: true }, { linkUp: false, linkChanged: false }]) {
      const out = signFailure(e, ctx);
      assert.strictEqual(out.transient, true, JSON.stringify(ctx));
      assert.notStrictEqual(out.name, 'SignUnsupportedError');
    }
  }
});

// Without a retry, a CoreScope that was briefly unreachable (a restart, a slow mobile
// request, a 429) left a held queue held for the whole session: only an 'online'
// event or a reconnect asked again, and navigator.onLine rarely changes.
function timerBox() {
  const timers = [];
  return {
    timers,
    setTimeout: (fn, ms) => { const h = { ms, cleared: false }; h.fn = () => { h.cleared = true; fn(); }; timers.push(h); return h; },
    clearTimeout: (h) => { if (h) h.cleared = true; },
    live: () => timers.filter((x) => !x.cleared && x.ms >= RETRY_DELAYS_MS[0]),
  };
}

test('a discovery without an answer is retried with a growing delay, and a success stops it', async () => {
  const box = timerBox();
  const retries = [];
  let up = false;
  const t = make({
    setTimeout: box.setTimeout, clearTimeout: box.clearTimeout, onRetry: (w) => retries.push(w),
    routes: { 'GET /api/config/client': () => { if (!up) throw new TypeError('Failed to fetch'); return res(200, { userManagement: { enabled: true, companionLinking: true } }); } },
  });
  // discover's own 5 s timeout timer is also in the box; only the retry timers count.
  await t.account.discover();
  assert.deepStrictEqual(box.live().map((x) => x.ms), [RETRY_DELAYS_MS[0]]);
  box.live()[0].fn();
  assert.deepStrictEqual(retries, ['discover']);
  await t.account.discover();
  assert.deepStrictEqual(box.live().map((x) => x.ms), [RETRY_DELAYS_MS[1]], 'one pending retry, the next delay');
  up = true;
  await t.account.discover();
  assert.deepStrictEqual(box.live(), [], 'an answer cancels the retry');
});

test('a link left waiting is retried later, and stops once linked', async () => {
  const box = timerBox();
  const retries = [];
  let fail = true;
  const t = make({
    storage: memStorage(session()),
    setTimeout: box.setTimeout, clearTimeout: box.clearTimeout, onRetry: (w) => retries.push(w),
    routes: {
      ...ENABLED,
      'GET /api/account/companions': () => res(200, []),
      'POST /api/account/companions/challenge': () => (fail ? res(429, { error: 'slow down' }) : res(200, { challenge: 'c1' })),
      'POST /api/account/companions': (req) => res(200, { pubkey: req.body.pubkey, name: 'obs', myNodes: 'added' }),
    },
  });
  await t.account.discover();
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: signer() }), 'waiting');
  const pending = box.live();
  assert.deepStrictEqual(pending.map((x) => x.ms), [RETRY_DELAYS_MS[0]]);
  pending[0].fn();
  assert.deepStrictEqual(retries, ['link']);
  fail = false;
  assert.strictEqual(await t.account.link({ pubkey: PK, name: 'obs', sign: signer() }), 'linked');
  assert.deepStrictEqual(box.live().filter((x) => x.ms !== LINK_SETTLE_MS), [], 'no retry left after the link');
});

test('the retry delay grows and then stays at its maximum', () => {
  assert.ok(RETRY_DELAYS_MS.length >= 3);
  for (let i = 1; i < RETRY_DELAYS_MS.length; i++) assert.ok(RETRY_DELAYS_MS[i] > RETRY_DELAYS_MS[i - 1]);
  assert.ok(RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] <= 10 * 60 * 1000);
});
