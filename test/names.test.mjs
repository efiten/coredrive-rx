// resolveName must short-circuit (no network) when resolveUrl is unconfigured.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { setConfig } from '../src/config.js';
import { resolveName, resolvePubkey, pickForwarder, isPathHash } from '../src/names.js';

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

test('resolvePubkey returns "" and does not fetch when resolveUrl is empty', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: '' });
  let called = false;
  const orig = globalThis.fetch;
  globalThis.fetch = () => { called = true; throw new Error('should not fetch'); };
  try {
    const pk = await resolvePubkey('aabbccdd11223344');
    assert.strictEqual(pk, '');
    assert.strictEqual(called, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolvePubkey returns an already-full 64-hex key unchanged, with no request', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: 'https://x/resolve' });
  let called = false;
  const orig = globalThis.fetch;
  globalThis.fetch = () => { called = true; throw new Error('should not fetch'); };
  try {
    const full = 'ab'.repeat(32);
    const pk = await resolvePubkey(full.toUpperCase());
    assert.strictEqual(pk, full);
    assert.strictEqual(called, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolvePubkey returns the full pubkey on an unambiguous match', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: 'https://x/resolve' });
  const orig = globalThis.fetch;
  const full = 'ef'.repeat(32);
  globalThis.fetch = async () => ({
    ok: true, json: async () => ({ prefix: 'efef7943', pubkey: full, name: 'BE-BRE-ON8AR', ambiguous: false }),
  });
  try {
    const pk = await resolvePubkey('efef7943');
    assert.strictEqual(pk, full);
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolvePubkey returns "" when the prefix is ambiguous', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: 'https://x/resolve' });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, json: async () => ({ prefix: 'aa', pubkey: 'aa'.repeat(32), name: '', ambiguous: true }),
  });
  try {
    const pk = await resolvePubkey('aa');
    assert.strictEqual(pk, '');
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolvePubkey returns "" when the prefix is unknown (no pubkey field)', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: 'https://x/resolve' });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ prefix: 'zz112233', ambiguous: false }) });
  try {
    const pk = await resolvePubkey('zz112233');
    assert.strictEqual(pk, '');
  } finally {
    globalThis.fetch = orig;
  }
});

test('resolvePubkey does not cache a network error — a later call retries', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: 'https://x/resolve' });
  const orig = globalThis.fetch;
  const full = 'cd'.repeat(32);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new Error('network down');
    return { ok: true, json: async () => ({ pubkey: full, ambiguous: false }) };
  };
  try {
    const first = await resolvePubkey('cdcd1122');
    assert.strictEqual(first, '');
    const second = await resolvePubkey('cdcd1122');
    assert.strictEqual(second, full);
    assert.strictEqual(calls, 2);
  } finally {
    globalThis.fetch = orig;
  }
});

// The 2026-10-16 field case: e470 is BE-HSS-HVZZWL-DIS (repeater) and Aegis (companion).
const REPEATER = { public_key: 'e470a7fd' + '00'.repeat(28), name: 'BE-HSS-HVZZWL-DIS', role: 'repeater' };
const COMPANION = { public_key: 'e470aa9f' + '00'.repeat(28), name: 'Aegis', role: 'companion' };

function mockResolveAndSearch(nodes) {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (url.startsWith('https://x/resolve')) return { ok: true, json: async () => ({ ambiguous: true }) };
    return { ok: true, json: async () => ({ nodes }) };
  };
  return urls;
}

test('an ambiguous path hash resolves to its one forwarder when the other match is a companion', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: 'https://x/resolve', searchUrl: 'https://x/search' });
  const orig = globalThis.fetch;
  const urls = mockResolveAndSearch([COMPANION, REPEATER]);
  try {
    assert.strictEqual(await resolveName('E470'), 'BE-HSS-HVZZWL-DIS');
    assert.strictEqual(await resolvePubkey('e470'), REPEATER.public_key);
    assert.deepStrictEqual(urls, ['https://x/resolve?prefix=e470', 'https://x/search?q=e470']); // one lookup, cached
  } finally {
    globalThis.fetch = orig;
  }
});

test('an ambiguous discover key (8 bytes) is not narrowed by role: any node can answer a discover', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: 'https://x/resolve', searchUrl: 'https://x/search' });
  const orig = globalThis.fetch;
  const urls = mockResolveAndSearch([REPEATER]);
  try {
    assert.strictEqual(await resolvePubkey('e470a7fd00000000'), '');
    assert.strictEqual(urls.length, 1);
  } finally {
    globalThis.fetch = orig;
  }
});

test('without searchUrl an ambiguous path hash stays unresolved', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: 'https://x/resolve', searchUrl: '' });
  const orig = globalThis.fetch;
  const urls = mockResolveAndSearch([REPEATER]);
  try {
    assert.strictEqual(await resolveName('e471'), '');
    assert.strictEqual(urls.length, 1);
  } finally {
    globalThis.fetch = orig;
  }
});

test('pickForwarder: two forwarders, a name-only match, and a full page', () => {
  const room = { public_key: 'e470bb' + '00'.repeat(29), name: 'Room', role: 'room' };
  assert.strictEqual(pickForwarder([REPEATER, room], 'e470').pubkey, '');
  assert.strictEqual(pickForwarder([COMPANION, room], 'e470').name, 'Room');
  // matched on its name, not its pubkey
  const byName = { public_key: 'ffff' + '00'.repeat(30), name: 'node-e470', role: 'repeater' };
  assert.strictEqual(pickForwarder([COMPANION, byName], 'e470').pubkey, '');
  // a full page may have cut off a second forwarder, so it decides nothing
  const page = [REPEATER, ...Array.from({ length: 9 }, () => COMPANION)];
  assert.strictEqual(pickForwarder(page, 'e470').pubkey, '');
  assert.strictEqual(pickForwarder(undefined, 'e470').pubkey, '');
});

test('isPathHash: up to 4 bytes is a path hop, 8 and 32 are node keys', () => {
  assert.strictEqual(isPathHash('e470'), true);
  assert.strictEqual(isPathHash('e470a7fd'), true);
  assert.strictEqual(isPathHash('e470a7fd67fae706'), false);
});
