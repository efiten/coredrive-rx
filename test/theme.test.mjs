// test/theme.test.mjs
// Copied with theme.js from core-hunter (its own vitest test, ported to
// node:test). The inline boot script in index.html must resolve the same way
// this does, or a stored light theme flashes dark on every load.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { THEME_PREFS, resolveTheme, nextThemePref } from '../src/ui/theme.js';
import { themeKey } from '../src/storage.js';

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

// The boot script actually runs here (in a node:vm sandbox), the same way
// test/sw.test.mjs runs the real public/sw.js — a hand-typed copy of the
// ternary would pass even if the shipped script's branching were wrong.
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extractBootScript(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  return scripts.find((s) => s.includes('dataset.theme'));
}

// runBootScript executes the extracted script in a fresh sandbox and returns
// the theme it painted. `stored` is what localStorage.getItem returns (or, if
// `throwing` is set, getItem throws instead and `stored`/`key` are unused).
function runBootScript(body, { stored, prefersDark, throwing = false, seenKeys } = {}) {
  const dataset = {};
  const sandbox = {
    localStorage: {
      getItem(key) {
        if (seenKeys) seenKeys.push(key);
        if (throwing) throw new Error('blocked (e.g. private browsing)');
        return stored;
      },
    },
    matchMedia: () => ({ matches: prefersDark }),
    document: { documentElement: { dataset } },
  };
  vm.runInNewContext(body, sandbox);
  return dataset.theme;
}

test("index.html's boot script agrees with resolveTheme", () => {
  const body = extractBootScript(HTML);
  assert.ok(body, 'index.html must have an inline script that sets dataset.theme');

  const seenKeys = [];
  for (const stored of ['dark', 'light', 'system', null, 'bogus']) {
    for (const prefersDark of [true, false]) {
      const painted = runBootScript(body, { stored, prefersDark, seenKeys });
      assert.strictEqual(painted, resolveTheme(stored, prefersDark),
        `stored=${stored} prefersDark=${prefersDark}`);
    }
  }
  // Reads exactly the un-namespaced key themeKey() returns — the same string
  // on every build, deliberately, because this script runs before Vite's
  // define reaches anything (see src/storage.js).
  assert.ok(seenKeys.length > 0);
  for (const key of seenKeys) assert.strictEqual(key, themeKey());
});

test("index.html's boot script swallows a throwing localStorage instead of crashing", () => {
  const body = extractBootScript(HTML);
  assert.ok(body, 'index.html must have an inline script that sets dataset.theme');
  const painted = runBootScript(body, { throwing: true, prefersDark: true });
  assert.strictEqual(painted, undefined, 'a blocked localStorage must leave the theme unset, not throw');
});
