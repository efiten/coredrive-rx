// The battery tip shows once, only in the Android app, and never blocks Connect when
// storage is unavailable.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { needsBatteryTip, markBatteryTipSeen, BATTERY_TIP_KEY } from '../src/batterytip.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test('the tip shows in the Android app until it has been seen once', () => {
  const s = mem();
  assert.equal(needsBatteryTip(s, true), true);
  markBatteryTipSeen(s);
  assert.equal(s.getItem(BATTERY_TIP_KEY), '1');
  assert.equal(needsBatteryTip(s, true), false);
});

test('the web app never shows the tip', () => {
  assert.equal(needsBatteryTip(mem(), false), false);
});

test('storage that throws skips the tip instead of blocking Connect', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(needsBatteryTip(broken, true), false);
  assert.doesNotThrow(() => markBatteryTipSeen(broken));
});
