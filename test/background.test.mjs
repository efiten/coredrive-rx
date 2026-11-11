// A hidden page must not stamp receptions with a position from before it went to the
// background, and afterwards it says how long it was away and what was lost.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { usableFix, startSpell, endSpell, spellText, FIX_STALE_MS, BG_NOTICE_MIN_MS } from '../src/background.js';

const fix = (at) => ({ lat: 51, lon: 4, acc_m: 5, at });

test('a visible page uses any fix, a hidden one only a fresh fix', () => {
  const now = 10_000_000;
  const old = fix(now - FIX_STALE_MS - 1);
  assert.equal(usableFix(old, now, false), old);
  assert.equal(usableFix(old, now, true), null);
  const fresh = fix(now - FIX_STALE_MS);
  assert.equal(usableFix(fresh, now, true), fresh);
  assert.equal(usableFix(null, now, false), null);
  const noTime = { lat: 51, lon: 4, acc_m: 5 };
  assert.equal(usableFix(noTime, now, true), noTime);
});

test('a background spell is reported only when it lasted a minute or more', () => {
  const s = startSpell(0);
  s.saved = 2; s.skipped = 5;
  assert.equal(endSpell(s, BG_NOTICE_MIN_MS - 1), null);
  assert.deepStrictEqual(endSpell(s, 12 * 60000), { ms: 12 * 60000, saved: 2, skipped: 5 });
  assert.equal(endSpell(null, 99999999), null);
});

test('the notice says how long and what was not saved', () => {
  assert.equal(spellText({ ms: 12 * 60000, saved: 1, skipped: 34 }),
    'The app was in the background for 12 min: 1 reception saved, 34 receptions not saved because the browser paused GPS.'
    + ' Keep CoreDrive RX on screen while mapping. Tap to dismiss.');
  assert.equal(spellText({ ms: 90000, saved: 0, skipped: 0 }),
    'The app was in the background for 2 min: 0 receptions saved. Keep CoreDrive RX on screen while mapping. Tap to dismiss.');
});
