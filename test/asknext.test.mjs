import test from 'node:test';
import assert from 'node:assert/strict';
import { nextAskKind, settledSet, settle } from '../src/asknext.js';
import { enqueue, takeNext } from '../src/regionsched.js';

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const ctx = (over = {}) => ({
  regionsOn: true, namesOn: true, regionsAnswered: new Set(), nameWanted: new Set(), named: new Map(), ...over,
});

test('nextAskKind: name first when CoreScope lacks it, then regions, then nothing', () => {
  const c = ctx({ nameWanted: new Set([A]) });
  assert.equal(nextAskKind(c, A), 'owner');
  assert.equal(nextAskKind(c, B), 'regions');
  c.named.set(A, 'BE-NEW-RPT');
  assert.equal(nextAskKind(c, A), 'regions');
  c.regionsAnswered.add(A);
  assert.equal(nextAskKind(c, A), null);
});

test('nextAskKind honours each flag on its own', () => {
  assert.equal(nextAskKind(ctx({ namesOn: false, nameWanted: new Set([A]) }), A), 'regions');
  assert.equal(nextAskKind(ctx({ regionsOn: false }), A), null);
  assert.equal(nextAskKind(ctx({ regionsOn: false, nameWanted: new Set([A]) }), A), 'owner');
});

test('settle keeps a target queued while it still owes the other answer', () => {
  const c = ctx({ nameWanted: new Set([A]) });
  const q = [A, B];
  c.named.set(A, 'X');
  settle(q, c, A);
  assert.deepEqual(q, [A, B]);
  c.regionsAnswered.add(A);
  settle(q, c, A);
  assert.deepEqual(q, [B]);
});

test('settledSet plugs into regionsched: a fully answered repeater is not queued again', () => {
  const c = ctx({ regionsOn: false, nameWanted: new Set([A]) });
  const q = [];
  const opts = { targetGapMs: 30000, maxAsks: 3, forgetMs: 300000 };
  assert.equal(enqueue(q, A, settledSet(c), new Map(), 0, opts), 'queued-now');
  assert.equal(takeNext(q, settledSet(c)), A);
  c.named.set(A, 'X');
  assert.equal(enqueue(q, A, settledSet(c), new Map(), 60000, opts), 'answered');
  assert.equal(enqueue(q, B, settledSet(c), new Map(), 60000, opts), 'answered', 'names only, and B has its name');
});
