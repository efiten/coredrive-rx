import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueue, dueToSend, takeNext, registerOutstanding, matchOutstanding,
  pruneOutstanding, markAnswered, ASK_SPACING_MS, OUTSTANDING_TTL_MS,
} from '../src/regionsprint.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const reply = (tag) => ({ tag, regions: ['be'], truncated: false, repeaterClock: 100 });

test('enqueue takes a repeater the first time it is heard', () => {
  const q = [];
  assert.equal(enqueue(q, A, new Set()), true);
  assert.deepEqual(q, [A]);
});

test('enqueue does not queue the same target twice while it is still waiting', () => {
  // A repeater in range is heard many times a minute. Queuing each reception would
  // ask it twice in a row with nothing heard in between, which measures the queue
  // rather than the mesh. It is re-queued by the NEXT reception after it is asked.
  const q = [A];
  assert.equal(enqueue(q, A, new Set()), false);
  assert.deepEqual(q, [A]);
});

test('enqueue never re-queues a repeater that already declared its list', () => {
  const q = [];
  assert.equal(enqueue(q, A, new Set([A])), false);
  assert.deepEqual(q, []);
});

test('dueToSend holds the 2s spacing and refuses while a round is running', () => {
  const q = [A];
  assert.equal(dueToSend(q, 1_000_000, null, false), true, 'nothing sent yet');
  assert.equal(dueToSend(q, 1_000_000, 1_000_000 - 1999, false), false, 'inside the spacing');
  assert.equal(dueToSend(q, 1_000_000, 1_000_000 - ASK_SPACING_MS, false), true);
  assert.equal(dueToSend(q, 1_000_000, null, true), false, 'a round is still running');
  assert.equal(dueToSend([], 1_000_000, null, false), false, 'nothing queued');
});

test('takeNext skips a target that answered while it sat in the queue', () => {
  const q = [A, B];
  assert.equal(takeNext(q, new Set([A])), B);
  assert.deepEqual(q, []);
});

test('takeNext returns null once the queue holds nothing askable', () => {
  const q = [A];
  assert.equal(takeNext(q, new Set([A])), null);
});

test('a reply is attributed by the tag it echoes, not by "something is outstanding"', () => {
  // Several requests are in flight at once here, so the tag is the only evidence of
  // who answered. Getting this wrong files one repeater's regions under another.
  const out = new Map();
  registerOutstanding(out, 0x1111, A, 1_000_000);
  registerOutstanding(out, 0x2222, B, 1_000_002);
  const hit = matchOutstanding(out, reply(0x2222));
  assert.equal(hit.target, B);
  assert.equal(out.has(0x2222), false, 'the answered tag is consumed');
  assert.equal(out.has(0x1111), true, 'the other request stays matchable');
});

test('a reply whose tag matches nothing outstanding is dropped, not guessed at', () => {
  const out = new Map();
  registerOutstanding(out, 0x1111, A, 1_000_000);
  assert.equal(matchOutstanding(out, reply(0xdeadbeef)), null);
  assert.equal(out.size, 1);
});

test('pruneOutstanding drops tags too old to still be answered', () => {
  const out = new Map();
  registerOutstanding(out, 0x1111, A, 1_000_000);
  registerOutstanding(out, 0x2222, B, 1_000_000 + OUTSTANDING_TTL_MS);
  assert.equal(pruneOutstanding(out, 1_000_000 + OUTSTANDING_TTL_MS), 1);
  assert.deepEqual(Array.from(out.keys()), [0x2222]);
});

test('markAnswered also cancels the ask this target has queued', () => {
  const q = [B, A];
  const answered = new Set();
  markAnswered(answered, q, A);
  assert.deepEqual(q, [B]);
  assert.equal(answered.has(A), true);
});
