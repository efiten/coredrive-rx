// coredrive-rx — the orchestrator: state, the BLE/queue/publish wiring, and the
// calls into src/ui that paint it. No DOM is built here (test/appdom.test.mjs
// pins that); every element write goes through a src/ui renderer.
// Pipeline: companion BLE 0x88 frame → parse raw packet → direct-heard filter →
// tag with phone GPS → IndexedDB queue → MQTT publish to CoreScope's ingestor.
// The companion's own pubkey (from SELF_INFO) is the identity / clientId / topic;
// the user never types it.
//
// Three tabs (src/ui/shell.js): Drive is the session map with its HUD, Heard is
// the glance-first monitor, Status holds Connect, the broker and the
// diagnostics. Discover runs automatically with a traffic backoff (monitor.js).
import { WebBluetoothTransport } from './transport.js';
import { parseFrame, PUSH_CODE_LOG_RX_DATA } from './frames.js';
import { parsePacket, deriveHeardKey, bytesToHex, isFloodRoute, ADV_TYPE_REPEATER } from './meshpacket.js';
import { requestSelfInfo, requestDeviceInfo, setPathHashMode } from './selfinfo.js';
import { resolveName, resolvePubkey } from './names.js';
import { upsertHeard, sameNode, addNodeKey } from './recent.js';
import { updateMotion, captureDecision } from './motion.js';
import { createWakeLock } from './wakelock.js';
import { createBeeper } from './beeper.js';
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
import { uplinkState, uplinkWarning, pushOutcome, regionInertReason, buildLogHeader, REGION_DISCOVERY_MIN_FW } from './uplink.js';
import {
  buildGetContactByKey, parseContactReply, needsPathOverride, buildOverrideFrame,
  buildRestoreFrame, encodePendingRestore, decodePendingRestore, RESP_CODE_OK, RESP_CODE_ERR,
  RESTORE_STORAGE_KEY,
} from './contactpath.js';
import { prefKey, themeKey } from './storage.js';
import { createShell, nextTab, tabOnConnect, TAB_STORAGE_KEY } from './ui/shell.js';
import { readingModel, renderReading } from './ui/reading.js';
import { statusLine, recentRows, countsModel, renderHeard } from './ui/heardview.js';
import { connectSteps, diagnosticsLines, renderStatus, appendLogLine } from './ui/statusview.js';
import { batteryLine, isLowBattery } from './ui/battery.js';
import { createMap } from './ui/map.js';
import { resolveTheme, nextThemePref } from './ui/theme.js';
import {
  splashState, splashRows, dismissBanner, SPLASH_ERRORS, COACH_MARKS, APP_NAME,
  renderSplashRows, positionCoachMarks,
} from './ui/splash.js';
import { calloutPosition } from './ui/calloutPosition.js';
import { hasUnseenEntries, migratedSeenId, renderWhatsNew } from './ui/changelog.js';
import { parseVersion, isUpdateAvailable } from './ui/update.js';

const LOG_LINE_CAP = 200; // dbg ring buffer; stated in the exported log header

const els = (id) => document.getElementById(id);
const state = {
  transport: null, gps: new Gps(), queue: new Queue(), publisher: null,
  companionPubkey: '', companionName: '', connected: false, recent: [],
  map: null, verbose: false, motion: null, paused: false, wakeLock: null,
  soundEnabled: false, beeper: null,
  // logLines: the debug-log ring buffer, newest first. Held here rather than read
  // back out of the DOM, so the shared log (buildLogHeader + these lines) does not
  // depend on how the #sheet-log sheet happens to render them.
  logLines: [],
  // The three numbered connect steps (src/ui/statusview.js owns their labels and
  // the "a failure stops the walk" rule); each is 'pending' | 'active' | 'done' |
  // 'failed'.
  steps: { companion: 'pending', id: 'pending', broker: 'pending' },
  // firstConnect: the tab only jumps to Drive on the FIRST connect of a session
  // (tabOnConnect) — a reconnect while Heard is open must not yank the screen away.
  firstConnect: true,
  themePref: 'system',
  // Cold-start splash gate (src/ui/splash.js): splashDismissed is persisted
  // (prefKey('splashSeen')) once the gate first resolves, so it is a genuine
  // cold-start experience — shown at most once per install. splashBleError is
  // session-only, set by a failed connectAll and cleared by the next attempt.
  splashDismissed: false,
  splashBleError: false,
  // changelog: entries from changelog.json (vite.config.js's rx-changelog-json
  // plugin), fetched once at boot; null until that fetch resolves.
  changelog: null,
  // batteryMv: the companion's last reported pack voltage, read off the RF
  // sampler's STATS_CORE reply (src/rfstats.js already owns that request; a
  // second requester would install a second listener for the same frame).
  // 0 is firmware's "no VBAT sense" sentinel and src/ui/battery.js treats it so.
  batteryMv: null,
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
  // auto-discover; discover is the last decision rendered, so a pause/resume can
  // repaint the HUD line without waiting for the next tick
  lastHeardAt: null, lastFireAt: 0, tick: null, discover: { state: 'paused', secs: 0 },
  // RF environment sampler; lastRfSample is the Status screen's readout
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
    // answers: accepted replies, oldest first, for the Heard "declared scopes" fold
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

// --- Elements ---------------------------------------------------------------
// Every element a renderer touches is looked up once here: index.html's ids are
// static markup, and this module is a deferred `type="module"` script, so the
// document is parsed before it runs. app.js owns this id → renderer mapping; no
// src/ui module knows an id. (One-off lookups in the boot block and in event
// handlers still use els() directly; those run on a gesture, not per render.)
const HERO = {
  snr: els('hero-snr'), rssi: els('hero-rssi'), since: els('hero-since'),
  name: els('hero-name'), fill: els('hero-fill'), peak: els('hero-peak'),
};
const HUD = {
  snr: els('hud-snr'), rssi: els('hud-rssi'), since: els('hud-since'),
  name: els('hud-sender'),
};
const HEARD = {
  gps: els('sl-gps'), pending: els('sl-pending'), upload: els('sl-upload'),
  udot: els('sl-udot'), rate: els('sl-rate'), recent: els('recent'),
  cNodes: els('cNodes'), cHex: els('cHex'), cRx: els('cRx'),
  cRfLogRow: els('cRfLogRow'), cRfLog: els('cRfLog'),
  countsSummary: els('fold-counts-summary'),
  regionsList: els('regionsList'), foldScopes: els('fold-scopes'),
};
const STATUS = {
  progress: els('progress'),
  fullRfLog: els('fullRfLogInfo'), rfSampler: els('rfSamplerInfo'), regions: els('regionsInfo'),
  battery: els('batteryInfo'), broker: els('brokerStatus'), companion: els('companionInfo'),
};
// The single elements app.js writes itself, because no src/ui renderer owns
// them. The first four are written on every monitor tick.
const EL = {
  log: els('log'),
  discoverText: els('discover-text'), hudDiscover: els('hud-discover'),
  tbCounts: els('tb-counts'), hudBacklog: els('hud-backlog'),
  heroPause: els('hero-pause'), rfSampleReadout: els('rfSampleReadout'),
  dotBle: els('dot-ble'), dotMqtt: els('dot-mqtt'),
};
// Splash gate + coach marks (src/ui/splash.js).
const SPLASH = {
  root: els('splash'), name: els('splash-name'), rows: els('splash-rows'),
  status: els('splash-status'), dismiss: els('splash-dismiss'),
};
// Each mark's own element, plus its real anchor element — passed straight
// into positionCoachMarks (src/ui/splash.js) alongside calloutPosition.
const COACH_ELS = COACH_MARKS.map((m) => ({
  el: els(m.id), anchor: els(m.anchor), opts: { side: m.side },
}));
// "What's new" sheet + its unseen badge, and the update-available button.
const WHATSNEW = { body: els('wn-body'), dot: els('wn-dot'), btn: els('btnWhatsNew') };

// The shell owns every "which element is visible" decision (tabs, sheets,
// toasts). Created in the boot block, before anything can render.
let shell = null;

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
      .then((nm) => { const cur = state.recent.find((x) => sameNode(x.key, canon)); if (cur) { cur.name = nm || ''; renderHeardScreen(); } })
      .catch(() => { const cur = state.recent.find((x) => sameNode(x.key, canon)); if (cur) cur._req = false; });
  }
  renderHeardScreen();
}

// MQTT config comes from the runtime config.json (loaded at startup via
// loadConfig), never the UI. The publish account is a shared, publish-only
// ingest account (EMQX ACL); not a real secret.

function log(msg) { els('status').textContent = msg; }

// dbg(msg, level): newest-first log line. level 'ok' = captured/published,
// 'tx' = our own discover/region sends, 'no' = held back or failed, anything
// else plain status; src/ui/statusview.js turns that into the line's class.
// The text is ALSO kept in state.logLines, because the shared log
// (buildLogHeader + these lines) must not depend on reading the DOM back.
function dbg(msg, level) {
  const text = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  state.logLines.unshift(text);
  if (state.logLines.length > LOG_LINE_CAP) state.logLines.length = LOG_LINE_CAP;
  appendLogLine(EL.log, { text, level }, LOG_LINE_CAP);
}

// showTab is shell.show plus the one thing the shell cannot know: MapLibre only
// sizes itself correctly while its container is visible, so the map is resized
// every time Drive appears.
function showTab(tab) {
  shell.show(tab);
  if (tab === 'drive' && state.map) state.map.resize();
  if (tab === 'status') { requestBattery(); checkForUpdate(); }
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

// PAUSED_TEXT is one state on two surfaces: the hero card's chip on Heard and
// the HUD's own line on Drive.
const PAUSED_TEXT = '⏸ Paused — stationary (resumes when you move)';

// renderDiscoverStatus writes the Heard discover line and the Drive HUD line,
// the two places the sweep is visible. On Drive the map is all you look at, so
// while the motion gate is pausing capture the HUD line carries the gate's own
// text instead of the countdown — "why did capture stop" is the question the
// chip answers, and the chip itself is on the other screen. The countdown comes
// back on the tick after the gate releases.
function renderDiscoverStatus(dec) {
  state.discover = dec; // kept so renderPauseChip can repaint the HUD line at once
  EL.discoverText.textContent = discoverText(dec);
  EL.hudDiscover.textContent = state.paused ? PAUSED_TEXT : discoverText(dec);
}

function discoverText(dec) {
  if (dec.state === 'link-down') return 'Discover paused — companion link down';
  if (!state.connected || dec.state === 'paused') return '';
  if (dec.state === 'backoff') return 'Backoff — mesh traffic is arriving';
  return dec.secs > 0 ? 'Discover active — next in ' + dec.secs + 's' : 'Discover active';
}

// renderPauseChip shows the motion gate's state in the hero card: capture is
// paused while src/motion.js reports standing still (75 m / 5 min), and there is
// no manual pause in this app. The chip is the reading's own, so it sits with it
// rather than in the toast stack.
function renderPauseChip() {
  EL.heroPause.textContent = PAUSED_TEXT;
  EL.heroPause.hidden = !state.paused;
  renderDiscoverStatus(state.discover); // the HUD line follows the same state
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
  shell.toast('toast-uplink', warn || '');
  if (state.uplink !== state.lastUplinkLogged) {
    if (state.lastUplinkLogged !== null) dbg('uplink → ' + state.uplink, state.uplink === 'ok' ? 'ok' : 'no');
    state.lastUplinkLogged = state.uplink;
  }
}

// The broker's own words for its lifecycle states, for the Status line.
const BROKER_TEXT = { connect: 'connected', reconnect: 'reconnecting…', offline: 'offline', close: 'disconnected', error: 'error' };

// renderStatusScreen paints the whole Status screen: the three numbered connect
// steps, the diagnostics lines, the battery, the broker and the companion. One
// writer, called after anything it shows changes — a late config must never
// leave the screen describing one that failed to arrive.
//
// The raw config (or null) goes straight to diagnosticsLines, whose
// regionInertReason needs the real "not loaded" case; the two logging flags are
// resolved here with featureEnabled, which owns what a missing key means.
function renderStatusScreen() {
  const cfg = getConfig();
  renderStatus(STATUS, {
    steps: connectSteps(state.steps),
    diagnostics: diagnosticsLines({
      config: cfg,
      flags: { fullRfLog: featureEnabled(cfg, 'fullRfLog'), rfSampler: featureEnabled(cfg, 'rfSampler') },
      fwVer: state.fwVer,
      supported: state.regions.supported,
      // Whether a companion has been read at all: with none, an unknown firmware
      // version is not yet a reason for anything (src/ui/statusview.js).
      connected: state.connected,
    }),
    battery: batteryLine(state.batteryMv),
    broker: state.publisher ? (BROKER_TEXT[state.brokerState] || state.brokerState) : '— not connected —',
    companion: state.transport && state.companionPubkey
      ? (state.companionName ? state.companionName + ' · ' : '') + state.companionPubkey.slice(0, 20) + '…'
      : '— not connected —',
  });
  renderRfSampleReadout();
  renderDots();
}

// renderRfSampleReadout is the sampler's latest READING, in its own element
// below the diagnostics lines: #rfSamplerInfo carries the flag sentence
// ("RF sampler: on") that src/ui/statusview.js owns, and a second writer there
// would leave the two fighting over one line. Hidden until a sample exists.
function renderRfSampleReadout() {
  const el = EL.rfSampleReadout;
  const s = state.lastRfSample;
  el.hidden = !s;
  if (s) el.textContent = 'RF: ' + s.noise_floor + ' dBm · RX air ' + s.rx_air_secs + ' s';
}

// renderDots is the topbar pair: BLE on the left, MQTT on the right. The BLE dot
// goes amber on a low companion battery (src/ui/battery.js), which is the only
// place a low pack is visible from the map.
function renderDots() {
  EL.dotBle.className = !state.connected ? '' : isLowBattery(state.batteryMv) ? 'warn' : 'on';
  EL.dotMqtt.className = !state.publisher ? ''
    : state.brokerState === 'connect' ? 'on'
    : state.brokerState === 'reconnect' ? 'warn'
    : 'bad'; // offline / close / error — a dead link must not read as idle
}

// requestBattery asks the companion for STATS_CORE once, when the Status screen
// becomes visible. The RF sampler collects the same reply on its own cadence and
// battery_mv is taken off that too, but the sampler is a config flag: with it off
// the battery would otherwise never be read, and a low pack has to be visible
// either way (it is what turns #dot-ble amber). Nothing goes on the air — this is
// a local BLE query (src/rfstats.js).
//
// The listener is temporary, the same one-shot pattern getContact/writeContact
// use: a second PERMANENT listener for a frame the sampler already listens for
// is exactly what the design amendment forbids. A stray core reply reaching the
// sampler's listener while one of its own asks is pending is still a genuine core
// sample, so a tick that picks this one up is not a partial sample.
const BATTERY_TIMEOUT_MS = 2000;

function requestBattery() {
  if (!state.transport || !bleLinkUp()) return;
  const onFrame = (dv) => {
    const s = parseStats(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    if (!s || s.subType !== STATS_CORE) return;
    cleanup();
    state.batteryMv = s.battery_mv;
    renderStatusScreen();
  };
  const timer = setTimeout(cleanup, BATTERY_TIMEOUT_MS);
  function cleanup() { clearTimeout(timer); if (state.transport) state.transport.offFrame(onFrame); }
  state.transport.onFrame(onFrame);
  state.transport.send(buildStatsRequest(STATS_CORE)).catch(() => cleanup());
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
  renderStatusScreen();
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
  renderStatusScreen();
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
  state.rxTimes = pruneTimestamps(state.rxTimes, now);
  renderReadingCards();
  renderHeardScreen();
}

// --- The reading: the Heard hero card and the Drive HUD (src/ui/reading.js) ---
// One model, painted twice at two sizes. Nothing to paint before the first
// reception, so index.html's own placeholders stay until then.
function renderReadingCards() {
  if (!state.lastHeard) return;
  const { key, snr, rssi, at } = state.lastHeard;
  // The name is derived on every render so it upgrades from key → resolved name
  // once names.js answers (the per-second tick re-renders this).
  const m = readingModel({ snr, rssi, name: nodeLabel(key), at, now: Date.now(), peakPct: state.snrPeakPct });
  renderReading(HERO, m);
  renderReading(HUD, m);
}

// --- The Heard screen (src/ui/heardview.js) ---
// One writer for the status line, the recent list, the counts fold and the
// declared-scopes fold, plus the two places the counts summary also appears:
// the topbar chip and the Drive HUD's backlog line.
async function renderHeardScreen() {
  const now = Date.now();
  state.pendingCount = await state.queue.count(); // also stamped into the exported log header
  const counts = countsModel({
    nodes: state.nodeKeys.length, hex: state.hexCells.size, rx: state.rxTotal,
    rfLog: state.rfLogged, fullRfLog: featureEnabled(getConfig(), 'fullRfLog'),
  });
  renderHeard(HEARD, {
    status: statusLine({
      fix: currentFix(), pending: state.pendingCount, brokerState: uploadState(),
      lastPublishAt: state.lastUploadAt, rate: state.rxTimes.length, now,
    }),
    recent: recentRows(state.recent, now),
    counts,
    answers: state.regions.answers,
  });
  EL.tbCounts.textContent = counts.summary;
  EL.hudBacklog.textContent = state.pendingCount ? state.pendingCount + ' unsent' : '';
  renderDots();
}

// uploadState translates the publisher's own lifecycle word into the one
// heardview's UPLOAD_CLASS keys the healthy state on ('connected'), and null
// when there is no publisher at all — which is neither healthy nor an error.
function uploadState() {
  if (!state.publisher) return null;
  return state.brokerState === 'connect' ? 'connected' : state.brokerState;
}

// noteRegionsAnswer records an accepted region-discovery reply for the Heard
// screen's declared-scopes fold. Name resolution reuses names.js's session cache
// — one lookup per newly-seen target, not a network call on every render.
function noteRegionsAnswer(target, regions, truncated) {
  const rec = { target, regions, truncated, at: Date.now(), name: undefined };
  state.regions.answers.push(rec);
  if (state.regions.answers.length > REGIONS_ANSWERS_MAX) state.regions.answers.shift();
  resolveName(target).then((nm) => { rec.name = nm || ''; renderHeardScreen(); });
  renderHeardScreen();
}

// noteSnr updates the meter fill and its peak marker from the latest reception
// (any packet, even one with no GPS fix).
function noteSnr(snr) {
  state.snrBarPct = snrToPct(snr);
  if (state.snrBarPct > state.snrPeakPct) state.snrPeakPct = state.snrBarPct;
  renderReadingCards();
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
  renderStatusScreen();
  renderHeardScreen();
  if (s === 'connect') drain().then(renderHeardScreen).catch(() => {}); // flush backlog on (re)connect
}

function renderConnectButton() {
  els('btnConnect').textContent = state.connected ? 'Disconnect' : 'Connect companion (BLE)';
}

// setStep moves one of the three numbered connect steps and repaints them.
// src/ui/statusview.js decides what a 'failed' step does to the ones after it.
function setStep(name, value) {
  state.steps[name] = value;
  renderStatusScreen();
}

// failActiveStep marks whichever step was in flight as failed, so the screen
// says WHERE a connect died rather than only that it did.
function failActiveStep() {
  for (const name of ['companion', 'id', 'broker']) {
    if (state.steps[name] === 'active') { setStep(name, 'failed'); return; }
  }
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
    renderHeardScreen();
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
  // rssi is kept alongside snr because the hero card and the HUD both show it
  // (src/ui/reading.js); the pipeline itself never reads it back.
  state.lastHeard = { key: hk.heardKey, snr: f.snr, rssi: f.rssi, at: Date.now() };
  noteSnr(f.snr); // sets bar/peak + tier from the now-current lastHeard
  renderHeardScreen(); // before the two early returns below, so the counts always move

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
  const rec = { rx_at: new Date().toISOString(), raw: rawHex, snr: f.snr, rssi: f.rssi, lat: fix.lat, lon: fix.lon, acc_m: fix.acc_m };
  await state.queue.add(rec);
  if (state.soundEnabled && state.beeper) state.beeper.beep(); // audio cue per mapped node (#7)
  if (state.map) state.map.addPoint(fix.lat, fix.lon, f.snr); // live hex on the session map
  renderHeardScreen();
}

// nodeLabel returns the resolved name for a heard key if known, else the key itself.
function nodeLabel(key) {
  const e = state.recent.find((x) => sameNode(x.key, key));
  return e && e.name ? e.name : key;
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
    renderHeardScreen();
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
    renderHeardScreen();
    renderUplinkChip();
  }
}

async function connectAll() {
  els('btnConnect').disabled = true;
  els('hashinfo').textContent = '';
  log('');
  setStep('companion', 'active');
  state.splashBleError = false; // a fresh attempt clears the splash gate's last failure
  try {
    state.transport = new WebBluetoothTransport();
    state.transport.onFrame(processFrame);
    state.transport.onFrame(onRegionsFrame); // no-op unless a region request is in flight
    state.transport.onStatus((s) => {
      dbg('BLE: ' + s);
      if (state.connected) log(s === 'connected' ? 'capturing' : 'BLE ' + s + '…');
    });
    await state.transport.connect();
    setStep('companion', 'done');
    refreshSplash(); // radio is up — the gate moves from intro to waiting-gps

    setStep('id', 'active');
    const info = await requestSelfInfo(state.transport);
    state.companionPubkey = info.pubkey.toLowerCase();
    state.companionName = info.name || ''; // sent as "origin" so the server can name this observer
    setStep('id', 'done');
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
      // null, and renderStatusScreen/noteRegionInert below both report that as the
      // reason rather than leaving an enabled-looking feature that never transmits.
      dbg('hash-mode check skipped: ' + e.message);
    }
    // One writer for the Status screen and one for the log, both fed by the same
    // pure regionInertReason — the two former writers could disagree.
    renderStatusScreen();
    noteRegionInert();

    state.gps.start((fix) => {
      if (state.map) state.map.setPosition(fix);
      state.motion = updateMotion(state.motion, fix, Date.now());
      setPaused(state.motion.paused);
      refreshSplash(); // the splash gate's own hasFix condition
    });

    setStep('broker', 'active');
    // One more attempt at the fetch whose single startup failure used to sink the
    // entire session. Connecting is a deliberate user action with the radio up, so
    // it is the best moment to retry.
    await retryConfig();
    const uploading = await startPublisher();
    // Never claim an uplink we do not have: a failed third step is what says
    // "capturing and buffering, NOT uploading". The old summary line read
    // "✅ All connected — capturing" through a session that published nothing.
    setStep('broker', uploading ? 'done' : 'failed');
    if (!uploading) dbg('capturing + buffering, NOT uploading — config.json not loaded; needs internet once (retrying)', 'no');
    state.connected = true;
    renderConnectButton();
    state.lastFireAt = 0; // fire a discover sweep immediately on the first tick
    state.tick = setInterval(monitorTick, 1000);
    startRfSampler();
    renderUplinkChip();
    log('capturing as ' + (info.name || state.companionPubkey.slice(0, 12)));
    // The first connect of a session moves off Status once (src/ui/shell.js);
    // a later reconnect leaves whatever tab is open where it is.
    showTab(tabOnConnect(shell.current(), state.firstConnect));
    state.firstConnect = false;

  } catch (e) {
    failActiveStep();
    dbg('connect failed: ' + e.message, 'no');
    log('connect failed: ' + e.message);
    state.splashBleError = true;
    await disconnectAll(true);
  }
  refreshSplash();
  els('btnConnect').disabled = false;
  renderHeardScreen();
}

// RF environment sampler. Three local BLE queries per tick — nothing goes on
// the air. Whole-sample-or-nothing: a tick that does not collect all three
// responses within RF_TIMEOUT_MS is discarded, because a partial sample would
// skew whichever delta chain it landed in on the server.
const RF_TIMEOUT_MS = 2000;

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
      // The companion's battery rides along on the core stats this sampler already
      // asks for: src/ui/battery.js turns battery_mv into the Status line and the
      // amber BLE dot, and nothing else is put on the BLE link for it.
      if (core) { state.batteryMv = core.battery_mv; renderStatusScreen(); }
      const radio = await ask(STATS_RADIO);
      const packets = await ask(STATS_PACKETS);
      const sample = mergeSample(core, radio, packets, fix, new Date().toISOString(), state.motion ? state.motion.paused : false);
      if (sample) {
        await state.queue.add(sample);
        state.lastRfSample = sample; // Status screen's RF readout
        renderStatusScreen();
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

async function disconnectAll(keepSteps) {
  state.connected = false;
  state.motion = null;
  state.paused = false;
  state.batteryMv = null; // a stale reading must not keep the BLE dot amber
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
  renderDiscoverStatus({ state: 'paused', secs: 0 }); // clears both discover lines
  if (state.wakeLock) state.wakeLock.disable(); // let the screen sleep again
  if (state.publisher) { state.publisher.end(); state.publisher = null; }
  state.brokerState = 'offline';
  try { state.gps.stop(); } catch (e) {}
  if (state.transport) { try { await state.transport.disconnect(); } catch (e) {} state.transport = null; }
  els('hashinfo').textContent = '';
  // keepSteps is set by a FAILED connect, so the step that failed stays on screen
  // instead of being reset to three pending ones by the disconnect that follows it.
  if (!keepSteps) { state.steps = { companion: 'pending', id: 'pending', broker: 'pending' }; log('disconnected.'); }
  renderConnectButton();
  renderStatusScreen();
}

// --- Theme (src/ui/theme.js) ------------------------------------------------
// index.html paints the theme from the same stored key before any module loads
// (themeKey() is deliberately un-namespaced so that inline script can read it).
// applyTheme keeps the cycle, the painted theme and the map's basemap in step.
function prefersDark() {
  return typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)').matches : undefined;
}

function storedThemePref() {
  try { return localStorage.getItem(themeKey()) || 'system'; } catch (e) { return 'system'; }
}

function applyTheme(pref) {
  state.themePref = pref;
  try { localStorage.setItem(themeKey(), pref); } catch (e) { /* private mode */ }
  const theme = resolveTheme(pref, prefersDark());
  document.documentElement.dataset.theme = theme;
  els('btnTheme').textContent = 'Theme: ' + pref;
  if (state.map) state.map.setTheme(theme);
}

// --- Cold-start splash gate + coach-mark tour (src/ui/splash.js) -----------
// initSplashContent writes the copy that never changes while the gate is up
// (splash-name, each coach mark's text). Called once at startup.
function initSplashContent() {
  SPLASH.name.textContent = APP_NAME;
  for (let i = 0; i < COACH_MARKS.length; i++) {
    const textEl = COACH_ELS[i].el.querySelector('.coach-text');
    if (textEl) textEl.textContent = COACH_MARKS[i].text;
  }
}

// splashArgs is the one place splashState's input is assembled, so the gate
// and the dismiss banner cannot disagree about what "connected"/"hasFix" mean.
// gpsError stays false: Gps (src/gps.js) does not surface a watch error to
// its caller, only the last-known fix, so this app's gate never reaches
// 'gps-error' in practice — the state itself stays fully testable (see
// test/splash.test.mjs) even though nothing here can trigger it.
function splashArgs(overrides) {
  return {
    // bleLinkUp(), not state.connected: the gate only cares whether the
    // radio itself is up, not whether SELF_INFO/the broker have finished —
    // those can still be in flight while GPS is already worth waiting for.
    hasFix: !!state.gps.latest(), connected: bleLinkUp(),
    bleError: state.splashBleError, gpsError: false,
    dismissed: state.splashDismissed, ...overrides,
  };
}

// persistSplashDismissed is the ONLY writer of the persisted flag, whether the
// gate resolved itself (a real fix arrived) or the Skip button forced it —
// either way this is a true cold-start gate: shown at most once per install.
function persistSplashDismissed() {
  state.splashDismissed = true;
  try { localStorage.setItem(prefKey('splashSeen'), '1'); } catch (e) { /* private mode */ }
}

// refreshSplash is the gate's one writer, called on every input change
// (connect attempt, GPS fix, dismiss, resize while visible).
function refreshSplash() {
  const s = splashState(splashArgs());
  const visible = s !== 'hidden';
  if (!visible && !state.splashDismissed) persistSplashDismissed();
  SPLASH.root.hidden = !visible;
  for (const c of COACH_ELS) c.el.hidden = !visible;
  if (!visible) return; // already dismissed or never yet needed — nothing left to paint
  renderSplashRows(SPLASH.rows, splashRows(s, { name: state.companionName }));
  SPLASH.status.textContent = SPLASH_ERRORS[s] || '';
  positionCoachMarks(COACH_ELS, { width: window.innerWidth, height: window.innerHeight }, calloutPosition);
}

// --- "What's new" (src/ui/changelog.js) -------------------------------------
// renderWhatsNewDot shows the badge while the newest fetched entry is not the
// one this install has acknowledged (storage.js's prefKey, never a literal).
function renderWhatsNewDot() {
  if (!state.changelog) { WHATSNEW.dot.hidden = true; return; }
  const seen = localStorage.getItem(prefKey('changelogSeen'));
  WHATSNEW.dot.hidden = !hasUnseenEntries(state.changelog, seen);
}

// loadChangelog fetches changelog.json once at boot (built by vite.config.js's
// rx-changelog-json plugin from docs/releases/*.md) and runs the one-time
// migratedSeenId to seed a first install's "seen" marker silently — a
// brand-new install must not badge every release that existed before it ever
// ran. Failure (offline at boot) is silent: the sheet says so when opened.
async function loadChangelog() {
  try {
    const res = await fetch('changelog.json', { cache: 'no-store' });
    if (!res.ok) return;
    state.changelog = await res.json();
    const stored = localStorage.getItem(prefKey('changelogSeen'));
    const newest = state.changelog[0] && state.changelog[0].id;
    const migrated = migratedSeenId(stored, null, newest);
    if (migrated && migrated !== stored) localStorage.setItem(prefKey('changelogSeen'), migrated);
    renderWhatsNewDot();
  } catch (e) { /* offline at boot — sheet reports "unavailable" if opened before a retry */ }
}

// --- Update check (src/ui/update.js) ----------------------------------------
// checkForUpdate runs every time the Status screen becomes visible (showTab).
// no-store: a cached version.json would report the build that was live the
// last time this device fetched it, not the one on the server now.
async function checkForUpdate() {
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    const latest = parseVersion(await res.text());
    els('btnUpdate').hidden = !isUpdateAvailable(VERSION, latest);
  } catch (e) {
    // Only a network-level failure (offline, DNS) lands here. A 404 or a
    // non-JSON body does not throw: parseVersion returns null for either,
    // isUpdateAvailable(VERSION, null) is false, and the button is hidden,
    // not left as it was.
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  shell = createShell(); // owns the tabs, the sheets and the toast stack
  els('appver').textContent = 'v' + VERSION;
  // First line of every session names the build. The exported log also carries it in
  // a header (buildLogHeader) because this line rolls out of the 200-line buffer
  // within minutes — two field logs arrived with no way to tell which version wrote
  // them, which sent a diagnosis down the wrong path entirely.
  dbg('CoreDrive RX v' + VERSION + ' started', 'st');
  try {
    await loadConfig();
    renderStatusScreen();
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
    renderStatusScreen();
  }
  renderUplinkChip();
  renderConnectButton();
  state.wakeLock = createWakeLock();
  // Audio cue (#7): default off, but remember the choice across app starts.
  state.beeper = createBeeper();
  state.soundEnabled = localStorage.getItem(prefKey('sound')) === '1';
  els('chkSound').checked = state.soundEnabled;
  // Web Bluetooth missing (e.g. iOS Safari) — point the user to a supported
  // browser. The sentence itself stays in index.html, where the rest of the
  // shell's copy lives; this only reveals the toast.
  if (!navigator.bluetooth) els('btnotice').hidden = false;
  els('btnConnect').addEventListener('click', () => {
    if (state.connected) { disconnectAll(); return; }
    state.wakeLock.enable(); // acquire in the user gesture (iOS needs it for video.play())
    if (state.soundEnabled) state.beeper.ensure(); // unlock audio in the same gesture
    connectAll();
  });
  els('btnClear').addEventListener('click', () => { state.logLines.length = 0; EL.log.replaceChildren(); });
  els('chkVerbose').addEventListener('change', (e) => { state.verbose = e.target.checked; });
  els('chkSound').addEventListener('change', (e) => {
    state.soundEnabled = e.target.checked;
    localStorage.setItem(prefKey('sound'), state.soundEnabled ? '1' : '0');
    if (state.soundEnabled) state.beeper.ensure(); // unlock + confirm audio in this gesture
  });
  els('btnPush').addEventListener('click', pushNow);
  els('btnShareLog').addEventListener('click', async () => {
    const lines = state.logLines;
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
  // The debug log and "What's new" are sheets over the map; the backdrop closes
  // them (src/ui/shell.js).
  els('btnDbg').addEventListener('click', () => shell.openSheet('sheet-log'));
  els('btnWhatsNew').addEventListener('click', () => {
    renderWhatsNew(WHATSNEW.body, state.changelog || []);
    if (state.changelog && state.changelog.length) {
      localStorage.setItem(prefKey('changelogSeen'), state.changelog[0].id);
      renderWhatsNewDot();
    }
    shell.openSheet('sheet-whatsnew');
  });
  els('btnUpdate').addEventListener('click', () => location.reload());
  // One manual zero-hop sweep, the same call the per-second tick makes.
  els('discover-btn').addEventListener('click', () => { if (state.connected) fireDiscover(Date.now()); });
  els('fab-recenter').addEventListener('click', () => { if (state.map) state.map.follow(true); });
  els('menu-btn').addEventListener('click', () => showTab('status'));
  // The shell's own tab buttons do not go through showTab: MapLibre can only size
  // itself while its container is visible, and the battery/update check happen
  // when the Status screen appears.
  els('tab-drive').addEventListener('click', () => { if (state.map) state.map.resize(); });
  els('tab-status').addEventListener('click', () => { requestBattery(); checkForUpdate(); });
  applyTheme(storedThemePref());
  els('btnTheme').addEventListener('click', () => applyTheme(nextThemePref(state.themePref)));
  // Cold-start splash gate: dismissed persists (prefKey), so this reads false
  // on a truly first run and true ever after, whichever way it first resolved.
  try { state.splashDismissed = localStorage.getItem(prefKey('splashSeen')) === '1'; } catch (e) { /* private mode */ }
  initSplashContent();
  refreshSplash();
  SPLASH.dismiss.addEventListener('click', () => {
    // dismissBanner names what Skip gives up before a fix has landed — said
    // once, to the debug log, since the gate itself is about to disappear.
    if (!state.gps.latest()) dbg(dismissBanner({ connected: bleLinkUp() }), 'no');
    persistSplashDismissed();
    refreshSplash();
  });
  window.addEventListener('resize', () => { if (!SPLASH.root.hidden) refreshSplash(); });
  loadChangelog();
  renderStatusScreen();
  renderHeardScreen();
  drainLoop();
  // Nothing works without a companion, so an unconnected start lands on Status
  // where the Connect button is (src/ui/shell.js).
  showTab(nextTab(localStorage.getItem(TAB_STORAGE_KEY), state.connected));
  // Coach marks anchor to real elements (#btnConnect included) whose layout
  // only exists once their screen is no longer `hidden` — the call above is
  // what first un-hides one, so positioning has to happen after it.
  refreshSplash();
  // The map last: it imports maplibre-gl lazily, so everything above is already
  // on screen before that bundle is fetched.
  try {
    state.map = await createMap({ container: 'map', theme: resolveTheme(state.themePref, prefersDark()) });
    if (shell.current() === 'drive') state.map.resize();
  } catch (e) {
    dbg('the session map could not start: ' + e.message, 'no');
  }
  // Network came back (e.g. cellular→WiFi handoff, or the radio finally up after a
  // cold start in a garage). Retry the config FIRST: this is the moment the fetch
  // that failed at startup can finally succeed, and draining before it is pointless
  // — with no config there is no publisher to drain into.
  window.addEventListener('online', () => {
    retryConfig().finally(() => { drain().then(renderHeardScreen).catch(() => {}); });
  });
  // 'sw.js' without the leading slash, so it resolves under the build's `base`:
  // a worker registered from /beta/ with an absolute path would claim the ROOT
  // scope and serve the experiment at the production URL. __REGISTER_SW__ is
  // false for the beta build (vite.config.js).
  if (__REGISTER_SW__ && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
