import { test } from 'node:test';
import assert from 'node:assert';
import { hexCellAt, hexBoundary, hexResForZoom } from '../src/hexgrid.js';

test('hexCellAt is stable and distinct', () => {
  const a = hexCellAt(51.05, 3.72, 9);
  assert.strictEqual(a, hexCellAt(51.05, 3.72, 9));
  assert.notStrictEqual(hexCellAt(51.20, 3.72, 9), a); // ~17 km away
});

test('hexBoundary is a closed 7-point ring', () => {
  const r = hexBoundary(hexCellAt(51.05, 3.72, 9));
  assert.strictEqual(r.length, 7);
  assert.deepStrictEqual(r[0], r[6]);
  assert.strictEqual(hexBoundary('garbage'), null);
});

test('hexResForZoom', () => {
  assert.strictEqual(hexResForZoom(16), 11);
  assert.strictEqual(hexResForZoom(8), 7);
  assert.strictEqual(hexResForZoom(3), 6);
});
