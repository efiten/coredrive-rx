// BETA scheduler for region discovery: ask every repeater, every time it is heard,
// until it answers. Built as a measurement, not as a replacement for src/regionreq.js.
//
// What it deliberately does NOT do, all of which the production scheduler does:
//   - no shared one-ask-per-60s airtime budget
//   - no per-target retry backoff (5/15/30 minutes)
//   - no single in-flight slot: several requests may be outstanding at once, so a
//     reply can no longer be matched by "the one pending request" and is matched on
//     the 4-byte tag the companion echoes back instead
//
// The premise under test is that a moving receiver passes from node to node, so the
// same repeater is never asked often enough to matter. Two things can falsify it and
// this module is instrumented for both: simple_repeater rate-limits anon requests to
// 4 per 180s shared across all requesters and all types, and a target parked in range
// is re-queued on every single reception.
//
// Everything here is pure: no DOM, no transport, no timers. app.js does the wiring.

export const ASK_SPACING_MS = 2000; // minimum gap between two transmitted asks
export const OUTSTANDING_TTL_MS = 120000; // how long an unanswered tag stays matchable

// enqueue adds one target to the back of the queue. A target already queued is not
// added twice: it would be asked twice in a row with nothing heard in between, which
// measures the queue rather than the mesh. A target that has answered is never queued
// again this session — that is the one rule this beta keeps.
export function enqueue(queue, target, answered) {
  if (answered.has(target) || queue.includes(target)) return false;
  queue.push(target);
  return true;
}

// dueToSend gates the worker: one ask at a time, at most one per ASK_SPACING_MS.
// `busy` covers the whole round including the contact-path override hold, so a
// round that has to restore a contact's path cannot be overtaken by the next ask.
export function dueToSend(queue, now, lastSentAt, busy, opts = {}) {
  if (busy || !queue.length) return false;
  return lastSentAt == null || now - lastSentAt >= (opts.spacingMs ?? ASK_SPACING_MS);
}

// takeNext pops the next target that has not answered in the meantime. A target can
// answer while it is still sitting in the queue (a reply to an earlier ask arrives
// late), and asking it again would spend airtime on an answer already in hand.
export function takeNext(queue, answered) {
  while (queue.length) {
    const target = queue.shift();
    if (!answered.has(target)) return target;
  }
  return null;
}

export function registerOutstanding(outstanding, tag, target, now) {
  outstanding.set(tag, { target, sentAt: now });
}

// matchOutstanding attributes a reply to the request whose tag it echoes. With several
// requests in flight the tag is the ONLY evidence of who answered: matching on "some
// request is outstanding" would file one repeater's declared regions under another and
// store it as fact. An unmatched reply is dropped rather than guessed at.
export function matchOutstanding(outstanding, parsed) {
  if (!parsed || parsed.tag == null) return null;
  const hit = outstanding.get(parsed.tag);
  if (!hit) return null;
  outstanding.delete(parsed.tag);
  return {
    target: hit.target,
    regions: parsed.regions,
    truncated: parsed.truncated,
    repeaterClock: parsed.repeaterClock,
  };
}

// pruneOutstanding drops tags too old to still be answered. Unbounded growth is the
// real risk here: this beta transmits up to 30 asks a minute and most go unanswered.
// Returns how many were dropped.
export function pruneOutstanding(outstanding, now, ttlMs = OUTSTANDING_TTL_MS) {
  let dropped = 0;
  for (const [tag, rec] of outstanding) {
    if (now - rec.sentAt >= ttlMs) { outstanding.delete(tag); dropped++; }
  }
  return dropped;
}

// markAnswered records the answer and takes the target out of the queue, so a reply
// that lands while the target is queued again cancels that pending ask too.
export function markAnswered(answered, queue, target) {
  answered.add(target);
  const at = queue.indexOf(target);
  if (at >= 0) queue.splice(at, 1);
}
