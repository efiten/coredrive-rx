// MeshCore packet parsing for RX coverage — JS port of CoreScope's
// internal/packetpath path extraction + the ingestor deriveHeardKey rule.
// Source of truth: firmware/docs/packet_format.md + internal/packetpath/path.go.

export const ROUTE_TRANSPORT_FLOOD = 0;
export const ROUTE_FLOOD = 1;
export const ROUTE_DIRECT = 2;
export const ROUTE_TRANSPORT_DIRECT = 3;
export const PAYLOAD_TYPE_ADVERT = 4;

function isTransportRoute(rt) {
  return rt === ROUTE_TRANSPORT_FLOOD || rt === ROUTE_TRANSPORT_DIRECT;
}

export function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex) {
  const clean = hex.trim().toLowerCase();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

// parsePacket extracts routing/header info from a raw MeshCore packet.
// Returns { routeType, payloadType, isAdvert, hops:[hex], advertPubkey:hex|null }
// or null if the buffer is too short / malformed.
export function parsePacket(bytes) {
  if (!bytes || bytes.length < 2) return null;
  const b0 = bytes[0];
  const routeType = b0 & 0x03;
  const payloadType = (b0 >> 2) & 0x0f;
  let off = 1;
  if (isTransportRoute(routeType)) {
    if (bytes.length < off + 4) return null;
    off += 4; // skip transport codes (region scoping)
  }
  if (off >= bytes.length) return null;
  const pathByte = bytes[off++];
  const hashSize = (pathByte >> 6) + 1;
  const hashCount = pathByte & 0x3f;
  const hops = [];
  for (let i = 0; i < hashCount; i++) {
    const s = off + i * hashSize;
    const e = s + hashSize;
    if (e > bytes.length) break;
    hops.push(bytesToHex(bytes.slice(s, e)));
  }
  off += hashCount * hashSize;

  const isAdvert = payloadType === PAYLOAD_TYPE_ADVERT;
  let advertPubkey = null;
  if (isAdvert && off + 32 <= bytes.length) {
    advertPubkey = bytesToHex(bytes.slice(off, off + 32)); // advert payload starts with the 32-byte pubkey
  }
  return { routeType, payloadType, isAdvert, hops, advertPubkey };
}

// deriveHeardKey applies the capture HARD RULE: record only the node heard
// directly — path[last] (last forwarder) or, for a 0-hop advert, the full
// pubkey. 1-byte prefixes are excluded (collision-prone). direction must be rx.
// Returns { heardKey, heardKeyLen, src } or null.
export function deriveHeardKey(direction, pkt) {
  if (direction !== 'rx' || !pkt) return null;
  if (pkt.hops.length > 0) {
    const last = pkt.hops[pkt.hops.length - 1].toLowerCase();
    const keylen = last.length / 2;
    if (keylen < 2) return null;
    return { heardKey: last, heardKeyLen: keylen, src: 'rxlog' };
  }
  if (pkt.isAdvert && pkt.advertPubkey) {
    const pk = pkt.advertPubkey.toLowerCase();
    return { heardKey: pk, heardKeyLen: pk.length / 2, src: 'advert' };
  }
  return null;
}
