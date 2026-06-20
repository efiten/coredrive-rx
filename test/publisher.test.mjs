// Drain robustness: a publish to a dead socket never acks, so publish() must time
// out (reject) instead of hanging forever — that hang is what froze the drain loop
// and left +60 receptions pending on a live WiFi connection.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { Publisher } from '../src/publisher.js';

const rec = { rx_at: 't', raw: 'aa', snr: 1, rssi: -90, lat: 0, lon: 0, acc_m: 5 };

test('publish rejects when the broker never acks (dead socket)', async () => {
  const p = new Publisher({ url: 'x' });
  p.client = { publish() { /* never invokes the callback — simulates a dead socket */ } };
  await assert.rejects(p.publish('pk', rec, 'name', 50), /publish timeout/);
});

test('publish resolves on a normal ack', async () => {
  const p = new Publisher({ url: 'x' });
  p.client = { publish(_t, _pl, _o, cb) { cb(null); } };
  await assert.doesNotReject(p.publish('pk', rec, 'name', 1000));
});

test('publish rejects on a broker error', async () => {
  const p = new Publisher({ url: 'x' });
  p.client = { publish(_t, _pl, _o, cb) { cb(new Error('nope')); } };
  await assert.rejects(p.publish('pk', rec, 'name', 1000), /nope/);
});
