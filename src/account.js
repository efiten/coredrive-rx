// CoreScope account for CoreDrive RX: discovery (the gate), device-token login, the
// linked-companions cache, companion auto-linking and the "hold until linked" flag.
//
// No DOM here. src/app.js wires it and src/accountview.js turns its state into the
// Settings card. fetch, storage, timers and the log are injected so node --test can
// drive every path. The HTTP contract is CoreScope's
// docs/specs/2026-10-08-companion-linking-design.md (user management, sub-project F).
//
// Everything is keyed on ONE origin, config.corescopeUrl (src/config.js). A token or a
// remembered flag stored for any other origin is ignored, because corescopeUrl can
// change and a token means nothing to another server.
//
// The token never leaves this module except in the Authorization header: it is not
// logged, not returned by any getter and not rendered.

import { bytesToHex } from './meshpacket.js';

export const TOKEN_KEY = 'coredrive-rx.cs-token';
export const REQUIRE_KEY = 'coredrive-rx.cs-require-linked';
export const DISCOVER_TIMEOUT_MS = 5000;
export const REQUEST_TIMEOUT_MS = 10000;
// LINK_SETTLE_MS: how long a FRESH link keeps the queue held. With
// requireLinkedCompanion, CoreScope's ingestor re-reads its linked-companion list on
// a miss at most once per 5 s and drops what arrives in between, after the broker
// has acked it. Waiting out that gap (plus a margin) means the first upload after
// linking is not lost.
export const LINK_SETTLE_MS = 6000;
// RETRY_DELAYS_MS: when discovery got no answer, or a link attempt is left 'waiting'
// (network, 429, BLE drop), it is asked again after these delays, the last one
// repeating. Without it only an 'online' event or a reconnect asked again, and a held
// queue could stay held for the whole session.
export const RETRY_DELAYS_MS = [30000, 60000, 120000, 300000, 600000];

// NetworkError: no HTTP answer at all (offline, DNS, CORS block, timeout). Every HTTP
// answer, error codes included, is NOT a NetworkError.
export class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetworkError';
  }
}

// transientError marks a failure that says nothing about the companion or the account,
// such as the BLE link dropping mid-sign. The link flow parks it as 'waiting' and tries
// again on the next connect or `online` event instead of reporting "Linking failed".
export function transientError(message) {
  const e = new Error(message);
  e.transient = true;
  return e;
}

// signFailure classifies an error from the companion's sign exchange. When the BLE link
// is down, or dropped and came back while signing (the transport reconnects in about
// 1.5 s, a sign step times out after 4 s), the error says nothing about the firmware
// or the companion: it becomes transient, so the link is retried instead of being
// reported as "firmware cannot sign" or "failed" for the rest of the connection.
export function signFailure(err, { linkUp, linkChanged }) {
  if (!linkUp || linkChanged) return transientError('the companion link dropped while signing (' + errText(err) + ')');
  return err;
}

// linkMessage is what the companion signs: the UTF-8 bytes of
// "corescope-link:" + host + ":" + challenge, host being the host of corescopeUrl.
export function linkMessage(host, challenge) {
  return new TextEncoder().encode('corescope-link:' + host + ':' + challenge);
}

// deviceNameFrom turns a user agent into the short label CoreScope shows under Devices,
// e.g. "Android · Chrome". Order matters: Edge and Samsung Internet also say "Chrome",
// Android also says "Linux", and iOS also says "Mac OS X".
export function deviceNameFrom(ua) {
  const s = String(ua || '');
  const platform = /Android/i.test(s) ? 'Android'
    : /iPhone|iPad|iPod/i.test(s) ? 'iOS'
    : /Windows/i.test(s) ? 'Windows'
    : /Macintosh|Mac OS X/i.test(s) ? 'macOS'
    : /Linux/i.test(s) ? 'Linux'
    : 'Unknown';
  const browser = /Bluefy/i.test(s) ? 'Bluefy'
    : /Edg\//.test(s) ? 'Edge'
    : /SamsungBrowser/i.test(s) ? 'Samsung Internet'
    : /Chrome\/|CriOS/.test(s) ? 'Chrome'
    : /Firefox\/|FxiOS/.test(s) ? 'Firefox'
    : /Safari\//.test(s) ? 'Safari'
    : 'Browser';
  return platform + ' · ' + browser;
}

function errText(e) { return e && e.message ? e.message : String(e); }

function readJSON(storage, key) {
  try {
    const s = storage.getItem(key);
    return s ? JSON.parse(s) : null;
  } catch (e) {
    return null;
  }
}
function writeJSON(storage, key, value) { try { storage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked: in-memory state still holds */ } }
function removeKey(storage, key) { try { storage.removeItem(key); } catch (e) { /* nothing to do */ } }

function normCompanions(list) {
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && typeof c.pubkey === 'string' && c.pubkey)
    .map((c) => ({ pubkey: c.pubkey.toLowerCase(), name: String(c.name || '') }));
}

// loadSession returns { origin, token, displayName, companions } stored for `origin`,
// or null. A session stored for another origin is dropped on sight.
export function loadSession(storage, origin) {
  const rec = readJSON(storage, TOKEN_KEY);
  if (!rec) return null; // nothing stored, or unreadable: logged out
  if (rec.origin !== origin || typeof rec.token !== 'string' || !rec.token) {
    removeKey(storage, TOKEN_KEY);
    return null;
  }
  return { origin, token: rec.token, displayName: String(rec.displayName || ''), companions: normCompanions(rec.companions) };
}
export function saveSession(storage, s) { writeJSON(storage, TOKEN_KEY, s); }
export function clearSession(storage) { removeKey(storage, TOKEN_KEY); }

// loadRequireLinked: the hold flag as THIS origin last answered it; false when it never
// answered ("a deployment that was never reached means not required").
export function loadRequireLinked(storage, origin) {
  const rec = readJSON(storage, REQUIRE_KEY);
  return !!(rec && rec.origin === origin && rec.value === true);
}
export function saveRequireLinked(storage, origin, value) {
  writeJSON(storage, REQUIRE_KEY, { origin, value: value === true });
}

// createAccount builds the account for one CoreScope origin.
//
// deps:
//   baseUrl       the CoreScope origin (config.corescopeUrl), non-empty
//   fetch         (url, opts) => Promise<Response>
//   storage       { getItem, setItem, removeItem } (localStorage in the app)
//   setTimeout / clearTimeout   optional, default the globals
//   now           () => ms, optional, default Date.now
//   onRetry       (what) => void, optional; what is 'discover' or 'link'. Called when a
//                 retry is due (RETRY_DELAYS_MS); the app re-runs discovery or the link.
//   log           (msg, level) optional
//   onChange      () => void, optional; called whenever anything shown on the card
//                 changes, and when a fresh link has settled (the queue may drain)
export function createAccount({
  baseUrl, fetch: fetchFn, storage,
  setTimeout: setT = globalThis.setTimeout, clearTimeout: clearT = globalThis.clearTimeout,
  now = () => Date.now(),
  log = () => {}, onChange = () => {}, onRetry = () => {},
}) {
  const host = new URL(baseUrl).host;
  const IDLE = Object.freeze({ pubkey: '', name: '', status: 'idle', reason: '' });
  const st = {
    enabled: false,
    discovered: false,
    requireLinked: loadRequireLinked(storage, baseUrl),
    session: loadSession(storage, baseUrl),
    link: { ...IDLE },
    blocked: new Set(), // pubkeys with a definite link failure on this connection
    inFlight: null,     // the one link attempt allowed at a time
    settling: new Map(), // pubkey → time a fresh link stops holding (LINK_SETTLE_MS)
    retry: { discover: { timer: null, n: 0 }, link: { timer: null, n: 0 } },
  };

  // scheduleRetry arms ONE retry of `what` after the next delay in RETRY_DELAYS_MS;
  // stopRetry cancels it and starts the delays over.
  function scheduleRetry(what) {
    const r = st.retry[what];
    if (r.timer) return;
    const ms = RETRY_DELAYS_MS[Math.min(r.n, RETRY_DELAYS_MS.length - 1)];
    r.n++;
    r.timer = setT(() => {
      r.timer = null;
      try { onRetry(what); } catch (e) { /* the app logs its own failures */ }
    }, ms);
    if (r.timer && typeof r.timer.unref === 'function') r.timer.unref();
  }
  function stopRetry(what) {
    const r = st.retry[what];
    if (r.timer) clearT(r.timer);
    r.timer = null;
    r.n = 0;
  }
  const changed = () => { try { onChange(); } catch (e) { /* a render error must not break the flow */ } };

  // withTimeout runs start(signal) and rejects with NetworkError after `ms`, aborting
  // the request. start is called synchronously, so a fire-and-forget caller (logout)
  // has issued its request by the time it returns.
  function withTimeout(start, ms) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setT(() => {
        if (ctl) ctl.abort();
        reject(new NetworkError('timed out after ' + ms / 1000 + ' s'));
      }, ms);
    });
    let started;
    try { started = Promise.resolve(start(ctl ? ctl.signal : undefined)); } catch (e) { started = Promise.reject(e); }
    return Promise.race([started, timeout]).finally(() => clearT(timer));
  }

  function isLinked(pubkey) {
    const pk = String(pubkey || '').toLowerCase();
    return !!pk && !!st.session && st.session.companions.some((c) => c.pubkey === pk);
  }

  // shouldHold: CoreScope drops data from unlinked companions, so do not send it. Off
  // (the default) means publishing never waits on the account.
  function shouldHold(pubkey) {
    if (!st.requireLinked) return false;
    if (!isLinked(pubkey)) return true;
    const until = st.settling.get(String(pubkey || '').toLowerCase());
    return until !== undefined && now() < until;
  }

  // settle keeps a freshly linked companion held for LINK_SETTLE_MS, then tells the
  // app (onChange) so a held queue drains.
  function settle(pubkey) {
    st.settling.set(pubkey, now() + LINK_SETTLE_MS);
    const h = setT(() => { st.settling.delete(pubkey); changed(); }, LINK_SETTLE_MS);
    if (h && typeof h.unref === 'function') h.unref(); // node: never keeps a process alive
  }

  // discover fetches /api/config/client once. Only userManagement.enabled === true with
  // userManagement.companionLinking === true turns the feature on; every other outcome is off, with one log line saying why. Any parsed
  // answer is also a fresh reading of the hold flag; no answer keeps the last known one.
  async function discover() {
    let json = null;
    let reason = '';
    try {
      const r = await withTimeout((signal) => fetchFn(baseUrl + '/api/config/client', { signal, cache: 'no-store', credentials: 'omit' }), DISCOVER_TIMEOUT_MS);
      if (r.status !== 200) reason = 'answered HTTP ' + r.status;
      else {
        try { json = await r.json(); } catch (e) { reason = 'answered something that is not JSON'; }
      }
    } catch (e) {
      reason = 'is unreachable (' + errText(e) + '); if CoreScope runs on another origin than this app, its corsAllowedOrigins must list this origin';
    }
    st.discovered = !reason;
    if (!reason) {
      st.requireLinked = !!json && json.clientRxRequireLinkedCompanion === true;
      saveRequireLinked(storage, baseUrl, st.requireLinked);
      const um = json && json.userManagement;
      if (!um || typeof um !== 'object') reason = 'has no userManagement block (older CoreScope, or user management off)';
      else if (um.enabled !== true) reason = 'has userManagement.enabled off';
      // A CoreScope with accounts but without companion linking answers the
      // device-token POST with its SPA page: a login there could only fail.
      else if (um.companionLinking !== true) reason = 'has user management but no companion linking (CoreScope older than companion linking)';
    }
    st.enabled = !reason;
    if (st.discovered) stopRetry('discover');
    else scheduleRetry('discover');
    if (st.enabled) {
      log('account: ' + baseUrl + ' has user management — CoreScope login available'
        + (st.requireLinked ? '; it only accepts data from linked companions' : ''), 'ok');
    } else {
      log('account: off — ' + baseUrl + ' ' + reason
        + (st.requireLinked ? '; uploads from unlinked companions stay held (last known setting)' : ''), 'st');
    }
    changed();
    return { enabled: st.enabled, requireLinked: st.requireLinked, reason };
  }

  // serverError returns CoreScope's own {"error": "..."} message, or ''.
  function serverError(res) {
    return res && res.json && typeof res.json.error === 'string' ? res.json.error : '';
  }

  // endSession forgets the token and the cache. Used for logout and for any 401.
  function endSession(why) {
    st.session = null;
    clearSession(storage);
    st.link = { ...IDLE };
    log('account: logged out — ' + why, why === 'by you' ? 'st' : 'no');
    changed();
  }

  // call makes one API request. No answer at all throws NetworkError; every HTTP
  // answer resolves { status, json, headers }. A 401 on a call that carried the token
  // ends the session here, once, for every caller. Headers are built synchronously, so
  // a caller that clears the session right after calling still sends the old token.
  async function call(method, path, body, { auth = true } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const sent = auth ? st.session : null;
    if (sent) headers.Authorization = 'Bearer ' + sent.token;
    let r;
    try {
      r = await withTimeout((signal) => fetchFn(baseUrl + path, {
        // Never cookies: CoreScope judges a request that carries its session
        // cookie on that cookie alone, and the bearer header would not count.
        method, headers, signal, cache: 'no-store', credentials: 'omit',
        body: body === undefined ? undefined : JSON.stringify(body),
      }), REQUEST_TIMEOUT_MS);
    } catch (e) {
      throw e instanceof NetworkError ? e : new NetworkError(errText(e));
    }
    let json = null;
    try { json = await r.json(); } catch (e) { json = null; }
    if (r.status === 401 && sent && st.session === sent) endSession('CoreScope answered 401 (token expired or revoked)');
    return { status: r.status, json, headers: r.headers };
  }

  // refreshCompanions replaces the linked cache with the server's list. Throws
  // NetworkError when CoreScope cannot be reached; the cache is then left as it was.
  async function refreshCompanions() {
    if (!st.session) return [];
    const res = await call('GET', '/api/account/companions');
    if (!st.session) return [];
    if (res.status !== 200 || !Array.isArray(res.json)) return st.session.companions.map((c) => ({ ...c }));
    st.session.companions = normCompanions(res.json);
    saveSession(storage, st.session);
    changed();
    return st.session.companions.map((c) => ({ ...c }));
  }

  // login exchanges email + password for a device token. The password is sent once and
  // never stored. Resolves { ok, message }; never throws.
  async function login(email, password, deviceName) {
    let res;
    try {
      res = await call('POST', '/api/auth/device-token', {
        email: String(email || '').trim(),
        password: String(password || ''),
        deviceName: String(deviceName || ''),
      }, { auth: false });
    } catch (e) {
      return { ok: false, message: 'CoreScope is unreachable (' + errText(e) + ')' };
    }
    if (res.status === 200 && res.json && typeof res.json.token === 'string' && res.json.token) {
      const user = res.json.user || {};
      st.session = { origin: baseUrl, token: res.json.token, displayName: String(user.displayName || ''), companions: [] };
      saveSession(storage, st.session);
      log('account: logged in as ' + (st.session.displayName || '(no display name)'), 'ok');
      changed();
      try { await refreshCompanions(); } catch (e) { log('account: companions list not loaded yet (' + errText(e) + ')', 'no'); }
      return { ok: true, message: '' };
    }
    if (res.status === 429) {
      const after = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('Retry-After')) : NaN;
      return { ok: false, message: Number.isFinite(after) && after > 0 ? 'Try again in ' + after + ' s.' : 'Too many attempts. Try again later.' };
    }
    return { ok: false, message: serverError(res) || 'Login failed (HTTP ' + res.status + ')' };
  }

  // logout revokes the token on the server without waiting for the answer, then
  // forgets it locally.
  function logout() {
    if (!st.session) return;
    call('POST', '/api/auth/logout').catch(() => { /* revoked server-side or not, it is gone here */ });
    endSession('by you');
  }

  function setLink(pubkey, name, status, reason = '') {
    st.link = { pubkey, name, status, reason };
    changed();
    return status;
  }

  // fail is a DEFINITE failure: shown with a Retry button, not repeated automatically
  // within this connection.
  function fail(pubkey, name, reason) {
    st.blocked.add(pubkey);
    log('account: linking ' + (name || pubkey.slice(0, 12) + '…') + ' failed — ' + reason, 'no');
    return setLink(pubkey, name, 'failed', reason);
  }

  // waiting is a failure that says nothing about the companion (network, BLE drop):
  // retried on the next connect or `online` event.
  function wait(pubkey, name, reason) {
    log('account: linking ' + (name || pubkey.slice(0, 12) + '…') + ' waits — ' + reason + '; retrying on the next connect or when the network returns', 'no');
    return setLink(pubkey, name, 'waiting', reason);
  }

  async function runLink(pubkey, name, sign, force) {
    if (!st.enabled || !st.session || !pubkey) return 'skipped';
    if (force) st.blocked.delete(pubkey);
    if (st.blocked.has(pubkey)) return st.link.status;
    if (isLinked(pubkey)) return setLink(pubkey, name, 'linked');
    setLink(pubkey, name, 'working');
    try {
      await refreshCompanions();
      if (!st.session) return 'logged-out';
      if (isLinked(pubkey)) return setLink(pubkey, name, 'linked');
      for (let attempt = 1; ; attempt++) {
        const ch = await call('POST', '/api/account/companions/challenge', { pubkey });
        if (!st.session) return 'logged-out';
        if (ch.status === 429) return wait(pubkey, name, 'CoreScope is rate limiting (HTTP 429)');
        if (ch.status !== 200 || !ch.json || typeof ch.json.challenge !== 'string' || !ch.json.challenge) {
          return fail(pubkey, name, 'no challenge: ' + (serverError(ch) || 'HTTP ' + ch.status));
        }
        const challenge = ch.json.challenge;
        // Sign the host the server says it verifies against (the host of its
        // userManagement.publicBaseUrl); fall back to corescopeUrl's host only
        // if the answer has none.
        const signHost = typeof ch.json.host === 'string' && ch.json.host ? ch.json.host : host;
        let signature;
        try {
          signature = await sign(linkMessage(signHost, challenge), pubkey);
        } catch (e) {
          if (e && e.name === 'SignUnsupportedError') {
            st.blocked.add(pubkey);
            log('account: ' + (name || pubkey.slice(0, 12) + '…') + ' cannot sign (' + errText(e) + ') — update its firmware to link it', 'no');
            return setLink(pubkey, name, 'unsupported');
          }
          if (e && e.transient) return wait(pubkey, name, errText(e));
          return fail(pubkey, name, 'signing failed: ' + errText(e));
        }
        const res = await call('POST', '/api/account/companions', { pubkey, challenge, signature: bytesToHex(signature), name });
        if (!st.session) return 'logged-out';
        if (res.status === 200) {
          if (!isLinked(pubkey)) st.session.companions.push({ pubkey, name: String((res.json && res.json.name) || name) });
          saveSession(storage, st.session);
          settle(pubkey);
          log('account: linked ' + (name || pubkey.slice(0, 12) + '…') + ' to ' + (st.session.displayName || 'this account'), 'ok');
          return setLink(pubkey, name, 'linked');
        }
        if (res.status === 429) return wait(pubkey, name, 'CoreScope is rate limiting (HTTP 429)');
        if (res.status === 410 && attempt === 1) {
          log('account: challenge expired or already used (410) — one retry with a new challenge', 'st');
          continue;
        }
        if (res.status === 400) {
          // The server verifies against the host of its userManagement.publicBaseUrl; a
          // corescopeUrl on another host makes every signature "bad".
          log('account: the signed message was bound to host ' + host + '; it must equal the host of CoreScope\'s userManagement.publicBaseUrl', 'no');
          return fail(pubkey, name, 'CoreScope rejected the signature (' + (serverError(res) || 'HTTP 400') + ')');
        }
        if (res.status === 410) return fail(pubkey, name, 'the challenge expired twice (HTTP 410)');
        return fail(pubkey, name, serverError(res) || 'HTTP ' + res.status);
      }
    } catch (e) {
      if (e instanceof NetworkError) return wait(pubkey, name, 'CoreScope unreachable (' + errText(e) + ')');
      return fail(pubkey, name, errText(e));
    }
  }

  // link runs the auto-link flow for the connected companion. One attempt at a time:
  // a caller for the SAME companion gets the running attempt's promise; a caller for
  // another companion waits for it and then runs its own (the radio signs one
  // challenge at a time, and an attempt must never be answered for another
  // companion). `sign(bytes, pubkey)` resolves the 64-byte signature of the companion
  // `pubkey` (src/app.js signOnCompanion). `force` is the Retry button: it lifts a
  // definite failure for this pubkey. Resolves the status:
  // 'linked' | 'working' | 'waiting' | 'unsupported' | 'failed' | 'logged-out' | 'skipped'.
  function link(args) {
    const pk = String(args.pubkey || '').toLowerCase();
    if (st.inFlight) {
      if (st.inFlight.pubkey === pk) return st.inFlight.promise;
      return st.inFlight.promise.catch(() => {}).then(() => link(args));
    }
    const promise = runLink(pk, String(args.name || ''), args.sign, !!args.force)
      .then((status) => {
        if (status === 'waiting') scheduleRetry('link');
        else stopRetry('link');
        return status;
      })
      .finally(() => { st.inFlight = null; });
    st.inFlight = { pubkey: pk, promise };
    return promise;
  }

  // newConnection: a user connected a companion. Definite failures from the previous
  // connection no longer apply.
  function newConnection() {
    st.blocked.clear();
    st.link = { ...IDLE };
    changed();
  }

  const api = {
    get enabled() { return st.enabled; },
    get discovered() { return st.discovered; },
    get requireLinked() { return st.requireLinked; },
    get loggedIn() { return !!st.session; },
    get displayName() { return st.session ? st.session.displayName : ''; },
    get companions() { return st.session ? st.session.companions.map((c) => ({ ...c })) : []; },
    get linkState() { return { ...st.link }; },
    discover,
    isLinked,
    shouldHold,
    login,
    logout,
    refreshCompanions,
    link,
    newConnection,
  };
  return api;
}
