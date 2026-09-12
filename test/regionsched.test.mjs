import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueue, dueToSend, takeNext, registerOutstanding, matchOutstanding,
  pruneOutstanding, markAnswered, markAsked, noteHeard, newSignalRange, noteSignal, DEFAULT_ASK_GAP_MS,
  DEFAULT_TARGET_GAP_MS, DEFAULT_MAX_ASKS, DEFAULT_FORGET_MS, OUTSTANDING_TTL_MS,
  DEFAULT_BONUS_SNR_DB,
} from '../src/regionsched.js';

const GAP = DEFAULT_TARGET_GAP_MS;
const OPTS = { targetGapMs: GAP, maxAsks: DEFAULT_MAX_ASKS, forgetMs: DEFAULT_FORGET_MS, bonusSnrDb: DEFAULT_BONUS_SNR_DB };
// A shorter allowance keeps the cap and bonus tests to two asks instead of four; the
// rules under test do not depend on the number.
const SMALL_CAP = { ...OPTS, maxAsks: 2 };

// spend sends one ask to A per snr given, one every targetGap, and returns the clock
// just after the last one.
function spend(targets, snrs, opts = SMALL_CAP, t0 = 1_000_000) {
  let now = t0;
  for (const snr of snrs) {
    enqueue([], A, new Set(), targets, now, opts, snr);
    markAsked(targets, A, now, snr);
    now += GAP;
  }
  return now;
}
const never = () => new Map();

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const reply = (tag) => ({ tag, regions: ['be'], truncated: false, repeaterClock: 100 });

test('enqueue takes a repeater the first time it is heard', () => {
  const q = [];
  assert.equal(enqueue(q, A, new Set(), never(), 1_000_000, OPTS), 'queued-now');
  assert.deepEqual(q, [A]);
});

test('enqueue does not queue the same target twice while it is still waiting', () => {
  // A repeater in range is heard many times a minute. Queuing each reception would
  // ask it twice in a row with nothing heard in between, which measures the queue
  // rather than the mesh. It is re-queued by the NEXT reception after it is asked.
  const q = [A];
  assert.equal(enqueue(q, A, new Set(), never(), 1_000_000, OPTS), 'queued');
  assert.deepEqual(q, [A]);
});

test('enqueue never re-queues a repeater that already declared its list', () => {
  const q = [];
  assert.equal(enqueue(q, A, new Set([A]), never(), 1_000_000, OPTS), 'answered');
  assert.deepEqual(q, []);
});

test('enqueue holds the same repeater off for targetGapMs after it was asked', () => {
  // A repeater parked in range is heard many times a minute, and simple_repeater drops
  // anon requests past 4 per 180s shared across all requesters — asking it on every
  // single reception cannot help and can exhaust its limiter for everyone.
  const targets = new Map([[A, { attempts: 1, lastAskedAt: 1_000_000, lastHeardAt: 1_000_000 }]]);
  const justTooSoon = [];
  assert.equal(enqueue(justTooSoon, A, new Set(), targets, 1_000_000 + GAP - 1, OPTS), 'too-soon');
  assert.deepEqual(justTooSoon, []);

  const dueAgain = [];
  assert.equal(enqueue(dueAgain, A, new Set(), targets, 1_000_000 + GAP, OPTS), 'queued-now');
  assert.deepEqual(dueAgain, [A]);
});

test('an unanswered repeater is dropped after maxAsks, however often it is heard', () => {
  // Without this the only exit is an answer, so a repeater held in range that never
  // replies is asked every targetGap for the rest of the session.
  const targets = new Map();
  const q = [];
  const now = spend(targets, [-4, -4]);
  assert.equal(targets.get(A).attempts, SMALL_CAP.maxAsks);
  assert.equal(enqueue(q, A, new Set(), targets, now, SMALL_CAP, -4), 'capped');
  // And it stays capped for as long as we keep hearing it. Each reception refreshes
  // lastHeardAt, so the encounter never ends and the count is never reset — stepping
  // straight to now + forgetMs instead would be a NEW encounter by definition, which
  // is a different rule and has its own test below.
  for (let i = 1; i <= 5; i++) {
    assert.equal(enqueue(q, A, new Set(), targets, now + GAP * i, SMALL_CAP, -4), 'capped', 'reception ' + i);
  }
  assert.deepEqual(q, []);
});

test('a repeater met again after forgetMs gets a fresh run — a new encounter is new evidence', () => {
  // The same node 40 km later is a different distance and a different antenna aspect.
  // Writing it off for the session because it was inaudible once loses exactly the
  // repeaters a drive exists to reach.
  const targets = new Map();
  const q = [];
  const now = spend(targets, [-4, -4]);
  assert.equal(enqueue(q, A, new Set(), targets, now, SMALL_CAP, -4), 'capped');
  const later = now + DEFAULT_FORGET_MS;
  assert.equal(enqueue(q, A, new Set(), targets, later, SMALL_CAP, -4), 'queued-now');
  assert.equal(targets.get(A).attempts, 0, 'the new encounter starts clean');
});

test('an answered repeater is never reopened, not even by a new encounter', () => {
  const targets = new Map([[A, { attempts: 0, lastAskedAt: null, lastHeardAt: 1_000_000 }]]);
  const answered = new Set([A]);
  assert.equal(enqueue([], A, answered, targets, 1_000_000 + DEFAULT_FORGET_MS * 3, OPTS), 'answered');
});

test('noteHeard keeps one encounter alive as long as receptions keep arriving', () => {
  // The encounter must be ended by SILENCE, not by elapsed time: a node heard steadily
  // for ten minutes is one meeting, and must not be handed a fresh run of asks halfway.
  const targets = new Map();
  let now = 1_000_000;
  noteHeard(targets, A, now, DEFAULT_FORGET_MS);
  markAsked(targets, A, now);
  for (let i = 0; i < 20; i++) {
    now += DEFAULT_FORGET_MS - 1000; // just inside the window, every time
    noteHeard(targets, A, now, DEFAULT_FORGET_MS);
  }
  assert.equal(targets.get(A).attempts, 1, 'still the same encounter');
});

test('the per-target clock starts when the ask goes out, not when it was queued', () => {
  // A target can sit in the queue behind others. Holding it off from the moment it was
  // HEARD would let a busy queue shorten the gap between two transmissions to it.
  const targets = new Map();
  markAsked(targets, A, 1_000_000);
  assert.equal(targets.get(A).lastAskedAt, 1_000_000);
  assert.equal(enqueue([], A, new Set(), targets, 1_000_000 + 1000, OPTS), 'too-soon');
});

test('dueToSend holds the ask gap and refuses while a round is running', () => {
  const q = [A];
  const gap = DEFAULT_ASK_GAP_MS;
  assert.equal(dueToSend(q, 1_000_000, null, false, gap), true, 'nothing sent yet');
  assert.equal(dueToSend(q, 1_000_000, 1_000_000 - (gap - 1), false, gap), false, 'inside the gap');
  assert.equal(dueToSend(q, 1_000_000, 1_000_000 - gap, false, gap), true);
  assert.equal(dueToSend(q, 1_000_000, null, true, gap), false, 'a round is still running');
  assert.equal(dueToSend([], 1_000_000, null, false, gap), false, 'nothing queued');
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
  assert.equal(pruneOutstanding(out, 1_000_000 + OUTSTANDING_TTL_MS).length, 1);
  assert.deepEqual(Array.from(out.keys()), [0x2222]);
});

test('markAnswered also cancels the ask this target has queued', () => {
  const q = [B, A];
  const answered = new Set();
  markAnswered(answered, q, A);
  assert.deepEqual(q, [B]);
  assert.equal(answered.has(A), true);
});

// --- Signal of the reception each ask went out on ------------------------------
// Three drives suggested that an answer only ever came from a reception at roughly
// -109 dBm or better, but that was assembled by hand from pairs of log lines that the
// ring buffer rolls out. The ask carries its own conditions now, so one drive can
// confirm or kill the idea of a signal floor.

test('an ask carries the signal of the reception that triggered it into its reply', () => {
  const out = new Map();
  registerOutstanding(out, 0x1111, A, 1_000_000, 1.75, -104);
  const hit = matchOutstanding(out, reply(0x1111));
  assert.equal(hit.snr, 1.75);
  assert.equal(hit.rssi, -104);
});

test('a timed-out ask hands its signal back — silence is the other half of the measurement', () => {
  const out = new Map();
  registerOutstanding(out, 0x1111, A, 1_000_000, -9.5, -119);
  registerOutstanding(out, 0x2222, B, 1_000_000 + OUTSTANDING_TTL_MS, 7, -102);
  const dropped = pruneOutstanding(out, 1_000_000 + OUTSTANDING_TTL_MS);
  assert.equal(dropped.length, 1);
  assert.deepEqual([dropped[0].target, dropped[0].snr, dropped[0].rssi], [A, -9.5, -119]);
  assert.equal(out.size, 1, 'the one still inside its window stays matchable');
});

test('noteSignal widens a range and survives a missing snr or rssi', () => {
  const r = newSignalRange();
  noteSignal(r, 1.75, -104);
  noteSignal(r, -0.5, -111);
  noteSignal(r, null, null);
  assert.equal(r.n, 3, 'every ask counts, even one the companion reported no signal for');
  assert.deepEqual([r.rssiMin, r.rssiMax], [-111, -104]);
  assert.deepEqual([r.snrMin, r.snrMax], [-0.5, 1.75]);
});

test('an empty range stays empty rather than reporting Infinity', () => {
  const r = newSignalRange();
  assert.equal(r.n, 0);
  assert.equal(r.rssiMin, null);
});

// The repeater's own limiter (anon_limiter(4, 180) in simple_repeater/MyMesh.cpp) is
// deliberately NOT mirrored here — see the note in src/regionsched.js. What bounds one
// repeater's load is the encounter, and these are its rules.

// --- The signal bonus ---------------------------------------------------------
// Field case, 2026-09-12: efef79435050 spent its whole encounter allowance between
// 21:06:50 and 21:08:08 on receptions around -115 dBm, all unanswered, and was then
// heard from 21:09:37 at -76 to -69 dBm with nothing left to spend.

test('a much stronger reception buys one more ask after the cap is reached', () => {
  const targets = new Map();
  const q = [];
  const now = spend(targets, [-4, -4]);
  assert.equal(enqueue(q, A, new Set(), targets, now, SMALL_CAP, -3), 'capped', 'a hair better is not better');
  assert.equal(enqueue(q, A, new Set(), targets, now, SMALL_CAP, -4 + DEFAULT_BONUS_SNR_DB), 'bonus');
  assert.deepEqual(q, [A]);
});

test('the bonus is once per encounter', () => {
  const targets = new Map();
  const q = [];
  let now = spend(targets, [-10, -10]);
  assert.equal(enqueue(q, A, new Set(), targets, now, SMALL_CAP, 2), 'bonus');
  q.length = 0;
  markAsked(targets, A, now, 2);
  now += GAP;
  assert.equal(enqueue(q, A, new Set(), targets, now, SMALL_CAP, 11), 'capped',
    'stronger again, but this encounter has had its extra ask');
});

test('the bonus compares against the best ask so far, not the last one', () => {
  // Otherwise a run that happens to end on a bad reception hands out a bonus for a
  // signal no better than one already spent.
  const targets = new Map();
  const q = [];
  const now = spend(targets, [-10, 2]); // the good one is not the last one
  assert.equal(targets.get(A).bestAskSnr, 2);
  assert.equal(enqueue(q, A, new Set(), targets, now, SMALL_CAP, 4), 'capped', '2 dB better than the best is not enough');
  assert.equal(enqueue(q, A, new Set(), targets, now, SMALL_CAP, 8), 'bonus', '6 dB better than the best is');
});

test('a reception with no signal reported can never earn the bonus', () => {
  const targets = new Map();
  const now = spend(targets, [-4, -4]);
  assert.equal(enqueue([], A, new Set(), targets, now, SMALL_CAP, null), 'capped');
});

test('a new encounter clears the bonus and the best-ask mark', () => {
  const targets = new Map();
  const t0 = 1_000_000;
  spend(targets, [5], SMALL_CAP, t0);
  const rec = targets.get(A);
  assert.equal(rec.bestAskSnr, 5);

  enqueue([], A, new Set(), targets, t0 + DEFAULT_FORGET_MS, SMALL_CAP, -8);
  assert.equal(rec.attempts, 0, 'fresh run');
  assert.equal(rec.bestAskSnr, null, 'nothing to beat yet');
  assert.equal(rec.bonusUsed, false, 'and a fresh bonus to spend');
});
