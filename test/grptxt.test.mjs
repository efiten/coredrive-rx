import test from 'node:test';
import assert from 'node:assert/strict';
import { channelKey, channelHash, packetHash, decryptGroupText, PAYLOAD_TYPE_GRP_TXT } from '../src/grptxt.js';
import { hexToBytes, parsePacket } from '../src/meshpacket.js';

// A real packet from CoreScope live (transmissions.hash 12c82f82df4cc29c): a
// MeshMapper ping on #wardriving, TRANSPORT_FLOOD with five 2-byte hops. CoreScope
// decrypted it to the text below; this module must agree on key, text and hash.
const RAW = '1463FF000045A5040986C2FF6E3C692681B38F68F90D02BDF8CF1FA0D669C25C634FA133C036A15575710ED2930BE56894A62C156769D573175AACE6CF4A939F220CBC';
const PAYLOAD_OFFSET = 1 + 4 + 1 + 10; // header, transport codes, path byte, 5 x 2-byte hops

test('a real #wardriving packet decrypts to the text CoreScope stored', async () => {
  const bytes = hexToBytes(RAW);
  assert.equal(parsePacket(bytes).payloadType, PAYLOAD_TYPE_GRP_TXT);
  const key = await channelKey('#wardriving');
  const hb = await channelHash(key);
  assert.equal(hb, 0x81, 'channel hash byte as on air');
  const msg = await decryptGroupText(bytes.slice(PAYLOAD_OFFSET), key, hb);
  assert.equal(msg.text, 'MeshMapper Daniel: MM:c6PDmc_yqw');
});

test('packetHash matches the hash CoreScope files the transmission under', async () => {
  const bytes = hexToBytes(RAW);
  assert.equal(await packetHash(PAYLOAD_TYPE_GRP_TXT, bytes.slice(PAYLOAD_OFFSET)), '12c82f82df4cc29c');
});

test('another channel key, a wrong hash byte or a broken MAC yields null', async () => {
  const payload = hexToBytes(RAW).slice(PAYLOAD_OFFSET);
  const key = await channelKey('#wardriving');
  const other = await channelKey('#coredrive');
  assert.equal(await decryptGroupText(payload, other, 0x81), null, 'wrong key fails the MAC');
  assert.equal(await decryptGroupText(payload, key, 0x82), null, 'wrong channel hash byte');
  const bad = payload.slice();
  bad[1] ^= 0xff;
  assert.equal(await decryptGroupText(bad, key, 0x81), null, 'tampered MAC');
  assert.equal(await decryptGroupText(payload.slice(0, 10), key, 0x81), null, 'too short');
});
