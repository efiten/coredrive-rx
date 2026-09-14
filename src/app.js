// coredrive-rx — wiring + Home monitor UI + Settings + on-screen debug.
// Pipeline: companion BLE 0x88 frame → parse raw packet → direct-heard filter →
// tag with phone GPS → IndexedDB queue → MQTT publish to CoreScope's ingestor.
// The companion's own pubkey (from SELF_INFO) is the identity / clientId / topic;
// the user never types it.
//
// Home is a pure monitor (counters, status strip, last-reception SNR meter, recently
// heard). Discover runs automatically with a traffic backoff (see monitor.js). Config
// and diagnostics live on the Settings tab.
import { WebBluetoothTransport } from './transport.js';
import { parseFrame, PUSH_CODE_LOG_RX_DATA } from './frames.js';
import { parsePacket, deriveHeardKey, bytesToHex, isFloodRoute, ADV_TYPE_REPEATER } from './meshpacket.js';
import { requestSelfInfo, requestDeviceInfo, setPathHashMode } from './selfinfo.js';
import { resolveName, resolvePubkey } from './names.js';
import { upsertHeard, sameNode, addNodeKey } from './recent.js';
import { updateMotion, captureDecision } from './motion.js';
import { createWakeLock } from './wakelock.js';
import { createBeeper } from './beeper.js';
import { createLocalMap } from './localmap.js';
import { hexCellAt } from './hexgrid.js';
import {
  discoverDecision, isOrganicHeard, snrToPct, decayPeak, pruneTimestamps, linkTransition,
} from './monitor.js';
import { shareLog } from './sharelog.js';
import { Gps } from './gps.js';
import { Queue } from './queue.js';
import { Publisher, KEEPALIVE_SECS } from './publisher.js';
import { drainOnce, serialiseDrain } from './drain.js';
import { loadConfig, getConfig, featureEnabled } from './config.js';
import { buildRfLogRecord } from './capture.js';
import { heardKeyAfterVerify } from './advertsig.js';
import { buildStatsRequest, parseStats, mergeSample, nextSampleDelay, STATS_CORE, STATS_RADIO, STATS_PACKETS } from './rfstats.js';
import { buildRegionsRequest, parseRegionsResponse, parseSentAck } from './regionreq.js';
import {
  enqueue, dueToSend, takeNext, registerOutstanding, matchOutstanding, pruneOutstanding,
  markAnswered, markAsked, newSignalRange, noteSignal, holdUntilReply, releaseHold,
} from './regionsched.js';
import { regionsRows } from './regionsview.js';
import { uplinkState, uplinkWarning, pushOutcome, regionInertReason, buildLogHeader, REGION_DISCOVERY_MIN_FW } from './uplink.js';
import {
  buildGetContactByKey, parseContactReply, needsPathOverride, buildOverrideFrame,
  buildRestoreFrame, encodePendingRestore, decodePendingRestore, RESP_CODE_OK, RESP_CODE_ERR,
  RESTORE_STORAGE_KEY,
} from './contactpath.js';

const LOG_LINE_CAP = 200; // dbg ring buffer; stated in the exported log header

const els = (id) => document.getElementById(id);
const state = {
  transport: null, gps: new Gps(), queue: new Queue(), publisher: null,
  companionPubkey: '', companionName: '', connected: false, recent: [],
  localMap: null, verbose: false, motion: null, paused: false, wakeLock: null,
  soundEnabled: false, beeper: null,
  // monitor counters / state
  rxTotal: 0, rfLogged: 0, nodeKeys: [], hexCells: new Set(), rxTimes: [],
  lastUploadAt: null, brokerState: 'offline',
  // Diagnostics carried into the exported log header (src/uplink.js): a startup
  // dbg line rolls out of the 200-line buffer within minutes, a header cannot.
  fwVer: null, uplink: 'no-config', lastUplinkLogged: null, lastRegionInertLogged: null,
  pendingCount: 0, lastConfigTryAt: null,
  // pubFailures: consecutive publish failures per queue id, so one unpublishable
  // record can be stepped over instead of blocking every record behind it forever.
  // staleReported: ids of retired publishers already called out, so an orphaned
  // client's endless reconnect loop is named once rather than flooding the log.
  pubFailures: new Map(), staleReported: new Set(),
  lastHeard: null, snrBarPct: 0, snrPeakPct: 0,
  // auto-discover
  lastHeardAt: null, lastFireAt: 0, tick: null,
  // RF environment sampler
  rfTimer: null, lastRfSample: null, rfGen: 0,
  // linkQuiet: true while the BLE link is down, so the pause and the resume are each
  // said once instead of once per tick.
  linkQuiet: false,
  // Region discovery (ANON_REQ_TYPE_REGIONS) — purely reception-driven: a repeater is
  // asked while we are hearing it, never on a clock (src/regionsched.js holds the
  // rules). supported reflects the FIRMWARE_VER_CODE gate.
  //
  //   queue        repeaters heard and not yet asked, drained one ask at a time
  //   targets      pubkey -> { attempts, lastAskedAt, lastHeardAt } for the CURRENT
  //                encounter; attempts is what the per-encounter cap counts
  //   answered     declared its list: out of rotation for the whole session
  //   outstanding  sent tag -> the request it belongs to, since several can be in
  //                flight and the tag is the only thing that tells them apart
  //   lastSignal   the signal of the most recent reception per repeater, so the ask
  //                that follows can be filed under the conditions that produced it
  regions: {
    supported: false,
    queue: [], targets: new Map(), answered: new Set(), outstanding: new Map(), lastSignal: new Map(),
    lastSentAt: null, busy: false, overrideRaw: null,
    // replyWaiters: target -> release, for the one round holding a contact override open
    // until that repeater answers (see holdUntilReply)
    replyWaiters: new Map(),
    heard: 0, queued: 0, asks: 0, replies: 0, flooded: 0, unmatched: 0, dropped: 0,
    capped: 0, bonus: 0,
    // The signal each ask went out on, split by what came back. If these two ranges
    // do not overlap, a signal floor is worth having and this says where it sits.
    sigAnswered: newSignalRange(), sigSilent: newSignalRange(),
    // answers: accepted replies, oldest first, for the Home "declared scopes" panel
    // (src/regionsview.js does the last-5/most-recent-first transform). Each entry
    // is { target, regions, truncated, at, name }; name is filled in lazily once
    // resolveName returns (see noteRegionsAnswer).
    answers: [],
  },
  // pathResolve: path-hash prefix -> whether it ever resolved to a full pubkey.
  // A Map, not two counters, because resolvePubkey is called on EVERY reception from
  // a forwarder and answers from its session cache — counting calls would report the
  // busiest node many times over and say nothing about how many distinct forwarders
  // could actually be identified. Last result wins, so a prefix that failed on a
  // transient network error and resolved later ends up counted as resolved.
  pathResolve: new Map(),
};

const RECENT_MAX = 20;
const REGIONS_ANSWERS_MAX = 200; // display only shows the last 5 (regionsview.js); this just bounds session memory
const HEX_COUNT_RES = 10; // fixed res (~90 m cells) for the distinct-hex session counter
// Build version, injected from package.json by Vite (see vite.config.js).
const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
// SNR → colour bucket (LoRa-ish). Returns a CSS colour.
function snrColor(snr) {
  if (snr == null) return '#95a5a6';
  if (snr >= 5) return '#2ecc71';
  if (snr >= -3) return '#f1c40f';
  if (snr >= -10) return '#e67e22';
  return '#e74c3c';
}

// noteHeard merges a heard node into the recent list (most-recent first). The same
// node can arrive under different key representations (path hash vs pubkey); the merge
// collapses them into one row. See src/recent.js.
function noteHeard(key, keylen, snr, rssi, src) {
  state.recent = upsertHeard(state.recent, { key, keylen, snr, rssi, src, now: Date.now() }, RECENT_MAX);
  const e = state.recent[0]; // merged entry is at the front
  // Resolve the name once per node, keyed on the canonical (longest) key. Re-find the
  // entry in the callback by sameNode (not exact key) so a key promotion mid-flight
  // (short hash → full pubkey) still writes the name to the merged row.
  if (e.name === undefined && !e._req) {
    e._req = true;
    const canon = e.key;
    resolveName(canon)
      .then((nm) => { const cur = state.recent.find((x) => sameNode(x.key, canon)); if (cur) { cur.name = nm || ''; renderRecent(); } })
      .catch(() => { const cur = state.recent.find((x) => sameNode(x.key, canon)); if (cur) cur._req = false; });
  }
  renderRecent();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderRecent() {
  const el = els('recent');
  if (!state.recent.length) { el.innerHTML = '<div class="muted">— nothing yet —</div>'; return; }
  el.innerHTML = state.recent.map((e) => {
    const snr = e.snr != null ? e.snr.toFixed(1) + ' dB' : 'no sig';
    const label = e.name ? esc(e.name) : '<span class="rk">' + e.key + '</span>';
    return '<div class="rr">' +
      '<span class="dot" style="background:' + snrColor(e.snr) + '"></span>' +
      '<span class="rname">' + label + '</span>' +
      '<span class="rsnr" style="color:' + snrColor(e.snr) + '">' + snr + '</span>' +
      '<span class="rc">×' + e.count + '</span></div>';
  }).join('');
}

// MQTT config comes from the runtime config.json (loaded at startup via
// loadConfig), never the UI. The publish account is a shared, publish-only
// ingest account (EMQX ACL); not a real secret.

function log(msg) { els('status').textContent = msg; }

// dbg(msg, level): newest-first log line. level 'ok'=green (captured/published),
// 'tx'=orange (our own discover sends), 'no'=red (held back/failed), default=grey (status).
function dbg(msg, level) {
  const el = els('log');
  const line = document.createElement('div');
  line.className = level === 'ok' ? 'lg-ok' : level === 'no' ? 'lg-no' : level === 'tx' ? 'lg-tx' : 'lg-st';
  line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  el.insertBefore(line, el.firstChild);
  while (el.childNodes.length > LOG_LINE_CAP) el.removeChild(el.lastChild);
}

// switchView cycles between Home (monitor), the full-screen Map, and Settings via the
// bottom bar. Leaflet must be invalidated when its container becomes visible, otherwise
// the tiles render at the wrong size.
function switchView(v) {
  els('view-home').style.display = v === 'home' ? 'block' : 'none';
  els('view-map').style.display = v === 'map' ? 'block' : 'none';
  els('view-settings').style.display = v === 'settings' ? 'block' : 'none';
  els('tabHome').classList.toggle('active', v === 'home');
  els('tabMap').classList.toggle('active', v === 'map');
  els('tabSettings').classList.toggle('active', v === 'settings');
  if (v === 'map' && state.localMap) state.localMap.invalidate();
}

// --- Discover (inbound: who can I hear?) ---
// Sends a ZERO-HOP CONTROL/DISCOVER_REQ (CMD_SEND_CONTROL_DATA=0x37). Every node in DIRECT
// RF range (repeater, companion, room server, sensor) replies with a DISCOVER_RESP carrying
// its pubkey, which arrives as a 0x88 frame and is attributed by deriveHeardKey (src=discover).
// Zero-hop, so it is NOT re-broadcast across the mesh — only local airtime. Wire format verified
// against meshcore_py commands/control_data.py + firmware payloads.md.
const CMD_SEND_CONTROL_DATA = 0x37;
const CTRL_NODE_DISCOVER_REQ = 0x80; // sub_type 0x8 in the upper nibble
const DISCOVER_PREFIX_ONLY = 0x01;   // lowest flag bit: responders send an 8-byte pubkey prefix
const DISCOVER_FILTER_ALL = 0xff;    // type_filter: bit per ADV_TYPE_*; all bits = every node type

function sendNodeDiscover() {
  if (!state.transport || !state.connected) return false;
  const tag = crypto.getRandomValues(new Uint8Array(4)); // reflected back in each DISCOVER_RESP
  const frame = new Uint8Array([CMD_SEND_CONTROL_DATA, CTRL_NODE_DISCOVER_REQ | DISCOVER_PREFIX_ONLY, DISCOVER_FILTER_ALL, ...tag]);
  state.transport.send(frame).catch((e) => dbg('discover send failed: ' + e.message, 'no'));
  return true;
}

// fireDiscover sends one zero-hop sweep and records the time so the next one is paced.
function fireDiscover(now) {
  if (sendNodeDiscover()) dbg('discover → zero-hop node-discover req (all types)', 'tx');
  state.lastFireAt = now;
}

// --- Region discovery (outbound: what does a repeater CLAIM to forward?) ---
// The ONLY part of this app that transmits addressed to one specific node. A request
// is answered only over a zero-hop DIRECT route, so it is worth sending exactly while
// the repeater's radio is demonstrably in range: every ask below is triggered by a
// reception of that repeater and by nothing else. src/regionsched.js holds the rules
// and the reasons; this is the wiring, the BLE round and the logging.
const REGION_ACK_TIMEOUT_MS = 4000;
// How long a contact whose stored path was forced to zero-hop is held that way when its
// repeater does NOT answer. When it does answer the hold ends there (holdUntilReply);
// every answer in the field logs so far came 1–2s after its ask. How early a restore is
// safe while no reply has come is a firmware question nothing here can answer, so this
// fallback keeps the old length.
const OVERRIDE_HOLD_MS = 20000;

// noteRepeaterHeard is called for every reception that identifies a repeater. It
// decides nothing itself — enqueue does — it just records what was heard and how well.
function noteRepeaterHeard(target, snr, rssi) {
  if (!state.transport) return;
  const r = state.regions;
  const cfg = getConfig();
  // noteRegionInert says which gate is holding this, exactly once — the four reasons
  // are otherwise indistinguishable from "no repeater heard yet".
  if (!featureEnabled(cfg, 'regionDiscovery') || !r.supported) { noteRegionInert(); return; }
  r.heard++;
  // Overwritten by every later reception: the signal that matters is the one the ask
  // actually goes out on, not the one that first put this repeater in the queue.
  r.lastSignal.set(target, { snr, rssi });
  const verdict = enqueue(r.queue, target, r.answered, r.targets, Date.now(), {
    targetGapMs: cfg.regionTargetGapSec * 1000,
    maxAsks: cfg.regionMaxAsks,
    forgetMs: cfg.regionForgetMin * 60000,
    bonusSnrDb: cfg.regionBonusSnrDb,
  }, snr);
  if (verdict === 'queued-now') r.queued++;
  else if (verdict === 'capped') r.capped++;
  else if (verdict === 'bonus') {
    r.queued++;
    r.bonus++;
    dbg('regions: heard ' + target.slice(0, 12) + '… at snr ' + snr
      + ', well above the ' + r.targets.get(target).bestAskSnr + ' its asks went out on — one more ask', 'st');
  }
}

// regionTick drains the queue and retires requests too old to be answered. Driven by
// the one-second monitor tick rather than its own timer: this app is routinely
// backgrounded on a phone mid-drive, where a setInterval fires late or not at all.
function regionTick(now) {
  const r = state.regions;
  for (const rec of pruneOutstanding(r.outstanding, now)) {
    r.dropped++;
    noteSignal(r.sigSilent, rec.snr, rec.rssi);
  }
  if (!dueToSend(r.queue, now, r.lastSentAt, r.busy, getConfig().regionAskGapSec * 1000)) return;
  const target = takeNext(r.queue, r.answered);
  if (!target) return;
  askRepeater(target);
}

// sendAndReadTag sends one request and resolves with the companion's own
// RESP_CODE_SENT ack: { tag, isFlood }, or null when the write failed or no ack came.
// Every later reply is matched against that tag, so an ask whose tag was never captured
// is an ask whose answer could not be attributed to anyone — it is not counted.
function sendAndReadTag(frame) {
  return new Promise((resolve) => {
    if (!state.transport) { resolve(null); return; }
    const onAck = (dv) => {
      const ack = parseSentAck(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
      if (!ack) return;
      cleanup();
      resolve(ack);
    };
    const timer = setTimeout(() => { cleanup(); resolve(null); }, REGION_ACK_TIMEOUT_MS);
    function cleanup() { clearTimeout(timer); if (state.transport) state.transport.offFrame(onAck); }
    state.transport.onFrame(onAck);
    state.transport.send(frame).catch((e) => {
      cleanup();
      // A write that threw put nothing on the air. It costs the target nothing beyond
      // the attempt already counted, and the queue moves on rather than waiting it out.
      dbg('regions: ask never left the phone (' + e.message + ')', 'no');
      resolve(null);
    });
  });
}

// askRepeater runs one whole round: the contact-path override if this target needs one,
// the request, its ack, and the restore. `busy` is held for all of it, so two rounds
// can never interleave their contact writes.
async function askRepeater(target) {
  const r = state.regions;
  r.busy = true;
  r.lastSentAt = Date.now();
  // Stamped at the transmission, not when the target was queued: a target that waited
  // its turn behind others still gets its full gap measured from THIS ask onward. The
  // signal goes in too — it is what a later reception has to beat to earn a bonus ask.
  const sig = r.lastSignal.get(target) ?? { snr: null, rssi: null };
  markAsked(r.targets, target, r.lastSentAt, sig.snr);
  let overrode = false;
  try {
    const frame = buildRegionsRequest(target);
    const contact = await getContact(target);
    if (needsPathOverride(contact)) {
      localStorage.setItem(RESTORE_STORAGE_KEY, encodePendingRestore(state.companionPubkey, target, contact.raw));
      const ok = await writeContact(buildOverrideFrame(contact.raw), CONTACT_WRITE_TIMEOUT_MS);
      if (!ok) dbg('regions: path override for ' + target.slice(0, 12) + '… did not ack — asking anyway', 'no');
      overrode = true;
      r.overrideRaw = contact.raw;
    }
    const ack = await sendAndReadTag(frame);
    if (ack == null) {
      dbg('regions: no send-ack for ' + target.slice(0, 12) + '… — ask not counted', 'no');
    } else if (ack.isFlood) {
      // The companion floods whenever the target is a contact whose out_path is
      // unknown, and a repeater ignores a flooded request without any error. Saying so
      // is the difference between "no reply yet" and "no reply can come".
      r.flooded++;
      dbg('regions: ' + target.slice(0, 12) + '… went out over FLOOD — repeaters only answer DIRECT', 'no');
    } else {
      r.asks++;
      registerOutstanding(r.outstanding, ack.tag, target, Date.now(), sig.snr, sig.rssi);
      dbg('regions → asked ' + target.slice(0, 12) + '… on snr ' + sig.snr + ' / rssi ' + sig.rssi
        + ' (attempt ' + r.targets.get(target).attempts + ' of ' + getConfig().regionMaxAsks
        + ' this encounter, queue ' + r.queue.length + ', outstanding ' + r.outstanding.size + ')', 'tx');
    }
    if (overrode) {
      // Held until this repeater answers, or OVERRIDE_HOLD_MS when it does not. A reply
      // can in principle land before the hold starts; then there is nothing to wait for.
      const ended = r.answered.has(target) ? 'reply' : await holdUntilReply(r.replyWaiters, target, OVERRIDE_HOLD_MS);
      const why = ended === 'reply' ? 'reply in, hold ended early' : 'no reply in ' + Math.round(OVERRIDE_HOLD_MS / 1000) + 's';
      const restored = await writeContact(buildRestoreFrame(r.overrideRaw), CONTACT_WRITE_TIMEOUT_MS);
      if (restored) { clearPendingRestore(target); dbg('regions: restored ' + target.slice(0, 12) + '…’s original path (' + why + ')', 'st'); }
      else dbg('regions: restore for ' + target.slice(0, 12) + '… did not ack — will retry on next connect', 'no');
    }
  } catch (e) {
    // state.transport is nulled the moment the companion drops, and this round
    // dereferences it in several places. Without this the rejection is unobserved.
    dbg('regions: ask to ' + target.slice(0, 12) + '… failed: ' + e.message, 'no');
  } finally {
    r.overrideRaw = null;
    r.busy = false;
  }
}

// --- Contact-path override (src/contactpath.js has the frame layout + decision) ---
// A target this app wants to ask may already be a saved contact whose stored
// out_path is not the zero-hop link node-discover just confirmed — sendAnonReq
// then floods or source-routes over a stale path, and a flooded/misrouted ask gets
// no reply (repeaters require a direct route from the CURRENT neighbour). Force the
// contact to zero-hop before asking, then always restore it, whether the ask
// succeeded, failed outright (still flooded), or simply timed out with no reply.
const GET_CONTACT_TIMEOUT_MS = 4000;
const CONTACT_WRITE_TIMEOUT_MS = 4000;
// getContact reads one contact by pubkey. Resolves parseContactReply's result, or
// null on a timeout/send failure — callers treat null the same as "not a contact":
// skip the override and ask as-is, since that is exactly today's (broken-for-
// contacts) behaviour and never worse than not asking at all. The ERR_CODE_NOT_FOUND
// reply carries no pubkey to match against (see src/contactpath.js), so a found
// reply is matched by its own echoed pub_key field; nothing else in this app issues
// CMD_GET_CONTACT_BY_KEY concurrently (transport.js serialises writes and this is
// the only per-target BLE flow), so an unmatched not-found reply arriving in this
// window can only be the answer to THIS request.
function getContact(pubkeyHex) {
  if (!state.transport) return Promise.resolve(null); // disconnected between scheduling and running this round
  return new Promise((resolve) => {
    const onFrame = (dv) => {
      const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      const parsed = parseContactReply(bytes);
      if (!parsed) return;
      if (parsed.found && bytesToHex(parsed.raw.slice(1, 33)) !== pubkeyHex) return; // some other contact's reply
      cleanup();
      resolve(parsed);
    };
    const timer = setTimeout(() => {
      cleanup();
      dbg('regions: contact lookup timed out for ' + pubkeyHex.slice(0, 12) + '… — asking without the path check', 'no');
      resolve(null);
    }, GET_CONTACT_TIMEOUT_MS);
    function cleanup() { clearTimeout(timer); if (state.transport) state.transport.offFrame(onFrame); }
    state.transport.onFrame(onFrame);
    state.transport.send(buildGetContactByKey(pubkeyHex)).catch((e) => { cleanup(); dbg('regions: contact lookup failed: ' + e.message, 'no'); resolve(null); });
  });
}

// writeContact sends a CMD_ADD_UPDATE_CONTACT frame (override or restore) and waits
// for its RESP_CODE_OK/RESP_CODE_ERR reply. Like getContact, this reply carries no
// correlator — same "only one in-flight BLE command of this kind" argument applies.
function writeContact(frame, timeoutMs) {
  if (!state.transport) return Promise.resolve(false); // disconnected mid-round — see getContact
  return new Promise((resolve) => {
    const onFrame = (dv) => {
      const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      if (bytes[0] !== RESP_CODE_OK && bytes[0] !== RESP_CODE_ERR) return;
      cleanup();
      resolve(bytes[0] === RESP_CODE_OK);
    };
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    function cleanup() { clearTimeout(timer); if (state.transport) state.transport.offFrame(onFrame); }
    state.transport.onFrame(onFrame);
    state.transport.send(frame).catch(() => { cleanup(); resolve(false); });
  });
}

// maybeReplayPendingRestore runs once per connect, before any region-discovery ask:
// if a previous session died between an override write and its restore, the target
// contact is still sitting zero-hop on the companion. Replayed only against the SAME
// companion the record was made for (keyed on self pubkey from SELF_INFO) — never a
// different one, which may have an unrelated contact under that pubkey.
async function maybeReplayPendingRestore() {
  const stored = localStorage.getItem(RESTORE_STORAGE_KEY);
  if (!stored) return;
  const rec = decodePendingRestore(stored);
  if (!rec) { localStorage.removeItem(RESTORE_STORAGE_KEY); return; } // corrupt — nothing safe to replay
  if (rec.self !== state.companionPubkey) return; // belongs to a different companion — leave it for its own connect
  dbg('regions: replaying a pending contact-path restore for ' + rec.target.slice(0, 12) + '… left over from a previous session', 'st');
  const ok = await writeContact(buildRestoreFrame(rec.raw), CONTACT_WRITE_TIMEOUT_MS);
  if (ok) { localStorage.removeItem(RESTORE_STORAGE_KEY); dbg('regions: pending restore replayed OK', 'ok'); }
  else dbg('regions: pending restore did not ack — will retry next connect', 'no');
}

function clearPendingRestore(target) {
  const rec = decodePendingRestore(localStorage.getItem(RESTORE_STORAGE_KEY) || '');
  if (rec && rec.self === state.companionPubkey && rec.target === target) localStorage.removeItem(RESTORE_STORAGE_KEY);
}

// onRegionsFrame is a dedicated BLE frame listener for ANON_REQ_TYPE_REGIONS replies.
// parseRegionsResponse checks bytes[0] itself — it must see the RAW notification,
// never parseFrame(...).data (parseFrame strips the leading code byte, which would
// silently misfire this check and discard every reply with no error anywhere).
//
// The reply is attributed on the tag it echoes, never on "a request is outstanding":
// several are, and guessing would file one repeater's declared regions under another
// and store it as fact.
function onRegionsFrame(dv) {
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  const parsed = parseRegionsResponse(bytes);
  if (!parsed) return;
  const r = state.regions;
  const hit = matchOutstanding(r.outstanding, parsed);
  if (!hit) {
    r.unmatched++;
    dbg('regions ← reply tag ' + parsed.tag + ' matches no outstanding ask — dropped, not attributed', 'no');
    return;
  }
  r.replies++;
  noteSignal(r.sigAnswered, hit.snr, hit.rssi);
  markAnswered(r.answered, r.queue, hit.target);
  releaseHold(r.replyWaiters, hit.target); // no-op unless this repeater's contact is held overridden
  noteRegionsAnswer(hit.target, hit.regions, hit.truncated);
  state.queue.add({
    kind: 'regions', at: new Date().toISOString(), target: hit.target,
    regions: hit.regions, truncated: hit.truncated, repeater_clock: hit.repeaterClock,
    rx_pubkey: state.companionPubkey,
  }).catch((e) => dbg('regions queue failed: ' + e.message, 'no'));
  dbg('regions ← ' + hit.target.slice(0, 12) + '… declares: ' + (hit.regions.join(',') || '(none)')
    + ' — asked on snr ' + hit.snr + ' / rssi ' + hit.rssi
    + ' (' + r.replies + ' of ' + r.asks + ' asks answered)', 'ok');
}

function renderDiscoverStatus(dec) {
  const el = els('discStatus');
  if (dec.state === 'link-down') { el.textContent = '🎯 Discover paused — companion link down'; return; }
  if (!state.connected || dec.state === 'paused') { el.textContent = ''; return; }
  if (dec.state === 'backoff') { el.textContent = '🎯 Backoff (verkeer actief)'; return; }
  el.textContent = dec.secs > 0 ? '🎯 Discover actief — volgende in ' + dec.secs + 's' : '🎯 Discover actief';
}

function renderPauseChip() {
  const el = els('pausechip');
  if (state.paused) { el.textContent = '⏸ Paused — stationary (resumes when you move)'; el.style.display = 'block'; }
  else { el.style.display = 'none'; }
}

// setPaused reacts to a moving↔stationary transition. Capture is gated in processFrame
// on state.paused; the discover loop is gated via discoverDecision (state 'paused').
function setPaused(paused) {
  if (paused === state.paused) return;
  state.paused = paused;
  renderPauseChip();
  dbg(paused ? 'stationary — capture/upload paused' : 'moving again — capture/upload resumed', paused ? 'no' : 'ok');
}

// --- Uplink health + config recovery (pure decisions in src/uplink.js) ---
// A degraded uplink used to be visible NOWHERE: the progress list said "All
// connected", the Home screen said nothing, and the only evidence was an absence
// of 'published …' lines. Everything below exists to make it a named, on-screen,
// logged state.

// currentUplink names the state of the config → publisher → broker chain.
function currentUplink() {
  return uplinkState({ hasConfig: !!getConfig(), hasPublisher: !!state.publisher, brokerState: state.brokerState });
}

// renderUplinkChip keeps an unhealthy uplink permanently on screen, and logs each
// TRANSITION once — a per-tick line would flood the 200-line buffer and push out
// exactly the history needed to diagnose it.
function renderUplinkChip() {
  state.uplink = currentUplink();
  const warn = uplinkWarning(state.uplink, state.connected);
  const el = els('uplinkchip');
  if (warn) { el.textContent = warn; el.style.display = 'block'; } else { el.style.display = 'none'; }
  if (state.uplink !== state.lastUplinkLogged) {
    if (state.lastUplinkLogged !== null) dbg('uplink → ' + state.uplink, state.uplink === 'ok' ? 'ok' : 'no');
    state.lastUplinkLogged = state.uplink;
  }
}

// applyConfigToSettings reflects the EFFECTIVE config on the Settings screen. Called
// at startup, after a successful retry, and after the firmware check, so a late
// config never leaves the screen describing one that failed to arrive. It is the
// single writer of regionsInfo — two writers previously disagreed.
function applyConfigToSettings() {
  const cfg = getConfig();
  els('fullRfLogInfo').style.display = featureEnabled(cfg, 'fullRfLog') ? '' : 'none';
  els('rfSamplerInfo').style.display = featureEnabled(cfg, 'rfSampler') ? '' : 'none';
  const regionsOn = featureEnabled(cfg, 'regionDiscovery');
  els('regionsInfo').style.display = regionsOn ? '' : 'none';
  if (!regionsOn) return;
  // Before the firmware is read, `supported` is still false and fwVer unknown —
  // reporting it "off" there would be a verdict on no evidence.
  if (state.fwVer == null && !state.connected) { els('regionsInfo').textContent = 'Region discovery: on (firmware checked on connect)'; return; }
  const why = regionInertReason({ config: cfg, supported: state.regions.supported, fwVer: state.fwVer });
  els('regionsInfo').textContent = why ? 'Region discovery: off — ' + why : 'Region discovery: on';
}

// noteRegionInert says ONCE, in the debug log, whether region discovery can
// transmit — and if not, which of the four gates is holding it. "No regions lines
// in the log" was previously consistent with all four and distinguished none.
function noteRegionInert() {
  const why = regionInertReason({ config: getConfig(), supported: state.regions.supported, fwVer: state.fwVer });
  const key = why ?? 'active';
  if (key === state.lastRegionInertLogged) return;
  state.lastRegionInertLogged = key;
  dbg(why ? 'regions: inert — ' + why : 'regions: active — will ask repeaters as they are heard', why ? 'no' : 'ok');
}

// startPublisher builds the MQTT publisher from the loaded config and connects it.
// Split out of connectAll so a config that only arrives on a LATER retry can bring
// uploading up on its own, without the user reconnecting the companion.
async function startPublisher() {
  if (state.publisher) {
    if (state.publisher.connected()) return true;
    // Never ADOPT a publisher that is not connected. It has its own 4 s reconnect loop,
    // and reporting success for it made connectAll print '③ CoreScope connected ✓' over
    // a client that was in fact looping. Retiring it stops that loop and its events.
    dbg('retiring publisher #' + state.publisher.id + ' — it was not connected', 'no');
    state.publisher.end();
    state.publisher = null;
  }
  const cfg = getConfig();
  if (!cfg || !cfg.mqttUrl) return false;
  state.publisher = new Publisher({ url: cfg.mqttUrl, username: cfg.mqttUsername, password: cfg.mqttPassword, clientId: state.companionPubkey });
  state.publisher.onStatus(onBrokerStatus);
  await state.publisher.connect();
  state.brokerState = 'connect';
  renderBroker();
  renderUplinkChip();
  return true;
}

// retryConfig re-attempts the single fetch whose one failure used to sink an entire
// session: no publisher was built, and fullRfLog / rfSampler / regionDiscovery all
// read false. Safe to call repeatedly — loadConfig dedupes concurrent attempts and
// caches only on success.
async function retryConfig() {
  if (getConfig()) return true;
  try {
    await loadConfig();
  } catch (e) {
    return false;
  }
  dbg('config.json loaded on retry — uploading and feature flags are live now', 'ok');
  applyConfigToSettings();
  noteRegionInert();
  if (state.connected) {
    try { await startPublisher(); } catch (e) { dbg('broker connect after config retry failed: ' + e.message, 'no'); }
    startRfSampler(); // returns immediately if the flag is off; was skipped when config was missing at connect
  }
  renderUplinkChip();
  return true;
}

// bleLinkUp asks the transport, which asks the browser. Not a flag of ours: the link
// drops without warning and a mirrored copy is stale exactly when it matters.
function bleLinkUp() {
  return !!state.transport && state.transport.connected();
}

// noteLinkState says once that the radio work has stopped, and once that it resumed.
// Without it a dropped link reads as a log that simply goes quiet — which is the same
// thing as an app that has crashed, an area with no traffic, or a feature turned off.
function noteLinkState(linkUp) {
  const edge = linkTransition(state.linkQuiet, linkUp);
  if (!edge) return;
  state.linkQuiet = !linkUp;
  if (edge === 'down') dbg('companion link down — discover, RF sampling and region asks held until it is back', 'no');
  else dbg('companion link back — discover, RF sampling and region asks resumed', 'ok');
}

// --- Per-second monitor tick: drives auto-discover, the SNR-meter decay, and the
// time-relative labels (last-heard / last-upload / rate / discover countdown). Runs only
// while connected.
function monitorTick() {
  const now = Date.now();
  const linkUp = bleLinkUp();
  noteLinkState(linkUp);
  const dec = discoverDecision(now, state.lastHeardAt, state.lastFireAt, state.paused, linkUp);
  if (dec.fire) { fireDiscover(now); renderDiscoverStatus(discoverDecision(now, state.lastHeardAt, state.lastFireAt, state.paused, linkUp)); }
  else renderDiscoverStatus(dec);
  if (!linkUp) return; // nothing below this can reach the radio
  // The only region-discovery work left on the clock: free a timed-out ask, so the
  // slot is available to the very next repeater heard instead of one tick later. The
  // asking itself happens on receptions (noteRepeaterHeard), never on a timer.
  regionTick(now);
  // A session that started without config must be able to heal without a restart:
  // retry once a minute (not per tick) for as long as it is missing.
  if (!getConfig() && (state.lastConfigTryAt == null || now - state.lastConfigTryAt >= 60000)) {
    state.lastConfigTryAt = now;
    retryConfig();
  }
  renderUplinkChip();
  state.snrPeakPct = decayPeak(state.snrPeakPct, state.snrBarPct, 1000);
  renderSnrMeter();
  state.rxTimes = pruneTimestamps(state.rxTimes, now);
  renderStatusStrip();
  renderLastHeard();
}

// --- Home renderers ---
function renderCounters() {
  els('cNodes').textContent = String(state.nodeKeys.length);
  els('cHex').textContent = String(state.hexCells.size);
  els('cRx').textContent = String(state.rxTotal);
  const cfg = getConfig();
  const fullRfLog = featureEnabled(cfg, 'fullRfLog');
  els('cRfLogRow').style.display = fullRfLog ? '' : 'none';
  if (fullRfLog) els('cRfLog').textContent = String(state.rfLogged);
}

function agoText(at, now) {
  if (at == null) return '—';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return s + 's geleden';
  return Math.floor(s / 60) + 'm geleden';
}

async function renderStatusStrip() {
  const now = Date.now();
  const fix = currentFix();
  els('sGps').textContent = fix ? '✓ ' + Math.round(fix.acc_m) + 'm' : '… no fix';
  state.pendingCount = await state.queue.count(); // also stamped into the exported log header
  els('sPending').textContent = state.pendingCount + ' pending';
  els('sRate').textContent = state.rxTimes.length + ' pkt/min';
  const dot = els('uDot');
  const color = !state.publisher ? '#9aa4b2'
    : state.brokerState === 'connect' ? '#2ecc71'
    : state.brokerState === 'reconnect' ? '#e6a23c'
    : '#e74c3c'; // offline / close / error → red so a dead link is obvious, not idle-grey
  dot.style.background = color;
  els('sUpload').lastChild.textContent = state.lastUploadAt ? 'upload ' + agoText(state.lastUploadAt, now) : 'upload —';
}

function renderLastHeard() {
  if (!state.lastHeard) { els('lastHeardCard').style.display = 'none'; return; }
  els('lastHeardCard').style.display = 'block';
  // Derive the label live so it upgrades from ID → resolved name once names.js
  // returns (the per-second tick re-renders this).
  const { key, at } = state.lastHeard;
  els('lhLine').textContent = nodeLabel(key) + ' — ' + agoText(at, Date.now());
}

// renderRegionsCard shows the last 5 repeaters that answered a region-discovery
// request, most recent first. Hidden entirely until there is at least one answer.
// declaresNothing is a real answer (the repeater flood-allows nothing), rendered
// distinctly from a non-empty list — never left blank as if unknown.
function renderRegionsCard() {
  const rows = regionsRows(state.regions.answers);
  if (!rows.length) { els('regionsCard').style.display = 'none'; return; }
  els('regionsCard').style.display = 'block';
  els('regionsList').innerHTML = rows.map((r) => {
    const label = r.name ? esc(r.name) : '<span class="rk">' + r.target.slice(0, 12) + '…</span>';
    const regionsCls = r.declaresNothing ? 'rgregions none' : 'rgregions';
    // '*' is not a region name — it declares that plain, unscoped floods are
    // forwarded. Shown as a separate marker so it cannot be read as a scope.
    const unscopedTag = r.unscoped ? '<span class="rgunscoped">+ unscoped</span>' : '';
    const regionsText = (r.declaresNothing ? 'declares no regions flood-allowed' : esc(r.regions.join(', '))) + unscopedTag;
    const warn = r.truncated ? '<div class="rgwarn">⚠ truncated — some regions may be missing</div>' : '';
    return '<div class="rgrow"><div class="rgname">' + label + '</div>' +
      '<div class="' + regionsCls + '">' + regionsText + '</div>' + warn + '</div>';
  }).join('');
}

// noteRegionsAnswer records an accepted region-discovery reply for the Home panel
// (renderRegionsCard). Name resolution reuses names.js's session cache — one lookup
// per newly-seen target, not a network call on every render.
function noteRegionsAnswer(target, regions, truncated) {
  const rec = { target, regions, truncated, at: Date.now(), name: undefined };
  state.regions.answers.push(rec);
  if (state.regions.answers.length > REGIONS_ANSWERS_MAX) state.regions.answers.shift();
  resolveName(target).then((nm) => { rec.name = nm || ''; renderRegionsCard(); });
  renderRegionsCard();
}

function renderSnrMeter() {
  els('snrFill').style.width = state.snrBarPct + '%';
  els('snrFill').style.background = snrColor(state.lastHeard ? state.lastHeard.snr : null);
  els('snrPeak').style.left = state.snrPeakPct + '%';
  els('snrVal').textContent = state.lastHeard && state.lastHeard.snr != null ? state.lastHeard.snr.toFixed(1) + ' dB' : '';
}

// noteSnr updates the SNR meter from the latest reception (any packet, even no-GPS).
function noteSnr(snr) {
  state.snrBarPct = snrToPct(snr);
  if (state.snrBarPct > state.snrPeakPct) state.snrPeakPct = state.snrBarPct;
  renderSnrMeter();
}

// --- Settings renderers ---
function renderBroker() {
  const m = { connect: 'connected', reconnect: 'reconnecting…', offline: 'offline', close: 'disconnected', error: 'error' };
  els('brokerStatus').textContent = state.publisher ? (m[state.brokerState] || state.brokerState) : '— not connected —';
}

// onBrokerStatus logs every MQTT lifecycle change to the debug log (previously invisible,
// so a field disconnect couldn't be diagnosed) and flushes the backlog on (re)connect.
function onBrokerStatus(s, arg, id) {
  // Only the CURRENT publisher may move the broker state. An orphaned client keeps its
  // own 4 s reconnect loop running and its failures used to overwrite brokerState, so a
  // healthy link was reported as down and the log filled with errors nobody could
  // attribute — ~18 'Keepalive timeout' lines against a single successful connect,
  // which is impossible for one client. Name each stale publisher once, then ignore it.
  const live = state.publisher ? state.publisher.id : null;
  if (id !== live) {
    if (!state.staleReported.has(id)) {
      state.staleReported.add(id);
      dbg('ignoring MQTT events from retired publisher #' + id + ' (live: ' + (live ?? 'none') + '), first was "' + s + '"', 'no');
    }
    return;
  }
  state.brokerState = s;
  if (s === 'connect') dbg('CoreScope connected (publisher #' + id + ', connack rc=' + ((arg && arg.returnCode) ?? '?') + ', keepalive ' + KEEPALIVE_SECS + 's)', 'ok');
  else if (s === 'reconnect') dbg('CoreScope reconnecting…', 'st');
  else if (s === 'offline') dbg('CoreScope offline (no network?)', 'no');
  else if (s === 'close') dbg('CoreScope connection closed', 'no');
  else if (s === 'error') dbg('CoreScope error: ' + ((arg && arg.message) || arg), 'no');
  renderBroker();
  renderStatusStrip();
  if (s === 'connect') drain().then(refreshCounters).catch(() => {}); // flush backlog on (re)connect
}

function setButton() {
  const b = els('btnConnect');
  b.textContent = state.connected ? 'Disconnect' : 'Connect companion (BLE)';
  b.classList.toggle('danger', state.connected);
}

// Stepped progress block under the button.
function progressReset() { els('progress').innerHTML = ''; }
function step(msg, cls) {
  const d = document.createElement('div');
  d.textContent = msg;
  if (cls) d.className = cls;
  els('progress').appendChild(d);
  return d;
}

function currentFix() { return state.gps.latest(); }

async function processFrame(dv) {
  const f = parseFrame(dv);
  if (!f || f.code !== PUSH_CODE_LOG_RX_DATA) return;
  const rawHex = bytesToHex(f.raw);
  const sig = ' snr=' + f.snr + ' rssi=' + f.rssi;
  if (state.verbose) dbg('0x88 raw=' + rawHex + sig, 'st'); // raw bytes only when verbose-debugging
  const pkt = parsePacket(f.raw);
  // An advert's Ed25519 signature is the only proof that the pubkey in it belongs to a
  // node that exists. Gated behind verifyAdverts, a failed check drops the identity and
  // leaves the reception itself in the non-attributed path below, where the measurement
  // is still recorded. Named in the log, because "the advert is missing" and "the advert
  // was forged" are otherwise the same silence.
  const claimed = deriveHeardKey('rx', pkt);
  const hk = await heardKeyAfterVerify(claimed, pkt, featureEnabled(getConfig(), 'verifyAdverts'));
  if (claimed && !hk) dbg('advert ' + claimed.heardKey.slice(0, 8) + '… failed its signature check, identity dropped', 'no');
  if (!hk) {
    // Explain why a frame wasn't attributed. Direct multi-hop packets can't be credited (the
    // transmitter removed itself from the path's front), and 1-byte hops are collision-prone —
    // both are called out. Everything else (tx / no advert) is pure noise, verbose only.
    const lastHop = pkt && pkt.hops.length ? pkt.hops[pkt.hops.length - 1] : null;
    const cfg = getConfig();
    // featureEnabled, not `cfg && cfg.fullRfLog`: with no config loaded this used to
    // read "off" and throw away RF data for the whole session. Collecting queues it
    // for the publish that happens once config arrives.
    const logged = featureEnabled(cfg, 'fullRfLog');
    const suffix = logged ? ', logged' : ', skipped';
    if (lastHop && pkt.hops.length && !isFloodRoute(pkt.routeType)) dbg('direct route — transmitter not in path' + suffix, 'st');
    else if (lastHop && lastHop.length === 2) dbg('1-byte path-hash (' + lastHop + ') — seen' + suffix, 'st');
    else if (state.verbose) dbg('not attributable (tx / no advert)' + suffix + sig, 'no');

    // fullRfLog: the packet is not coverage, so the counters, SNR meter,
    // recently-heard list, beeper and map hexes must not move. The motion/
    // idle-gate state below IS deliberately shared with the coverage path —
    // updateMotion is a pure function of the latest GPS fix and now, the same
    // fix already drives it on every GPS callback, and applying the idle gate
    // here is the point (a stationary phone shouldn't queue RF-log rows either).
    if (!logged) return;
    const rfFix = currentFix();
    let rfCapture = false;
    if (rfFix) {
      const rfDec = captureDecision(state.motion, rfFix, Date.now());
      state.motion = rfDec.motion;
      setPaused(state.motion.paused);
      rfCapture = rfDec.capture;
    }
    const rfRec = buildRfLogRecord({
      hk, fullRfLog: logged, rawHex, snr: f.snr, rssi: f.rssi,
      fix: rfFix, captureAllowed: rfCapture, nowISO: new Date().toISOString(),
    });
    if (!rfRec) return;
    state.rfLogged++;
    await state.queue.add(rfRec);
    renderCounters();
    return;
  }

  // Organic traffic (an overheard forwarder/advert, not our own discover reply) means we're
  // in an active area — back off discover so we don't poll on top of live traffic.
  if (isOrganicHeard(hk)) state.lastHeardAt = Date.now();

  // Region-discovery candidates: only a 0-hop advert (hk.src === 'advert') carries the
  // full pubkey ANON_REQ_TYPE_REGIONS needs to address, and only ADV_TYPE_REPEATER
  // firmware implements the reply (simple_repeater/MyMesh.cpp) — a chat/room/sensor
  // node would just be a request that can never be answered.
  //
  // advertTs is stored ONLY as the answered-key, which makes the policy "ask each
  // repeater once per session". It does NOT signal a config change: Mesh.cpp:418
  // sets it to getCurrentTime() on every advert, so it moves every advert interval
  // (47h in this network) whether or not anything changed. The firmware DOES track
  // a real config-change signal — _prefs.discovery_mod_timestamp, set on `regions
  // save` (CommonCLI.cpp:1037) and filterable via the discover request's optional
  // `since` field (simple_repeater/MyMesh.cpp:791-798) — but asking once per drive
  // is deliberate: it costs ~19 requests against the ~180 the discover sweep already
  // sends, and it keeps every stored list demonstrably current instead of assumed.
  const regionsCfg = getConfig();
  if (featureEnabled(regionsCfg, 'regionDiscovery') && hk.src === 'advert' && pkt.advertType === ADV_TYPE_REPEATER && pkt.advertTs != null) {
    noteRepeaterHeard(hk.heardKey, f.snr, f.rssi);
  }
  // Discover responses are the common case (47h advert intervals mean real adverts are
  // rare) but carry only an 8-byte pubkey prefix in practice — resolve to the full
  // 32-byte pubkey ANON_REQ_TYPE_REGIONS must address before keying the candidate map,
  // so the same repeater never appears twice under two different keys. advertTs is
  // stored null: the due rule (answered.get(pubkey) !== advertTs, see dueDelayMs)
  // then asks it once per session and re-asks automatically if a real advert with a
  // timestamp later arrives. Async and non-blocking — a failed resolve just adds nothing.
  if (featureEnabled(regionsCfg, 'regionDiscovery') && hk.src === 'discover' && pkt.discoverType === ADV_TYPE_REPEATER) {
    resolvePubkey(hk.heardKey).then((pk) => {
      if (!pk) return;
      noteRepeaterHeard(pk, f.snr, f.rssi);
    });
  }

  // Forwarders as candidates. A 'rxlog' attribution only happens on a FLOOD route,
  // where path[last] IS the node that transmitted to us (see deriveHeardKey) — one
  // radio hop away, which is exactly the direct-neighbour relation a regions request
  // needs. The hop carries only a 2-4 byte prefix of that node's pubkey (the app asks
  // the companion for 2-byte mode on connect), so it has to be resolved first, the
  // same way the discover path above already does; a prefix is not addressable.
  //
  // Node type is unknown here — a path hash carries none. That is acceptable rather
  // than ignored: a node only appears in a path because it RETRANSMITTED the packet,
  // and companions and sensors do not forward, so this population is repeaters (and
  // possibly room servers, which forward but do not answer ANON_REQ_TYPE_REGIONS).
  // A non-answerer costs one ask and is then held off by the existing 5/15/30-minute
  // backoff, the same as a repeater that stays silent.
  //
  // This fills a real gap: isOrganicHeard backs the discover sweep off for 15s after
  // any organic reception, so in busy areas — where forwarder traffic is densest —
  // the sweep is suppressed and yields the FEWEST discover-sourced candidates exactly
  // where there is the most to hear.
  if (featureEnabled(regionsCfg, 'regionDiscovery') && hk.src === 'rxlog') {
    resolvePubkey(hk.heardKey).then((pk) => {
      state.pathResolve.set(hk.heardKey, !!pk);
      if (!pk) return;
      noteRepeaterHeard(pk, f.snr, f.rssi);
    });
  }

  noteHeard(hk.heardKey, hk.heardKeyLen, f.snr, f.rssi, hk.src); // show in the list even without a GPS fix
  state.rxTotal++;
  state.rxTimes.push(Date.now());
  addNodeKey(state.nodeKeys, hk.heardKey);
  state.lastHeard = { key: hk.heardKey, snr: f.snr, at: Date.now() };
  noteSnr(f.snr); // sets bar/peak + colour from the now-current lastHeard
  renderCounters();
  renderLastHeard();

  const fix = currentFix();
  if (!fix) { dbg('heard ' + hk.heardKey + ' (' + hk.src + ')' + sig + ' — no GPS, not queued', 'no'); return; }
  // Wake-on-packet (issue #9): a heard packet advances the idle gate too, so movement
  // resumes capture even when the GPS callback cadence stalled while backgrounded /
  // screen-off. A packet from a moved position unpauses; one still at the parked
  // anchor stays paused.
  const dec = captureDecision(state.motion, fix, Date.now());
  state.motion = dec.motion;
  setPaused(state.motion.paused);
  if (!dec.capture) { dbg('heard ' + hk.heardKey + ' (' + hk.src + ')' + sig + ' — stationary, not queued', 'no'); return; }
  dbg('heard ' + hk.heardKey + ' (' + hk.heardKeyLen + 'B, ' + hk.src + ')' + sig, 'ok');
  state.hexCells.add(hexCellAt(fix.lat, fix.lon, HEX_COUNT_RES));
  renderCounters();
  const rec = { rx_at: new Date().toISOString(), raw: rawHex, snr: f.snr, rssi: f.rssi, lat: fix.lat, lon: fix.lon, acc_m: fix.acc_m };
  await state.queue.add(rec);
  if (state.soundEnabled && state.beeper) state.beeper.beep(); // audio cue per mapped node (#7)
  if (state.localMap) state.localMap.addPoint(fix.lat, fix.lon, f.snr); // live hex on the map
  refreshCounters();
}

// nodeLabel returns the resolved name for a heard key if known, else the key itself.
function nodeLabel(key) {
  const e = state.recent.find((x) => sameNode(x.key, key));
  return e && e.name ? e.name : key;
}

async function refreshCounters() {
  renderCounters();
  renderStatusStrip();
}

// drain publishes as much of the buffered queue as the link allows, once. The loop and
// its commit rules live in src/drain.js (tested there); this is only the wiring.
//
// It used to collect every published id and call queue.remove ONCE after the loop, so a
// single rejecting publish threw the progress away — and since publishes are sequential,
// a 59-record backlog needs ~5 s of continuous link at 86 ms round-trip and ~18 s at
// 300 ms. On a mobile link that stayed up about a second at a time, that design could
// never commit anything at all.
// Serialised: drainLoop, the broker 'connect' event, the 'online' event and the Push
// button all call this, and two overlapping passes each take their own queue snapshot
// and publish the SAME rows. Seen in the field as 'published 59 record(s)' followed one
// second later by 'published 49 record(s)' for a 59-record queue — 49 duplicate rows
// delivered to the ingestor. A caller arriving mid-pass now joins the running one.
const drain = serialiseDrain(async () => {
  const r = await drainOnce({
    queue: state.queue,
    publisher: state.publisher,
    pubkey: state.companionPubkey,
    name: state.companionName,
    failures: state.pubFailures,
    log: dbg,
  });
  if (r.committed) {
    state.lastUploadAt = Date.now();
    dbg('published ' + r.committed + ' record(s)' + (r.stopped === 'link' ? ' before the link dropped — rest kept' : ''), 'ok');
  }
  return r.committed;
});

// drainLoop runs forever every 5 s. A publish to a dead socket never acks, but
// publisher.publish now times out (rejecting), and rescheduling lives in `finally`, so a
// stalled send can never kill the loop (the +60-pending-on-WiFi bug).
async function drainLoop() {
  try {
    await drain();
    refreshCounters();
  } catch (e) {
    dbg('publish error (kept buffered): ' + e.message, 'no');
  } finally {
    setTimeout(drainLoop, 5000);
  }
}

// pushNow is the Settings button: the manual recovery path for a client sitting on a
// backlog. It reports queue depth SEPARATELY from link health and picks the repair
// that matches the actual fault (pushOutcome in src/uplink.js decides both).
//
// What it replaces: a single 'nothing pending / not connected' line that could not
// tell a healthy empty queue from a dead uplink holding hundreds of records — and a
// reconnect branch guarded on `state.publisher && !connected()`, which SKIPPED the
// one case that most needed recovery: no publisher at all (null), where it then
// reported "nothing pending" no matter how deep the queue was.
async function pushNow() {
  const b = els('btnPush');
  b.disabled = true;
  try {
    const pending = await state.queue.count();
    const uplink = currentUplink();
    const published = uplink === 'ok' ? await drain() : 0;
    const outcome = pushOutcome({ uplink, pending, published });
    dbg(outcome.message, outcome.level);
    if (outcome.reloadConfig) {
      if (await retryConfig()) await drain(); // config arrived — flush immediately
    } else if (outcome.reconnect) {
      if (state.publisher) state.publisher.reconnect(); // drain fires on the 'connect' event
      else if (state.connected) await startPublisher();
    }
  } catch (e) {
    dbg('push failed (kept buffered): ' + e.message, 'no');
  } finally {
    b.disabled = false;
    refreshCounters();
    renderUplinkChip();
  }
}

async function connectAll() {
  els('btnConnect').disabled = true;
  progressReset();
  els('companionInfo').textContent = '— not connected —';
  els('hashinfo').textContent = '';
  log('');
  const s1 = step('① Connecting to companion…', 'pending');
  try {
    state.transport = new WebBluetoothTransport();
    state.transport.onFrame(processFrame);
    state.transport.onFrame(onRegionsFrame); // no-op unless a region request is in flight
    state.transport.onStatus((s) => {
      dbg('BLE: ' + s);
      if (state.connected) log(s === 'connected' ? 'capturing' : 'BLE ' + s + '…');
    });
    await state.transport.connect();
    s1.textContent = '① Companion connected ✓';
    s1.className = '';

    const s2 = step('② Reading companion ID…', 'pending');
    const info = await requestSelfInfo(state.transport);
    state.companionPubkey = info.pubkey.toLowerCase();
    state.companionName = info.name || ''; // sent as "origin" so the server can name this observer
    s2.textContent = '② Companion: ' + (info.name || '(unnamed)') + ' ✓';
    s2.className = '';
    els('companionInfo').textContent = (info.name ? info.name + ' · ' : '') + state.companionPubkey.slice(0, 20) + '…';
    dbg('SELF_INFO → ' + (info.name || '(unnamed)') + ' ' + state.companionPubkey);
    await maybeReplayPendingRestore(); // fix up any contact left zero-hop by a crash/BLE-drop last session, before anything else touches it

    // Ensure the companion adverts with 2-byte path hashes — 1-byte mode produces
    // collision-prone IDs that our capture rule rejects, so the contribution is useless.
    // state.regions.supported resets to false BEFORE the query: if requestDeviceInfo
    // throws below, a stale `true` from an earlier connection (e.g. a prior device,
    // or a prior successful connect this session) must never carry over — an
    // unverified device would otherwise spend this feature's one airtime budget on
    // firmware that silently ignores the request, indistinguishable from being out
    // of range.
    state.regions.supported = false;
    try {
      const di = await requestDeviceInfo(state.transport);
      if (di.pathHashMode === 0 || di.pathHashMode == null) {
        await setPathHashMode(state.transport, 1);
        els('hashinfo').textContent = '⚙️ Set companion to 2-byte path-hash mode';
        dbg('path-hash mode was ' + di.pathHashMode + ' → set to 1 (2-byte)');
      } else {
        els('hashinfo').textContent = 'Path-hash mode: ' + (di.pathHashMode + 1) + '-byte ✓';
        dbg('path-hash mode already ' + di.pathHashMode + ' (' + (di.pathHashMode + 1) + '-byte)');
      }
      // Region discovery needs FIRMWARE_VER_CODE >= 13 to address a repeater that
      // isn't already a saved contact (CMD_SEND_ANON_REQ, companion_radio/MyMesh.cpp).
      // di.fwVer IS that byte (RESP_CODE_DEVICE_INFO offset 1). Off by default in
      // config; when on but the firmware is too old, leave it off and say why —
      // no silent failure. Both branches write the Settings line: reconnecting to a
      // v13+ device after a v12 one must not leave a stale "off — firmware v12" on
      // screen while the feature is actually live.
      state.fwVer = di.fwVer;
      state.regions.supported = di.fwVer >= REGION_DISCOVERY_MIN_FW;
    } catch (e) {
      // requestDeviceInfo threw or timed out — supported stays false and fwVer stays
      // null, and applyConfigToSettings/noteRegionInert below both report that as the
      // reason rather than leaving an enabled-looking feature that never transmits.
      dbg('hash-mode check skipped: ' + e.message);
    }
    // One writer for the Settings line and one for the log, both fed by the same
    // pure regionInertReason — the two former writers could disagree.
    applyConfigToSettings();
    noteRegionInert();

    state.gps.start((fix) => {
      if (state.localMap) state.localMap.setPosition(fix.lat, fix.lon);
      state.motion = updateMotion(state.motion, fix, Date.now());
      setPaused(state.motion.paused);
    });

    const s3 = step('③ Connecting to CoreScope…', 'pending');
    // One more attempt at the fetch whose single startup failure used to sink the
    // entire session. Connecting is a deliberate user action with the radio up, so
    // it is the best moment to retry.
    await retryConfig();
    const uploading = await startPublisher();
    if (uploading) {
      s3.textContent = '③ CoreScope connected ✓';
      s3.className = '';
    } else {
      s3.textContent = '③ NOT uploading — config.json not loaded; needs internet once (retrying)';
      s3.className = 'err';
    }

    // Never claim an uplink we do not have. This line read "✅ All connected —
    // capturing" through an entire session that published nothing at all.
    if (uploading) step('✅ All connected — capturing');
    else step('⚠️ Capturing + buffering — NOT uploading', 'err');
    state.connected = true;
    setButton();
    state.lastFireAt = 0; // fire a discover sweep immediately on the first tick
    state.tick = setInterval(monitorTick, 1000);
    startRfSampler();
    renderUplinkChip();
    log('capturing as ' + (info.name || state.companionPubkey.slice(0, 12)));
    switchView('home'); // connected → jump to the live monitor

  } catch (e) {
    step('✗ ' + e.message, 'err');
    dbg('connect failed: ' + e.message, 'no');
    log('connect failed: ' + e.message);
    await disconnectAll(true);
  }
  els('btnConnect').disabled = false;
  refreshCounters();
}

// RF environment sampler. Three local BLE queries per tick — nothing goes on
// the air. Whole-sample-or-nothing: a tick that does not collect all three
// responses within RF_TIMEOUT_MS is discarded, because a partial sample would
// skew whichever delta chain it landed in on the server.
const RF_TIMEOUT_MS = 2000;

function renderRfSampler() {
  if (!state.lastRfSample) return;
  els('rfSamplerInfo').textContent = 'RF: ' + state.lastRfSample.noise_floor + ' dBm · RX air ' + state.lastRfSample.rx_air_secs + ' s';
}

function startRfSampler() {
  const cfg = getConfig();
  if (!featureEnabled(cfg, 'rfSampler')) return;

  // Generation guard: a tick awaits state.queue.add(sample) mid-cycle. If
  // disconnectAll() → stopRfSampler() → startRfSampler() (reconnect) all happen
  // during that await, the stale tick would otherwise resume, overwrite the new
  // session's state.rfTimer with its own reschedule, and run a second concurrent
  // tick loop against this closure's now-orphaned `pending` map. Each session
  // bumps state.rfGen; a tick only reschedules itself if its captured
  // generation is still current.
  state.rfGen += 1;
  const myGen = state.rfGen;

  const pending = new Map(); // subType -> resolve
  state.transport.onFrame((dvFrame) => {
    const bytes = new Uint8Array(dvFrame.buffer, dvFrame.byteOffset, dvFrame.byteLength);
    const s = parseStats(bytes);
    if (!s) return;
    const resolve = pending.get(s.subType);
    if (resolve) { pending.delete(s.subType); resolve(s); }
  });

  const ask = (subType) => new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(subType); resolve(null); }, RF_TIMEOUT_MS);
    pending.set(subType, (v) => { clearTimeout(timer); resolve(v); });
    state.transport.send(buildStatsRequest(subType)).catch(() => {
      clearTimeout(timer);
      pending.delete(subType);
      resolve(null);
    });
  });

  const tick = async () => {
    if (!state.transport || !state.companionPubkey) return;
    // A sample taken over a dead link is three writes that throw and one
    // "rf sample incomplete — discarded" line. Reschedule and wait for the link.
    if (!bleLinkUp()) {
      if (state.rfGen !== myGen) return;
      state.rfTimer = setTimeout(tick, nextSampleDelay(state.motion ? state.motion.paused : false));
      return;
    }
    const fix = currentFix();
    if (fix) {
      const core = await ask(STATS_CORE);
      const radio = await ask(STATS_RADIO);
      const packets = await ask(STATS_PACKETS);
      const sample = mergeSample(core, radio, packets, fix, new Date().toISOString(), state.motion ? state.motion.paused : false);
      if (sample) {
        await state.queue.add(sample);
        state.lastRfSample = sample; // Settings diagnostics line
        renderRfSampler();
        dbg('rf sample noise=' + sample.noise_floor + 'dBm rx_air=' + sample.rx_air_secs + 's', 'st');
      } else {
        dbg('rf sample incomplete — discarded', 'no');
      }
    }
    if (state.rfGen !== myGen) return; // superseded by a disconnect/reconnect during the await above
    state.rfTimer = setTimeout(tick, nextSampleDelay(state.motion ? state.motion.paused : false));
  };

  state.rfTimer = setTimeout(tick, nextSampleDelay(state.motion ? state.motion.paused : false));
}

function stopRfSampler() {
  state.rfGen += 1; // invalidate any tick currently mid-await so it will not reschedule itself
  if (state.rfTimer) { clearTimeout(state.rfTimer); state.rfTimer = null; }
}

async function disconnectAll(keepProgress) {
  state.connected = false;
  state.motion = null;
  state.paused = false;
  renderPauseChip();
  clearInterval(state.tick); state.tick = null;
  stopRfSampler();
  // Outstanding requests die with the transport: no reply can arrive on a link that is
  // gone, and a tag from this session must never match one from the next.
  state.regions.outstanding.clear();
  state.regions.queue.length = 0;
  // A contact left zero-hop here is exactly what the localStorage crash-safety record
  // covers — leave it in place (do NOT restore over a transport that's gone, and do NOT
  // clear the record) so maybeReplayPendingRestore fixes it on the next connect.
  if (state.regions.overridePending) { clearTimeout(state.regions.overridePending.timer); state.regions.overridePending = null; }
  els('discStatus').textContent = '';
  if (state.wakeLock) state.wakeLock.disable(); // let the screen sleep again
  if (state.publisher) { state.publisher.end(); state.publisher = null; }
  state.brokerState = 'offline';
  renderBroker();
  try { state.gps.stop(); } catch (e) {}
  if (state.transport) { try { await state.transport.disconnect(); } catch (e) {} state.transport = null; }
  els('companionInfo').textContent = '— not connected —';
  els('hashinfo').textContent = '';
  if (!keepProgress) { progressReset(); log('disconnected.'); }
  setButton();
}

window.addEventListener('DOMContentLoaded', async () => {
  els('appver').textContent = 'v' + VERSION;
  // First line of every session names the build. The exported log also carries it in
  // a header (buildLogHeader) because this line rolls out of the 200-line buffer
  // within minutes — two field logs arrived with no way to tell which version wrote
  // them, which sent a diagnosis down the wrong path entirely.
  dbg('CoreDrive RX v' + VERSION + ' started', 'st');
  try {
    await loadConfig();
    applyConfigToSettings();
  } catch (e) {
    // Loud on THREE surfaces. This failure previously wrote one line to els('status'),
    // which connectAll then cleared with log('') — so the most consequential startup
    // fault in the app was invisible in the very log people share to report it.
    dbg('config.json failed to load: ' + e.message, 'no');
    // config.json is deliberately never served from the offline cache, so starting
    // the app needs a live connection ONCE. Say that here rather than leaving the
    // user to infer it: capture and buffering are unaffected, only uploading waits.
    dbg('the app needs an internet connection at startup to fetch config.json — capture and buffering still work, uploading waits; retrying every minute and as soon as the network returns', 'no');
    log('Config error: ' + e.message + ' — needs internet to load settings; retrying automatically.');
    applyConfigToSettings();
  }
  renderUplinkChip();
  setButton();
  state.wakeLock = createWakeLock();
  // Audio cue (#7): default off, but remember the choice across app starts.
  state.beeper = createBeeper();
  state.soundEnabled = localStorage.getItem('coredrive.sound') === '1';
  els('chkSound').checked = state.soundEnabled;
  // Web Bluetooth missing (e.g. iOS Safari) — point the user to a supported browser.
  if (!navigator.bluetooth) els('btnotice').style.display = 'block';
  els('btnConnect').addEventListener('click', () => {
    if (state.connected) { disconnectAll(); return; }
    state.wakeLock.enable(); // acquire in the user gesture (iOS needs it for video.play())
    if (state.soundEnabled) state.beeper.ensure(); // unlock audio in the same gesture
    connectAll();
  });
  els('btnClear').addEventListener('click', () => { els('log').textContent = ''; });
  els('chkVerbose').addEventListener('change', (e) => { state.verbose = e.target.checked; });
  els('chkSound').addEventListener('change', (e) => {
    state.soundEnabled = e.target.checked;
    localStorage.setItem('coredrive.sound', state.soundEnabled ? '1' : '0');
    if (state.soundEnabled) state.beeper.ensure(); // unlock + confirm audio in this gesture
  });
  els('btnPush').addEventListener('click', pushNow);
  els('btnShareLog').addEventListener('click', async () => {
    const lines = Array.from(els('log').childNodes).map((n) => n.textContent);
    // Built HERE, at share time, so it can never roll out of the ring buffer the way
    // a logged startup line does. It carries everything a reader of a shared log
    // needs and previously had to guess: app version, the EFFECTIVE config flags
    // (which is how a stale cached config becomes visible), firmware version, whether
    // region discovery can transmit at all, uplink state and queue depth.
    const header = buildLogHeader({
      version: VERSION,
      nowISO: new Date().toISOString(),
      config: getConfig(),
      fwVer: state.fwVer,
      regionsSupported: state.regions.supported,
      companionName: state.companionName,
      companionPubkey: state.companionPubkey,
      uplink: currentUplink(),
      pending: state.pendingCount,
      pathResolve: {
        attempted: state.pathResolve.size,
        resolved: Array.from(state.pathResolve.values()).filter(Boolean).length,
      },
      asks: {
        heard: state.regions.heard, seen: state.regions.targets.size,
        asks: state.regions.asks, replies: state.regions.replies,
        answered: state.regions.answered.size, queue: state.regions.queue.length,
        outstanding: state.regions.outstanding.size, flooded: state.regions.flooded,
        unmatched: state.regions.unmatched, dropped: state.regions.dropped,
        capped: state.regions.capped, bonus: state.regions.bonus,
        sigAnswered: state.regions.sigAnswered, sigSilent: state.regions.sigSilent,
      },
      lineCount: lines.length,
      lineCap: LOG_LINE_CAP,
    });
    const text = header + (lines.join('\n') || '(empty log)');
    try { await shareLog(text); } catch (e) { dbg('share failed: ' + e.message, 'no'); }
  });
  els('btnDbg').addEventListener('click', () => {
    const logEl = els('log');
    const show = logEl.style.display === 'none';
    logEl.style.display = show ? 'block' : 'none';
    els('btnDbg').textContent = show ? 'Hide debug log' : 'Show debug log';
  });
  renderRecent();
  renderCounters();
  renderStatusStrip();
  renderBroker();
  drainLoop();
  state.localMap = createLocalMap('liveMap');
  els('tabHome').addEventListener('click', () => switchView('home'));
  els('tabMap').addEventListener('click', () => switchView('map'));
  els('tabSettings').addEventListener('click', () => switchView('settings'));
  switchView(state.connected ? 'home' : 'settings'); // land on Settings (where Connect lives) until connected
  // Network came back (e.g. cellular→WiFi handoff, or the radio finally up after a
  // cold start in a garage). Retry the config FIRST: this is the moment the fetch
  // that failed at startup can finally succeed, and draining before it is pointless
  // — with no config there is no publisher to drain into.
  window.addEventListener('online', () => {
    retryConfig().finally(() => { drain().then(refreshCounters).catch(() => {}); });
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});
