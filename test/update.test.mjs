// test/update.test.mjs
// Update-check helpers, copied unchanged from core-hunter (vitest -> node:test).
// Every case ported as-is: this module is pure version-string arithmetic and
// carries no app-specific behaviour.
import { test } from 'node:test';
import assert from 'node:assert';
import { parseVersion, compareVersions, isUpdateAvailable } from '../src/ui/update.js';

test('parseVersion reads the version out of the version.json payload', () => {
  assert.strictEqual(parseVersion('{"version":"0.13.0"}'), '0.13.0');
});

test('parseVersion returns null for malformed JSON', () => {
  assert.strictEqual(parseVersion('not json'), null);
  assert.strictEqual(parseVersion(''), null);
});

test('parseVersion returns null when there is no usable version field', () => {
  assert.strictEqual(parseVersion('{"version":""}'), null);
  assert.strictEqual(parseVersion('{"version":123}'), null);
  assert.strictEqual(parseVersion('{}'), null);
});

test('compareVersions orders by major, then minor, then patch', () => {
  assert.strictEqual(compareVersions('1.0.0', '0.9.9'), 1);
  assert.strictEqual(compareVersions('0.13.0', '0.12.9'), 1);
  assert.strictEqual(compareVersions('0.12.1', '0.12.0'), 1);
  assert.strictEqual(compareVersions('0.12.0', '0.12.1'), -1);
  assert.strictEqual(compareVersions('0.12.0', '0.12.0'), 0);
});

test('compareVersions treats missing trailing components as zero', () => {
  assert.strictEqual(compareVersions('1.2', '1.2.0'), 0);
  assert.strictEqual(compareVersions('1.2.1', '1.2'), 1);
});

test('isUpdateAvailable is true only when latest is strictly newer than current', () => {
  assert.strictEqual(isUpdateAvailable('0.12.0', '0.13.0'), true);
  assert.strictEqual(isUpdateAvailable('0.12.0', '0.12.0'), false);
});

test('isUpdateAvailable never nags on a null/blank or older latest (stale/failed fetch)', () => {
  assert.strictEqual(isUpdateAvailable('0.12.0', null), false);
  assert.strictEqual(isUpdateAvailable('0.12.0', ''), false);
  assert.strictEqual(isUpdateAvailable('0.12.0', '0.11.0'), false);
});
