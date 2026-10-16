import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScopeList, parseDefaultScope, buildUnscopedFrame, buildGetDefaultScope, mergeRegionTable,
  matchHeard, chooseScope, pruneHeard, RESP_CODE_DEFAULT_FLOOD_SCOPE,
} from '../src/autoscope.js';

const BE1 = 'be01' + 'a'.repeat(60);
const BE2 = 'be02' + 'a'.repeat(60);
const NL1 = '4e01' + 'b'.repeat(60);
const NL2 = '4e02' + 'b'.repeat(60);
const NL3 = '4e03' + 'b'.repeat(60);
const WILD = 'ff01' + 'c'.repeat(60);

// Shapes as live CoreScope returned them on 2026-10-16 for Limburg border repeaters.
const server = [
  { pubkey: BE1, regions: ['be', 'be-vli', 'eu'], wildcard: true },
  { pubkey: BE2, regions: ['be', 'nl', 'nl-li', 'de'], wildcard: true },
  { pubkey: NL1, regions: ['nl', 'nl-li'], wildcard: true },
  { pubkey: NL2, regions: ['nl', 'nl-li', 'eu'], wildcard: true },
  { pubkey: NL3, regions: ['nl-li'], wildcard: false },
  { pubkey: WILD, regions: [], wildcard: true },
];
const table = mergeRegionTable(server, []);
const prefs = parseScopeList('de, nl, #be');

test('parseScopeList: comma list, # and case dropped, * and duplicates skipped', () => {
  assert.deepEqual(prefs, ['de', 'nl', 'be']);
  assert.deepEqual(parseScopeList('be'), ['be']);
  assert.deepEqual(parseScopeList(' BE,be,*,'), ['be']);
  assert.deepEqual(parseScopeList(''), []);
});

test('default-scope frames match the firmware (MyMesh.cpp:1937, 1957-1965)', () => {
  assert.deepEqual(Array.from(buildUnscopedFrame()), [54, 1]);
  assert.deepEqual(Array.from(buildGetDefaultScope()), [64]);
  const f = new Uint8Array(1 + 31 + 16);
  f[0] = RESP_CODE_DEFAULT_FLOOD_SCOPE;
  f.set(new TextEncoder().encode('#BE'), 1);
  assert.equal(parseDefaultScope(f), 'be');
  assert.equal(parseDefaultScope(new Uint8Array([RESP_CODE_DEFAULT_FLOOD_SCOPE])), '');
  assert.equal(parseDefaultScope(new Uint8Array([1])), null);
  assert.equal(parseDefaultScope(null), null);
});

test('mergeRegionTable: a session answer replaces the server entry', () => {
  const t = mergeRegionTable(server, [{ target: NL3.toUpperCase(), regions: ['*', 'nl', '#BE'], at: 5 }]);
  const e = t.get(NL3);
  assert.deepEqual([...e.regions].sort(), ['be', 'nl']);
  assert.equal(e.wildcard, true);
  assert.equal(t.size, server.length);
});

test('matchHeard: full keys and unique prefixes match, ambiguous prefixes are skipped', () => {
  const m = matchHeard([BE1, '4e01', '4e0', 'be0', NL2.slice(0, 6)], table);
  assert.deepEqual([...m.keys()].sort(), [BE1, NL1, NL2].sort());
  assert.equal(matchHeard(['be'], table).size, 0, 'a 1-byte key is too short');
  assert.equal(matchHeard(['be0'], table).size, 0, 'be0 fits two repeaters');
});

test('in Belgium: be wins', () => {
  const r = chooseScope({ prefs, companionDefault: 'be', heardKeys: [BE1, BE2], table });
  assert.equal(r.mode, 'scope');
  assert.equal(r.scope, 'be');
  assert.match(r.reason, /^2 of 2 repeaters/);
});

test('just over the border: the Dutch repeaters outvote the one Belgian that also lists nl', () => {
  const r = chooseScope({ prefs, companionDefault: 'be', heardKeys: [BE2, NL1, NL2, NL3], table });
  assert.equal(r.scope, 'nl', r.reason);
  assert.match(r.reason, /be 1, de 1, nl 3/);
});

test('a tie goes to the companion default, then to the list order', () => {
  const t = mergeRegionTable([{ pubkey: BE1, regions: ['be'] }, { pubkey: NL1, regions: ['nl'] }], []);
  assert.equal(chooseScope({ prefs, companionDefault: 'be', heardKeys: [BE1, NL1], table: t }).scope, 'be');
  assert.equal(chooseScope({ prefs, companionDefault: '', heardKeys: [BE1, NL1], table: t }).scope, 'nl');
});

test('the companion default counts even when it is not in the list', () => {
  const t = mergeRegionTable([{ pubkey: BE1, regions: ['be-vli'] }], []);
  assert.equal(chooseScope({ prefs, companionDefault: 'be-vli', heardKeys: [BE1], table: t }).scope, 'be-vli');
});

test('no preferred region forwarded but * is: unscoped', () => {
  const r = chooseScope({ prefs, companionDefault: '', heardKeys: [WILD], table });
  assert.equal(r.mode, 'unscoped');
  assert.equal(r.scope, '');
});

test('nothing known: the companion default', () => {
  assert.deepEqual(
    { ...chooseScope({ prefs, companionDefault: 'be', heardKeys: ['1234'], table }), reason: '' },
    { mode: 'default', scope: 'be', reason: '' },
  );
  assert.equal(chooseScope({ prefs, companionDefault: null, heardKeys: [], table }).scope, '');
  const t = mergeRegionTable([{ pubkey: NL3, regions: ['nl-li'], wildcard: false }], []);
  assert.equal(chooseScope({ prefs, companionDefault: 'be', heardKeys: [NL3], table: t }).mode, 'default');
});

test('pruneHeard drops keys older than the window', () => {
  const h = new Map([['aaaa', 0], ['bbbb', 290000]]);
  pruneHeard(h, 300001);
  assert.deepEqual([...h.keys()], ['bbbb']);
});
