// Asks the connected MeshCore companion to sign bytes with its own Ed25519 identity
// key, which is how CoreScope learns that whoever links a companion holds its key
// (src/account.js). Layouts verified against MeshCore
// examples/companion_radio/MyMesh.cpp, handleCmdFrame:
//
//   CMD_SIGN_START  [0x21]          → RESP_CODE_SIGN_START [0x13][reserved][max_len u32 LE]
//   CMD_SIGN_DATA   [0x22][chunk…]  → RESP_CODE_OK [0x00] | RESP_CODE_ERR [0x01][err]
//   CMD_SIGN_FINISH [0x23]          → RESP_CODE_SIGNATURE [0x14][64-byte signature]
//
// Firmware that predates these commands answers CMD_SIGN_START from the final else of
// handleCmdFrame: RESP_CODE_ERR + ERR_CODE_UNSUPPORTED_CMD.
//
// Same request/response path as src/selfinfo.js: register an onFrame listener, send
// one frame, settle on the first matching reply or a timeout, remove the listener.
//
// OK and ERR carry no correlator, and the discover sweep, region discovery's contact
// writes and setPathHashMode produce them too. The CALLER must hold the radio for the
// whole exchange (src/app.js signOnCompanion → acquireRadio). The firmware answers in
// order, so an OK/ERR that arrives before RESP_CODE_SIGN_START belongs to an earlier
// command and is ignored here; after it, nothing else is in flight.
//
// Frame size: one BLE write is one companion frame (src/transport.js). The firmware
// caps a frame at MAX_FRAME_SIZE = 176 and the ESP32 build negotiates an MTU of 176,
// leaving 173 bytes of ATT payload per write. SIGN_CHUNK keeps every data frame well
// under both.

export const CMD_SIGN_START = 0x21;
export const CMD_SIGN_DATA = 0x22;
export const CMD_SIGN_FINISH = 0x23;
export const RESP_CODE_OK = 0x00;
export const RESP_CODE_ERR = 0x01;
export const RESP_CODE_SIGN_START = 0x13;
export const RESP_CODE_SIGNATURE = 0x14;
export const ERR_CODE_UNSUPPORTED_CMD = 0x01;
export const SIGNATURE_SIZE = 64;
export const SIGN_CHUNK = 128;
export const SIGN_STEP_TIMEOUT_MS = 4000;

// SignUnsupportedError: the firmware cannot sign at all. src/account.js shows
// "firmware cannot sign" and does not ask again until the next connect.
export class SignUnsupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SignUnsupportedError';
  }
}

// signDataFrames splits the message into CMD_SIGN_DATA frames of at most SIGN_CHUNK
// data bytes each.
export function signDataFrames(data, chunk = SIGN_CHUNK) {
  if (!(data instanceof Uint8Array) || !data.length) throw new TypeError('signDataFrames: expected non-empty bytes');
  const frames = [];
  for (let i = 0; i < data.length; i += chunk) {
    const part = data.subarray(i, Math.min(i + chunk, data.length));
    const f = new Uint8Array(1 + part.length);
    f[0] = CMD_SIGN_DATA;
    f.set(part, 1);
    frames.push(f);
  }
  return frames;
}

// parseSignStart reads [0x13][reserved][max_len u32 LE] → { maxLen }, or null.
export function parseSignStart(b) {
  if (!b || b.length < 6 || b[0] !== RESP_CODE_SIGN_START) return null;
  return { maxLen: new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(2, true) };
}

// parseSignature reads [0x14][64 bytes] → the 64-byte signature, or null.
export function parseSignature(b) {
  if (!b || b.length < 1 + SIGNATURE_SIZE || b[0] !== RESP_CODE_SIGNATURE) return null;
  return b.slice(1, 1 + SIGNATURE_SIZE);
}

// exchange sends one frame and settles on the first reply `judge` recognises.
// judge(bytes) returns undefined to ignore a frame, { value } to resolve, { error } to
// reject. onTimeout() builds the rejection for silence.
function exchange(transport, frame, judge, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    const onFrame = (dv) => {
      const b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      const verdict = judge(b);
      if (verdict === undefined) return;
      cleanup();
      if (verdict.error) reject(verdict.error);
      else resolve(verdict.value);
    };
    const timer = setTimeout(() => { cleanup(); reject(onTimeout()); }, timeoutMs);
    function cleanup() { clearTimeout(timer); transport.offFrame(onFrame); }
    transport.onFrame(onFrame);
    transport.send(frame).catch((e) => { cleanup(); reject(e); });
  });
}

// signWithCompanion resolves the companion's 64-byte Ed25519 signature over `data`.
// Rejects with SignUnsupportedError when the firmware cannot sign (ERR or silence on
// START), and with a plain Error for anything later or a failed write.
export async function signWithCompanion(transport, data, timeoutMs = SIGN_STEP_TIMEOUT_MS) {
  const frames = signDataFrames(data);
  const start = await exchange(transport, new Uint8Array([CMD_SIGN_START]), (b) => {
    if (b[0] === RESP_CODE_SIGN_START) {
      const s = parseSignStart(b);
      return s ? { value: s } : { error: new Error('malformed SIGN_START reply') };
    }
    if (b[0] === RESP_CODE_ERR && b[1] === ERR_CODE_UNSUPPORTED_CMD) {
      return { error: new SignUnsupportedError('the companion firmware does not support signing') };
    }
    return undefined; // an earlier command's OK/ERR, or any other frame
  }, timeoutMs, () => new SignUnsupportedError('no answer to CMD_SIGN_START — the companion firmware cannot sign'));

  if (data.length > start.maxLen) {
    throw new Error('the message is ' + data.length + ' bytes, the companion signs at most ' + start.maxLen);
  }

  for (const f of frames) {
    await exchange(transport, f, (b) => {
      if (b[0] === RESP_CODE_OK) return { value: true };
      if (b[0] === RESP_CODE_ERR) return { error: new Error('the companion refused sign data (error ' + b[1] + ')') };
      return undefined;
    }, timeoutMs, () => new Error('sign data timeout'));
  }

  return exchange(transport, new Uint8Array([CMD_SIGN_FINISH]), (b) => {
    if (b[0] === RESP_CODE_SIGNATURE) {
      const sig = parseSignature(b);
      return sig ? { value: sig } : { error: new Error('malformed SIGNATURE reply') };
    }
    if (b[0] === RESP_CODE_ERR) return { error: new Error('the companion refused to sign (error ' + b[1] + ')') };
    return undefined;
  }, timeoutMs, () => new Error('signature timeout'));
}
