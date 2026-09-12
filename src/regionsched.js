// Region-discovery scheduling: which repeater to ask, when, and when to stop.
//
// The rule is that a repeater is asked while we are hearing it, and not otherwise.
// Everything else here exists to bound that. What this replaced is worth keeping
// written down, because all three limits seemed reasonable and all three cost answers:
//
//   - a shared one-ask-per-60s airtime budget. One ask, from wherever, blocked every
//     repeater heard in the following minute. The 2026-09-11 log has a repeater heard
//     at -102 dBm skipped because the budget had gone 31 seconds earlier on the SAME
//     node at -120.
//   - a 5/15/30-minute per-target retry backoff counted per session. A repeater asked
//     once from a bad spot was locked out for the rest of the drive, including when it
//     was later heard at close range.
//   - a single in-flight slot with a 20s timeout, which capped the feature at three
//     asks a minute, and at one per session whenever a request went unanswered.
//
// Replies are therefore matched on the 4-byte tag the companion echoes back: several
// requests can be outstanding at once, and "something is pending" would file one
// repeater's regions under another.
//
// Everything here is pure: no DOM, no transport, no timers. app.js does the wiring.

export const OUTSTANDING_TTL_MS = 120000; // how long an unanswered tag stays matchable

// Four limits, all settable in config.json so a deployment on another mesh can retune
// them without a rebuild. The two that bound ONE repeater's load come from the
// firmware's own limiter: simple_repeater accepts 4 anon requests per 180s, shared
// across every requester and every request type. That is one per 45 seconds for
// everybody together, so a client that asks one node faster than that cannot be
// answered and is spending someone else's quota.
//
//   askGapMs     between ANY two transmitted asks. Small by design: five different
//                repeaters heard at once should all be asked while they are in range.
//   targetGapMs  between two asks to the SAME repeater. 30s is deliberately shorter
//                than the limiter's 45s, because at road speed a node is often out of
//                range before 45 seconds are up: the real choice there is between one
//                more try and no second try at all.
//   maxAsks      unanswered asks per ENCOUNTER, and this is what keeps the total
//                inside the limiter rather than targetGapMs — three asks 30s apart is
//                3 in any 180s window, under the 4 the firmware allows.
//   forgetMs     silence after which the next reception counts as a NEW encounter with
//                a fresh run. The same repeater met again 40 km later is a different
//                distance and a different antenna aspect; the failures of the last
//                meeting say nothing about this one.
export const DEFAULT_ASK_GAP_MS = 2000;
export const DEFAULT_TARGET_GAP_MS = 30000;
export const DEFAULT_MAX_ASKS = 4;
export const DEFAULT_FORGET_MS = 5 * 60000;

// The firmware's limiter, mirrored here as a hard per-target ceiling rather than left
// to be approximated by maxAsks and the spacing. It is what makes the encounter cap and
// the bonus below safe to raise: whatever those two allow, no repeater is ever sent
// more than the four requests per 180s it accepts, and the quota we do not use stays
// available to other clients. Not configurable — it is not ours to raise.
export const LIMITER_WINDOW_MS = 180000;
export const LIMITER_MAX_IN_WINDOW = 4;

// A repeater can spend its whole encounter allowance during a bad stretch and then be
// heard far better while it still counts as the same encounter. Measured on 2026-09-12:
// efef79435050 used its three asks between 21:06:50 and 21:08:08, all around -115 dBm
// and all unanswered, and was then heard from 21:09:37 at -76 to -69 dBm, up to 46 dB
// stronger, with nothing left to spend. Those were the best receptions of the drive.
//
// So a reception this much better in snr than the best one any ask in this encounter
// went out on buys exactly ONE more ask. Once per encounter, and still under the
// limiter above. A signal FLOOR was the other candidate and the same drive killed it:
// two of the three answers came from asks at snr -5.25 and -1.75 dB, which any floor
// worth setting would have blocked.
export const DEFAULT_BONUS_SNR_DB = 6;

// noteHeard updates one target's record and reports it. A gap of forgetMs since the
// last reception starts a NEW encounter: the attempt count and the per-target clock are
// cleared, because the next reception is a different meeting with that repeater —
// different place, different distance — and the failures of the last one say nothing
// about this one.
export function noteHeard(targets, target, now, forgetMs) {
  const rec = targets.get(target);
  if (!rec) {
    const fresh = { attempts: 0, lastAskedAt: null, lastHeardAt: now, bestAskSnr: null, bonusUsed: false, sentAt: [] };
    targets.set(target, fresh);
    return fresh;
  }
  if (now - rec.lastHeardAt >= forgetMs) {
    rec.attempts = 0;
    rec.lastAskedAt = null;
    rec.bestAskSnr = null;
    rec.bonusUsed = false;
    // sentAt is deliberately NOT cleared: the limiter is a property of the repeater's
    // radio, not of our idea of an encounter, and it ages out on its own clock.
  }
  rec.lastHeardAt = now;
  return rec;
}

// recentAsks counts how many asks to this target still fall inside the limiter window,
// pruning the ones that have aged out as it goes.
export function recentAsks(rec, now, windowMs = LIMITER_WINDOW_MS) {
  rec.sentAt = (rec.sentAt ?? []).filter((t) => now - t < windowMs);
  return rec.sentAt.length;
}

// enqueue records that this repeater was heard again, and is the only thing that ever
// creates an ask. `snr` is this reception's signal and may be null. The verdict is
// returned rather than a bare false so the log can say which rule spoke:
//   'answered'  it declared its list: done for this session, no encounter reopens it
//   'queued'    already waiting; queueing each reception would ask it twice in a row
//               with nothing heard in between, which measures the queue not the mesh
//   'limiter'   four asks to it already inside the firmware's 180s window
//   'capped'    this encounter has used its maxAsks and this reception is not enough
//               better than the ones already spent to earn the bonus
//   'too-soon'  asked less than targetGapMs ago
//   'bonus'     capped, but heard enough stronger to be worth one more — queued
export function enqueue(queue, target, answered, targets, now, opts, snr = null) {
  const rec = noteHeard(targets, target, now, opts.forgetMs);
  if (answered.has(target)) return 'answered';
  if (queue.includes(target)) return 'queued';
  if (recentAsks(rec, now) >= LIMITER_MAX_IN_WINDOW) return 'limiter';
  let bonus = false;
  if (rec.attempts >= opts.maxAsks) {
    const gain = opts.bonusSnrDb ?? DEFAULT_BONUS_SNR_DB;
    const better = snr != null && rec.bestAskSnr != null && snr - rec.bestAskSnr >= gain;
    if (rec.bonusUsed || !better) return 'capped';
    bonus = true;
  }
  if (rec.lastAskedAt != null && now - rec.lastAskedAt < opts.targetGapMs) return 'too-soon';
  if (bonus) rec.bonusUsed = true; // spent on queueing, not on sending: a bonus that
  // never leaves the queue because the repeater answered in the meantime has cost
  // nothing, and tracking it through the queue would buy nothing back.
  queue.push(target);
  return bonus ? 'bonus' : 'queued-now';
}

// markAsked counts the attempt and stamps the per-target clock. Called when an ask is
// actually transmitted, never when one is merely queued, so a target that sat in the
// queue behind others is held off from the moment it went out rather than from the
// moment it was heard.
export function markAsked(targets, target, now, snr = null) {
  const rec = targets.get(target) ?? { attempts: 0, lastAskedAt: null, lastHeardAt: now, bestAskSnr: null, bonusUsed: false, sentAt: [] };
  rec.attempts++;
  rec.lastAskedAt = now;
  rec.sentAt = (rec.sentAt ?? []).concat(now);
  // The best reception any ask has gone out on, which is what a later one has to beat
  // to earn the bonus. Tracked here rather than at enqueue so it reflects transmissions.
  if (snr != null && (rec.bestAskSnr == null || snr > rec.bestAskSnr)) rec.bestAskSnr = snr;
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

// registerOutstanding also files the signal of the reception that triggered this ask.
// Four logs point at a clean split: of the eleven asks whose trigger signal could be
// recovered by hand, every one at snr +1.75 dB or better was answered and every one at
// -1.25 dB or worse stayed silent. That reading had to be assembled from pairs of log
// lines the ring buffer rolls out mid-drive. Carrying the signal WITH the request is
// what turns it into a measurement, and a signal floor is the next thing it can justify.
export function registerOutstanding(outstanding, tag, target, now, snr, rssi) {
  outstanding.set(tag, { target, sentAt: now, snr, rssi });
}

export function newSignalRange() {
  return { n: 0, rssiMin: null, rssiMax: null, snrMin: null, snrMax: null };
}

// noteSignal widens a range with one more sample. Null-safe on both fields: the
// companion reports snr and rssi separately and either can be missing on a frame.
export function noteSignal(range, snr, rssi) {
  range.n++;
  if (rssi != null) {
    range.rssiMin = range.rssiMin == null ? rssi : Math.min(range.rssiMin, rssi);
    range.rssiMax = range.rssiMax == null ? rssi : Math.max(range.rssiMax, rssi);
  }
  if (snr != null) {
    range.snrMin = range.snrMin == null ? snr : Math.min(range.snrMin, snr);
    range.snrMax = range.snrMax == null ? snr : Math.max(range.snrMax, snr);
  }
  return range;
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
    snr: hit.snr,
    rssi: hit.rssi,
  };
}

// pruneOutstanding drops tags too old to still be answered and RETURNS those records,
// because a request that timed out is the negative half of the signal measurement: the
// reception that produced it is one the repeater did not answer from. Unbounded growth
// is the other reason it exists — most asks are never answered.
export function pruneOutstanding(outstanding, now, ttlMs = OUTSTANDING_TTL_MS) {
  const dropped = [];
  for (const [tag, rec] of outstanding) {
    if (now - rec.sentAt >= ttlMs) { outstanding.delete(tag); dropped.push(rec); }
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
