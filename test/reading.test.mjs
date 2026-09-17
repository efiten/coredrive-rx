// test/reading.test.mjs
// The presentation layer around monitor.js: which tier a reception paints in,
// what the three readouts say, and how far the meter fills. Thresholds are the
// ones app.js has painted since v1.0 (snrColor): 5 / -3 / -10 dB.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { snrTier, readingModel, renderReading } from '../src/ui/reading.js';
import { snrToPct } from '../src/monitor.js';

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

test('renderReading writes the model into DOM elements with correct class strings', () => {
  // Fake DOM elements: plain objects with textContent, className, and style properties
  const els = {
    snr: { textContent: '', className: '', style: {} },
    rssi: { textContent: '', className: '', style: {} },
    since: { textContent: '', className: '', style: {} },
    name: { textContent: '', className: '', style: {} },
    fill: { textContent: '', className: '', style: {} },
    peak: { textContent: '', className: '', style: {} },
  };

  // Use SNR = 2.5 which is in the 'warm' tier and yields a clean percentage
  const snr = 2.5;
  const fillPct = snrToPct(snr);
  const m = readingModel({ snr, rssi: -95, name: 'ON8AR', at: 2000, now: 5000, peakPct: 80 });

  renderReading(els, m);

  assert.strictEqual(els.snr.textContent, '+2.50 dB');
  assert.strictEqual(els.snr.className, 'mono tier-warm');
  assert.strictEqual(els.rssi.textContent, '-95 dBm');
  assert.strictEqual(els.since.textContent, '3s');
  assert.strictEqual(els.name.textContent, 'ON8AR');
  assert.strictEqual(els.fill.className, 'meter-fill fill-warm');
  assert.strictEqual(els.fill.style.width, `${fillPct}%`);
  assert.strictEqual(els.peak.style.left, `${Math.max(fillPct, 80)}%`);
});

test('renderReading does not throw and writes nothing when optional elements are absent', () => {
  const els = { snr: { textContent: '', className: '', style: {} } };
  const m = readingModel({ snr: -3, rssi: null, name: null, at: null, now: 0 });

  assert.doesNotThrow(() => renderReading(els, m));
  assert.strictEqual(els.snr.textContent, '-3.00 dB');
  assert.strictEqual(els.snr.className, 'mono tier-warm');
  // Optional elements should not have been touched (remain undefined/unchanged)
  assert.ok(!('rssi' in els));
  assert.ok(!('since' in els));
  assert.ok(!('name' in els));
  assert.ok(!('fill' in els));
  assert.ok(!('peak' in els));
});

test('every class string renderReading emits exists in app.css', () => {
  const cssPath = new URL('../src/styles/app.css', import.meta.url);
  const css = readFileSync(cssPath, 'utf8');

  // Derive the set of tiers that snrTier actually returns by testing its output
  const tierSet = new Set();
  const testSnrs = [10, 5, 4.99, -3, -3.01, -10, -10.01, null];
  for (const snr of testSnrs) {
    tierSet.add(snrTier(snr));
  }

  // Verify each tier has both .tier-* and .fill-* classes in the stylesheet
  for (const tier of tierSet) {
    assert.match(css, new RegExp(`\\.tier-${tier}\\b`),
      `CSS must define .tier-${tier}`);
    assert.match(css, new RegExp(`\\.fill-${tier}\\b`),
      `CSS must define .fill-${tier}`);
  }

  // Verify the structural classes exist
  assert.match(css, /\.mono\b/, 'CSS must define .mono');
  assert.match(css, /\.meter-fill\b/, 'CSS must define .meter-fill');
  assert.match(css, /\.meter-peak\b/, 'CSS must define .meter-peak');
});
