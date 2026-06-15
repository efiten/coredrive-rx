// SELF_INFO handshake: send CMD_APP_START (0x01) and parse the PACKET_SELF_INFO
// (0x05) reply to learn the companion's own pubkey (and name). Source of truth:
// firmware/docs/companion_protocol.md.
import { bytesToHex } from './meshpacket.js';

const CMD_APP_START = 0x01;
const RESP_SELF_INFO = 0x05;

// requestSelfInfo resolves { pubkey, name } from the connected companion.
export function requestSelfInfo(transport, appName = 'coredrive-rx', timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const onFrame = (dv) => {
      const b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      if (b[0] !== RESP_SELF_INFO) return;
      cleanup();
      const info = parseSelfInfo(b);
      info ? resolve(info) : reject(new Error('malformed SELF_INFO'));
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('SELF_INFO timeout')); }, timeoutMs);
    function cleanup() { clearTimeout(timer); transport.offFrame(onFrame); }

    transport.onFrame(onFrame);
    // APP_START frame: [0x01][7 reserved bytes][app name UTF-8]
    const name = new TextEncoder().encode(appName);
    const frame = new Uint8Array(8 + name.length);
    frame[0] = CMD_APP_START;
    frame.set(name, 8);
    transport.send(frame).catch((e) => { cleanup(); reject(e); });
  });
}

const CMD_DEVICE_QUERY = 0x16;   // [0x16, 0x03] -> RESP_CODE_DEVICE_INFO
const RESP_DEVICE_INFO = 0x0d;
const CMD_SET_PATH_HASH_MODE = 0x3d; // [0x3D, 0x00, mode]  (mode 0=1B,1=2B,2=3B)

// requestDeviceInfo resolves { fwVer, pathHashMode } from the companion.
// pathHashMode is at DEVICE_INFO byte 81 (firmware v10+); null if absent.
export function requestDeviceInfo(transport, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const onFrame = (dv) => {
      const b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      if (b[0] !== RESP_DEVICE_INFO) return;
      cleanup();
      resolve({ fwVer: b[1], pathHashMode: b.length > 81 ? b[81] : null });
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('DEVICE_INFO timeout')); }, timeoutMs);
    function cleanup() { clearTimeout(timer); transport.offFrame(onFrame); }
    transport.onFrame(onFrame);
    transport.send(new Uint8Array([CMD_DEVICE_QUERY, 0x03])).catch((e) => { cleanup(); reject(e); });
  });
}

// setPathHashMode sets the companion's advert path-hash size (1=2-byte). Fire-and-forget.
export function setPathHashMode(transport, mode) {
  return transport.send(new Uint8Array([CMD_SET_PATH_HASH_MODE, 0x00, mode]));
}

// parseSelfInfo: pubkey at bytes 4-35 (32 bytes), device name at bytes 58+.
function parseSelfInfo(b) {
  if (b.length < 36) return null;
  const pubkey = bytesToHex(b.slice(4, 36));
  let name = '';
  if (b.length > 58) {
    try { name = new TextDecoder().decode(b.slice(58)).replace(/\0+$/, ''); } catch (e) { name = ''; }
  }
  return { pubkey, name };
}
