// Catch-up for work that runs on timers. With the screen off, the Android WebView
// stopped running JavaScript timers while Bluetooth frames and GPS fixes still arrived
// (field log 2026-11-10: eleven minutes of receptions, no upload, no RF sample, no
// discover, and a broker link that had died for want of a keepalive). Every frame and
// fix therefore asks catchUpPlan which timed jobs are overdue and runs them itself.
//
// The slack keeps this out of the way while timers do run: a job counts as overdue
// only well after its own timer should have fired.

export const CATCHUP = {
  tickMs: 1000,      // monitorTick interval (src/app.js)
  drainMs: 5000,     // drainLoop interval (src/app.js)
  slackMs: 3000,     // how late a timer may be before an event runs the job instead
  kickMs: 15000,     // at most one forced broker reconnect per this many ms
};

// catchUpPlan decides, from timestamps only, what an incoming event should run.
//   s = { now, lastTickAt, lastDrainAt, rfDueAt, publisherDown, lastKickAt }
// lastTickAt / lastDrainAt: when that job last ran (null = never, nothing to catch up).
// rfDueAt: when the scheduled RF sample is due (null = none scheduled or one running).
// Returns { tick, drain, rf, reconnect } booleans.
export function catchUpPlan(s, c = CATCHUP) {
  const late = (at, period) => at != null && s.now - at >= period + c.slackMs;
  const drain = late(s.lastDrainAt, c.drainMs);
  return {
    tick: late(s.lastTickAt, c.tickMs),
    drain,
    rf: s.rfDueAt != null && s.now - s.rfDueAt >= c.slackMs,
    // Only when the drain timer is late as well: with timers running, mqtt.js's own
    // reconnect timer is in charge and a second attempt would only get in its way.
    reconnect: drain && !!s.publisherDown && (s.lastKickAt == null || s.now - s.lastKickAt >= c.kickMs),
  };
}
