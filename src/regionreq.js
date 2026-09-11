// Region discovery request/response framing (ANON_REQ_TYPE_REGIONS).
// Layouts verified against meshcore-firmware; see the spec for citations.
//
// NOTE: the app sends NO timestamp. sendAnonReq (BaseChatMesh.cpp) prepends a
// 4-byte tag itself from getCurrentTimeUnique(), which the repeater echoes back.

import { regionDiscoverDue } from './monitor.js';

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

// selectNextTarget picks the next repeater to ask, or null when there is nothing
// worth asking. Fresh candidates come first; a repeater that has never answered is
// DEMOTED rather than dropped, because silence is ambiguous — out of direct range,
// rate-limited, firmware too old, or busy — so dropping loses a node that was merely
// out of range for one stretch, while retrying at equal priority lets a permanent
// non-answerer starve one that would answer.
// RETRY_BACKOFF_MS: how long a target that did not answer must wait before it may
// be asked again, indexed by how many times it has already been asked this session.
// The last entry repeats for every further attempt.
//
// Demotion alone was not enough. It moves a silent target behind the answering
// ones, but once every OTHER candidate has answered they are no longer due, the
// pool falls back to "every due candidate", and the silent one is handed back
// every single round — observed in the field as nine asks to one node in nine
// minutes. That is not just wasted airtime: simple_repeater rate-limits anon
// requests to 4 per 180s SHARED across all types and all requesters, so hammering
// a node makes it LESS likely to ever answer, not more.
export const RETRY_BACKOFF_MS = [0, 5 * 60000, 15 * 60000, 30 * 60000];

export function retryBackoffFor(attempts) {
  if (attempts <= 0) return 0;
  return RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length - 1)];
}

// isTargetDue is the per-target half of "worth asking": not already answered this
// session and not sitting inside its retry backoff.
//
// The advertTs comparison is an answered-key, not a freshness check. Discover-sourced
// candidates carry null, so `answered.get(t) === null` after a reply means "asked
// once this session" — which is the intended policy. An advert's timestamp changes on
// every advert regardless of configuration, so it must not be read as "the config
// changed"; see the note at the candidate-recording site in app.js. Shared by
// selectNextTarget (the periodic pool scan) and heardAskEligible (the event-driven
// ask for one specific just-heard target) so the two paths can never disagree about
// whether a given target may be asked.
export function isTargetDue(target, advertTs, answered, attempts, lastAskedAt, now) {
  if (answered.get(target) === advertTs) return false;
  const last = lastAskedAt.get(target);
  if (last == null) return true;
  return now - last >= retryBackoffFor(attempts.get(target) ?? 0);
}

// selectNextTarget picks the next repeater to ask, or null when nothing is worth
// asking right now. `now` and the attempts/lastAskedAt maps are passed in so the
// decision stays pure and testable.
export function selectNextTarget(state) {
  const now = state.now ?? 0;
  const attempts = state.attempts ?? new Map();
  const lastAskedAt = state.lastAskedAt ?? new Map();
  const due = (c) => isTargetDue(c.pubkey, c.advertTs, state.answered, attempts, lastAskedAt, now);
  const fresh = state.candidates.filter((c) => due(c) && !state.demoted.has(c.pubkey));
  const pool = fresh.length ? fresh : state.candidates.filter(due);
  if (!pool.length) return null;
  return pool[state.cursor % pool.length].pubkey;
}

// heardAskEligible is the event-driven twin of selectNextTarget: given a repeater
// that was JUST heard directly, decide whether it may be asked right now instead of
// waiting for the next timer tick. `r` is the same regions-state shape app.js keeps
// (pending, lastAskAt, answered, attempts, lastAskedAt) — no DOM, no transport.
//
// Deliberately NOT here: any notion of `demoted`/fresh-pool priority. That machinery
// exists in selectNextTarget to pick fairly AMONG MANY due candidates on a timer.
// Here there is nothing to pick from — the target is already decided by physics (it's
// the one whose radio we can currently hear), so which repeaters get asked and in
// what order now falls out of which ones are actually in range at each moment, and
// the retry backoff already stops one silent node from monopolising the shared
// budget. Layering demotion on top would be a second fairness mechanism solving a
// problem this event ordering already solves.
export function heardAskEligible(target, advertTs, r, now) {
  if (r.pending && !pendingExpired(r.pending, now)) return false;
  if (!regionDiscoverDue(now, r.lastAskAt)) return false;
  return isTargetDue(target, advertTs, r.answered, r.attempts, r.lastAskedAt, now);
}

// PENDING_TIMEOUT_MS: how long one outstanding request may hold the single pending
// slot. This app deliberately keeps only ONE ask in flight, so that slot is also the
// gate on the event-driven path (heardAskEligible above) — which means an ask that is
// never released takes every LATER ask down with it.
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
