// test/theme.test.mjs
// Copied with theme.js from core-hunter (its own vitest test, ported to
// node:test). The inline boot script in index.html must resolve the same way
// this does, or a stored light theme flashes dark on every load.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { THEME_PREFS, resolveTheme, nextThemePref } from '../src/ui/theme.js';

test('an explicit preference wins over the device', () => {
  assert.strictEqual(resolveTheme('light', true), 'light');
  assert.strictEqual(resolveTheme('dark', false), 'dark');
});

test('no preference follows the device, and unknown means dark', () => {
  assert.strictEqual(resolveTheme('system', false), 'light');
  assert.strictEqual(resolveTheme('system', true), 'dark');
  assert.strictEqual(resolveTheme(null, undefined), 'dark');
  assert.strictEqual(resolveTheme('bogus', undefined), 'dark');
});

test('the cycle is system -> dark -> light -> system, total for junk', () => {
  assert.deepStrictEqual(THEME_PREFS, ['system', 'dark', 'light']);
  assert.strictEqual(nextThemePref('system'), 'dark');
  assert.strictEqual(nextThemePref('light'), 'system');
  assert.strictEqual(nextThemePref('junk'), 'system');
});

test("index.html's boot script agrees with resolveTheme", () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const m = html.match(/localStorage\.getItem\('([^']+)'\)/);
  assert.ok(m, 'boot script must read the theme preference from localStorage');
  for (const [pref, prefersDark] of [['light', true], ['dark', false], ['system', true], ['system', false]]) {
    const painted = pref === 'dark' || pref === 'light' ? pref : (prefersDark === false ? 'light' : 'dark');
    assert.strictEqual(painted, resolveTheme(pref, prefersDark));
  }
});
