import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTag, pingText, buildChannelMessage, buildScopeFrame, scopeKeyName, buildGetChannel,
  buildSetChannel, parseChannelInfo, pickSlot, matchEcho, RESP_CODE_CHANNEL_INFO,
} from '../src/uplinkping.js';
import { channelKey, channelHash } from '../src/grptxt.js';
import { hexToBytes } from '../src/meshpacket.js';
import { ecb } from '@noble/ciphers/aes.js';

test('channel message frame: [3][0][idx][ts LE][text]', () => {
  const f = buildChannelMessage(4, 0x01020304, 'cdrx ab');
  assert.deepEqual(Array.from(f.slice(0, 7)), [3, 0, 4, 0x04, 0x03, 0x02, 0x01]);
  assert.equal(new TextDecoder().decode(f.slice(7)), 'cdrx ab');
});

test('scope frame sets a 16-byte key or resets with [54][0]', () => {
  const key = new Uint8Array(16).fill(7);
  const f = buildScopeFrame(key);
  assert.equal(f.length, 18);
  assert.deepEqual(Array.from(f.slice(0, 2)), [54, 0]);
  assert.deepEqual(Array.from(f.slice(2)), Array.from(key));
  assert.deepEqual(Array.from(buildScopeFrame(null)), [54, 0]);
});

test('scope names get a leading # like RegionMap does', () => {
  assert.equal(scopeKeyName('be'), '#be');
  assert.equal(scopeKeyName('#be'), '#be');
  assert.equal(scopeKeyName('  '), '');
});

test('tags are 8 hex characters and the ping text carries nothing else', () => {
  const t = makeTag();
  assert.match(t, /^[0-9a-f]{8}$/);
  assert.equal(pingText(t), 'cdrx ' + t);
});

test('get/set channel frames and CHANNEL_INFO parsing round-trip', () => {
  assert.deepEqual(Array.from(buildGetChannel(5)), [31, 5]);
  const key = new Uint8Array(16).map((_, i) => i + 1);
  const set = buildSetChannel(5, '#coredrive', key);
  assert.equal(set.length, 50);
  assert.deepEqual(Array.from(set.slice(0, 2)), [32, 5]);
  const info = new Uint8Array(50);
  info[0] = RESP_CODE_CHANNEL_INFO;
  info.set(set.slice(1), 1);
  const c = parseChannelInfo(info);
  assert.equal(c.idx, 5);
  assert.equal(c.name, '#coredrive');
  assert.deepEqual(Array.from(c.secret), Array.from(key));
  assert.equal(parseChannelInfo(new Uint8Array([18, 1])), null);
});

test('pickSlot reuses our slot, else takes the first empty one, never a foreign one', () => {
  const key = new Uint8Array(16).fill(9);
  const zero = new Uint8Array(16);
  const ch = (idx, name, secret) => ({ idx, name, secret });
  assert.deepEqual(pickSlot([ch(0, 'Public', key.map(() => 1)), ch(1, '', zero), ch(2, '#coredrive', key)], '#coredrive', key), { idx: 2, write: false });
  assert.deepEqual(pickSlot([ch(0, 'Public', key.map(() => 1)), ch(1, '', zero), ch(2, '', zero)], '#coredrive', key), { idx: 1, write: true });
  assert.equal(pickSlot([ch(0, '#coredrive', key.map(() => 2))], '#coredrive', key), null, 'same name, other key: not ours');
  assert.equal(pickSlot([ch(0, 'x', key)], '#coredrive', key), null, 'no free slot');
});

// buildEcho makes a GRP_TXT the way the firmware would, then wraps it in a flooded
// packet with the given 2-byte hops.
async function buildEcho(name, text, hops) {
  const key = await channelKey(name);
  const hb = await channelHash(key);
  const t = new TextEncoder().encode(text);
  const plain = new Uint8Array(Math.ceil((5 + t.length) / 16) * 16);
  plain.set([1, 2, 3, 4, 0], 0);
  plain.set(t, 5);
  const ct = ecb(key, { disablePadding: true }).encrypt(plain);
  const secret = new Uint8Array(32);
  secret.set(key);
  const hk = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hk, ct)).slice(0, 2);
  const hopBytes = hops.flatMap((h) => Array.from(hexToBytes(h)));
  return { key, hb, raw: new Uint8Array([(5 << 2) | 1, 0x40 | hops.length, ...hopBytes, hb, ...mac, ...ct]) };
}

test('matchEcho finds our tag and names the first and last hop', async () => {
  const { key, hb, raw } = await buildEcho('#coredrive', 'ON8AR mobile: cdrx 0a1b2c3d', ['c0cd', '1403']);
  const e = await matchEcho(raw, key, hb, '0a1b2c3d');
  assert.equal(e.firstHop, 'c0cd');
  assert.equal(e.lastHop, '1403');
  assert.equal(e.hops, 2);
  assert.match(e.hash, /^[0-9a-f]{16}$/);
});

test('matchEcho ignores another tag, another channel and an unforwarded packet', async () => {
  const a = await buildEcho('#coredrive', 'X: cdrx 0a1b2c3d', ['c0cd']);
  assert.equal(await matchEcho(a.raw, a.key, a.hb, 'ffffffff'), null, 'another ping');
  const b = await buildEcho('#other', 'X: cdrx 0a1b2c3d', ['c0cd']);
  assert.equal(await matchEcho(b.raw, a.key, a.hb, '0a1b2c3d'), null, 'other channel');
  const c = await buildEcho('#coredrive', 'X: cdrx 0a1b2c3d', []);
  assert.equal(await matchEcho(c.raw, c.key, c.hb, '0a1b2c3d'), null, 'no hops: not a re-broadcast');
});
