// Pure monitor helpers: auto-discover scheduling/backoff, SNR meter mapping +
// peak-hold decay, and the rolling capture-rate window.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import {
  discoverDecision, isOrganicHeard, snrToPct, decayPeak, pruneTimestamps,
  DISCOVER_INTERVAL_MS, DISCOVER_BACKOFF_MS, linkTransition } from '../src/monitor.js';

test('discover fires immediately when never fired and channel quiet', () => {
  const d = discoverDecision(1000, null, 0, false);
  assert.strictEqual(d.fire, true);
  assert.strictEqual(d.state, 'active');
});

test('discover paused while stationary, never fires', () => {
  const d = discoverDecision(1_000_000, null, 0, true);
  assert.deepStrictEqual(d, { fire: false, state: 'paused', secs: 0 });
});

test('a 2-byte heard packet arms the 15s backoff; discover stays silent', () => {
  const now = 1_000_000;
  const d = discoverDecision(now, now - 5000, 0, false); // 5 s ago < 15 s
  assert.strictEqual(d.fire, false);
  assert.strictEqual(d.state, 'backoff');
  assert.strictEqual(d.secs, 10); // 15 - 5 remaining
});

test('discover resumes only after 15 s of silence', () => {
  const now = 1_000_000;
  const lastHeard = now - DISCOVER_BACKOFF_MS; // exactly 15 s ago → no longer in backoff
  const d = discoverDecision(now, lastHeard, now - DISCOVER_INTERVAL_MS, false);
  assert.strictEqual(d.state, 'active');
  assert.strictEqual(d.fire, true); // also due on the base interval
});

test('within the interval but quiet: active, counts down, does not fire', () => {
  const now = 1_000_000;
  const d = discoverDecision(now, now - 20000, now - 10000, false); // last heard 20s ago, fired 10s ago
  assert.strictEqual(d.fire, false);
  assert.strictEqual(d.state, 'active');
  assert.strictEqual(d.secs, 20); // 30 - 10 until next sweep
});

test('isOrganicHeard: forwarder/advert yes, our own discover reply no', () => {
  assert.strictEqual(isOrganicHeard({ src: 'rxlog' }), true);
  assert.strictEqual(isOrganicHeard({ src: 'advert' }), true);
  assert.strictEqual(isOrganicHeard({ src: 'discover' }), false);
  assert.strictEqual(isOrganicHeard(null), false);
});

test('snrToPct clamps to the fixed display range', () => {
  assert.strictEqual(snrToPct(null), 0);
  assert.strictEqual(snrToPct(-20), 0);    // floor
  assert.strictEqual(snrToPct(10), 100);   // ceil
  assert.strictEqual(snrToPct(-100), 0);   // clamped
  assert.strictEqual(snrToPct(50), 100);   // clamped
  assert.strictEqual(snrToPct(-5), 50);    // midpoint of [-20,10]
});

test('peak never sits below the live bar and decays toward it over time', () => {
  // live bar at 20%, stale peak at 80%, 1 s elapsed → drops by 25
  assert.strictEqual(decayPeak(80, 20, 1000), 55);
  // would drop below target → clamped to the target
  assert.strictEqual(decayPeak(30, 20, 1000), 20);
  // bar above peak pushes nothing down (caller raises peak); decay keeps target floor
  assert.strictEqual(decayPeak(20, 40, 1000), 40);
});

test('capture-rate window drops entries older than 60 s', () => {
  const now = 100_000;
  const times = [now - 70000, now - 30000, now - 1000, now];
  const kept = pruneTimestamps(times, now);
  assert.strictEqual(kept.length, 3); // the 70 s-old one is gone
});

// --- Region discovery cadence (deliberately independent of the stationary pause) ---


// --- Link-down ----------------------------------------------------------------
// Field log 2026-09-13, 01:57:54 onward: the BLE link dropped and the sweep kept firing
// every 30s for two and a half minutes, each one logging
// "discover send failed: GATT Server is disconnected". A sweep over a dead link is not
// a sweep, so the decision has to know.

test('discoverDecision does not sweep while the link is down', () => {
  const d = discoverDecision(1_000_000, null, 0, false, false);
  assert.equal(d.fire, false);
  assert.equal(d.state, 'link-down');
});

test('link-down outranks both the pause and a sweep that is due', () => {
  // Due (lastFireAt 0) and stationary at the same time: neither may turn into a write.
  assert.equal(discoverDecision(1_000_000, null, 0, true, false).state, 'link-down');
  assert.equal(discoverDecision(1_000_000, null, 0, false, false).fire, false);
});

test('the first tick after the link returns sweeps immediately', () => {
  // lastFireAt is not advanced while down, so nothing has to be waited out afterwards.
  const now = 1_000_000;
  const lastFire = now - DISCOVER_INTERVAL_MS * 5;
  assert.equal(discoverDecision(now, null, lastFire, false, false).fire, false);
  assert.equal(discoverDecision(now, null, lastFire, false, true).fire, true);
});

test('linkUp defaults to true, so an existing caller keeps sweeping', () => {
  assert.equal(discoverDecision(1_000_000, null, 0, false).fire, true);
});

// --- Link up/down edge announcements ------------------------------------------
// Regression (field log 2026-09-14, 08:47–08:50): "companion link back" was logged on
// EVERY per-second tick while the link was simply up, flooding the 200-line debug ring
// buffer so that heard/asks/regions lines rolled out within minutes — while a real drop
// was never announced at all.

test('a steady link announces nothing, tick after tick', () => {
  let quiet = false; // link up at start
  for (let i = 0; i < 200; i++) assert.equal(linkTransition(quiet, true), null);
});

test('a steady down link announces nothing either', () => {
  for (let i = 0; i < 200; i++) assert.equal(linkTransition(true, false), null);
});

test('the drop is announced once, then stays quiet', () => {
  let quiet = false;
  assert.equal(linkTransition(quiet, false), 'down');
  quiet = true; // caller flips the flag on an edge
  assert.equal(linkTransition(quiet, false), null);
});

test('the return is announced once, then stays quiet', () => {
  let quiet = true;
  assert.equal(linkTransition(quiet, true), 'back');
  quiet = false;
  assert.equal(linkTransition(quiet, true), null);
});

test('a full drop/return cycle over per-second ticks announces exactly two edges', () => {
  // Drives the real monitorTick loop: 10 s up, 5 s down, 10 s up again.
  const ups = [...Array(10).fill(true), ...Array(5).fill(false), ...Array(10).fill(true)];
  let quiet = false;
  const said = [];
  for (const up of ups) {
    const edge = linkTransition(quiet, up);
    if (edge) { said.push(edge); quiet = !up; }
  }
  assert.deepEqual(said, ['down', 'back']);
});
