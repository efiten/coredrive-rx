// Pure merge logic for the "recently heard nodes" list. A node can arrive under
// several heard-key representations (2-byte path hash vs full pubkey); since the
// hash is a prefix of the pubkey they must collapse into one row.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { sameNode, upsertHeard } from '../src/recent.js';

test('sameNode matches a prefix relationship, case-insensitive', () => {
  assert.strictEqual(sameNode('aabb', 'AABBCCDD'), true); // 2-byte hash is a prefix of the pubkey
  assert.strictEqual(sameNode('aabbccdd', 'aabb'), true);
  assert.strictEqual(sameNode('aabb', 'aabb'), true);
  assert.strictEqual(sameNode('aabb', 'aacc'), false);
});

test('repeat of the same key increments count, keeps one row', () => {
  let list = [];
  list = upsertHeard(list, { key: 'aabb', keylen: 2, snr: -5, rssi: -90, src: 'rxlog', now: 1 }, 20);
  list = upsertHeard(list, { key: 'aabb', keylen: 2, snr: -3, rssi: -88, src: 'rxlog', now: 2 }, 20);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].count, 2);
  assert.strictEqual(list[0].snr, -3);  // newest reception
  assert.strictEqual(list[0].last, 2);
});

test('hash then full pubkey for the same node collapse to one row, longest key wins', () => {
  let list = [];
  list = upsertHeard(list, { key: 'aabb', keylen: 2, snr: -5, rssi: -90, src: 'rxlog', now: 1 }, 20);
  list = upsertHeard(list, { key: 'aabbccddeeff', keylen: 6, snr: 4, rssi: -70, src: 'advert', now: 2 }, 20);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].key, 'aabbccddeeff'); // most-specific identity kept
  assert.strictEqual(list[0].keylen, 6);
  assert.strictEqual(list[0].count, 2);            // counts summed across representations
  assert.strictEqual(list[0].snr, 4);              // newest reception
});

test('two pre-existing prefix-related rows collapse on the next heard', () => {
  let list = [
    { key: 'aabb', keylen: 2, count: 3, snr: -5, rssi: -90, src: 'rxlog', last: 1 },
    { key: 'aabbccdd', keylen: 4, count: 2, snr: 0, rssi: -80, src: 'advert', last: 2 },
  ];
  list = upsertHeard(list, { key: 'aabb', keylen: 2, snr: 1, rssi: -75, src: 'rxlog', now: 3 }, 20);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].key, 'aabbccdd');
  assert.strictEqual(list[0].count, 6); // 3 + 2 + 1
});

test('genuinely different nodes stay as separate rows, most-recent first', () => {
  let list = [];
  list = upsertHeard(list, { key: 'aabb', keylen: 2, snr: -5, rssi: -90, src: 'rxlog', now: 1 }, 20);
  list = upsertHeard(list, { key: 'ccdd', keylen: 2, snr: -2, rssi: -85, src: 'rxlog', now: 2 }, 20);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].key, 'ccdd'); // newest at front
  assert.strictEqual(list[1].key, 'aabb');
});

test('respects the max cap', () => {
  let list = [];
  for (let i = 0; i < 25; i++) {
    const k = (0x1000 + i).toString(16); // distinct 2-byte keys, no prefix overlap
    list = upsertHeard(list, { key: k, keylen: 2, snr: 0, rssi: -80, src: 'rxlog', now: i }, 20);
  }
  assert.strictEqual(list.length, 20);
});
