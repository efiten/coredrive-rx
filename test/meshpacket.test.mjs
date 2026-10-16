// Run: node --test  (or: node test/meshpacket.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert';
import { parsePacket, deriveHeardKey, hexToBytes, bytesToHex } from '../src/meshpacket.js';

// Real relayed advert fixture (payload_type=4, 5×2-byte hops). Same hex used in
// CoreScope's ingestor test; last hop = 152c.
const RELAYED_ADVERT =
  '11451000D818206D3AAC152C8A91F89957E6D30CA51F36E28790228971C473B755F244F718754CF5EE4A2FD58D944466E42CDED140C66D0CC590183E32BAF40F112BE8F3F2BDF6012B4B2793C52F1D36F69EE054D9A05593286F78453E56C0EC4A3EB95DDA2A7543FCCC00B939CACC009278603902FC12BCF84B706120526F6F6620536F6C6172';

test('relayed packet → directly-heard last hop (multibyte, rxlog)', () => {
  const pkt = parsePacket(hexToBytes(RELAYED_ADVERT));
  assert.ok(pkt, 'parse');
  assert.strictEqual(pkt.hops.length, 5);
  const hk = deriveHeardKey('rx', pkt);
  assert.deepStrictEqual(hk, { heardKey: '152c', heardKeyLen: 2, src: 'rxlog' });
});

test('0-hop advert → full pubkey (advert)', () => {
  // FLOOD advert, 0 hops: header 0x11 (route 1, payload 4), pathByte 0x00, then 32-byte pubkey.
  const pubkey = 'ab'.repeat(32);
  const raw = '11' + '00' + pubkey + 'deadbeef';
  const hk = deriveHeardKey('rx', parsePacket(hexToBytes(raw)));
  assert.deepStrictEqual(hk, { heardKey: pubkey, heardKeyLen: 32, src: 'advert' });
});

test('node-discover reply → responder pubkey prefix (discover)', () => {
  // CONTROL packet, 0 hops. header: route DIRECT(2) | payload CONTROL(0x0B<<2) = 0x2E.
  // payload: flags 0x90 (DISCOVER_RESP sub_type 9 | node_type 0), snr 0x14, tag deadbeef, 8-byte pubkey prefix.
  const prefix = '1122334455667788';
  const raw = '2e' + '00' + '90' + '14' + 'deadbeef' + prefix;
  const pkt = parsePacket(hexToBytes(raw));
  assert.strictEqual(pkt.isDiscoverResp, true);
  const hk = deriveHeardKey('rx', pkt);
  assert.deepStrictEqual(hk, { heardKey: prefix, heardKeyLen: 8, src: 'discover' });
});

test('node-discover reply exposes discoverType (repeater) from the low nibble of flags', () => {
  // flags 0x92: DISCOVER_RESP sub_type(9)<<4 | ADV_TYPE_REPEATER(2).
  const prefix = '1122334455667788';
  const raw = '2e' + '00' + '92' + '14' + 'deadbeef' + prefix;
  const pkt = parsePacket(hexToBytes(raw));
  assert.strictEqual(pkt.discoverType, 2);
});

test('node-discover reply exposes discoverType (non-repeater) from the low nibble of flags', () => {
  // flags 0x90: DISCOVER_RESP sub_type(9)<<4 | node_type 0 (not ADV_TYPE_REPEATER).
  const prefix = '1122334455667788';
  const raw = '2e' + '00' + '90' + '14' + 'deadbeef' + prefix;
  const pkt = parsePacket(hexToBytes(raw));
  assert.strictEqual(pkt.discoverType, 0);
});

test('DIRECT packet with a path is not attributed (transmitter removed from front)', () => {
  // header: route DIRECT(2) | payload TXT_MSG(2<<2) = 0x0A. pathByte 0x41 (2-byte hashes, 1 hop),
  // hop 'aabb'. For direct routing path[last] is the route's far end, not the node we heard.
  const pkt = parsePacket(hexToBytes('0a' + '41' + 'aabb' + 'deadbeef'));
  assert.strictEqual(pkt.routeType, 2);
  assert.strictEqual(pkt.hops.length, 1);
  assert.strictEqual(deriveHeardKey('rx', pkt), null);
});

test('TRACE packet is not attributed via path bytes (SNR, not hops)', () => {
  // header: route FLOOD(1) | payload TRACE(0x09<<2) = 0x25. pathByte 0x03 (3 entries), 3 SNR bytes.
  const raw = '25' + '03' + 'aabbcc' + 'deadbeef';
  const pkt = parsePacket(hexToBytes(raw));
  assert.strictEqual(deriveHeardKey('rx', pkt), null);
});

test('0-hop advert exposes advertTs and advertType for region-discovery candidate tracking', () => {
  // header 0x11 (route FLOOD(1), payload ADVERT(4<<2)), pathByte 0x00 (0 hops),
  // pubkey(32) + timestamp(4, LE 0x12345678) + signature(64, zero-filled) + appdata
  // flags(1) = 0x02 (ADV_TYPE_REPEATER, no name/loc).
  const pubkey = 'ab'.repeat(32);
  const raw = '11' + '00' + pubkey + '78563412' + '00'.repeat(64) + '02';
  const pkt = parsePacket(hexToBytes(raw));
  assert.strictEqual(pkt.advertTs, 0x12345678);
  assert.strictEqual(pkt.advertType, 2);
});

test('a too-short advert leaves advertTs/advertType null rather than throwing', () => {
  const pubkey = 'ab'.repeat(32);
  const raw = '11' + '00' + pubkey + 'de'; // not even a full 4-byte timestamp, no appdata
  const pkt = parsePacket(hexToBytes(raw));
  assert.strictEqual(pkt.advertTs, null);
  assert.strictEqual(pkt.advertType, null);
});

test('an advert with a timestamp but no appdata leaves advertType null (not out of bounds)', () => {
  const pubkey = 'ab'.repeat(32);
  const raw = '11' + '00' + pubkey + '78563412' + '00'.repeat(64); // timestamp + signature, no appdata
  const pkt = parsePacket(hexToBytes(raw));
  assert.strictEqual(pkt.advertTs, 0x12345678);
  assert.strictEqual(pkt.advertType, null);
});

test('tx and 1-byte-last-hop are rejected', () => {
  const pkt = parsePacket(hexToBytes(RELAYED_ADVERT));
  assert.strictEqual(deriveHeardKey('tx', pkt), null);
  // FLOOD txt, 1 hop of 1 byte: header 0x09, pathByte 0x01, hop 'aa'
  const oneByte = parsePacket(hexToBytes('0901aa'));
  assert.strictEqual(deriveHeardKey('rx', oneByte), null);
});

// advertSig exposes the exact bytes the firmware signs and verifies over:
// pubkey(32) || timestamp(4, LE) || app_data, with app_data capped at
// MAX_ADVERT_DATA_SIZE (meshcore-firmware src/Mesh.cpp:271-280 and :404-437,
// src/MeshCore.h:12). Getting the cap wrong makes every long advert look forged.
test('an advert exposes the exact bytes the firmware signed', () => {
  const pubkey = 'ab'.repeat(32);
  const raw = '11' + '00' + pubkey + '78563412' + '11'.repeat(64) + '02' + 'cd'.repeat(4);
  const pkt = parsePacket(hexToBytes(raw));
  assert.strictEqual(bytesToHex(pkt.advertSig.pubkey), pubkey);
  assert.strictEqual(bytesToHex(pkt.advertSig.signature), '11'.repeat(64));
  assert.strictEqual(bytesToHex(pkt.advertSig.message), pubkey + '78563412' + '02' + 'cd'.repeat(4));
});

test('the signed message caps appdata at 32 bytes, as the firmware does', () => {
  const pubkey = 'ab'.repeat(32);
  const raw = '11' + '00' + pubkey + '78563412' + '11'.repeat(64) + 'cd'.repeat(40);
  const pkt = parsePacket(hexToBytes(raw));
  assert.strictEqual(bytesToHex(pkt.advertSig.message), pubkey + '78563412' + 'cd'.repeat(32));
});

test('an advert too short to hold a full signature exposes no signed message', () => {
  const raw = '11' + '00' + 'ab'.repeat(32) + '78563412' + '11'.repeat(20);
  assert.strictEqual(parsePacket(hexToBytes(raw)).advertSig, null);
});

test('a packet that is not an advert exposes no signed message', () => {
  const raw = '2E' + '00' + '90' + '14' + 'deadbeef' + '1122334455667788';
  assert.strictEqual(parsePacket(hexToBytes(raw)).advertSig, null);
});

test('node-discover reply without prefix_only carries the full 32-byte pubkey (nodeNames)', () => {
  // simple_repeater/MyMesh.cpp:824 sends 6 + PUB_KEY_SIZE bytes when prefix_only is clear.
  const pubkey = 'c0cdee59e0db981b' + '11'.repeat(24);
  const raw = '2e' + '00' + '92' + '14' + 'deadbeef' + pubkey;
  const pkt = parsePacket(hexToBytes(raw));
  assert.strictEqual(pkt.discoverType, 2);
  assert.deepStrictEqual(deriveHeardKey('rx', pkt), { heardKey: pubkey, heardKeyLen: 32, src: 'discover' });
});
