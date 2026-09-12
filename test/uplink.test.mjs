// Pure decisions about the uplink (config → publisher → broker → queue) and the
// diagnostic header stamped onto an exported debug log.
//
// Every case here comes from a real field diagnosis that took far too long:
//   - a session that captured for an hour and published nothing, while the UI
//     said "All connected" and the Push button said "nothing pending";
//   - a session running on a config cached before rfSampler/regionDiscovery
//     existed, so both were silently off and looked broken;
//   - two shared logs with no way to tell which app version produced them.
import { test } from 'node:test';
import assert from 'node:assert';
import { uplinkState, uplinkWarning, pushOutcome, regionInertReason, buildLogHeader } from '../src/uplink.js';

const CFG = { fullRfLog: true, rfSampler: true, regionDiscovery: true };

// --- uplinkState -------------------------------------------------------------

test('no config is its own state — it is the only one the app can fix by itself', () => {
  assert.strictEqual(uplinkState({ hasConfig: false, hasPublisher: false, brokerState: null }), 'no-config');
});

test('config but no publisher is distinct from a publisher that is down', () => {
  assert.strictEqual(uplinkState({ hasConfig: true, hasPublisher: false, brokerState: null }), 'no-publisher');
  assert.strictEqual(uplinkState({ hasConfig: true, hasPublisher: true, brokerState: 'close' }), 'down');
  assert.strictEqual(uplinkState({ hasConfig: true, hasPublisher: true, brokerState: 'offline' }), 'down');
  assert.strictEqual(uplinkState({ hasConfig: true, hasPublisher: true, brokerState: 'connect' }), 'ok');
});

test('a missing config wins over everything else — it is the upstream cause', () => {
  assert.strictEqual(uplinkState({ hasConfig: false, hasPublisher: true, brokerState: 'connect' }), 'no-config');
});

// --- uplinkWarning: the persistent on-screen banner --------------------------

test('a healthy uplink shows no banner', () => {
  assert.strictEqual(uplinkWarning('ok'), null);
});

test('every unhealthy state says records are KEPT, not lost', () => {
  for (const s of ['no-config', 'no-publisher', 'down']) {
    const w = uplinkWarning(s);
    assert.ok(w, s + ' must warn');
    assert.match(w, /not being uploaded/i, s + ' must say uploading is stopped');
    assert.match(w, /kept/i, s + ' must reassure that nothing is lost');
  }
});

test('the no-config banner names config.json so the cause is actionable', () => {
  assert.match(uplinkWarning('no-config'), /config\.json/);
});

test('the no-config banner says internet is needed — config.json is never served offline', () => {
  // config.json is deliberately excluded from the service-worker cache (a stale copy
  // silently disables feature flags), so a cold start with no connection genuinely
  // cannot upload. The user must be told that, not left guessing.
  assert.match(uplinkWarning('no-config'), /internet/i);
});

test('before connecting, only a missing config warns — the rest is the normal resting state', () => {
  // A cold open has no publisher and an offline broker by definition. Warning about
  // that would put a red banner on screen every single launch, before anything is
  // even being captured, which trains the user to ignore it.
  assert.strictEqual(uplinkWarning('no-publisher', false), null);
  assert.strictEqual(uplinkWarning('down', false), null);
  assert.ok(uplinkWarning('no-config', false), 'a missing config is actionable before connecting too');
});

test('once connected, every unhealthy state warns again', () => {
  for (const s of ['no-config', 'no-publisher', 'down']) assert.ok(uplinkWarning(s, true), s);
});

// --- pushOutcome: the "Push pending now" button ------------------------------

test('an empty queue on a healthy link says exactly that — never "not connected"', () => {
  // The old message was 'nothing pending / not connected', which conflated a
  // healthy empty queue with a dead uplink and a null publisher.
  const r = pushOutcome({ uplink: 'ok', pending: 0, published: 0 });
  assert.match(r.message, /queue is empty/i);
  assert.doesNotMatch(r.message, /not connected/i);
  assert.strictEqual(r.level, 'st');
});

test('a successful push reports the count', () => {
  const r = pushOutcome({ uplink: 'ok', pending: 3, published: 3 });
  assert.match(r.message, /pushed 3 record/);
  assert.strictEqual(r.level, 'ok');
});

test('a healthy link that published nothing while records are buffered is flagged, not hidden', () => {
  const r = pushOutcome({ uplink: 'ok', pending: 7, published: 0 });
  assert.match(r.message, /7 record/);
  assert.strictEqual(r.level, 'no');
});

test('no publisher triggers a reconnect AND reports the real backlog', () => {
  // The old code skipped its reconnect branch entirely when state.publisher was
  // null — the exact case where recovery was needed — and reported 0 pending
  // regardless of how many records were actually buffered.
  const r = pushOutcome({ uplink: 'no-publisher', pending: 412, published: 0 });
  assert.strictEqual(r.reconnect, true);
  assert.match(r.message, /412/);
});

test('a down broker triggers a reconnect and never claims the queue is empty', () => {
  const r = pushOutcome({ uplink: 'down', pending: 0, published: 0 });
  assert.strictEqual(r.reconnect, true);
  assert.doesNotMatch(r.message, /empty/i);
});

test('no config asks for a config reload, not a broker reconnect', () => {
  const r = pushOutcome({ uplink: 'no-config', pending: 88, published: 0 });
  assert.strictEqual(r.reloadConfig, true);
  assert.strictEqual(r.reconnect, false);
  assert.match(r.message, /88/);
  assert.match(r.message, /config/i);
  assert.match(r.message, /internet/i);
});

// --- regionInertReason: why the one transmitting feature never fires ---------

test('region discovery off in config is named as such', () => {
  const why = regionInertReason({ config: { ...CFG, regionDiscovery: false }, supported: false, fwVer: 13 });
  assert.match(why, /config\.json/);
});

test('region discovery on but firmware too old names the firmware version', () => {
  const why = regionInertReason({ config: CFG, supported: false, fwVer: 12 });
  assert.match(why, /firmware/i);
  assert.match(why, /12/);
});

test('region discovery on with unknown firmware says the device info was never read', () => {
  const why = regionInertReason({ config: CFG, supported: false, fwVer: null });
  assert.match(why, /firmware version/i);
});

test('a working region discovery has no reason to report', () => {
  assert.strictEqual(regionInertReason({ config: CFG, supported: true, fwVer: 13 }), null);
});

test('no config at all is reported as the cause rather than blaming the firmware', () => {
  assert.match(regionInertReason({ config: null, supported: false, fwVer: null }), /config/i);
});

// --- buildLogHeader: every shared log must identify itself --------------------

const BASE = {
  version: '1.11.0',
  nowISO: '2026-09-07T09:12:33.000Z',
  config: CFG,
  fwVer: 13,
  regionsSupported: true,
  companionName: 'On8AR-Mobile',
  companionPubkey: '3583b9257d077a416e73debdbefc3836',
  uplink: 'ok',
  pending: 0,
  lineCount: 200,
  lineCap: 200,
};

test('the header stamps the app version — without it a shared log is unidentifiable', () => {
  assert.match(buildLogHeader(BASE), /v1\.11\.0/);
});

test('the header stamps when it was generated', () => {
  assert.match(buildLogHeader(BASE), /2026-09-07T09:12:33/);
});

test('the header prints every effective config flag, which is how a stale config shows up', () => {
  // A device on a config cached before these flags existed reports them off while
  // the served config.json says on — invisible until the two are compared.
  const h = buildLogHeader({ ...BASE, config: { fullRfLog: true, rfSampler: false, regionDiscovery: false } });
  assert.match(h, /fullRfLog=on/);
  assert.match(h, /rfSampler=off/);
  assert.match(h, /regionDiscovery=off/);
});

test('a missing config is shouted, and says which defaults are collecting meanwhile', () => {
  const h = buildLogHeader({ ...BASE, config: null, uplink: 'no-config', pending: 412 });
  assert.match(h, /NOT LOADED/);
  assert.match(h, /412 pending/);
  // A no-config session still collects on defaults — a reader must be able to tell
  // what is in the 412 records without guessing.
  assert.match(h, /fullRfLog=on/);
  assert.match(h, /regionDiscovery=off/);
});

test('the header states whether region discovery can transmit at all, and why not', () => {
  const ok = buildLogHeader(BASE);
  assert.match(ok, /regions\s+active/);
  const old = buildLogHeader({ ...BASE, fwVer: 12, regionsSupported: false });
  assert.match(old, /regions\s+inert/);
  assert.match(old, /12/);
});

test('the header records the firmware version', () => {
  assert.match(buildLogHeader(BASE), /firmware\s+v13/);
  assert.match(buildLogHeader({ ...BASE, fwVer: null, regionsSupported: false }), /firmware\s+unknown/);
});

test('a full ring buffer warns that older lines have already rolled out', () => {
  assert.match(buildLogHeader(BASE), /rolled out/i);
  assert.doesNotMatch(buildLogHeader({ ...BASE, lineCount: 42 }), /rolled out/i);
});

test('the header never leaks the broker password even if handed the whole config', () => {
  const h = buildLogHeader({ ...BASE, config: { ...CFG, mqttPassword: 'sup3rs3cret', mqttUsername: 'u', mqttUrl: 'wss://b/ws' } });
  assert.doesNotMatch(h, /sup3rs3cret/);
});

// verifyAdverts changes which identities reach CoreScope, so a log that does not say
// whether it was on cannot be read: an advert missing from a capture is then either a
// rejected forgery or a bug, with nothing to tell them apart.
test('the header prints whether advert signatures were verified', () => {
  const on = buildLogHeader({ ...BASE, config: { fullRfLog: true, rfSampler: true, regionDiscovery: true, verifyAdverts: true } });
  assert.match(on, /verifyAdverts=on/);
  const off = buildLogHeader({ ...BASE, config: { fullRfLog: true, rfSampler: true, regionDiscovery: true } });
  assert.match(off, /verifyAdverts=off/);
});

test('a missing config says advert verification is off, not silent about it', () => {
  assert.match(buildLogHeader({ ...BASE, config: null, uplink: 'no-config' }), /verifyAdverts=off/);
});

// --- path-hash resolve stats --------------------------------------------------
// Forwarders are heard as a 2-4 byte path-hash prefix, which must be resolved to a
// full pubkey before it can be asked for its regions. Whether that resolve usually
// succeeds decides whether the whole path-hash candidate source is worth its
// airtime, and a 200-line ring buffer cannot answer it — individual log lines roll
// out long before the drive ends. It belongs in the header, next to the other
// session-wide facts.

test('the header reports how many path-hash prefixes resolved to a pubkey', () => {
  const h = buildLogHeader({ ...BASE, pathResolve: { attempted: 15, resolved: 12 } });
  assert.match(h, /path keys/);
  assert.match(h, /12 of 15/);
});

test('the header names the unresolved remainder, which is the number that decides the feature', () => {
  const h = buildLogHeader({ ...BASE, pathResolve: { attempted: 15, resolved: 12 } });
  assert.match(h, /3 ambiguous or unknown/);
});

test('a session that resolved every prefix says so without an alarming zero-count', () => {
  const h = buildLogHeader({ ...BASE, pathResolve: { attempted: 4, resolved: 4 } });
  assert.match(h, /4 of 4/);
  assert.doesNotMatch(h, /ambiguous or unknown/);
});

test('no path-hash prefix tried yet prints no row at all rather than a misleading 0 of 0', () => {
  assert.doesNotMatch(buildLogHeader({ ...BASE, pathResolve: { attempted: 0, resolved: 0 } }), /path keys/);
  assert.doesNotMatch(buildLogHeader(BASE), /path keys/);
});

// --- Ask counters in the header ----------------------------------------------
// Region discovery's per-ask lines are the first thing the 200-line ring buffer rolls
// out on a long drive, so the ratios that say whether it is working have to survive in
// the header.

test('buildLogHeader reports the ask counters', () => {
  const h = buildLogHeader({
    version: '1.15.0', nowISO: 'now', config: null, fwVer: 13, regionsSupported: true,
    uplink: 'ok', pending: 0, lineCount: 1, lineCap: 200,
    asks: {
      heard: 340, seen: 22, asks: 61, replies: 7, answered: 7, queue: 3,
      outstanding: 5, flooded: 1, unmatched: 2, dropped: 12, capped: 96, limited: 4, bonus: 2,
      sigAnswered: { n: 7, rssiMin: -109, rssiMax: -78, snrMin: 1.75, snrMax: 12.25 },
      sigSilent: { n: 12, rssiMin: -125, rssiMax: -111, snrMin: -13.5, snrMax: -0.5 },
    },
  });
  assert.match(h, /asks {7}7 of 22 repeaters answered — 61 asks sent, 7 answered, over 340 receptions/);
  assert.match(h, /asks q {5}3 queued, 5 awaiting a reply, 12 timed out, 2 unmatched replies, 1 sent as FLOOD/);
  assert.match(h, /asks cap {3}96 receptions ignored \(encounter allowance spent\), 4 held off by the repeater limiter, 2 extra asks earned/);
  assert.match(h, /asks sig {3}answered 7: rssi -109 … -78dBm, snr 1.75 … 12.25dB \| silent 12: rssi -125 … -111dBm/);
});

test('buildLogHeader omits the ask rows when nothing passed them', () => {
  // A caller that does not know about them must not produce a header full of zeros
  // that reads like a session which asked nothing.
  const h = buildLogHeader({
    version: '1.15.0', nowISO: 'now', config: null, fwVer: 13, regionsSupported: true,
    uplink: 'ok', pending: 0, lineCount: 1, lineCap: 200, asks: null,
  });
  assert.doesNotMatch(h, /asks/);
});
