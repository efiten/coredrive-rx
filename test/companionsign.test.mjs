// The companion signs a CoreScope challenge with its own Ed25519 key. Layouts are the
// firmware's (MeshCore examples/companion_radio/MyMesh.cpp, CMD_SIGN_*); the fake
// transport below has the same onFrame/offFrame/send surface as WebBluetoothTransport.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import {
  CMD_SIGN_START, CMD_SIGN_DATA, CMD_SIGN_FINISH, RESP_CODE_OK, RESP_CODE_ERR,
  RESP_CODE_SIGN_START, RESP_CODE_SIGNATURE, ERR_CODE_UNSUPPORTED_CMD, SIGN_CHUNK,
  signDataFrames, parseSignStart, parseSignature, signWithCompanion, SignUnsupportedError,
} from '../src/companionsign.js';

const le32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const SIG = Array.from({ length: 64 }, (_, i) => i + 1);
const bytes = (n) => Uint8Array.from({ length: n }, (_, i) => i & 0xff);

// fakeTransport: `reply(frame)` returns the frames the companion answers with. They
// are delivered after the write settles, as a real notification would be.
function fakeTransport(reply) {
  const t = {
    listeners: [],
    sent: [],
    onFrame(cb) { t.listeners.push(cb); },
    offFrame(cb) { t.listeners = t.listeners.filter((f) => f !== cb); },
    async send(frame) {
      const copy = Uint8Array.from(frame);
      t.sent.push(copy);
      const out = reply(copy) || [];
      setImmediate(() => out.forEach((f) => t.emit(f)));
    },
    emit(arr) {
      const u = Uint8Array.from(arr);
      t.listeners.slice().forEach((cb) => cb(new DataView(u.buffer)));
    },
  };
  return t;
}

// firmware answers the way handleCmdFrame does; each step can be overridden.
function firmware({ maxLen = 8192, onStart, onData, onFinish } = {}) {
  const got = [];
  const reply = (f) => {
    if (f[0] === CMD_SIGN_START) return onStart ? onStart(f) : [[RESP_CODE_SIGN_START, 0, ...le32(maxLen)]];
    if (f[0] === CMD_SIGN_DATA) { got.push(...f.slice(1)); return onData ? onData(f) : [[RESP_CODE_OK]]; }
    if (f[0] === CMD_SIGN_FINISH) return onFinish ? onFinish(f) : [[RESP_CODE_SIGNATURE, ...SIG]];
    return [[RESP_CODE_ERR, ERR_CODE_UNSUPPORTED_CMD]];
  };
  return { reply, got };
}

test('CMD_SIGN_DATA frames are [0x22][chunk], at most SIGN_CHUNK data bytes each, in order', () => {
  const data = bytes(300);
  const frames = signDataFrames(data);
  assert.deepStrictEqual(frames.map((f) => f.length), [1 + SIGN_CHUNK, 1 + SIGN_CHUNK, 1 + 300 - 2 * SIGN_CHUNK]);
  assert.ok(frames.every((f) => f[0] === CMD_SIGN_DATA));
  assert.deepStrictEqual(Uint8Array.from(frames.flatMap((f) => Array.from(f.slice(1)))), data);
});

test('a data frame fits one BLE write: ESP32 MTU 176 leaves 173 bytes, MAX_FRAME_SIZE is 176', () => {
  assert.ok(1 + SIGN_CHUNK <= 173);
});

test('signDataFrames refuses empty input — there is nothing to prove with it', () => {
  assert.throws(() => signDataFrames(new Uint8Array(0)), TypeError);
});

test('parseSignStart reads [0x13][reserved][max_len u32 LE]', () => {
  assert.deepStrictEqual(parseSignStart(Uint8Array.from([RESP_CODE_SIGN_START, 0, ...le32(8192)])), { maxLen: 8192 });
  assert.strictEqual(parseSignStart(Uint8Array.from([RESP_CODE_SIGN_START, 0, 0])), null, 'too short');
  assert.strictEqual(parseSignStart(Uint8Array.from([RESP_CODE_OK, 0, ...le32(8192)])), null, 'wrong code');
});

test('parseSignature returns exactly the 64 bytes after 0x14', () => {
  assert.deepStrictEqual(Array.from(parseSignature(Uint8Array.from([RESP_CODE_SIGNATURE, ...SIG]))), SIG);
  assert.strictEqual(parseSignature(Uint8Array.from([RESP_CODE_SIGNATURE, ...SIG.slice(0, 63)])), null);
  assert.strictEqual(parseSignature(Uint8Array.from([RESP_CODE_OK, ...SIG])), null);
});

test('a full exchange sends START, the data, FINISH, and resolves the signature', async () => {
  const fw = firmware();
  const t = fakeTransport(fw.reply);
  const msg = bytes(200);
  const sig = await signWithCompanion(t, msg, 200);
  assert.deepStrictEqual(Array.from(sig), SIG);
  assert.deepStrictEqual(t.sent.map((f) => f[0]), [CMD_SIGN_START, CMD_SIGN_DATA, CMD_SIGN_DATA, CMD_SIGN_FINISH]);
  assert.deepStrictEqual(Uint8Array.from(fw.got), msg, 'the companion received exactly the message');
  assert.strictEqual(t.listeners.length, 0, 'every listener is removed again');
});

test('an OK or ERR arriving before the START reply belongs to an earlier command and is ignored', async () => {
  // The discover sweep answers RESP_CODE_OK and carries no correlator. The firmware
  // answers in order, so anything ahead of 0x13 is someone else's.
  const fw = firmware({ onStart: () => [[RESP_CODE_OK], [RESP_CODE_ERR, 3], [RESP_CODE_SIGN_START, 0, ...le32(8192)]] });
  const sig = await signWithCompanion(fakeTransport(fw.reply), bytes(10), 200);
  assert.deepStrictEqual(Array.from(sig), SIG);
});

test('ERR_CODE_UNSUPPORTED_CMD on START means the firmware cannot sign', async () => {
  const fw = firmware({ onStart: () => [[RESP_CODE_ERR, ERR_CODE_UNSUPPORTED_CMD]] });
  const t = fakeTransport(fw.reply);
  await assert.rejects(signWithCompanion(t, bytes(10), 200), SignUnsupportedError);
  assert.deepStrictEqual(t.sent.map((f) => f[0]), [CMD_SIGN_START], 'nothing is sent after the refusal');
  assert.strictEqual(t.listeners.length, 0);
});

test('silence after START also means the firmware cannot sign', async () => {
  const fw = firmware({ onStart: () => [] });
  await assert.rejects(signWithCompanion(fakeTransport(fw.reply), bytes(10), 30), SignUnsupportedError);
});

test('ERR on a data chunk rejects, and is NOT reported as unsupported firmware', async () => {
  const fw = firmware({ onData: () => [[RESP_CODE_ERR, 3]] });
  await assert.rejects(signWithCompanion(fakeTransport(fw.reply), bytes(10), 200), (e) => {
    assert.ok(!(e instanceof SignUnsupportedError));
    assert.match(e.message, /refused sign data/);
    return true;
  });
});

test('silence after FINISH rejects with a signature timeout', async () => {
  const fw = firmware({ onFinish: () => [] });
  await assert.rejects(signWithCompanion(fakeTransport(fw.reply), bytes(10), 30), /signature timeout/);
});

test('a message longer than the companion accepts is refused before any data is sent', async () => {
  const fw = firmware({ maxLen: 16 });
  const t = fakeTransport(fw.reply);
  await assert.rejects(signWithCompanion(t, bytes(17), 200), /at most 16/);
  assert.deepStrictEqual(t.sent.map((f) => f[0]), [CMD_SIGN_START]);
});

test('a write that fails rejects with the transport error', async () => {
  const t = fakeTransport(() => []);
  t.send = async () => { throw new Error('not connected'); };
  await assert.rejects(signWithCompanion(t, bytes(10), 200), /not connected/);
  assert.strictEqual(t.listeners.length, 0);
});
