// Drain robustness: a publish to a dead socket never acks, so publish() must time
// out (reject) instead of hanging forever — that hang is what froze the drain loop
// and left +60 receptions pending on a live WiFi connection.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { Publisher, KEEPALIVE_SECS } from '../src/publisher.js';

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

test('reconnect() asks the client to reconnect (manual recovery)', () => {
  const p = new Publisher({ url: 'x' });
  let called = false;
  p.client = { connected: false, reconnectTimer: 1, reconnect() { called = true; } };
  assert.strictEqual(p.reconnect(), true);
  assert.strictEqual(called, true);
});

test('reconnect() is a no-op when there is no client', () => {
  const p = new Publisher({ url: 'x' });
  assert.doesNotThrow(() => p.reconnect());
});

test('onStatus receives the event and its arg (e.g. error reason)', () => {
  const p = new Publisher({ url: 'x' });
  const seen = [];
  p.onStatus((ev, arg) => seen.push([ev, arg && arg.message]));
  p._emit('reconnect');
  p._emit('error', new Error('boom'));
  assert.deepStrictEqual(seen, [['reconnect', undefined], ['error', 'boom']]);
});

test('records without kind still go to /packets with the unchanged shape', () => {
  const rec = { rx_at: '2026-08-17T10:00:00.000Z', raw: 'aabb', snr: 4.5, rssi: -101, lat: 51.2, lon: 4.4, acc_m: 8 };
  assert.equal(Publisher.topicFor('aa11', rec), 'meshcore/client/aa11/packets');
  const p = Publisher.payloadFor('aa11', rec, 'node');
  assert.equal(p.type, 'PACKET');
  assert.equal(p.raw, 'aabb');
  assert.equal(p.gps.lat, 51.2);
});

test('kind rf goes to /rf with the RF_SAMPLE shape', () => {
  const rec = { kind: 'rf', at: '2026-08-17T10:00:00.000Z', lat: 51.2, lon: 4.4, acc_m: 8,
    stationary: true, uptime_secs: 84213, noise_floor: -119, rx_air_secs: 20877 };
  assert.equal(Publisher.topicFor('aa11', rec), 'meshcore/client/aa11/rf');
  const p = Publisher.payloadFor('aa11', rec, 'node');
  assert.equal(p.type, 'RF_SAMPLE');
  assert.equal(p.timestamp, '2026-08-17T10:00:00.000Z');
  assert.equal(p.stationary, true);
  assert.equal(p.noise_floor, -119);
  assert.equal(p.gps.lat, 51.2);
  assert.equal('recv_errors' in p, false, 'absent stays absent');
});

test('kind regions goes to /regions with the REGIONS shape', () => {
  const rec = { kind: 'regions', at: '2026-08-18T10:00:00.000Z', target: 'bb'.repeat(32),
    regions: ['*', 'be'], truncated: false, repeater_clock: 1755518096, lat: 51.2, lon: 4.4, acc_m: 8 };
  assert.equal(Publisher.topicFor('aa11', rec), 'meshcore/client/aa11/regions');
  const p = Publisher.payloadFor('aa11', rec, 'node');
  assert.equal(p.type, 'REGIONS');
  assert.deepEqual(p.regions, ['*', 'be']);
  assert.equal(p.target, rec.target);
  assert.equal(p.gps.lat, 51.2);
});

test('an rf record and a record with no kind are unaffected by the third branch', () => {
  assert.equal(Publisher.topicFor('aa11', { kind: 'rf', at: 't' }), 'meshcore/client/aa11/rf');
  assert.equal(Publisher.topicFor('aa11', { rx_at: 't', raw: 'aa' }), 'meshcore/client/aa11/packets');
});

test('an empty regions array survives the wire as [], not dropped or coerced', () => {
  const rec = { kind: 'regions', at: '2026-08-18T10:00:00.000Z', target: 'cc'.repeat(32),
    regions: [], truncated: false, repeater_clock: 1755518096, lat: null, lon: null, acc_m: null };
  const p = Publisher.payloadFor('aa11', rec, 'node');
  assert.deepEqual(p.regions, []);
});

test('truncated is carried faithfully, true and false alike', () => {
  const base = { kind: 'regions', at: 't', target: 'dd'.repeat(32), regions: ['*'],
    repeater_clock: 1, lat: null, lon: null, acc_m: null };
  assert.equal(Publisher.payloadFor('aa11', { ...base, truncated: true }, 'node').truncated, true);
  assert.equal(Publisher.payloadFor('aa11', { ...base, truncated: false }, 'node').truncated, false);
});

// --- publisher identity: attributing a status event to the client that raised it ---

test('each Publisher gets a distinct id so a stale client can be told apart', () => {
  const a = new Publisher({ url: 'wss://b/ws' });
  const b = new Publisher({ url: 'wss://b/ws' });
  assert.notStrictEqual(a.id, b.id);
  assert.ok(b.id > a.id, 'ids must be monotonic so "newer" is decidable');
});

test('status events carry the publisher id', () => {
  // A single module-level handler receives events from every instance ever made.
  // Without the id, an orphaned client's failures overwrote the live one's state.
  const p = new Publisher({ url: 'wss://b/ws' });
  const seen = [];
  p.onStatus((ev, arg, id) => seen.push([ev, arg, id]));
  p._emit('error', new Error('Keepalive timeout'));
  assert.strictEqual(seen[0][0], 'error');
  assert.strictEqual(seen[0][1].message, 'Keepalive timeout');
  assert.strictEqual(seen[0][2], p.id);
});

test('keepalive is stated explicitly, not inherited from mqtt.js', () => {
  assert.strictEqual(typeof KEEPALIVE_SECS, 'number');
  assert.ok(KEEPALIVE_SECS > 0);
});

// timerVariant: mqtt.js defaults to 'auto', which on a browser schedules the keepalive
// interval with worker-timers. That Worker is created on the FIRST connect and takes its
// time origin from the wall clock at that moment, while the page's
// performance.timeOrigin + performance.now() stops advancing while an Android device
// sleeps. A session left open overnight therefore handed the Worker a "now" hours in the
// past, every keepalive tick was already overdue, the Worker fired three of them back to
// back, and mqtt.js raised 'Keepalive timeout' in the same second as the CONNACK. Each
// reconnect re-armed the manager against the same skew and the Worker is a module
// singleton, so only a page reload ended the loop.
test('connect options pin the keepalive timer to native, not worker-timers', () => {
  const o = Publisher.connectOptions({ url: 'x', username: 'u', password: 'p', clientId: 'c' });
  assert.strictEqual(o.timerVariant, 'native');
});

test('connect options keep the credentials, client id, keepalive and reconnect period', () => {
  const o = Publisher.connectOptions({ url: 'x', username: 'u', password: 'p', clientId: 'c' });
  assert.strictEqual(o.username, 'u');
  assert.strictEqual(o.password, 'p');
  assert.strictEqual(o.clientId, 'c');
  assert.strictEqual(o.keepalive, KEEPALIVE_SECS);
  assert.strictEqual(o.reconnectPeriod, 4000);
  assert.strictEqual(o.clean, true);
});

// --- reconnect() against the real mqtt.js client ---
//
// mqtt.js connect() builds a new stream without closing the one it replaces. Calling
// client.reconnect() while a CONNECT is still unanswered therefore leaves the earlier
// socket open, and when that orphan later closes, its 'close' marks the whole client
// disconnected even though the newest socket holds a live session. Field log
// 2026-09-19: five "Push pending now" presses in four seconds during a slow connect,
// then "connected" followed by "offline" and "connection closed" in the same second,
// repeatedly. A fake stream stands in for the WebSocket so no network is touched.

const CONNACK_OK = Buffer.from([0x20, 0x02, 0x00, 0x00]);
const tick = () => new Promise((r) => setTimeout(r, 10));

async function realClient() {
  const { default: mqtt } = await import('mqtt');
  const { Duplex } = await import('node:stream');
  const streams = [];
  const build = () => {
    const s = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
    streams.push(s);
    return s;
  };
  const client = new mqtt.MqttClient(build, { ...Publisher.connectOptions({ clientId: 'c' }), connectTimeout: 60000 });
  client.on('error', () => {});
  await tick();
  return { client, streams };
}

test('reconnect() does not open a second socket while a connect is still unanswered', async (t) => {
  const { client, streams } = await realClient();
  t.after(() => { client.end(true); streams.forEach((s) => s.destroy()); });
  const p = new Publisher({ url: 'x' });
  p.client = client;
  assert.strictEqual(p.reconnect(), false);
  p.reconnect();
  p.reconnect();
  await tick();
  assert.strictEqual(streams.length, 1);
  streams[0].push(CONNACK_OK);
  await tick();
  assert.strictEqual(client.connected, true);
});

test('reconnect() still skips the wait between attempts once the socket has closed', async (t) => {
  const { client, streams } = await realClient();
  t.after(() => { client.end(true); streams.forEach((s) => s.destroy()); });
  const p = new Publisher({ url: 'x' });
  p.client = client;
  streams[0].destroy();
  await tick();
  assert.strictEqual(p.reconnect(), true);
  await tick();
  assert.strictEqual(streams.length, 2);
  assert.strictEqual(streams.filter((s) => !s.destroyed).length, 1);
});
