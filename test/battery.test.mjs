// test/battery.test.mjs
// Battery percentage helpers, copied from core-hunter (vitest -> node:test).
// The curve's endpoints are firmware's, and a 0 reading is firmware's sentinel
// for a board without VBAT sense, not a flat pack.
import { test } from 'node:test';
import assert from 'node:assert';
import { mvToPercent, isMultiCell, isLowBattery, batteryLine } from '../src/ui/battery.js';

test('a single-cell reading maps onto the firmware curve', () => {
  assert.strictEqual(mvToPercent(4200), 100);
  assert.strictEqual(mvToPercent(3000), 0);
  assert.strictEqual(typeof mvToPercent(3800), 'number');
});

test('no reading and a multi-cell pack have no honest percentage', () => {
  assert.strictEqual(mvToPercent(null), null);
  assert.strictEqual(mvToPercent(0), 0);
  assert.strictEqual(isMultiCell(6100), true);
  assert.strictEqual(mvToPercent(6100), null);
});

test('a pack we cannot read is not "low"', () => {
  assert.strictEqual(isLowBattery(6100), false);
  assert.strictEqual(isLowBattery(null), false);
  assert.strictEqual(isLowBattery(3499), true);
  assert.strictEqual(isLowBattery(3500), false);
});

// The 75% below is not a literal picked by this test: it is what core-hunter's
// copied MV_EMPTY (3000) / MV_FULL (4200) curve actually produces for 3900mV —
// ((3900-3000)/(4200-3000))*100 = 75 — verified against those constants, not
// asserted on faith.
test('the Status line shows a voltage when a percentage would be a guess', () => {
  assert.deepStrictEqual(batteryLine(3900), { text: 'Battery 3.90 V (75%)', low: false });
  assert.deepStrictEqual(batteryLine(6100), { text: 'Battery 6.10 V', low: false });
  assert.deepStrictEqual(batteryLine(0), { text: 'Battery — not reported', low: false });
  assert.deepStrictEqual(batteryLine(null), { text: 'Battery — not reported', low: false });
  assert.strictEqual(batteryLine(3400).low, true);
});

// A board without VBAT sense reports exactly 0 (src/rfstats.js passes firmware's
// raw value through). mvToPercent clamps that to 0%, not null, so isLowBattery's
// multi-cell guard never caught it — and src/app.js's renderDots calls
// isLowBattery directly, bypassing batteryLine's own sentinel handling. The
// result was a permanent amber BLE dot on a companion that has no pack to warn
// about. 0 is "not reported", which is not "low".
test('a companion with no battery sense is not low', () => {
  assert.strictEqual(isLowBattery(0), false);
  assert.strictEqual(isLowBattery(undefined), false);
  assert.strictEqual(isLowBattery(NaN), false);
  // The sentinel is the only new exemption: a real reading under the firmware
  // threshold still warns, and 1mV is a reading, not the sentinel.
  assert.strictEqual(isLowBattery(1), true);
  assert.strictEqual(isLowBattery(3000), true);
});
