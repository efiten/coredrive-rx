// holdUntilReply's DEFAULT timers, which every other test bypasses by passing its own.
//
// Browsers require the native timer functions to be called with the global object as
// `this`: `({ setTimeout }).setTimeout(fn, 0)` throws "TypeError: Illegal invocation"
// in Chromium. Node's setTimeout is an ordinary function and does not check, so a
// default built as an object literal passes every test here and throws on a phone.
//
// It did. Field log 2026-09-18 08:21:06, 08:26:23 and 08:26:54, one per repeater,
// each immediately after the ask went out and each on the one attempt where the
// contact-path override had been applied — so the hold was skipped and the repeater's
// original path was never restored in that session.
//
// The stub below is the browser's rule, not a mock of our code: it throws unless it is
// called with the global as its receiver.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { holdUntilReply, releaseHold } from '../src/regionsched.js';

const A = 'a'.repeat(64);

function withStrictTimers(fn) {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = function strictSetTimeout(cb, ms) {
    if (this !== globalThis && this !== undefined) throw new TypeError('Illegal invocation');
    return realSet(cb, ms);
  };
  globalThis.clearTimeout = function strictClearTimeout(id) {
    if (this !== globalThis && this !== undefined) throw new TypeError('Illegal invocation');
    return realClear(id);
  };
  try { return fn(); } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}

test('the default timers survive a browser receiver check', async () => {
  const waiters = new Map();
  const held = withStrictTimers(() => holdUntilReply(waiters, A, 50));
  assert.strictEqual(typeof held.then, 'function');
  assert.strictEqual(await held, 'timeout');
});

test('releasing a default-timer hold clears its timer without throwing', async () => {
  const waiters = new Map();
  const held = withStrictTimers(() => holdUntilReply(waiters, A, 20000));
  withStrictTimers(() => assert.strictEqual(releaseHold(waiters, A), true));
  assert.strictEqual(await held, 'reply');
  assert.strictEqual(waiters.size, 0);
});
