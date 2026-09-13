import test from 'node:test';
import assert from 'node:assert/strict';
import { WebBluetoothTransport } from '../src/transport.js';

// A writeChar stub that records overlap: Web Bluetooth rejects a second write
// started before the first settles, so the bug this guards is two sends issued
// in the same tick (the discover sweep and region discovery share one).
function fakeChar() {
  const c = { inFlight: 0, maxInFlight: 0, order: [], resolvers: [] };
  c.writeValue = (bytes) => {
    c.inFlight++;
    c.maxInFlight = Math.max(c.maxInFlight, c.inFlight);
    c.order.push(bytes[0]);
    return new Promise((res) => c.resolvers.push(() => { c.inFlight--; res(); }));
  };
  return c;
}

test('two sends issued in the same tick never overlap on the GATT characteristic', async () => {
  const t = new WebBluetoothTransport();
  const c = fakeChar();
  t.writeChar = c;

  const a = t.send(new Uint8Array([1]));
  const b = t.send(new Uint8Array([2]));

  // Writes are chained, so the first starts a microtask later rather than
  // synchronously; drain the queue before inspecting what actually began.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(c.maxInFlight, 1, 'the second write must not start before the first settles');
  assert.deepEqual(c.order, [1], 'only the first write has been issued');
  c.resolvers.shift()();
  await a;
  await Promise.resolve();
  assert.deepEqual(c.order, [1, 2], 'the second write starts once the first has settled');
  c.resolvers.shift()();
  await b;
  assert.equal(c.maxInFlight, 1);
});

test('a failed send rejects for its own caller without poisoning later sends', async () => {
  const t = new WebBluetoothTransport();
  let calls = 0;
  t.writeChar = { writeValue: () => { calls++; return calls === 1 ? Promise.reject(new Error('GATT busy')) : Promise.resolve(); } };

  await assert.rejects(t.send(new Uint8Array([1])), /GATT busy/);
  await t.send(new Uint8Array([2])); // must still go through
  assert.equal(calls, 2);
});

test('send rejects when not connected', async () => {
  const t = new WebBluetoothTransport();
  await assert.rejects(t.send(new Uint8Array([1])), /not connected/);
});

// connected() is read straight off the browser's device object rather than mirrored
// into a flag: the link drops without warning, and a stale copy is what sends writes
// into a dead characteristic.
test('connected() reports the live GATT state, and false before there is a device', () => {
  const t = new WebBluetoothTransport();
  assert.equal(t.connected(), false, 'no device yet');
  t.device = { gatt: { connected: true } };
  assert.equal(t.connected(), true);
  t.device.gatt.connected = false;
  assert.equal(t.connected(), false);
  t.device = { };
  assert.equal(t.connected(), false, 'a device with no gatt is not connected');
});
