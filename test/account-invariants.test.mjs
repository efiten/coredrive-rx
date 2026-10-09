// The two invariants of the CoreScope login feature, end to end through drainOnce and
// the real Publisher payload builders:
//   1. The MQTT topic and payload are byte-for-byte identical whether a user is logged
//      in or not (the payload is a contract with CoreScope's ingestor).
//   2. Publishing never waits on the account, unless CoreScope requires linked
//      companions — then it holds, and never drops.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { Publisher } from '../src/publisher.js';
import { drainOnce } from '../src/drain.js';
import { createAccount, TOKEN_KEY } from '../src/account.js';

const ORIGIN = 'https://corescope.example';
const PK = 'ab'.repeat(32);
const ROWS = [
  { id: 1, rx_at: '2026-10-08T10:00:00.000Z', raw: 'aabb', snr: 5.25, rssi: -90, lat: 51.1, lon: 4.4, acc_m: 6 },
  { id: 2, kind: 'rf', at: '2026-10-08T10:00:01.000Z', lat: 51.1, lon: 4.4, acc_m: 6, stationary: false, noise_floor: -110 },
  { id: 3, kind: 'regions', at: '2026-10-08T10:00:02.000Z', target: 'cd'.repeat(32), regions: ['be'], truncated: false, repeater_clock: 1, lat: 51.1, lon: 4.4, acc_m: 6 },
];

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const res = (status, json) => ({ status, ok: status === 200, json: async () => json, headers: { get: () => null } });

// The real Publisher with a fake mqtt client that records the exact bytes it is handed.
function capturingPublisher() {
  const p = new Publisher({ url: 'wss://broker.example/ws' });
  const wire = [];
  p.client = { connected: true, publish(topic, payload, opts, cb) { wire.push({ topic, payload, qos: opts.qos }); cb(null); } };
  // A short publish timeout so the test's event loop is not held open by 8 s timers.
  return { publisher: { connected: () => p.connected(), publish: (pk, rec, name) => p.publish(pk, rec, name, 50) }, wire };
}

function queueOf(rows) {
  let left = rows.map((r) => ({ ...r }));
  return { async takeAll() { return left.slice(); }, async remove(ids) { left = left.filter((r) => !ids.includes(r.id)); }, remaining: () => left.map((r) => r.id) };
}

async function accountWith({ requireLinked = false, loggedIn = false, linked = false }) {
  const storage = memStorage(loggedIn ? {
    [TOKEN_KEY]: JSON.stringify({ origin: ORIGIN, token: 'tok-secret-123', displayName: 'Erwin Account', companions: linked ? [{ pubkey: PK, name: 'obs' }] : [] }),
  } : {});
  const fetch = async () => res(200, { userManagement: { enabled: true }, ...(requireLinked ? { clientRxRequireLinkedCompanion: true } : {}) });
  const account = createAccount({ baseUrl: ORIGIN, fetch, storage });
  await account.discover();
  return account;
}

async function drainWith(account) {
  const { publisher, wire } = capturingPublisher();
  const queue = queueOf(ROWS);
  const r = await drainOnce({ queue, publisher, pubkey: PK, name: 'obs', failures: new Map(), hold: () => account.shouldHold(PK) });
  return { wire, r, queue };
}

test('the MQTT topic and payload bytes are identical whether or not a user is logged in', async () => {
  const out = await drainWith(await accountWith({ loggedIn: false }));
  const inn = await drainWith(await accountWith({ loggedIn: true, linked: true }));
  assert.strictEqual(out.wire.length, 3);
  assert.deepStrictEqual(inn.wire, out.wire);
});

test('the payload carries nothing from the account: no token, no display name', async () => {
  const { wire } = await drainWith(await accountWith({ loggedIn: true, linked: true }));
  for (const w of wire) {
    assert.ok(!w.payload.includes('tok-secret-123'));
    assert.ok(!w.payload.includes('Erwin Account'));
  }
});

test('flag off: drain publishes regardless of login state', async () => {
  for (const a of [await accountWith({ loggedIn: false }), await accountWith({ loggedIn: true, linked: false })]) {
    const { r, queue } = await drainWith(a);
    assert.strictEqual(r.published, 3);
    assert.deepStrictEqual(queue.remaining(), []);
  }
});

test('flag on and the companion unlinked: nothing is published and the queue is untouched', async () => {
  for (const a of [await accountWith({ requireLinked: true, loggedIn: false }), await accountWith({ requireLinked: true, loggedIn: true, linked: false })]) {
    const { r, wire, queue } = await drainWith(a);
    assert.strictEqual(r.stopped, 'held');
    assert.strictEqual(wire.length, 0);
    assert.deepStrictEqual(queue.remaining(), [1, 2, 3]);
  }
});

test('flag on and the companion linked: everything is published', async () => {
  const { r, queue } = await drainWith(await accountWith({ requireLinked: true, loggedIn: true, linked: true }));
  assert.strictEqual(r.published, 3);
  assert.deepStrictEqual(queue.remaining(), []);
});
