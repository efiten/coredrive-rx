// Uplink ping: the bytes on the wire and the decisions about them, nothing else.
// WHEN to ping is src/uplinksched.js; the BLE round and the echo window live in app.js.
//
// A ping is one channel message on a dedicated hashtag channel (#coredrive by default)
// carrying only a random tag; the position goes to CoreScope over MQTT, never over the
// mesh. Two things can then be learned:
//   echo     the companion hears a repeater re-broadcast it: a repeater heard us, and
//            the packet's first hop says which one
//   arrival  a CoreScope observer received it, found by the packet hash (CoreScope side)
// Frame layouts verified against companion_radio/MyMesh.cpp (firmware v1.17.1).
import { parsePacket, hexToBytes } from './meshpacket.js';
import { decryptGroupText, packetHash, PAYLOAD_TYPE_GRP_TXT } from './grptxt.js';

export const CMD_SEND_CHANNEL_TXT_MSG = 3;  // [3][txt_type 0][idx][ts u32 LE][text] → OK
export const CMD_GET_CHANNEL = 31;          // [31][idx] → RESP_CODE_CHANNEL_INFO | ERR
export const CMD_SET_CHANNEL = 32;          // [32][idx][name 32][secret 16] → OK
export const CMD_SET_FLOOD_SCOPE = 54;      // [54][0][key 16] sets, [54][0] resets (fw v8+)
export const RESP_CODE_CHANNEL_INFO = 18;   // [18][idx][name 32][secret 16]
export const SCOPE_MIN_FW = 8;
const PING_PREFIX = 'cdrx ';

export function makeTag() {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function pingText(tag) {
  return PING_PREFIX + tag;
}

export function buildChannelMessage(idx, unixTs, text) {
  const t = new TextEncoder().encode(text);
  const out = new Uint8Array(7 + t.length);
  out[0] = CMD_SEND_CHANNEL_TXT_MSG;
  out[1] = 0; // TXT_TYPE_PLAIN, the only type the firmware accepts here
  out[2] = idx;
  new DataView(out.buffer).setUint32(3, unixTs >>> 0, true);
  out.set(t, 7);
  return out;
}

// buildScopeFrame sets the flood-scope override to `key`, or resets it with null.
// While set, the next channel message goes out as TRANSPORT_FLOOD with that region's
// code, and only repeaters configured for the region forward it
// (simple_repeater/MyMesh.cpp:440-442, 569-570).
export function buildScopeFrame(key) {
  if (!key) return new Uint8Array([CMD_SET_FLOOD_SCOPE, 0]);
  const out = new Uint8Array(18);
  out[0] = CMD_SET_FLOOD_SCOPE;
  out.set(key, 2);
  return out;
}

// scopeKeyName is the name a region key is derived from: RegionMap prepends '#' to
// a name that lacks one (helpers/RegionMap.cpp:177-185).
export function scopeKeyName(scope) {
  const s = String(scope || '').trim();
  if (!s) return '';
  return s.startsWith('#') ? s : '#' + s;
}

export function buildGetChannel(idx) {
  return new Uint8Array([CMD_GET_CHANNEL, idx]);
}

export function buildSetChannel(idx, name, key) {
  const out = new Uint8Array(2 + 32 + 16);
  out[0] = CMD_SET_CHANNEL;
  out[1] = idx;
  out.set(new TextEncoder().encode(name).slice(0, 31), 2);
  out.set(key, 34);
  return out;
}

export function parseChannelInfo(b) {
  if (!b || b.length < 2 + 32 + 16 || b[0] !== RESP_CODE_CHANNEL_INFO) return null;
  const nameBytes = b.slice(2, 34);
  const nul = nameBytes.indexOf(0);
  return {
    idx: b[1],
    name: new TextDecoder().decode(nul >= 0 ? nameBytes.slice(0, nul) : nameBytes),
    secret: b.slice(34, 50),
  };
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// pickSlot chooses where the ping channel lives: a slot that already holds exactly
// this name and key, else the first empty slot (no name, all-zero secret), else none.
// A slot with the right name but another key belongs to someone else's channel and
// is never overwritten.
export function pickSlot(channels, name, key) {
  const mine = channels.find((c) => c.name === name && sameBytes(c.secret, key));
  if (mine) return { idx: mine.idx, write: false };
  const free = channels.find((c) => c.name === '' && c.secret.every((v) => v === 0));
  return free ? { idx: free.idx, write: true } : null;
}

// matchEcho checks one received raw packet for a re-broadcast of our ping. Returns
// { hash, firstHop, lastHop, hops } or null. firstHop is the repeater that picked the
// ping up from us; lastHop is the one we heard it from.
export async function matchEcho(raw, key, hashByte, tag) {
  const bytes = typeof raw === 'string' ? hexToBytes(raw) : raw;
  const pkt = parsePacket(bytes);
  if (!pkt || pkt.payloadType !== PAYLOAD_TYPE_GRP_TXT || !pkt.hops.length) return null;
  const payload = bytes.slice(payloadOffset(bytes));
  const msg = await decryptGroupText(payload, key, hashByte);
  if (!msg || !msg.text.endsWith(': ' + pingText(tag))) return null;
  return {
    hash: await packetHash(PAYLOAD_TYPE_GRP_TXT, payload),
    firstHop: pkt.hops[0],
    lastHop: pkt.hops[pkt.hops.length - 1],
    hops: pkt.hops.length,
  };
}

// payloadOffset: header, 4 transport-code bytes on TRANSPORT routes, the path byte,
// then hashCount * hashSize path bytes (Packet.cpp).
function payloadOffset(bytes) {
  const routeType = bytes[0] & 0x03;
  let off = routeType === 0 || routeType === 3 ? 5 : 1;
  const pathByte = bytes[off++];
  return off + (pathByte & 0x3f) * ((pathByte >> 6) + 1);
}
