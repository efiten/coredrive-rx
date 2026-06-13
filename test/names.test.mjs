// resolveName must short-circuit (no network) when resolveUrl is unconfigured.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { setConfig } from '../src/config.js';
import { resolveName } from '../src/names.js';

test('resolveName returns "" and does not fetch when resolveUrl is empty', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: '' });
  let called = false;
  const orig = globalThis.fetch;
  globalThis.fetch = () => { called = true; throw new Error('should not fetch'); };
  try {
    const name = await resolveName('aabb');
    assert.strictEqual(name, '');
    assert.strictEqual(called, false);
  } finally {
    globalThis.fetch = orig;
  }
});
