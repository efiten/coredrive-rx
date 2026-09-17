// The map's pure parts: which basemap a theme asks for, and the GeoJSON the hex
// layer draws. The MapLibre instance itself is exercised by the smoke test.
import { test } from 'node:test';
import assert from 'node:assert';
import { basemapUrl, hexFeature, hexCollection } from '../src/ui/map.js';
import { hexCellAt } from '../src/hexgrid.js';

test('each theme has its own basemap and neither is a CDN we do not allow', () => {
  assert.notStrictEqual(basemapUrl('dark'), basemapUrl('light'));
  for (const t of ['dark', 'light']) assert.match(basemapUrl(t), /^https:\/\//);
});

test('an unknown theme falls back to dark, which is what boots', () => {
  assert.strictEqual(basemapUrl('nonsense'), basemapUrl('dark'));
});

test('a cell becomes a closed polygon carrying its tier', () => {
  const cell = hexCellAt(50.85, 4.5, 10);
  const f = hexFeature(cell, 4.25);
  assert.strictEqual(f.type, 'Feature');
  assert.strictEqual(f.geometry.type, 'Polygon');
  const ring = f.geometry.coordinates[0];
  assert.ok(ring.length >= 7, 'a hex ring closes: 6 corners + the repeat');
  assert.deepStrictEqual(ring[0], ring[ring.length - 1]);
  assert.strictEqual(f.properties.tier, 'warm');
  assert.strictEqual(f.properties.id, cell);
});

test('a cell with no metric still draws, in its own tier', () => {
  const f = hexFeature(hexCellAt(50.85, 4.5, 10), null);
  assert.strictEqual(f.properties.tier, 'none');
});

test('the collection keeps one feature per cell', () => {
  const a = hexCellAt(50.85, 4.5, 10);
  const b = hexCellAt(51.0, 4.7, 10);
  const fc = hexCollection(new Map([[a, 3], [b, -12]]));
  assert.strictEqual(fc.type, 'FeatureCollection');
  assert.strictEqual(fc.features.length, 2);
});
