// Timer catch-up driven by frames and GPS fixes (src/catchup.js).
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { catchUpPlan, CATCHUP } from '../src/catchup.js';

const base = { now: 100000, lastTickAt: 99500, lastDrainAt: 98000, rfDueAt: 120000, publisherDown: false, lastKickAt: null };
const none = { tick: false, drain: false, rf: false, reconnect: false };

test('nothing to do while the timers keep time', () => {
  assert.deepStrictEqual(catchUpPlan(base), none);
});

test('a timer that is only a little late is left to fire itself', () => {
  const s = { ...base, lastTickAt: base.now - CATCHUP.tickMs - CATCHUP.slackMs + 1, lastDrainAt: base.now - CATCHUP.drainMs - CATCHUP.slackMs + 1, rfDueAt: base.now - CATCHUP.slackMs + 1 };
  assert.deepStrictEqual(catchUpPlan(s), none);
});

test('frozen timers: tick, drain and the RF sample all run from the event', () => {
  const s = { ...base, lastTickAt: base.now - 600000, lastDrainAt: base.now - 600000, rfDueAt: base.now - 300000 };
  assert.deepStrictEqual(catchUpPlan(s), { tick: true, drain: true, rf: true, reconnect: false });
});

test('jobs that never ran or have nothing scheduled are not caught up', () => {
  assert.deepStrictEqual(catchUpPlan({ ...base, lastTickAt: null, lastDrainAt: null, rfDueAt: null }), none);
});

test('a dead broker link is reopened only when the drain timer is late too', () => {
  assert.strictEqual(catchUpPlan({ ...base, publisherDown: true }).reconnect, false);
  const frozen = { ...base, lastDrainAt: base.now - 60000, publisherDown: true };
  assert.strictEqual(catchUpPlan(frozen).reconnect, true);
  assert.strictEqual(catchUpPlan({ ...frozen, publisherDown: false }).reconnect, false);
});

test('forced reconnects are spaced at least kickMs apart', () => {
  const frozen = { ...base, lastDrainAt: base.now - 60000, publisherDown: true };
  assert.strictEqual(catchUpPlan({ ...frozen, lastKickAt: base.now - CATCHUP.kickMs + 1 }).reconnect, false);
  assert.strictEqual(catchUpPlan({ ...frozen, lastKickAt: base.now - CATCHUP.kickMs }).reconnect, true);
});
