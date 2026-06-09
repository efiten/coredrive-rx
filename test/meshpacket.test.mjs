// Run: node --test  (or: node test/meshpacket.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert';
import { parsePacket, deriveHeardKey, hexToBytes } from '../src/meshpacket.js';

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

test('tx and 1-byte-last-hop are rejected', () => {
  const pkt = parsePacket(hexToBytes(RELAYED_ADVERT));
  assert.strictEqual(deriveHeardKey('tx', pkt), null);
  // FLOOD txt, 1 hop of 1 byte: header 0x09, pathByte 0x01, hop 'aa'
  const oneByte = parsePacket(hexToBytes('0901aa'));
  assert.strictEqual(deriveHeardKey('rx', oneByte), null);
});
