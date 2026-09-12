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

export const OUTSTANDING_TTL_MS = 120000; // how long an unanswered tag stays matchable

// Two throttles, and they answer different questions. Both come from config.json
// (betaAskGapSec / betaTargetGapSec) so the rig can be retuned on the server between
// drives without a rebuild.
//
//   askGapMs     between ANY two transmitted asks. Stops two rounds overlapping and
//                bounds total airtime. Small by design: a burst of five different
//                repeaters heard at once should all get asked while they are in range.
//   targetGapMs  between two asks to the SAME repeater. This is the one that matters
//                for a node parked in range, which is heard many times a minute:
//                simple_repeater drops anon requests past 4 per 180s shared across all
//                requesters, so asking one node faster than that cannot help and may
//                exhaust its limiter for everyone.
export const DEFAULT_ASK_GAP_MS = 2000;
export const DEFAULT_TARGET_GAP_MS = 15000;

// And two rules that end the asking, because "until it answers" on its own never ends:
// a repeater you keep hearing and that never replies would be asked every targetGap for
// the rest of the session.
//
//   maxAsks    how many unanswered asks one repeater gets per ENCOUNTER. Past this it
//              is dropped, answered or not. simple_repeater allows 4 anon requests per
//              180s across all requesters, so a run much longer than that is spending
//              airtime on a limiter that is already refusing.
//   forgetMs   how long a repeater must be out of earshot before the next reception
//              counts as a NEW encounter and gives it a fresh run of maxAsks. This is
//              what keeps a node met again 40 km later from being written off by a run
//              of failed asks in a spot where it was barely audible.
export const DEFAULT_MAX_ASKS = 6;
export const DEFAULT_FORGET_MS = 5 * 60000;

// noteHeard updates one target's record and reports it. A gap of forgetMs since the
// last reception starts a NEW encounter: the attempt count and the per-target clock are
// cleared, because the next reception is a different meeting with that repeater —
// different place, different distance — and the failures of the last one say nothing
// about this one.
export function noteHeard(targets, target, now, forgetMs) {
  const rec = targets.get(target);
  if (!rec) {
    const fresh = { attempts: 0, lastAskedAt: null, lastHeardAt: now };
    targets.set(target, fresh);
    return fresh;
  }
  if (now - rec.lastHeardAt >= forgetMs) { rec.attempts = 0; rec.lastAskedAt = null; }
  rec.lastHeardAt = now;
  return rec;
}

// enqueue records that this repeater was heard again, and is the only thing that ever
// creates an ask. Four reasons it says no, and the reason is returned rather than a
// bare false so the log can say which:
//   'answered'  it declared its list: done for this session, no encounter reopens it
//   'queued'    already waiting; queueing each reception would ask it twice in a row
//               with nothing heard in between, which measures the queue not the mesh
//   'capped'    this encounter has used its maxAsks
//   'too-soon'  asked less than targetGapMs ago
export function enqueue(queue, target, answered, targets, now, opts) {
  const rec = noteHeard(targets, target, now, opts.forgetMs);
  if (answered.has(target)) return 'answered';
  if (queue.includes(target)) return 'queued';
  if (rec.attempts >= opts.maxAsks) return 'capped';
  if (rec.lastAskedAt != null && now - rec.lastAskedAt < opts.targetGapMs) return 'too-soon';
  queue.push(target);
  return 'queued-now';
}

// markAsked counts the attempt and stamps the per-target clock. Called when an ask is
// actually transmitted, never when one is merely queued, so a target that sat in the
// queue behind others is held off from the moment it went out rather than from the
// moment it was heard.
export function markAsked(targets, target, now) {
  const rec = targets.get(target) ?? { attempts: 0, lastAskedAt: null, lastHeardAt: now };
  rec.attempts++;
  rec.lastAskedAt = now;
  targets.set(target, rec);
}

// dueToSend gates the worker: one round at a time, at most one ask per askGapMs.
// `busy` covers the whole round including the contact-path override hold, so a round
// that has to restore a contact's path cannot be overtaken by the next ask.
export function dueToSend(queue, now, lastSentAt, busy, askGapMs) {
  if (busy || !queue.length) return false;
  return lastSentAt == null || now - lastSentAt >= askGapMs;
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
