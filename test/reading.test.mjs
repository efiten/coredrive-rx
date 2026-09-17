// test/reading.test.mjs
// The presentation layer around monitor.js: which tier a reception paints in,
// what the three readouts say, and how far the meter fills. Thresholds are the
// ones app.js has painted since v1.0 (snrColor): 5 / -3 / -10 dB.
import { test } from 'node:test';
import assert from 'node:assert';
import { snrTier, readingModel } from '../src/ui/reading.js';

test('the tiers are the thresholds the app has always painted', () => {
  assert.strictEqual(snrTier(9), 'hot');
  assert.strictEqual(snrTier(5), 'hot');
  assert.strictEqual(snrTier(4.75), 'warm');
  assert.strictEqual(snrTier(-3), 'warm');
  assert.strictEqual(snrTier(-3.25), 'mid');
  assert.strictEqual(snrTier(-10), 'mid');
  assert.strictEqual(snrTier(-10.25), 'cool');
});

test('a reception with no metric has a tier of its own, not the worst one', () => {
  assert.strictEqual(snrTier(null), 'none');
  assert.strictEqual(snrTier(undefined), 'none');
  assert.strictEqual(snrTier(NaN), 'none');
});

test('the model formats the three readouts', () => {
  const m = readingModel({ snr: 4.25, rssi: -92, name: 'ON8AR-Rpt', at: 1000, now: 4000 });
  assert.strictEqual(m.snrText, '+4.25 dB');
  assert.strictEqual(m.rssiText, '-92 dBm');
  assert.strictEqual(m.sinceText, '3s');
  assert.strictEqual(m.name, 'ON8AR-Rpt');
  assert.strictEqual(m.tier, 'warm');
});

test('the meter fills by the same mapping monitor.js already owns', () => {
  assert.strictEqual(readingModel({ snr: -20, rssi: -120, at: 0, now: 0 }).fillPct, 0);
  assert.strictEqual(readingModel({ snr: 10, rssi: -60, at: 0, now: 0 }).fillPct, 100);
  assert.strictEqual(readingModel({ snr: -5, rssi: -100, at: 0, now: 0 }).fillPct, 50);
});

test('the peak never sits below the live fill', () => {
  const m = readingModel({ snr: 10, rssi: -60, at: 0, now: 0, peakPct: 20 });
  assert.strictEqual(m.peakPct, 100);
});

test('no reception yet is an empty model, not a zero reading', () => {
  const m = readingModel({ snr: null, rssi: null, name: null, at: null, now: 5000 });
  assert.strictEqual(m.snrText, '');
  assert.strictEqual(m.sinceText, '');
  assert.strictEqual(m.tier, 'none');
  assert.strictEqual(m.fillPct, 0);
});
