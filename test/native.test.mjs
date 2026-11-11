import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapacitorBleTransport } from '../src/transport-native.js';
import { NativeGps } from '../src/gps-native.js';
import { isNativeApp } from '../src/platform.js';
import { NUS_SERVICE, NUS_WRITE, NUS_NOTIFY } from '../src/transport.js';

function fakeBle() {
  const calls = [];
  const ble = {
    calls, onDisconnect: null, notify: null, enabled: true, writes: [],
    async initialize(o) { calls.push(['initialize', o]); },
    async isEnabled() { return ble.enabled; },
    async requestEnable() { calls.push(['requestEnable']); ble.enabled = true; },
    async requestDevice(o) { calls.push(['requestDevice', o]); return { deviceId: 'AA:BB' }; },
    async connect(id, onDisconnect) { calls.push(['connect', id]); ble.onDisconnect = onDisconnect; },
    async startNotifications(id, svc, ch, cb) { calls.push(['notify', id, svc, ch]); ble.notify = cb; },
    async write(id, svc, ch, dv) {
      calls.push(['write', id, svc, ch]);
      ble.writes.push(Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)));
    },
    async disconnect(id) { calls.push(['disconnect', id]); },
  };
  return ble;
}

test('connect asks for the NUS service, connects and subscribes to the notify characteristic', async () => {
  const ble = fakeBle();
  const t = new CapacitorBleTransport(ble);
  await t.connect();
  assert.deepEqual(ble.calls[0], ['initialize', { androidNeverForLocation: true }]);
  assert.deepEqual(ble.calls.find((c) => c[0] === 'requestDevice'), ['requestDevice', { services: [NUS_SERVICE] }]);
  assert.deepEqual(ble.calls.find((c) => c[0] === 'notify'), ['notify', 'AA:BB', NUS_SERVICE, NUS_NOTIFY]);
  assert.equal(t.connected(), true);
  assert.equal(t.isConnected(), true);
});

test('Bluetooth switched off: the user is asked to enable it first', async () => {
  const ble = fakeBle();
  ble.enabled = false;
  await new CapacitorBleTransport(ble).connect();
  assert.ok(ble.calls.some((c) => c[0] === 'requestEnable'));
});

test('frames from the notify characteristic reach every listener as a DataView', async () => {
  const ble = fakeBle();
  const t = new CapacitorBleTransport(ble);
  const got = [];
  const a = (dv) => got.push(['a', dv.getUint8(0)]);
  t.onFrame(a);
  t.onFrame((dv) => got.push(['b', dv.getUint8(0)]));
  await t.connect();
  ble.notify(new DataView(new Uint8Array([0x88, 1]).buffer));
  t.offFrame(a);
  ble.notify(new DataView(new Uint8Array([0x83]).buffer));
  assert.deepEqual(got, [['a', 0x88], ['b', 0x88], ['b', 0x83]]);
});

test('send writes the whole frame to the write characteristic, one at a time', async () => {
  const ble = fakeBle();
  let release;
  const gate = new Promise((r) => { release = r; });
  const order = [];
  const write = ble.write;
  ble.write = async (...args) => { order.push('start'); if (order.length === 1) await gate; await write(...args); order.push('end'); };
  const t = new CapacitorBleTransport(ble);
  await t.connect();
  const sub = new Uint8Array([9, 1, 2, 3]).subarray(1); // a view, not the whole buffer
  const p1 = t.send(new Uint8Array([7, 8]));
  const p2 = t.send(sub);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, ['start'], 'second write waits for the first');
  release();
  await Promise.all([p1, p2]);
  assert.deepEqual(ble.writes, [[7, 8], [1, 2, 3]]);
  assert.ok(ble.calls.filter((c) => c[0] === 'write').every((c) => c[3] === NUS_WRITE));
});

test('send before connect rejects', async () => {
  await assert.rejects(new CapacitorBleTransport(fakeBle()).send(new Uint8Array([1])), /not connected/);
});

test('a dropped link reconnects and reports reconnecting, then connected', async () => {
  const ble = fakeBle();
  const t = new CapacitorBleTransport(ble, { firstDelayMs: 1 });
  const status = [];
  t.onStatus((s) => status.push(s));
  await t.connect();
  ble.onDisconnect('AA:BB');
  assert.equal(t.connected(), false);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(status, ['reconnecting', 'connected']);
  assert.equal(t.connected(), true);
  assert.equal(ble.calls.filter((c) => c[0] === 'connect').length, 2);
});

test('a user disconnect does not reconnect', async () => {
  const ble = fakeBle();
  const t = new CapacitorBleTransport(ble, { firstDelayMs: 1 });
  await t.connect();
  await t.disconnect();
  ble.onDisconnect('AA:BB');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ble.calls.filter((c) => c[0] === 'connect').length, 1);
  assert.equal(t.connected(), false);
});

test('native GPS starts a background watcher and keeps the latest fix', async () => {
  let opts, cb, removed = null;
  const plugin = {
    async addWatcher(o, c) { opts = o; cb = c; return 'w1'; },
    async removeWatcher(o) { removed = o; },
  };
  const g = new NativeGps(plugin);
  const fixes = [];
  await g.start((f) => fixes.push(f));
  assert.equal(opts.requestPermissions, true);
  assert.equal(opts.stale, false);
  assert.ok(opts.backgroundMessage, 'a background message turns on the foreground service');
  assert.equal(g.latest(), null);
  cb({ latitude: 50.9, longitude: 4.7, accuracy: 8 });
  cb(undefined, Object.assign(new Error('denied'), { code: 'NOT_AUTHORIZED' }));
  const { at, ...pos } = g.latest();
  assert.deepEqual(pos, { lat: 50.9, lon: 4.7, acc_m: 8 });
  assert.ok(Math.abs(Date.now() - at) < 1000, 'the fix carries when it arrived');
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0], g.latest());
  g.stop();
  await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(removed, { id: 'w1' });
});

test('native GPS asks for notifications before the foreground service starts', async () => {
  const order = [];
  const plugin = { async addWatcher() { order.push('watch'); return 'w1'; }, async removeWatcher() {} };
  const notifications = { async requestPermissions() { order.push('notify'); return { display: 'granted' }; } };
  await new NativeGps(plugin, notifications).start();
  assert.deepEqual(order, ['notify', 'watch']);
});

test('native GPS still starts when the notification request fails', async () => {
  let started = false;
  const plugin = { async addWatcher() { started = true; return 'w1'; }, async removeWatcher() {} };
  const notifications = { async requestPermissions() { throw new Error('denied'); } };
  await new NativeGps(plugin, notifications).start();
  assert.equal(started, true);
});

test('isNativeApp follows Capacitor.isNativePlatform', () => {
  assert.equal(isNativeApp({ isNativePlatform: () => true }), true);
  assert.equal(isNativeApp({ isNativePlatform: () => false }), false);
  assert.equal(isNativeApp(undefined), false);
});
