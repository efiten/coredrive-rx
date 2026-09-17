// test/calloutPosition.test.mjs
// Spotlight-callout positioning, copied unchanged from core-hunter
// (vitest -> node:test). Every case ported as-is: this module is pure
// geometry and carries no app-specific behaviour.
import { test } from 'node:test';
import assert from 'node:assert';
import { calloutPosition, unionRect, avoidOverlap, overlapsAny } from '../src/ui/calloutPosition.js';

const rect = (o) => ({ left: 0, top: 0, right: 0, bottom: 0, ...o });
const vp = { width: 400, height: 800 };
const size = { width: 150, height: 60 };

test('calloutPosition places below and left-aligned to the target by default', () => {
  const target = rect({ left: 12, top: 40, right: 120, bottom: 70 });
  assert.deepStrictEqual(calloutPosition(target, vp, size), { top: 80, left: 12 });
});

test('calloutPosition places above the target when side is "above"', () => {
  const target = rect({ left: 12, top: 700, right: 120, bottom: 730 });
  assert.deepStrictEqual(calloutPosition(target, vp, size, { side: 'above' }), { top: 630, left: 12 });
});

test('calloutPosition right-aligns to the target when align is "right"', () => {
  const target = rect({ left: 300, top: 40, right: 388, bottom: 70 });
  assert.deepStrictEqual(calloutPosition(target, vp, size, { align: 'right' }), { top: 80, left: 238 });
});

test('calloutPosition places to the left of the target when side is "left"', () => {
  const target = rect({ left: 350, top: 400, right: 390, bottom: 440 });
  assert.deepStrictEqual(calloutPosition(target, vp, size, { side: 'left' }), { top: 400, left: 190 });
});

test('calloutPosition clamps horizontally so the callout never runs off the right edge', () => {
  const target = rect({ left: 380, top: 40, right: 398, bottom: 70 });
  assert.deepStrictEqual(calloutPosition(target, vp, size), { top: 80, left: 242 });
});

test('calloutPosition clamps to the margin so the callout never runs off the left edge', () => {
  const target = rect({ left: -50, top: 40, right: 10, bottom: 70 });
  assert.deepStrictEqual(calloutPosition(target, vp, size), { top: 80, left: 8 });
});

test('calloutPosition clamps vertically so the callout never runs off the bottom edge', () => {
  const target = rect({ left: 12, top: 770, right: 120, bottom: 795 });
  assert.deepStrictEqual(calloutPosition(target, vp, size), { top: 732, left: 12 });
});

test('unionRect returns the bounding box that encloses all given rects', () => {
  const rects = [
    rect({ left: 20, top: 10, right: 40, bottom: 30 }),
    rect({ left: 5, top: 50, right: 45, bottom: 90 }),
    rect({ left: 30, top: 5, right: 60, bottom: 20 }),
  ];
  assert.deepStrictEqual(unionRect(rects), { left: 5, top: 5, right: 60, bottom: 90, width: 55, height: 85 });
});

test('unionRect handles a single rect', () => {
  assert.deepStrictEqual(
    unionRect([rect({ left: 1, top: 2, right: 3, bottom: 4 })]),
    { left: 1, top: 2, right: 3, bottom: 4, width: 2, height: 2 },
  );
});

test('avoidOverlap leaves a box that hits nothing where it was anchored', () => {
  const viewport = { width: 1280, height: 800 };
  const box = (top, left, width = 200, height = 100) => ({ top, left, width, height });
  assert.deepStrictEqual(avoidOverlap(box(100, 0), [box(100, 400)], viewport), { top: 100, left: 0 });
});

test('avoidOverlap drops a box below the one it would cover, keeping its horizontal anchor', () => {
  const viewport = { width: 1280, height: 800 };
  const box = (top, left, width = 200, height = 100) => ({ top, left, width, height });
  assert.deepStrictEqual(avoidOverlap(box(100, 0), [box(80, 0)], viewport), { top: 188, left: 0 });
});

test('avoidOverlap re-checks a box it has already passed — the move can create a new collision', () => {
  const viewport = { width: 1280, height: 800 };
  const box = (top, left, width = 200, height = 100) => ({ top, left, width, height });
  // Order matters: the far box (250) is checked first and missed, then the
  // near one (80) pushes the callout down INTO it. A single sweep stops at
  // 188, on top of the box it was supposed to avoid.
  assert.deepStrictEqual(
    avoidOverlap(box(100, 0), [box(250, 0), box(80, 0)], viewport),
    { top: 358, left: 0 },
  );
});

test('avoidOverlap goes above the blocker when there is no room below', () => {
  const viewport = { width: 1280, height: 800 };
  const box = (top, left, width = 200, height = 100) => ({ top, left, width, height });
  // Was 692 before: settling downward and clamping to the viewport at the end
  // put the box back inside the blocker it had just cleared (690..790),
  // because the clamp does not know what it is clamping into. Going up is the
  // only placement that is both on screen and clear.
  const placed = avoidOverlap(box(700, 0), [box(690, 0)], viewport);
  assert.strictEqual(placed.top, 582);
  assert.strictEqual(overlapsAny({ ...placed, width: 200, height: 100 }, [box(690, 0)]), false);
});

test('avoidOverlap keeps the box where it belongs when neither direction has room, and says so', () => {
  const viewport = { width: 1280, height: 800 };
  const box = (top, left, width = 200, height = 100) => ({ top, left, width, height });
  // A blocker taller than the viewport can be escaped in no direction. The
  // anchored position is the least bad answer, and overlapsAny is what lets
  // the caller notice and stop drawing boxes at all.
  const tall = [{ top: 0, left: 0, width: 400, height: 800 }];
  const placed = avoidOverlap(box(300, 0), tall, viewport);
  assert.deepStrictEqual(placed, { top: 300, left: 0 });
  assert.strictEqual(overlapsAny({ ...placed, width: 200, height: 100 }, tall), true);
});

test('avoidOverlap ignores a box that only overlaps vertically, in another column', () => {
  const viewport = { width: 1280, height: 800 };
  const box = (top, left, width = 200, height = 100) => ({ top, left, width, height });
  assert.deepStrictEqual(avoidOverlap(box(100, 0), [box(100, 250)], viewport), { top: 100, left: 0 });
});

test('overlapsAny is false for an empty blocker list', () => {
  const b = (top, left, width = 200, height = 100) => ({ top, left, width, height });
  assert.strictEqual(overlapsAny(b(0, 0), []), false);
});

test('overlapsAny separates touching edges from a real overlap', () => {
  const b = (top, left, width = 200, height = 100) => ({ top, left, width, height });
  // Exactly adjacent is not overlapping — otherwise a box placed at
  // blocker.bottom + gap would report a collision it just resolved.
  assert.strictEqual(overlapsAny(b(100, 0), [b(0, 0)]), false);
  assert.strictEqual(overlapsAny(b(99, 0), [b(0, 0)]), true);
});

test('overlapsAny needs both axes to overlap', () => {
  const b = (top, left, width = 200, height = 100) => ({ top, left, width, height });
  assert.strictEqual(overlapsAny(b(50, 0), [b(0, 200)]), false);
  assert.strictEqual(overlapsAny(b(50, 199), [b(0, 0)]), true);
});
