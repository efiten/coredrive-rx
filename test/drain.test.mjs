// Draining the offline queue. Every case here is a field failure or a near miss:
// a mobile link that stays up for about a second at a time, and a queue that must
// not lose or duplicate what it already delivered.
import { test } from 'node:test';
import assert from 'node:assert';
import { drainOnce, COMMIT_EVERY, POISON_AFTER } from '../src/drain.js';

// fakeQueue records exactly what was removed and when, which is the whole question.
function fakeQueue(n) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i + 1, raw: 'aa' }));
  return {
    rows,
    removals: [],
    async takeAll() { return this.rows.slice(); },
    async remove(ids) { this.removals.push(ids.slice()); this.rows = this.rows.filter((r) => !ids.includes(r.id)); },
    remaining() { return this.rows.map((r) => r.id); },
  };
}

// fakePublisher: `plan` decides each publish by 1-based call number —
// 'ok' | 'reject' | 'drop' (reject AND the link goes down, as a real drop does).
function fakePublisher(plan) {
  return {
    calls: 0,
    up: true,
    connected() { return this.up; },
    async publish() {
      this.calls++;
      const verdict = typeof plan === 'function' ? plan(this.calls) : (plan[this.calls] || 'ok');
      if (verdict === 'drop') { this.up = false; throw new Error('publish timeout'); }
      if (verdict === 'reject') throw new Error('publish timeout');
      return undefined;
    },
  };
}

const base = (queue, publisher, failures = new Map()) =>
  ({ queue, publisher, pubkey: 'ab'.repeat(32), name: 'obs', failures });

test('a clean run publishes and removes everything', async () => {
  const q = fakeQueue(5);
  const r = await drainOnce(base(q, fakePublisher({})));
  assert.strictEqual(r.published, 5);
  assert.strictEqual(r.committed, 5);
  assert.strictEqual(r.stopped, 'done');
  assert.deepStrictEqual(q.remaining(), []);
});

test('a link that dies mid-flush KEEPS the records it already delivered', async () => {
  // The bug this replaces: `queue.remove` ran only after the loop completed, so a
  // throw discarded every acknowledgement earned before it. On a link that stays up
  // for about a second, that meant the queue could never commit anything at all.
  const q = fakeQueue(20);
  const p = fakePublisher({ 4: 'drop' });
  const r = await drainOnce(base(q, p));
  assert.strictEqual(r.published, 3, 'three were acknowledged before the drop');
  assert.strictEqual(r.committed, 3, 'and all three must be committed');
  assert.deepStrictEqual(q.remaining(), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
});

test('nothing acknowledged is ever left behind to be sent twice', async () => {
  const q = fakeQueue(9);
  const p = fakePublisher({ 7: 'drop' });
  await drainOnce(base(q, p));
  const removed = q.removals.flat();
  assert.deepStrictEqual(removed, [1, 2, 3, 4, 5, 6], 'exactly the acked ids, no more, no less');
  assert.strictEqual(new Set(removed).size, removed.length, 'and never removed twice');
});

test('progress is committed in batches, not only at the end', async () => {
  const q = fakeQueue(COMMIT_EVERY * 2 + 3);
  const p = fakePublisher({});
  await drainOnce(base(q, p));
  assert.ok(q.removals.length >= 3, 'expected several commits, got ' + q.removals.length);
  assert.strictEqual(q.removals[0].length, COMMIT_EVERY);
});

test('a dropped link stops the pass instead of burning a timeout per remaining record', async () => {
  // 59 records × an 8 s publish timeout is eight minutes of pointless waiting
  // against a socket that is already gone.
  const q = fakeQueue(59);
  const p = fakePublisher({ 2: 'drop' });
  const r = await drainOnce(base(q, p));
  assert.strictEqual(p.calls, 2, 'must not keep publishing after the link went down');
  assert.strictEqual(r.stopped, 'link');
});

test('a transient failure retries the SAME record next pass rather than skipping it', async () => {
  const q = fakeQueue(4);
  const failures = new Map();
  const r = await drainOnce(base(q, fakePublisher({ 1: 'reject' }), failures));
  assert.strictEqual(r.published, 0);
  assert.strictEqual(r.skipped, 0, 'one failure is not yet evidence the record is bad');
  assert.strictEqual(r.stopped, 'error');
  assert.deepStrictEqual(q.remaining(), [1, 2, 3, 4], 'nothing lost');
  assert.strictEqual(failures.get(1), 1);
});

test('a record that keeps failing is stepped over so it cannot block the queue', async () => {
  // Otherwise one permanently unpublishable row at the head of the queue stops
  // every reception behind it, forever.
  const q = fakeQueue(3);
  const failures = new Map();
  const alwaysFailFirst = (call) => (call === 1 ? 'reject' : 'ok');
  for (let pass = 1; pass < POISON_AFTER; pass++) {
    const r = await drainOnce(base(q, fakePublisher(alwaysFailFirst), failures));
    assert.strictEqual(r.published, 0, 'pass ' + pass + ' should still be retrying record 1');
  }
  const last = await drainOnce(base(q, fakePublisher(alwaysFailFirst), failures));
  assert.strictEqual(last.skipped, 1, 'record 1 is now treated as unpublishable');
  assert.strictEqual(last.published, 2, 'and the records behind it finally go out');
  assert.deepStrictEqual(q.remaining(), [1], 'the skipped record is kept, not discarded');
});

test('a record that recovers clears its failure count', async () => {
  const q = fakeQueue(2);
  const failures = new Map();
  await drainOnce(base(q, fakePublisher({ 1: 'reject' }), failures));
  assert.strictEqual(failures.get(1), 1);
  await drainOnce(base(q, fakePublisher({}), failures));
  assert.strictEqual(failures.has(1), false, 'a success must not leave a stale strike behind');
  assert.deepStrictEqual(q.remaining(), []);
});

test('no publisher, no connection or no pubkey is a no-op, not an error', async () => {
  const q = fakeQueue(3);
  for (const deps of [
    { ...base(q, null) },
    { ...base(q, { connected: () => false, publish: async () => {} }) },
    { ...base(q, fakePublisher({})), pubkey: '' },
  ]) {
    const r = await drainOnce(deps);
    assert.strictEqual(r.published, 0);
    assert.strictEqual(r.stopped, 'link');
  }
  assert.deepStrictEqual(q.remaining(), [1, 2, 3], 'and the queue is untouched');
});

test('an empty queue publishes nothing and commits nothing', async () => {
  const q = fakeQueue(0);
  const r = await drainOnce(base(q, fakePublisher({})));
  assert.deepStrictEqual(r, { published: 0, committed: 0, skipped: 0, stopped: 'done' });
  assert.strictEqual(q.removals.length, 0, 'must not call remove([]) for nothing');
});

test('repeated LINK drops never quarantine an innocent record', async () => {
  // A drop is the link's fault. Counting it against the record meant three drops in
  // a row wrongly marked a good reception unpublishable and stepped over it.
  const q = fakeQueue(3);
  const failures = new Map();
  for (let pass = 0; pass <= POISON_AFTER + 1; pass++) {
    const r = await drainOnce(base(q, fakePublisher({ 1: 'drop' }), failures));
    assert.strictEqual(r.skipped, 0, 'pass ' + pass + ' must not skip anything');
    assert.strictEqual(r.stopped, 'link');
  }
  assert.strictEqual(failures.size, 0, 'no strikes may accumulate from link drops');
  assert.deepStrictEqual(q.remaining(), [1, 2, 3], 'nothing lost, nothing skipped');
});

// --- serialiseDrain: two passes must never publish the same rows -------------

test('serialiseDrain joins a concurrent caller onto the pass already running', async () => {
  // Field evidence: "published 59 record(s)" followed one second later by
  // "published 49 record(s)" for a 59-record queue. 59 - 49 = 10 = COMMIT_EVERY:
  // a second pass called takeAll() after the first had committed its opening batch,
  // saw the other 49 still queued, and delivered every one of them a second time.
  // Callers are drainLoop (5 s), the broker 'connect' event, the 'online' event and
  // the Push button — none of which coordinated.
  const { serialiseDrain } = await import('../src/drain.js');
  let starts = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const drain = serialiseDrain(async () => { starts++; await gate; return 'result'; });

  const a = drain();
  const b = drain();
  const c = drain();
  release();
  assert.deepStrictEqual(await Promise.all([a, b, c]), ['result', 'result', 'result']);
  assert.strictEqual(starts, 1, 'exactly one pass may run');
});

test('serialiseDrain allows a NEW pass once the previous one finished', async () => {
  const { serialiseDrain } = await import('../src/drain.js');
  let starts = 0;
  const drain = serialiseDrain(async () => { starts++; });
  await drain();
  await drain();
  assert.strictEqual(starts, 2);
});

test('serialiseDrain releases the slot after a rejection, and propagates it', async () => {
  // A failed pass must not wedge every future drain — that would be the config-load
  // bug all over again, in the publish path.
  const { serialiseDrain } = await import('../src/drain.js');
  let starts = 0;
  const drain = serialiseDrain(async () => { starts++; if (starts === 1) throw new Error('boom'); return 'ok'; });
  await assert.rejects(() => drain(), /boom/);
  assert.strictEqual(await drain(), 'ok', 'the slot must be free again');
  assert.strictEqual(starts, 2);
});

// --- hold until linked (src/account.js shouldHold) ---------------------------

test('a held pass publishes nothing and leaves the queue exactly as it was', async () => {
  const q = fakeQueue(4);
  let reads = 0;
  const takeAll = q.takeAll.bind(q);
  q.takeAll = async () => { reads++; return takeAll(); };
  const p = fakePublisher({});
  const r = await drainOnce({ ...base(q, p), hold: () => true });
  assert.deepStrictEqual(r, { published: 0, committed: 0, skipped: 0, stopped: 'held' });
  assert.strictEqual(p.calls, 0);
  assert.strictEqual(reads, 0, 'the queue is not even read');
  assert.deepStrictEqual(q.removals, []);
  assert.deepStrictEqual(q.remaining(), [1, 2, 3, 4]);
});

test('without a hold function the pass is exactly as before', async () => {
  const q = fakeQueue(3);
  const r = await drainOnce(base(q, fakePublisher({})));
  assert.strictEqual(r.published, 3);
  assert.strictEqual(r.stopped, 'done');
});

test('a hold that lifts releases the whole queue on the next pass', async () => {
  const q = fakeQueue(5);
  const p = fakePublisher({});
  let held = true;
  const hold = () => held;
  assert.strictEqual((await drainOnce({ ...base(q, p), hold })).stopped, 'held');
  held = false;
  const r = await drainOnce({ ...base(q, p), hold });
  assert.strictEqual(r.published, 5);
  assert.deepStrictEqual(q.remaining(), []);
});

test('a broker link that is down still reports "link", not "held"', async () => {
  const q = fakeQueue(2);
  const p = fakePublisher({});
  p.up = false;
  assert.strictEqual((await drainOnce({ ...base(q, p), hold: () => true })).stopped, 'link');
});
