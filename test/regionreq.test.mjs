import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRegionsRequest, parseRegionsResponse, CMD_SEND_ANON_REQ,
  parseSentAck, RESP_CODE_SENT, applyRegionsReply, TRUNCATION_WARN_BYTES, retryBackoffFor,
  isTargetDue, heardAskDecision, pendingExpired, PENDING_TIMEOUT_MS, recordCandidate,
  commitAsk, undoAsk, SKIP_IN_FLIGHT, SKIP_BUDGET, SKIP_ANSWERED, SKIP_BACKOFF,
} from '../src/regionreq.js';
import { REGION_INTERVAL_MS } from '../src/monitor.js';

// The ask decision now reports WHY it said no, because the timer fallback that used
// to print a once-a-minute "nothing to ask" line is gone. Most assertions here only
// care about the verdict.
const eligible = (target, advertTs, r, now) => heardAskDecision(target, advertTs, r, now).ask;

const PK = 'aa'.repeat(32);
const le32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

test('buildRegionsRequest is [57][pubkey 32][0x01][0x00] — no app timestamp', () => {
  const f = buildRegionsRequest(PK);
  assert.equal(f.length, 1 + 32 + 2);
  assert.equal(f[0], CMD_SEND_ANON_REQ);
  assert.deepEqual(Array.from(f.slice(1, 33)), new Array(32).fill(0xaa));
  assert.equal(f[33], 0x01, 'req type');
  assert.equal(f[34], 0x00, 'reply_path_len = 0 for a zero-hop reply');
});

test('buildRegionsRequest throws on a too-short pubkey', () => {
  assert.throws(() => buildRegionsRequest('aa'.repeat(31)), TypeError);
});

test('buildRegionsRequest throws on a too-long pubkey', () => {
  assert.throws(() => buildRegionsRequest('aa'.repeat(33)), TypeError);
});

test('buildRegionsRequest throws on non-hex characters', () => {
  assert.throws(() => buildRegionsRequest('zz'.repeat(32)), TypeError);
});

test('buildRegionsRequest accepts an uppercase pubkey and lowercases it', () => {
  const f = buildRegionsRequest(PK.toUpperCase());
  assert.deepEqual(Array.from(f.slice(1, 33)), new Array(32).fill(0xaa));
});

test('parseRegionsResponse reads tag, clock and the CSV', () => {
  // [0x8C][reserved][tag 4][repeater_clock 4][CSV]
  const bytes = new Uint8Array([0x8c, 0, ...le32(0x11223344), ...le32(1755518096), ...ascii('*,be,be-vlg,be-van')]);
  const r = parseRegionsResponse(bytes);
  assert.equal(r.tag, 0x11223344);
  assert.equal(r.repeaterClock, 1755518096);
  assert.deepEqual(r.regions, ['*', 'be', 'be-vlg', 'be-van']);
  assert.equal(r.truncated, false);
});

test('parseRegionsResponse flags a CSV near the 172-byte ceiling', () => {
  const long = Array.from({ length: 24 }, (_, i) => `be-x${String(i).padStart(2, '0')}`).join(',');
  assert.ok(long.length > TRUNCATION_WARN_BYTES, 'fixture must exceed the flag threshold');
  const bytes = new Uint8Array([0x8c, 0, ...le32(1), ...le32(2), ...ascii(long)]);
  assert.equal(parseRegionsResponse(bytes).truncated, true);
});

test('parseRegionsResponse flags a 139-byte CSV — the boundary that can still hide a dropped 30-char name', () => {
  // Worst case per firmware RegionMap.cpp exportNamesTo: max_len = MAX_PACKET_PAYLOAD(184) - 12 = 172.
  // A name of the maximum length L = sizeof(RegionEntry::name) - 1 = 30 is dropped once the bytes
  // already written W reach `max_len - L - 2` = 140. At that instant the buffer holds 140 bytes
  // ending in a trailing comma, which exportNamesTo then trims — so the delivered CSV can be as
  // short as 139 bytes while a further 30-char name was silently dropped right after it.
  // Fixture: four 30-char names plus one 15-char name, comma-joined, totals exactly 139 bytes.
  const long = ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30), 'd'.repeat(30), 'e'.repeat(15)].join(',');
  assert.equal(long.length, 139, 'fixture must sit exactly on the derived boundary');
  const bytes = new Uint8Array([0x8c, 0, ...le32(1), ...le32(2), ...ascii(long)]);
  assert.equal(parseRegionsResponse(bytes).truncated, true, 'the new threshold must flag it');
});

test('parseRegionsResponse measures the boundary in bytes, not UTF-16 code units', () => {
  // RegionMap::is_name_char accepts every byte >= 0x80, so accented region names are
  // legal. Each 'eé' costs two bytes but one code unit, so this CSV is 139 bytes on
  // the wire and 124 code units after decoding: a csv.length comparison would miss it.
  const long = ['é'.repeat(15), 'b'.repeat(30), 'c'.repeat(30), 'd'.repeat(30), 'e'.repeat(15)].join(',');
  const encoded = new TextEncoder().encode(long);
  assert.equal(encoded.length, 139, 'fixture must sit on the derived byte boundary');
  assert.ok(long.length < TRUNCATION_WARN_BYTES, 'and must fall short of it when counted as chars');
  const bytes = new Uint8Array([0x8c, 0, ...le32(1), ...le32(2), ...encoded]);
  assert.equal(parseRegionsResponse(bytes).truncated, true);
});

test('parseRegionsResponse rejects a wrong code and a short frame', () => {
  assert.equal(parseRegionsResponse(new Uint8Array([0x88, 0, 1, 2])), null);
  assert.equal(parseRegionsResponse(new Uint8Array([0x8c, 0, 1, 2])), null);
  assert.equal(parseRegionsResponse(new Uint8Array()), null);
});

test('an empty CSV yields an empty list, not null', () => {
  const bytes = new Uint8Array([0x8c, 0, ...le32(1), ...le32(2)]);
  assert.deepEqual(parseRegionsResponse(bytes).regions, []);
});

// --- RESP_CODE_SENT ack + tag-matched reply attribution ---
// The repeater rate-limits (anon_limiter) and replies after SERVER_RESPONSE_DELAY,
// and a different repeater is asked every round (60s later) — a reply delayed past
// one round can land while another target is pending. Matching by "something is
// pending" (not by tag) would attribute repeater A's regions to repeater B: wrong
// data stored as a fact. The tag exists in the protocol precisely to prevent this.

test('parseSentAck reads the tag from a RESP_CODE_SENT ack', () => {
  // [0x06][is_flood: 1][tag: 4][est_timeout: 4]
  const bytes = new Uint8Array([RESP_CODE_SENT, 0, ...le32(0x11223344), ...le32(9000)]);
  assert.deepEqual(parseSentAck(bytes), { tag: 0x11223344, isFlood: false });
});

test('parseSentAck rejects a wrong code and a too-short frame', () => {
  assert.equal(parseSentAck(new Uint8Array([5, 0, ...le32(1)])), null);
  assert.equal(parseSentAck(new Uint8Array([RESP_CODE_SENT, 0, 1, 2])), null);
  assert.equal(parseSentAck(null), null);
});

const reply = (tag, regions) => ({ tag, repeaterClock: 100, regions, truncated: false });

test('a reply whose tag matches the pending request is accepted and attributed to that target', () => {
  const pending = { target: 'aa'.repeat(32), advertTs: 5, tag: 0x11223344 };
  const result = applyRegionsReply(pending, reply(0x11223344, ['be']));
  assert.equal(result.accepted, true);
  assert.equal(result.target, pending.target);
  assert.equal(result.advertTs, 5);
  assert.deepEqual(result.regions, ['be']);
});

test('a reply whose tag does NOT match is ignored — not attributed to the pending target', () => {
  const pending = { target: 'aa'.repeat(32), advertTs: 5, tag: 0x11223344 };
  const stray = reply(0xdeadbeef, ['wrong-node-regions']);
  assert.deepEqual(applyRegionsReply(pending, stray), { accepted: false });
});

test('after a mismatched reply, the correct reply still arrives and is attributed correctly', () => {
  // applyRegionsReply is pure and does not mutate `pending` — mirroring the real
  // caller, which must only clear its pending slot on accepted:true, so the SAME
  // pending object is still valid to match against the next frame.
  const pending = { target: 'aa'.repeat(32), advertTs: 5, tag: 0x11223344 };
  const stray = reply(0xdeadbeef, ['wrong-node-regions']);
  const real = reply(0x11223344, ['be', 'be-vlg']);
  assert.equal(applyRegionsReply(pending, stray).accepted, false, 'stray reply must not consume the pending slot');
  const result = applyRegionsReply(pending, real);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.regions, ['be', 'be-vlg']);
});

test('a reply is ignored when no tag has been captured yet (RESP_CODE_SENT ack not back)', () => {
  const pending = { target: 'aa'.repeat(32), advertTs: 5, tag: null };
  assert.deepEqual(applyRegionsReply(pending, reply(0x11223344, ['be'])), { accepted: false });
});

test('a reply is ignored when there is no pending request at all', () => {
  assert.deepEqual(applyRegionsReply(null, reply(1, [])), { accepted: false });
});

test('parseSentAck reports the route the companion actually used', () => {
  // [0x06][is_flood][tag 4][est_timeout 4] — companion_radio/MyMesh.cpp:1568-1572
  const direct = new Uint8Array([RESP_CODE_SENT, 0, ...le32(0xaabbccdd), 0, 0, 0, 0]);
  const flood = new Uint8Array([RESP_CODE_SENT, 1, ...le32(0xaabbccdd), 0, 0, 0, 0]);
  assert.equal(parseSentAck(direct).isFlood, false, 'a direct send can be answered');
  assert.equal(parseSentAck(flood).isFlood, true, 'a flooded send will be silently ignored by the repeater');
  assert.equal(parseSentAck(flood).tag, 0xaabbccdd, 'the tag is still read on the flood path');
});

// --- Retry backoff (field bug: nine asks to one silent node in nine minutes) ---

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);

test('a silent target is NOT re-asked a minute later just because it is heard again', () => {
  // Exactly the field case, now expressed on the only path left: A was asked, stayed
  // silent, and is heard again on the next pass. Re-asking on the old one-minute
  // cadence is what made simple_repeater's 4-per-180s anon limiter drop it for good.
  const r = {
    pending: null, lastAskAt: null, answered: new Map(),
    attempts: new Map([[A, 1]]), lastAskedAt: new Map([[A, 1_000_000]]),
  };
  assert.equal(eligible(A, null, r, 1_000_000 + 60_000), false, 'one minute after a silent ask, A is still backed off');
});

test('a silent target IS retried once its backoff has elapsed — silence stays ambiguous', () => {
  const r = {
    pending: null, lastAskAt: null, answered: new Map(),
    attempts: new Map([[A, 1]]), lastAskedAt: new Map([[A, 1_000_000]]),
  };
  assert.equal(eligible(A, null, r, 1_000_000 + retryBackoffFor(1)), true,
    'dropping a node forever would lose one that was merely out of range');
});

test('backoff lengthens with each failed attempt and then holds', () => {
  assert.equal(retryBackoffFor(0), 0, 'a never-asked target is immediately eligible');
  assert.ok(retryBackoffFor(2) > retryBackoffFor(1));
  assert.ok(retryBackoffFor(3) > retryBackoffFor(2));
  assert.equal(retryBackoffFor(9), retryBackoffFor(3), 'the last step repeats rather than growing without bound');
});

test('a candidate known only from a discover reply is asked once, then not again until a real advert arrives', () => {
  // Discover- and forwarder-sourced candidates carry advertTs:null (neither a discover
  // reply nor a path hash carries a timestamp). The rule is answered.get(t) !== advertTs
  // — null !== null is false, so once it has answered it goes quiet, exactly like an
  // advert-sourced repeater whose timestamp has not changed.
  const r = { pending: null, lastAskAt: null, answered: new Map(), attempts: new Map(), lastAskedAt: new Map() };
  assert.equal(eligible(A, null, r, 1_000_000), true, 'asked once');

  r.answered.set(A, null);
  assert.equal(eligible(A, null, r, 2_000_000), false, 'not re-asked while still only known via discover');
  assert.equal(eligible(A, 12345, r, 2_000_000), true, 're-asked once a real advert with a timestamp arrives');
});

// --- Event-driven ask on a heard packet. This is the ONLY path that asks: the 60s
// timer fallback is gone, because it picked from the whole session pool with no
// notion of range and spent the shared budget on repeaters we had long driven past
// (see maybeAskHeardTarget in src/app.js) ---

test('isTargetDue: never asked and never answered is due', () => {
  assert.equal(isTargetDue(A, 1, new Map(), new Map(), new Map(), 1_000_000), true);
});

test('isTargetDue: answered at the same advert timestamp is not due', () => {
  assert.equal(isTargetDue(A, 1, new Map([[A, 1]]), new Map(), new Map(), 1_000_000), false);
});

test('isTargetDue: inside the per-target backoff is not due', () => {
  const attempts = new Map([[A, 1]]);
  const lastAskedAt = new Map([[A, 1_000_000]]);
  assert.equal(isTargetDue(A, null, new Map(), attempts, lastAskedAt, 1_000_000 + 60_000), false, 'still inside the 5-min backoff');
  assert.equal(isTargetDue(A, null, new Map(), attempts, lastAskedAt, 1_000_000 + retryBackoffFor(1)), true, 'due once the backoff elapses');
});

test('heardAskDecision: a due repeater heard within budget is eligible', () => {
  const r = { pending: null, lastAskAt: null, answered: new Map(), attempts: new Map(), lastAskedAt: new Map() };
  assert.equal(eligible(A, 1, r, 1_000_000), true);
});

test('heardAskDecision: a second repeater heard 5s later is NOT eligible — the 60s budget is shared', () => {
  const r = { pending: null, lastAskAt: 1_000_000, answered: new Map(), attempts: new Map(), lastAskedAt: new Map() };
  assert.equal(eligible(B, 1, r, 1_000_000 + 5000), false);
  assert.equal(eligible(B, 1, r, 1_000_000 + REGION_INTERVAL_MS), true, 'eligible again once the budget clock elapses');
});

test('heardAskDecision: a repeater inside its per-target backoff is NOT eligible even with budget free', () => {
  const r = {
    pending: null, lastAskAt: null, answered: new Map(),
    attempts: new Map([[A, 1]]), lastAskedAt: new Map([[A, 1_000_000]]),
  };
  assert.equal(eligible(A, null, r, 1_000_000 + 60_000), false);
});

test('heardAskDecision: an already-answered repeater is NOT eligible', () => {
  const r = { pending: null, lastAskAt: null, answered: new Map([[A, 1]]), attempts: new Map(), lastAskedAt: new Map() };
  assert.equal(eligible(A, 1, r, 1_000_000), false);
});

test('heardAskDecision: an ask already pending blocks a heard target regardless of budget/backoff', () => {
  // sentAt is what makes this pending genuinely in-flight rather than expired (see
  // pendingExpired). The one-ask-at-a-time rule this asserts is unchanged; it is now
  // bounded in time, which the expiry tests below cover.
  const r = { pending: { target: B, advertTs: 1, tag: null, sentAt: 1_000_000 }, lastAskAt: null, answered: new Map(), attempts: new Map(), lastAskedAt: new Map() };
  assert.equal(eligible(A, 1, r, 1_000_000), false);
});

test('an evaluation that asks nobody must not consume the airtime budget', () => {
  // Field regression: the timer path stamped lastAskAt on EVERY evaluation, so a
  // minute in which nothing was asked still spent the budget. A repeater heard
  // 19s later was then blocked, and the ask slipped to the next minute — exactly
  // the delay the heard-driven path exists to remove. The budget must count
  // transmissions, not evaluations.
  const t0 = 1_000_000;
  const r = {
    pending: null, lastAskAt: null, // nothing has ever been SENT
    answered: new Map(), attempts: new Map(), lastAskedAt: new Map(),
  };
  assert.equal(eligible(A, null, r, t0 + 19_000), true,
    'a repeater heard 19s after a no-op evaluation is still eligible');

  r.lastAskAt = t0; // now something was actually sent
  assert.equal(eligible(A, null, r, t0 + 19_000), false,
    'but 19s after a real ask the budget is genuinely spent');
});

test('AES block padding is trimmed — it must not land inside the last region name', () => {
  // The reply is encrypted with a block cipher, so the plaintext arrives NUL-padded
  // to a 16-byte boundary. Production carried this into storage in 48 of 65 rows:
  // "belml" became "belml\0\0\0…", which matches no observed scope and reads as a
  // region the repeater declares but never forwards — a false finding, every time.
  const csv = 'be,be-vli,belml';
  const padded = new Uint8Array([
    0x8c, 0, ...le32(1), ...le32(2), ...ascii(csv), 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const r = parseRegionsResponse(padded);
  assert.deepEqual(r.regions, ['be', 'be-vli', 'belml'],
    'the last name must not carry NUL bytes');
  assert.equal(r.regions[2].length, 5, 'no trailing NULs survive into the name');
});

test('a wildcard-only reply survives padding as exactly "*"', () => {
  // 0x2A followed by seven NULs is one full AES block; this is the shape that made
  // regions_csv = '*' compare false in SQL and could mask the wildcard entirely.
  const padded = new Uint8Array([0x8c, 0, ...le32(1), ...le32(2), 0x2a, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(parseRegionsResponse(padded).regions, ['*']);
});

test('a reply that is only padding yields no regions, not one empty name', () => {
  const padded = new Uint8Array([0x8c, 0, ...le32(1), ...le32(2), 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(parseRegionsResponse(padded).regions, []);
});

// --- Pending-request expiry ---------------------------------------------------
// Field regression (2026-09-11 commute log): 23 minutes, ~19 repeaters heard, one
// single reply. Every ask in the log landed exactly on the 60s timer cadence and
// not one "heard … directly — asking now" line appeared, even though repeaters
// were being heard continuously. Cause: state.regions.pending was cleared in only
// three places — a FLOOD send-ack, an accepted reply, and disconnect — so the
// ordinary outcome on a moving receiver (sent DIRECT, never answered) left it set
// forever. heardAskDecision's pending gate then disabled the event-driven path for
// the rest of the session, leaving only the clock-picked ask that the module header
// says cannot work while moving. A pending request must expire.

test('pendingExpired: a request still inside its window has not expired', () => {
  const p = { target: A, advertTs: null, tag: 1, sentAt: 1_000_000 };
  assert.equal(pendingExpired(p, 1_000_000 + PENDING_TIMEOUT_MS - 1), false);
});

test('pendingExpired: a request outstanding past its window has expired', () => {
  const p = { target: A, advertTs: null, tag: 1, sentAt: 1_000_000 };
  assert.equal(pendingExpired(p, 1_000_000 + PENDING_TIMEOUT_MS), true);
});

test('pendingExpired: no pending request is not an expired one', () => {
  assert.equal(pendingExpired(null, 1_000_000), false);
});

test('pendingExpired: a pending without a sentAt is treated as expired, never as a permanent block', () => {
  // Asymmetric on purpose. A pending that wedges forever silently kills the whole
  // event-driven path for a session; one that expires early costs at most one extra
  // ask, and the shared 60s airtime budget bounds even that. Fail toward expiry.
  assert.equal(pendingExpired({ target: A, advertTs: null, tag: null }, 1_000_000), true);
});

test('heardAskDecision: an EXPIRED pending no longer blocks a heard repeater', () => {
  // The exact field scenario: an unanswered ask must not cost us every later one.
  const r = {
    pending: { target: B, advertTs: null, tag: 7, sentAt: 1_000_000 },
    lastAskAt: null, answered: new Map(), attempts: new Map(), lastAskedAt: new Map(),
  };
  const stillInFlight = 1_000_000 + PENDING_TIMEOUT_MS - 1;
  assert.equal(eligible(A, null, r, stillInFlight), false,
    'one request at a time still holds while the reply could plausibly arrive');
  const afterExpiry = 1_000_000 + PENDING_TIMEOUT_MS;
  assert.equal(eligible(A, null, r, afterExpiry), true,
    'but a silent request must not disable the heard path for the rest of the session');
});

test('a silent repeater does not wedge the heard path for every later repeater', () => {
  // Regression at the level the field log showed it: ask B, hear nothing back, then
  // drive into range of A. Before the fix this returned false forever.
  const t0 = 1_000_000;
  const r = {
    pending: null, lastAskAt: null,
    answered: new Map(), attempts: new Map(), lastAskedAt: new Map(),
  };
  // B is heard and asked.
  assert.equal(eligible(B, null, r, t0), true);
  r.lastAskAt = t0;
  r.attempts.set(B, 1);
  r.lastAskedAt.set(B, t0);
  r.pending = { target: B, advertTs: null, tag: 7, sentAt: t0 };
  // B never answers. A minute later we are past a different repeater.
  const later = t0 + REGION_INTERVAL_MS;
  assert.equal(eligible(A, null, r, later), true,
    'A is due, the budget has elapsed, and B\'s silence is not A\'s problem');
});

// --- Candidate recording ------------------------------------------------------
// Three sources now write candidates: a 0-hop advert (real advertTs), a discover
// response (null) and a path-hash forwarder (null). The map value is the ANSWERED-KEY
// that isTargetDue compares against, so a later source must never weaken what an
// earlier one established — overwriting a real advertTs with null makes an
// already-answered repeater look due again and re-asks it for nothing.

test('recordCandidate: a new pubkey is recorded with whatever key it came with', () => {
  const c = new Map();
  recordCandidate(c, A, null);
  assert.equal(c.get(A), null);
  recordCandidate(c, B, 4242);
  assert.equal(c.get(B), 4242);
});

test('recordCandidate: an advert timestamp UPGRADES a prefix-sourced null', () => {
  const c = new Map([[A, null]]);
  recordCandidate(c, A, 4242);
  assert.equal(c.get(A), 4242, 'an advert carries strictly better information than a path hash');
});

test('recordCandidate: a prefix-sourced null must NOT downgrade a known advert timestamp', () => {
  // The regression this exists to prevent: A adverts (ts 4242), is asked, answers,
  // and answered[A] becomes 4242. Later we hear A forward a packet, which carries no
  // timestamp. Writing null here would make answered.get(A) !== advertTs, so A reads
  // as due and gets re-asked despite having already answered this session.
  const c = new Map([[A, 4242]]);
  recordCandidate(c, A, null);
  assert.equal(c.get(A), 4242);
});

test('recordCandidate: a NEW advert timestamp replaces the old one — a re-advert must re-ask', () => {
  // Deliberately not the same as the downgrade case. A changed advertTs is the
  // documented signal to ask again (see the candidate-recording note in app.js).
  const c = new Map([[A, 4242]]);
  recordCandidate(c, A, 5353);
  assert.equal(c.get(A), 5353);
});

test('recordCandidate: an answered repeater heard again as a forwarder stays not-due', () => {
  // Same fact as the downgrade test, asserted through the rule that actually matters.
  const c = new Map([[A, 4242]]);
  const answered = new Map([[A, 4242]]);
  recordCandidate(c, A, null);
  assert.equal(isTargetDue(A, c.get(A), answered, new Map(), new Map(), 9_000_000), false);
});

test('recordCandidate returns the EFFECTIVE answered-key, not the one it was handed', () => {
  // The ask decision and the stored candidate must use the SAME key or they disagree.
  // Protecting only the map is not enough: a caller that then passes its own null to
  // heardAskDecision asks isTargetDue(t, null, ...) while answered holds 4242, which
  // reads as due and re-asks a repeater that already answered. Handing the effective
  // key back makes that mismatch unrepresentable at the call site.
  const c = new Map([[A, 4242]]);
  assert.equal(recordCandidate(c, A, null), 4242, 'the kept timestamp wins over the null offered');

  const fresh = new Map();
  assert.equal(recordCandidate(fresh, B, null), null, 'a genuinely new prefix-sourced candidate is null');
  assert.equal(recordCandidate(fresh, B, 5353), 5353, 'an upgrading advert returns its own timestamp');
});

// --- Ask bookkeeping: commit and undo ----------------------------------------
// An ask costs the target an attempt, its place in the retry backoff, and the whole
// shared 60s airtime budget. Field log (2026-09-11 commute): two of six asks never
// reached the radio at all — the BLE characteristic went invalid on a reconnect and
// the write threw — and both targets were charged anyway, then logged as "no reply
// within 20s" as if the repeater had stayed silent. A write that threw put nothing
// on the air, so it must cost nothing.

test('commitAsk charges the target and the shared budget, and opens the pending slot', () => {
  const r = { pending: null, lastAskAt: null, answered: new Map(), attempts: new Map(), lastAskedAt: new Map() };
  commitAsk(r, A, 4242, 1_000_000);
  assert.equal(r.attempts.get(A), 1);
  assert.equal(r.lastAskedAt.get(A), 1_000_000);
  assert.equal(r.lastAskAt, 1_000_000, 'the airtime budget is spent at the one site that transmits');
  assert.deepEqual(r.pending, { target: A, advertTs: 4242, tag: null, sentAt: 1_000_000 });
});

test('undoAsk refunds everything an ask that never left the phone took', () => {
  const r = { pending: null, lastAskAt: null, answered: new Map(), attempts: new Map(), lastAskedAt: new Map() };
  const receipt = commitAsk(r, A, null, 1_000_000);
  assert.equal(undoAsk(r, receipt), true);
  assert.equal(r.pending, null, 'the slot is free for the next repeater heard');
  assert.equal(r.attempts.has(A), false, 'a target that was never asked must not carry an attempt');
  assert.equal(r.lastAskedAt.has(A), false);
  assert.equal(r.lastAskAt, null, 'no airtime was spent, so none is charged');
  assert.equal(eligible(A, null, r, 1_000_001), true, 'and the very next reception may ask it');
});

test('undoAsk restores the PREVIOUS attempt count rather than clearing it', () => {
  // A target asked once before must not be handed a clean slate by a failed write:
  // that would erase a real, transmitted ask and let it be hammered again.
  const r = {
    pending: null, lastAskAt: 500_000, answered: new Map(),
    attempts: new Map([[A, 1]]), lastAskedAt: new Map([[A, 500_000]]),
  };
  const receipt = commitAsk(r, A, null, 1_000_000);
  undoAsk(r, receipt);
  assert.equal(r.attempts.get(A), 1);
  assert.equal(r.lastAskedAt.get(A), 500_000);
  assert.equal(r.lastAskAt, 500_000);
});

test('undoAsk does nothing once the send-ack captured a tag — that ask is on the air', () => {
  const r = { pending: null, lastAskAt: null, answered: new Map(), attempts: new Map(), lastAskedAt: new Map() };
  const receipt = commitAsk(r, A, null, 1_000_000);
  r.pending.tag = 0x11223344; // the companion acked the send
  assert.equal(undoAsk(r, receipt), false);
  assert.equal(r.attempts.get(A), 1, 'a transmitted ask keeps its cost');
  assert.equal(r.pending.tag, 0x11223344, 'and its pending slot, so the reply can still be matched');
});

test('undoAsk does nothing once another ask holds the slot', () => {
  // A late rejection from a dead write must never free a slot that now belongs to a
  // different target, nor refund a budget that target has legitimately spent.
  const r = { pending: null, lastAskAt: null, answered: new Map(), attempts: new Map(), lastAskedAt: new Map() };
  const receipt = commitAsk(r, A, null, 1_000_000);
  r.pending = null; // A's round expired
  commitAsk(r, B, null, 1_100_000);
  assert.equal(undoAsk(r, receipt), false);
  assert.equal(r.pending.target, B);
  assert.equal(r.lastAskAt, 1_100_000);
});

// --- Why an ask was skipped ---------------------------------------------------
// With the timer fallback gone there is no once-a-minute "nothing to ask" line, so
// the heard path has to be able to say why it stayed quiet — otherwise a silent log
// is consistent with an in-flight ask, a spent budget, a backed-off target and a
// repeater that already answered, and distinguishes none of them.

test('heardAskDecision names the in-flight ask that is blocking', () => {
  const r = {
    pending: { target: B, advertTs: null, tag: 7, sentAt: 1_000_000 },
    lastAskAt: null, answered: new Map(), attempts: new Map(), lastAskedAt: new Map(),
  };
  const d = heardAskDecision(A, null, r, 1_000_000 + 1000);
  assert.equal(d.ask, false);
  assert.equal(d.why, SKIP_IN_FLIGHT);
  assert.equal(d.target, B, 'which request is holding the slot');
});

test('heardAskDecision reports how long the shared airtime budget still has to run', () => {
  const r = { pending: null, lastAskAt: 1_000_000, answered: new Map(), attempts: new Map(), lastAskedAt: new Map() };
  const d = heardAskDecision(A, null, r, 1_000_000 + 20_000);
  assert.equal(d.why, SKIP_BUDGET);
  assert.equal(d.waitMs, REGION_INTERVAL_MS - 20_000);
});

test('heardAskDecision reports the remaining per-target backoff', () => {
  const r = {
    pending: null, lastAskAt: null, answered: new Map(),
    attempts: new Map([[A, 1]]), lastAskedAt: new Map([[A, 1_000_000]]),
  };
  const d = heardAskDecision(A, null, r, 1_000_000 + 60_000);
  assert.equal(d.why, SKIP_BACKOFF);
  assert.equal(d.waitMs, retryBackoffFor(1) - 60_000);
});

test('heardAskDecision separates "already answered" from "backed off" — one is done, the other is waiting', () => {
  const r = { pending: null, lastAskAt: null, answered: new Map([[A, 4242]]), attempts: new Map(), lastAskedAt: new Map() };
  assert.equal(heardAskDecision(A, 4242, r, 9_000_000).why, SKIP_ANSWERED);
});
