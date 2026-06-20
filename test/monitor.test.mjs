// Pure monitor helpers: auto-discover scheduling/backoff, SNR meter mapping +
// peak-hold decay, and the rolling capture-rate window.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import {
  discoverDecision, isOrganicHeard, snrToPct, decayPeak, pruneTimestamps,
  DISCOVER_INTERVAL_MS, DISCOVER_BACKOFF_MS,
} from '../src/monitor.js';

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
