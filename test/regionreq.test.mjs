import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRegionsRequest, parseRegionsResponse, CMD_SEND_ANON_REQ,
  parseSentAck, RESP_CODE_SENT, TRUNCATION_WARN_BYTES,
} from '../src/regionreq.js';

const PK = 'aa'.repeat(32);
const le32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

test('buildRegionsRequest is [57][pubkey 32][0x01][0x00] — no app timestamp', () => {
  const f = buildRegionsRequest(PK);
  assert.equal(f.length, 1 + 32 + 2);
  assert.equal(f[0], CMD_SEND_ANON_REQ);
  assert.deepEqual(Array.from(f.slice(1, 33)), new Array(32).fill(0xaa));
  assert.equal(f[33], 0x01, 'req type');
  assert.equal(f[34], 0x00, 'reply_path_len = 0 for a zero-hop reply');
});

test('buildRegionsRequest throws on a too-short pubkey', () => {
  assert.throws(() => buildRegionsRequest('aa'.repeat(31)), TypeError);
});

test('buildRegionsRequest throws on a too-long pubkey', () => {
  assert.throws(() => buildRegionsRequest('aa'.repeat(33)), TypeError);
});

test('buildRegionsRequest throws on non-hex characters', () => {
  assert.throws(() => buildRegionsRequest('zz'.repeat(32)), TypeError);
});

test('buildRegionsRequest accepts an uppercase pubkey and lowercases it', () => {
  const f = buildRegionsRequest(PK.toUpperCase());
  assert.deepEqual(Array.from(f.slice(1, 33)), new Array(32).fill(0xaa));
});

test('parseRegionsResponse reads tag, clock and the CSV', () => {
  // [0x8C][reserved][tag 4][repeater_clock 4][CSV]
  const bytes = new Uint8Array([0x8c, 0, ...le32(0x11223344), ...le32(1755518096), ...ascii('*,be,be-vlg,be-van')]);
  const r = parseRegionsResponse(bytes);
  assert.equal(r.tag, 0x11223344);
  assert.equal(r.repeaterClock, 1755518096);
  assert.deepEqual(r.regions, ['*', 'be', 'be-vlg', 'be-van']);
  assert.equal(r.truncated, false);
});

test('parseRegionsResponse flags a CSV near the 172-byte ceiling', () => {
  const long = Array.from({ length: 24 }, (_, i) => `be-x${String(i).padStart(2, '0')}`).join(',');
  assert.ok(long.length > TRUNCATION_WARN_BYTES, 'fixture must exceed the flag threshold');
  const bytes = new Uint8Array([0x8c, 0, ...le32(1), ...le32(2), ...ascii(long)]);
  assert.equal(parseRegionsResponse(bytes).truncated, true);
});

test('parseRegionsResponse flags a 139-byte CSV — the boundary that can still hide a dropped 30-char name', () => {
  // Worst case per firmware RegionMap.cpp exportNamesTo: max_len = MAX_PACKET_PAYLOAD(184) - 12 = 172.
  // A name of the maximum length L = sizeof(RegionEntry::name) - 1 = 30 is dropped once the bytes
  // already written W reach `max_len - L - 2` = 140. At that instant the buffer holds 140 bytes
  // ending in a trailing comma, which exportNamesTo then trims — so the delivered CSV can be as
  // short as 139 bytes while a further 30-char name was silently dropped right after it.
  // Fixture: four 30-char names plus one 15-char name, comma-joined, totals exactly 139 bytes.
  const long = ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30), 'd'.repeat(30), 'e'.repeat(15)].join(',');
  assert.equal(long.length, 139, 'fixture must sit exactly on the derived boundary');
  const bytes = new Uint8Array([0x8c, 0, ...le32(1), ...le32(2), ...ascii(long)]);
  assert.equal(parseRegionsResponse(bytes).truncated, true, 'the new threshold must flag it');
});

test('parseRegionsResponse measures the boundary in bytes, not UTF-16 code units', () => {
  // RegionMap::is_name_char accepts every byte >= 0x80, so accented region names are
  // legal. Each 'eé' costs two bytes but one code unit, so this CSV is 139 bytes on
  // the wire and 124 code units after decoding: a csv.length comparison would miss it.
  const long = ['é'.repeat(15), 'b'.repeat(30), 'c'.repeat(30), 'd'.repeat(30), 'e'.repeat(15)].join(',');
  const encoded = new TextEncoder().encode(long);
  assert.equal(encoded.length, 139, 'fixture must sit on the derived byte boundary');
  assert.ok(long.length < TRUNCATION_WARN_BYTES, 'and must fall short of it when counted as chars');
  const bytes = new Uint8Array([0x8c, 0, ...le32(1), ...le32(2), ...encoded]);
  assert.equal(parseRegionsResponse(bytes).truncated, true);
});

test('parseRegionsResponse rejects a wrong code and a short frame', () => {
  assert.equal(parseRegionsResponse(new Uint8Array([0x88, 0, 1, 2])), null);
  assert.equal(parseRegionsResponse(new Uint8Array([0x8c, 0, 1, 2])), null);
  assert.equal(parseRegionsResponse(new Uint8Array()), null);
});

test('an empty CSV yields an empty list, not null', () => {
  const bytes = new Uint8Array([0x8c, 0, ...le32(1), ...le32(2)]);
  assert.deepEqual(parseRegionsResponse(bytes).regions, []);
});

// --- RESP_CODE_SENT ack ---
// The companion echoes a 4-byte tag for every CMD_SEND_*, and reports whether it chose
// a flooded route. Both matter: a repeater answers a regions request only over a DIRECT
// route, and the tag is what src/regionsched.js matches every later reply against.

test('parseSentAck reads the tag from a RESP_CODE_SENT ack', () => {
  // [0x06][is_flood: 1][tag: 4][est_timeout: 4]
  const bytes = new Uint8Array([RESP_CODE_SENT, 0, ...le32(0x11223344), ...le32(9000)]);
  assert.deepEqual(parseSentAck(bytes), { tag: 0x11223344, isFlood: false });
});

test('parseSentAck rejects a wrong code and a too-short frame', () => {
  assert.equal(parseSentAck(new Uint8Array([5, 0, ...le32(1)])), null);
  assert.equal(parseSentAck(new Uint8Array([RESP_CODE_SENT, 0, 1, 2])), null);
  assert.equal(parseSentAck(null), null);
});

test('AES block padding is trimmed — it must not land inside the last region name', () => {
  // The reply is encrypted with a block cipher, so the plaintext arrives NUL-padded
  // to a 16-byte boundary. Production carried this into storage in 48 of 65 rows:
  // "belml" became "belml\0\0\0…", which matches no observed scope and reads as a
  // region the repeater declares but never forwards — a false finding, every time.
  const csv = 'be,be-vli,belml';
  const padded = new Uint8Array([
    0x8c, 0, ...le32(1), ...le32(2), ...ascii(csv), 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const r = parseRegionsResponse(padded);
  assert.deepEqual(r.regions, ['be', 'be-vli', 'belml'],
    'the last name must not carry NUL bytes');
  assert.equal(r.regions[2].length, 5, 'no trailing NULs survive into the name');
});

test('a wildcard-only reply survives padding as exactly "*"', () => {
  // 0x2A followed by seven NULs is one full AES block; this is the shape that made
  // regions_csv = '*' compare false in SQL and could mask the wildcard entirely.
  const padded = new Uint8Array([0x8c, 0, ...le32(1), ...le32(2), 0x2a, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(parseRegionsResponse(padded).regions, ['*']);
});

test('a reply that is only padding yields no regions, not one empty name', () => {
  const padded = new Uint8Array([0x8c, 0, ...le32(1), ...le32(2), 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(parseRegionsResponse(padded).regions, []);
});
