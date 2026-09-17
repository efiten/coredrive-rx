// test/storage.test.mjs
// The beta build lives on the same origin as production (/beta vs /), so the
// IndexedDB name and the localStorage keys must differ per build or the two
// share one queue. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { storageNs, dbName, prefKey, themeKey, __setNs } from '../src/storage.js';

test('no namespace keeps the production names byte for byte', () => {
  __setNs('');
  assert.strictEqual(storageNs(), '');
  assert.strictEqual(dbName('coredrive-rx'), 'coredrive-rx');
  assert.strictEqual(prefKey('sound'), 'coredrive.sound');
  assert.strictEqual(prefKey('contactPathRestore'), 'coredrive.contactPathRestore');
});

test('a namespace suffixes the db and the key prefix', () => {
  __setNs('-beta');
  assert.strictEqual(dbName('coredrive-rx'), 'coredrive-rx-beta');
  assert.strictEqual(prefKey('sound'), 'coredrive-beta.sound');
});

test('an unset build constant falls back to production names', () => {
  __setNs(undefined);
  assert.strictEqual(storageNs(), '');
  assert.strictEqual(dbName('coredrive-rx'), 'coredrive-rx');
});

test('the theme key is never namespaced, so index.html can paint before any module loads', () => {
  __setNs('-beta');
  assert.strictEqual(themeKey(), 'coredrive.theme');
  __setNs('');
  assert.strictEqual(themeKey(), 'coredrive.theme');
});
