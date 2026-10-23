// What a repeater in range still has to be asked: its name (ANON_REQ_TYPE_OWNER) or
// its regions (ANON_REQ_TYPE_REGIONS). Both requests go through ONE queue and one
// per-encounter budget (src/regionsched.js), for two reasons in the firmware:
//
//   - the companion tracks a single pending anon request; every send clears the one
//     before it (companion_radio/MyMesh.cpp:1570 clearPendingReqs), so a second ask
//     sent before the first reply lands throws that reply away;
//   - the repeater's anon limiter (4 per 180s) is shared across request types, so two
//     queues would double one repeater's load.
//
// ctx = { regionsOn, namesOn, regionsAnswered: Set, nameWanted: Set, named: Map }.
// nameWanted holds only pubkeys CoreScope answered for without a name.

// nextAskKind returns 'owner', 'regions', or null when nothing is owed. The name goes
// first: it is the rarer gap, and a repeater that answers one ask usually answers the
// next one too.
export function nextAskKind(ctx, target) {
  if (ctx.namesOn && ctx.nameWanted.has(target) && !ctx.named.has(target)) return 'owner';
  if (ctx.regionsOn && !ctx.regionsAnswered.has(target)) return 'regions';
  return null;
}

// settledSet adapts nextAskKind to the `answered` argument of enqueue/takeNext in
// src/regionsched.js: a target counts as answered once it owes nothing.
export function settledSet(ctx) {
  return { has: (target) => nextAskKind(ctx, target) === null };
}

// settle takes a target out of the queue once its last owed answer is in. An answer
// that leaves another request owed keeps it queued.
export function settle(queue, ctx, target) {
  if (nextAskKind(ctx, target) !== null) return;
  const at = queue.indexOf(target);
  if (at >= 0) queue.splice(at, 1);
}
