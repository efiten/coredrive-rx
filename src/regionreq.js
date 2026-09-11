// Region discovery request/response framing (ANON_REQ_TYPE_REGIONS).
// Layouts verified against meshcore-firmware; see the spec for citations.
//
// NOTE: the app sends NO timestamp. sendAnonReq (BaseChatMesh.cpp) prepends a
// 4-byte tag itself from getCurrentTimeUnique(), which the repeater echoes back.

import { regionDiscoverDue, REGION_INTERVAL_MS } from './monitor.js';

export const CMD_SEND_ANON_REQ = 57;
export const PUSH_CODE_BINARY_RESPONSE = 0x8c;
export const ANON_REQ_TYPE_REGIONS = 0x01;
export const RESP_CODE_SENT = 6; // companion_radio/MyMesh.cpp:77 — shared by every CMD_SEND_* path

// The repeater's CSV budget is sizeof(reply_data) - 12 = 172 bytes (MAX_PACKET_PAYLOAD
// 184, minus the 12-byte handleAnonRegionsReq/MyMesh.cpp header room). exportNamesTo
// (RegionMap.cpp) SKIPS a name that does not fit and keeps going, so an overflowing
// list has holes rather than being a truncated prefix — there is no marker to detect.
//
// Derivation of the threshold (RegionMap.cpp exportNamesTo): a name of length L is
// dropped once the bytes already written, W, satisfy `W + L + 2 >= max_len`. The
// longest possible name is L = sizeof(RegionEntry::name) - 1 = 31 - 1 = 30, so the
// drop can occur as early as W = max_len - L - 2 = 172 - 30 - 2 = 140. At that point
// the buffer holds exactly those 140 bytes, ending in the trailing comma written by
// the last successfully appended name — and exportNamesTo trims that trailing comma
// before returning. So the delivered CSV can be as short as 140 - 1 = 139 bytes while
// still hiding a dropped 30-char name right after it. Flag at or above that floor.
export const TRUNCATION_WARN_BYTES = 139;

export function buildRegionsRequest(pubkeyHex) {
  const pk = pubkeyHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pk)) {
    throw new TypeError(`buildRegionsRequest: pubkeyHex must be exactly 64 hex characters, got: ${pubkeyHex}`);
  }
  const out = new Uint8Array(1 + 32 + 2);
  out[0] = CMD_SEND_ANON_REQ;
  for (let i = 0; i < 32; i++) out[1 + i] = parseInt(pk.substr(i * 2, 2), 16);
  out[33] = ANON_REQ_TYPE_REGIONS;
  out[34] = 0x00; // reply_path_len — zero-hop reply
  return out;
}

// RETRY_BACKOFF_MS: how long a target that did not answer must wait before it may
// be asked again, indexed by how many times it has already been asked this session.
// The last entry repeats for every further attempt.
//
// Silence is ambiguous — out of direct range, rate-limited, firmware too old, or
// busy — so a silent target is held off rather than dropped: dropping loses a node
// that was merely out of range for one stretch. The backoff is what stops the other
// failure mode, observed in the field as nine asks to one node in nine minutes. That
// is not just wasted airtime: simple_repeater rate-limits anon requests to 4 per 180s
// SHARED across all types and all requesters, so hammering a node makes it LESS
// likely to ever answer, not more.
export const RETRY_BACKOFF_MS = [0, 5 * 60000, 15 * 60000, 30 * 60000];

export function retryBackoffFor(attempts) {
  if (attempts <= 0) return 0;
  return RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length - 1)];
}

// recordCandidate writes one candidate, keyed by full pubkey. The map VALUE is the
// answered-key isTargetDue compares against, and three sources now write it with
// different quality of information: a 0-hop advert carries a real advertTs, while a
// discover response and a path-hash forwarder both carry null.
//
// So this is not a plain set: a null must never overwrite a timestamp we already know.
// Doing so makes answered.get(t) !== advertTs for a repeater that HAS answered, which
// reads as due and re-asks it for nothing. A different timestamp does overwrite — a
// re-advert is the documented signal to ask again.
//
// Returns the EFFECTIVE answered-key, which callers must hand to the ask decision
// instead of the value they offered. Otherwise the two disagree: a caller passing its
// own null makes isTargetDue compare null against an answered 4242 and re-ask a
// repeater that already answered.
export function recordCandidate(candidates, pubkey, advertTs) {
  const kept = candidates.get(pubkey);
  if (advertTs == null && kept != null) return kept;
  candidates.set(pubkey, advertTs);
  return advertTs;
}

// dueDelayMs is how long this target must still wait before it may be asked:
// 0 = right now, Infinity = it has already answered and there is nothing to wait for.
// One function so "is it due" and "why not, and for how long" can never disagree.
//
// The advertTs comparison is an answered-key, not a freshness check. Discover- and
// forwarder-sourced candidates carry null, so `answered.get(t) === null` after a reply
// means "asked once this session" — which is the intended policy. An advert's
// timestamp changes on every advert regardless of configuration, so it must not be
// read as "the config changed"; see the note at the candidate-recording site in app.js.
export function dueDelayMs(target, advertTs, answered, attempts, lastAskedAt, now) {
  if (answered.get(target) === advertTs) return Infinity;
  const last = lastAskedAt.get(target);
  if (last == null) return 0;
  return Math.max(0, retryBackoffFor(attempts.get(target) ?? 0) - (now - last));
}

// isTargetDue is the per-target half of "worth asking": not already answered this
// session and not sitting inside its retry backoff.
export function isTargetDue(target, advertTs, answered, attempts, lastAskedAt, now) {
  return dueDelayMs(target, advertTs, answered, attempts, lastAskedAt, now) === 0;
}

// Why an ask did not happen. These exist because the once-a-minute timer sweep that
// used to narrate the scheduler is gone: without a reason code a quiet log is equally
// consistent with an ask in flight, a spent airtime budget, a backed-off target and a
// repeater that already answered, and tells the reader which of those it is: none.
export const SKIP_IN_FLIGHT = 'in-flight';
export const SKIP_BUDGET = 'budget';
export const SKIP_ANSWERED = 'answered';
export const SKIP_BACKOFF = 'backoff';

// heardAskDecision decides whether a repeater we are hearing RIGHT NOW may be asked.
// `r` is the regions-state shape app.js keeps (pending, lastAskAt, answered, attempts,
// lastAskedAt) — no DOM, no transport. Returns { ask: true } or { ask: false, why, … }.
//
// This is now the only decision there is. A 60s timer used to pick a second target
// from the whole session pool, which had no notion of range: the 2026-09-11 commute
// log shows four such asks to repeaters last heard three to six minutes earlier, none
// answered, while the one ask that fired on a live reception was answered in two
// seconds. Worse than the wasted airtime, each blind ask charged its target an attempt
// and pushed it into the 5/15/30-minute backoff, so the repeaters that WERE being
// heard could not be asked when they came into range.
//
// Deliberately NOT here: any notion of fairness between candidates. There is nothing
// to pick from — the target is decided by physics, it is the one whose radio we can
// currently hear — so which repeaters get asked, and in what order, falls out of which
// ones are actually in range at each moment.
export function heardAskDecision(target, advertTs, r, now) {
  if (r.pending && !pendingExpired(r.pending, now)) {
    return { ask: false, why: SKIP_IN_FLIGHT, target: r.pending.target };
  }
  if (!regionDiscoverDue(now, r.lastAskAt)) {
    return { ask: false, why: SKIP_BUDGET, waitMs: REGION_INTERVAL_MS - (now - r.lastAskAt) };
  }
  const delay = dueDelayMs(target, advertTs, r.answered, r.attempts, r.lastAskedAt, now);
  if (delay === Infinity) return { ask: false, why: SKIP_ANSWERED };
  if (delay > 0) return { ask: false, why: SKIP_BACKOFF, waitMs: delay };
  return { ask: true };
}

// commitAsk books one ask: the target's attempt count and retry clock, the shared
// airtime budget, and the single pending slot. It returns a RECEIPT — the values it
// overwrote — because the write that follows can fail before anything reaches the
// radio, and only the receipt can put the scheduler back where it was.
//
// tag starts null: the reply-matcher (applyRegionsReply) treats a null tag as "not yet
// confirmed" and refuses to accept ANY reply until the RESP_CODE_SENT ack fills it in.
// A reply must never be attributed on the sole evidence that a request is pending.
export function commitAsk(r, target, advertTs, now) {
  const receipt = {
    target,
    attempts: r.attempts.get(target),
    lastAskedAt: r.lastAskedAt.get(target),
    lastAskAt: r.lastAskAt,
  };
  r.attempts.set(target, (r.attempts.get(target) ?? 0) + 1);
  r.lastAskedAt.set(target, now);
  r.lastAskAt = now;
  r.pending = { target, advertTs, tag: null, sentAt: now };
  return receipt;
}

// undoAsk gives back everything commitAsk took, for an ask that never reached the
// radio. Returns whether it rolled anything back.
//
// Field case (2026-09-11 commute): the BLE characteristic goes invalid on a reconnect,
// the write throws, and nothing is transmitted — yet the target was charged an attempt
// and dropped into the 5/15/30-minute backoff, the shared 60s budget was spent, and
// the slot was held until it timed out, which logged as "no reply within 20s" as
// though the repeater had stayed silent. Two of six asks in that log were this.
//
// Refuses when the send-ack already captured a tag (that request IS on the air and its
// reply can still arrive) or when the slot has moved on to another target — a late
// rejection must not free someone else's round or refund airtime they legitimately
// spent.
export function undoAsk(r, receipt) {
  if (!r.pending || r.pending.target !== receipt.target || r.pending.tag != null) return false;
  r.pending = null;
  if (receipt.attempts == null) r.attempts.delete(receipt.target);
  else r.attempts.set(receipt.target, receipt.attempts);
  if (receipt.lastAskedAt == null) r.lastAskedAt.delete(receipt.target);
  else r.lastAskedAt.set(receipt.target, receipt.lastAskedAt);
  r.lastAskAt = receipt.lastAskAt;
  return true;
}

// PENDING_TIMEOUT_MS: how long one outstanding request may hold the single pending
// slot. This app deliberately keeps only ONE ask in flight, so that slot is also the
// gate on the ask path (heardAskDecision above) — which means an ask that is never
// released takes every LATER ask down with it.
//
// That is exactly what happened in the field (2026-09-11 commute): pending was
// cleared on a FLOOD send-ack, on an accepted reply, and on disconnect — but the
// ordinary outcome for a moving receiver is none of those. A request sent DIRECT to a
// repeater we have already driven past is simply never answered, and that left the
// slot occupied for the rest of the session: 23 minutes, ~19 repeaters heard, one
// reply, and not a single event-driven ask after the first silent one.
//
// The value is the same horizon as the contact-path override backstop in app.js, and
// that is not a coincidence worth letting drift: once the override is torn down the
// contact is back on its stale path and the reply can no longer arrive, so a pending
// request must never outlive its own override.
export const PENDING_TIMEOUT_MS = 20000;

// pendingExpired reports whether the outstanding request has been waiting long enough
// that the round is over. A missing sentAt counts as EXPIRED, not as in-flight — the
// asymmetry is deliberate: a wedged slot silently disables the heard path for a whole
// session, while an early expiry costs at most one extra ask and the shared 60s
// airtime budget (regionDiscoverDue) bounds even that. Fail toward expiry.
export function pendingExpired(pending, now, opts = {}) {
  if (!pending) return false;
  if (pending.sentAt == null) return true;
  return now - pending.sentAt >= (opts.timeoutMs ?? PENDING_TIMEOUT_MS);
}

export function parseRegionsResponse(bytes) {
  if (!bytes || bytes.length < 10 || bytes[0] !== PUSH_CODE_BINARY_RESPONSE) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The reply payload is encrypted with a BLOCK cipher (Utils::encryptThenMAC ->
  // AES), so the plaintext we get back is NUL-padded up to a 16-byte boundary. The
  // firmware's own length is not carried through to us, so the padding must be
  // trimmed here or it lands inside the LAST region name: "belml" becomes
  // "belml\0\0\0…", which then matches no observed scope and reads as a region the
  // repeater declares but never forwards. Verified in production: 48 of 65 stored
  // rows carried this padding.
  let end = bytes.length;
  while (end > 10 && bytes[end - 1] === 0) end--;
  const payload = bytes.slice(10, end);
  const csv = new TextDecoder().decode(payload);
  return {
    tag: v.getUint32(2, true),
    repeaterClock: v.getUint32(6, true),
    regions: csv.length ? csv.split(',') : [],
    // Measured on the wire bytes, not csv.length: the firmware budget is bytes, and
    // is_name_char accepts every byte >= 0x80, so an accented name costs more bytes
    // than it does UTF-16 code units. Comparing the decoded length would under-flag
    // exactly the lists most likely to have overflowed. Padding is excluded — it is
    // not part of the repeater's answer and must not count toward the ceiling.
    truncated: payload.length >= TRUNCATION_WARN_BYTES,
  };
}

// parseSentAck reads the tag from the immediate ack for CMD_SEND_ANON_REQ:
// [0x06][is_flood: 1][tag: 4][est_timeout: 4] (companion_radio/MyMesh.cpp:1568-1572).
// RESP_CODE_SENT is shared by every CMD_SEND_* path in the firmware (text message,
// login, anon req, ...) — the caller must only feed this the ack that followed its
// own send, not just any RESP_CODE_SENT frame that happens to arrive.
export function parseSentAck(bytes) {
  if (!bytes || bytes.length < 6 || bytes[0] !== RESP_CODE_SENT) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // isFlood is decisive, not informational: the repeater answers a regions request
  // ONLY over a direct route (simple_repeater/MyMesh.cpp requires isRouteDirect())
  // and ignores a flooded one without any error. The companion picks the route for
  // us — sendAnonReq floods whenever the target is a known contact whose
  // out_path_len is OUT_PATH_UNKNOWN — and reports which it chose here
  // (companion_radio/MyMesh.cpp:1569: out_frame[1] = SENT_FLOOD ? 1 : 0). Without
  // reading it, a request that can never be answered is indistinguishable from one
  // still in flight.
  return { tag: v.getUint32(2, true), isFlood: bytes[1] === 1 };
}

// applyRegionsReply decides whether a parsed PUSH_CODE_BINARY_RESPONSE answers the
// currently pending request. `pending` is { target, advertTs, tag } (tag captured
// from parseSentAck) or null. The repeater rate-limits and replies after a delay,
// and a DIFFERENT repeater is asked every round, so a reply delayed past one round
// can arrive while another target is pending — matching on "something is pending"
// rather than on the echoed tag would attribute one repeater's declared regions to
// a different repeater and store it as fact. On any mismatch (including a tag not
// yet captured) this returns accepted:false and the caller MUST NOT clear pending —
// the real reply may still be on its way.
export function applyRegionsReply(pending, parsed) {
  if (!pending || !parsed || pending.tag == null || parsed.tag !== pending.tag) {
    return { accepted: false };
  }
  return {
    accepted: true,
    target: pending.target,
    advertTs: pending.advertTs,
    regions: parsed.regions,
    truncated: parsed.truncated,
    repeaterClock: parsed.repeaterClock,
  };
}
