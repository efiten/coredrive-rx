// Pure idle-gate logic: from a stream of GPS fixes, decide moving vs stationary so
// capture/upload pauses when parked and resumes on movement. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { updateMotion, distanceM, DEFAULT_RADIUS_M, DEFAULT_DWELL_MS } from '../src/motion.js';

const MIN = 60 * 1000;

test('distanceM is ~0 for the same point and ~111 m per 0.001° latitude', () => {
  const a = { lat: 50.85, lon: 4.5 };
  assert.ok(distanceM(a, a) < 1);
  assert.ok(distanceM(a, { lat: 50.851, lon: 4.5 }) > 100);
});

test('first fix seeds an active (not paused) gate anchored at the fix', () => {
  const s = updateMotion(null, { lat: 50.85, lon: 4.5 }, 0);
  assert.strictEqual(s.paused, false);
  assert.deepStrictEqual(s.anchor, { lat: 50.85, lon: 4.5 });
});

test('continuous movement (each fix > radius) stays active and re-anchors', () => {
  let s = updateMotion(null, { lat: 50.850, lon: 4.5 }, 0);
  s = updateMotion(s, { lat: 50.853, lon: 4.5 }, 5 * MIN);   // ~330 m
  assert.strictEqual(s.paused, false);
  assert.strictEqual(s.anchor.lat, 50.853);                  // re-anchored
  s = updateMotion(s, { lat: 50.856, lon: 4.5 }, 20 * MIN);  // moved again
  assert.strictEqual(s.paused, false);                       // no pause despite >dwell elapsed overall
});

test('staying within the radius past the dwell time pauses', () => {
  let s = updateMotion(null, { lat: 50.85, lon: 4.5 }, 0);
  s = updateMotion(s, { lat: 50.8501, lon: 4.5 }, 5 * MIN);  // ~11 m jitter, within radius
  assert.strictEqual(s.paused, false);                       // not long enough yet
  s = updateMotion(s, { lat: 50.8501, lon: 4.5 }, 16 * MIN);
  assert.strictEqual(s.paused, true);
});

test('moving again after a pause resumes and re-anchors', () => {
  let s = updateMotion(null, { lat: 50.85, lon: 4.5 }, 0);
  s = updateMotion(s, { lat: 50.85, lon: 4.5 }, 16 * MIN);
  assert.strictEqual(s.paused, true);
  s = updateMotion(s, { lat: 50.86, lon: 4.5 }, 17 * MIN);   // ~1.1 km away
  assert.strictEqual(s.paused, false);
  assert.strictEqual(s.anchor.lat, 50.86);
});

test('within-radius jitter does not reset the dwell timer', () => {
  let s = updateMotion(null, { lat: 50.85, lon: 4.5 }, 0);
  s = updateMotion(s, { lat: 50.8500, lon: 4.5001 }, 5 * MIN);
  s = updateMotion(s, { lat: 50.8501, lon: 4.4999 }, 10 * MIN);
  assert.strictEqual(s.anchorTime, 0);                       // anchor time held from arrival
  s = updateMotion(s, { lat: 50.8500, lon: 4.5000 }, 16 * MIN);
  assert.strictEqual(s.paused, true);                        // paused at arrival+16min, jitter didn't reset it
});

test('default thresholds are 75 m / 15 min', () => {
  assert.strictEqual(DEFAULT_RADIUS_M, 75);
  assert.strictEqual(DEFAULT_DWELL_MS, 15 * 60 * 1000);
});
