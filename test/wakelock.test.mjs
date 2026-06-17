// Wake-lock selection logic: native Screen Wake Lock where present, hidden looping
// video fallback otherwise, re-acquire on visibility. Verified with fake
// navigator/document (no real browser). Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { createWakeLock } from '../src/wakelock.js';

function fakeDoc() {
  const listeners = {};
  const el = (tag) => ({
    tag, attrs: {}, style: {}, children: [], muted: false, playCount: 0, paused: false,
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); },
    play() { this.playCount++; this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
  });
  return {
    visibilityState: 'visible',
    body: { appended: [], appendChild(e) { this.appended.push(e); } },
    createElement: el,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn); },
    fire(type) { (listeners[type] || []).forEach((f) => f()); },
  };
}

function nativeNav() {
  const calls = [];
  return { calls, wakeLock: { async request(type) { calls.push(type); return { async release() {} }; } } };
}

test('native present: enable requests a screen wake lock, no fallback video', async () => {
  const nav = nativeNav();
  const doc = fakeDoc();
  await createWakeLock({ navigator: nav, document: doc }).enable();
  assert.deepStrictEqual(nav.calls, ['screen']);
  assert.strictEqual(doc.body.appended.length, 0);
});

test('native absent: enable creates and plays a fallback video', async () => {
  const doc = fakeDoc();
  await createWakeLock({ navigator: {}, document: doc }).enable();
  assert.strictEqual(doc.body.appended.length, 1);
  assert.strictEqual(doc.body.appended[0].playCount, 1);
});

test('native request rejects: falls back to the video', async () => {
  const nav = { wakeLock: { async request() { throw new Error('not allowed'); } } };
  const doc = fakeDoc();
  await createWakeLock({ navigator: nav, document: doc }).enable();
  assert.strictEqual(doc.body.appended.length, 1);
  assert.strictEqual(doc.body.appended[0].playCount, 1);
});

test('disable releases the native sentinel', async () => {
  const released = [];
  const nav = { wakeLock: { async request() { return { async release() { released.push(true); } }; } } };
  const wl = createWakeLock({ navigator: nav, document: fakeDoc() });
  await wl.enable();
  await wl.disable();
  assert.strictEqual(released.length, 1);
});

test('disable pauses the fallback video', async () => {
  const doc = fakeDoc();
  const wl = createWakeLock({ navigator: {}, document: doc });
  await wl.enable();
  await wl.disable();
  assert.strictEqual(doc.body.appended[0].paused, true);
});

test('visibilitychange→visible re-acquires the native lock', async () => {
  const nav = nativeNav();
  const doc = fakeDoc();
  await createWakeLock({ navigator: nav, document: doc }).enable();
  assert.deepStrictEqual(nav.calls, ['screen']);
  doc.fire('visibilitychange');
  assert.deepStrictEqual(nav.calls, ['screen', 'screen']);
});

test('double enable does not stack; disable when idle is a no-op', async () => {
  const nav = nativeNav();
  const wl = createWakeLock({ navigator: nav, document: fakeDoc() });
  await wl.enable();
  await wl.enable();
  assert.deepStrictEqual(nav.calls, ['screen']);
  await createWakeLock({ navigator: nav, document: fakeDoc() }).disable(); // no throw
});
