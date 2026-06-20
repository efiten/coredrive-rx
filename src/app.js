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
import { parsePacket, deriveHeardKey, bytesToHex, isFloodRoute } from './meshpacket.js';
import { requestSelfInfo, requestDeviceInfo, setPathHashMode } from './selfinfo.js';
import { resolveName } from './names.js';
import { upsertHeard, sameNode, addNodeKey } from './recent.js';
import { updateMotion } from './motion.js';
import { createWakeLock } from './wakelock.js';
import { createLocalMap } from './localmap.js';
import { hexCellAt } from './hexgrid.js';
import {
  discoverDecision, isOrganicHeard, snrToPct, decayPeak, pruneTimestamps,
} from './monitor.js';
import { shareLog } from './sharelog.js';
import { Gps } from './gps.js';
import { Queue } from './queue.js';
import { Publisher } from './publisher.js';
import { loadConfig, getConfig } from './config.js';

const els = (id) => document.getElementById(id);
const state = {
  transport: null, gps: new Gps(), queue: new Queue(), publisher: null,
  companionPubkey: '', companionName: '', connected: false, recent: [],
  localMap: null, verbose: false, motion: null, paused: false, wakeLock: null,
  // monitor counters / state
  rxTotal: 0, nodeKeys: [], hexCells: new Set(), rxTimes: [],
  lastUploadAt: null, brokerState: 'offline',
  lastHeard: null, snrBarPct: 0, snrPeakPct: 0,
  // auto-discover
  lastHeardAt: null, lastFireAt: 0, tick: null,
};

const RECENT_MAX = 20;
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
  while (el.childNodes.length > 200) el.removeChild(el.lastChild);
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

function renderDiscoverStatus(dec) {
  const el = els('discStatus');
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

// --- Per-second monitor tick: drives auto-discover, the SNR-meter decay, and the
// time-relative labels (last-heard / last-upload / rate / discover countdown). Runs only
// while connected.
function monitorTick() {
  const now = Date.now();
  const dec = discoverDecision(now, state.lastHeardAt, state.lastFireAt, state.paused);
  if (dec.fire) { fireDiscover(now); renderDiscoverStatus(discoverDecision(now, state.lastHeardAt, state.lastFireAt, state.paused)); }
  else renderDiscoverStatus(dec);
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
  els('sPending').textContent = (await state.queue.count()) + ' pending';
  els('sRate').textContent = state.rxTimes.length + ' pkt/min';
  const dot = els('uDot');
  const color = state.brokerState === 'connect' ? '#2ecc71' : state.brokerState === 'reconnect' ? '#e6a23c' : '#9aa4b2';
  dot.style.background = color;
  els('sUpload').lastChild.textContent = state.lastUploadAt ? 'upload ' + agoText(state.lastUploadAt, now) : 'upload —';
}

function renderLastHeard() {
  if (!state.lastHeard) { els('lastHeardCard').style.display = 'none'; return; }
  els('lastHeardCard').style.display = 'block';
  const { label, at } = state.lastHeard;
  els('lhLine').textContent = label + ' — ' + agoText(at, Date.now());
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
  const m = { connect: 'connected', reconnect: 'reconnecting…', offline: 'offline', close: 'disconnected' };
  els('brokerStatus').textContent = state.publisher ? (m[state.brokerState] || state.brokerState) : '— not connected —';
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
  const hk = deriveHeardKey('rx', pkt);
  if (!hk) {
    // Explain why a frame wasn't attributed. Direct multi-hop packets can't be credited (the
    // transmitter removed itself from the path's front), and 1-byte hops are collision-prone —
    // both are called out. Everything else (tx / no advert) is pure noise, verbose only.
    const lastHop = pkt && pkt.hops.length ? pkt.hops[pkt.hops.length - 1] : null;
    if (lastHop && pkt.hops.length && !isFloodRoute(pkt.routeType)) dbg('direct route — transmitter not in path, skipped', 'st');
    else if (lastHop && lastHop.length === 2) dbg('1-byte path-hash (' + lastHop + ') — seen, ignored', 'st');
    else if (state.verbose) dbg('not attributable (tx / no advert) — skip' + sig, 'no');
    return;
  }

  // Organic traffic (an overheard forwarder/advert, not our own discover reply) means we're
  // in an active area — back off discover so we don't poll on top of live traffic.
  if (isOrganicHeard(hk)) state.lastHeardAt = Date.now();

  noteHeard(hk.heardKey, hk.heardKeyLen, f.snr, f.rssi, hk.src); // show in the list even without a GPS fix
  state.rxTotal++;
  state.rxTimes.push(Date.now());
  addNodeKey(state.nodeKeys, hk.heardKey);
  state.lastHeard = { label: nodeLabel(hk.heardKey), snr: f.snr, at: Date.now() };
  noteSnr(f.snr); // sets bar/peak + colour from the now-current lastHeard
  renderCounters();
  renderLastHeard();

  const fix = currentFix();
  if (!fix) { dbg('heard ' + hk.heardKey + ' (' + hk.src + ')' + sig + ' — no GPS, not queued', 'no'); return; }
  if (state.paused) { dbg('heard ' + hk.heardKey + ' (' + hk.src + ')' + sig + ' — stationary, not queued', 'no'); return; }
  dbg('heard ' + hk.heardKey + ' (' + hk.heardKeyLen + 'B, ' + hk.src + ')' + sig, 'ok');
  state.hexCells.add(hexCellAt(fix.lat, fix.lon, HEX_COUNT_RES));
  renderCounters();
  const rec = { rx_at: new Date().toISOString(), raw: rawHex, snr: f.snr, rssi: f.rssi, lat: fix.lat, lon: fix.lon, acc_m: fix.acc_m };
  await state.queue.add(rec);
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

// drain publishes all buffered receptions once. Returns the count published. Isolated
// from the loop so the "Push pending now" button can call it directly.
async function drain() {
  if (!(state.publisher && state.publisher.connected() && state.companionPubkey)) return 0;
  const rows = await state.queue.takeAll();
  const done = [];
  for (const r of rows) { await state.publisher.publish(state.companionPubkey, r, state.companionName); done.push(r.id); }
  if (done.length) {
    await state.queue.remove(done);
    state.lastUploadAt = Date.now();
    dbg('published ' + done.length + ' record(s)', 'ok');
  }
  return done.length;
}

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

// pushNow is the Settings button: force one drain attempt and report the outcome.
async function pushNow() {
  const b = els('btnPush');
  b.disabled = true;
  try {
    const n = await drain();
    dbg(n ? 'pushed ' + n + ' record(s)' : 'nothing pending / not connected', n ? 'ok' : 'st');
  } catch (e) {
    dbg('push failed (kept buffered): ' + e.message, 'no');
  } finally {
    b.disabled = false;
    refreshCounters();
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

    // Ensure the companion adverts with 2-byte path hashes — 1-byte mode produces
    // collision-prone IDs that our capture rule rejects, so the contribution is useless.
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
    } catch (e) { dbg('hash-mode check skipped: ' + e.message); }

    state.gps.start((fix) => {
      if (state.localMap) state.localMap.setPosition(fix.lat, fix.lon);
      state.motion = updateMotion(state.motion, fix, Date.now());
      setPaused(state.motion.paused);
    });

    const s3 = step('③ Connecting to CoreScope…', 'pending');
    const cfg = getConfig();
    if (cfg && cfg.mqttUrl) {
      state.publisher = new Publisher({ url: cfg.mqttUrl, username: cfg.mqttUsername, password: cfg.mqttPassword, clientId: state.companionPubkey });
      state.publisher.onStatus((s) => {
        state.brokerState = s;
        renderBroker();
        renderStatusStrip();
        if (s === 'connect') drain().then(refreshCounters).catch(() => {}); // flush backlog on (re)connect
      });
      await state.publisher.connect();
      state.brokerState = 'connect';
      renderBroker();
      s3.textContent = '③ CoreScope connected ✓';
      s3.className = '';
    } else {
      s3.textContent = '③ MQTT not configured (config.json)';
      s3.className = 'err';
    }

    step('✅ All connected — capturing');
    state.connected = true;
    setButton();
    state.lastFireAt = 0; // fire a discover sweep immediately on the first tick
    state.tick = setInterval(monitorTick, 1000);
    log('capturing as ' + (info.name || state.companionPubkey.slice(0, 12)));
  } catch (e) {
    step('✗ ' + e.message, 'err');
    dbg('connect failed: ' + e.message, 'no');
    log('connect failed: ' + e.message);
    await disconnectAll(true);
  }
  els('btnConnect').disabled = false;
  refreshCounters();
}

async function disconnectAll(keepProgress) {
  state.connected = false;
  state.motion = null;
  state.paused = false;
  renderPauseChip();
  clearInterval(state.tick); state.tick = null;
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
  try {
    await loadConfig();
  } catch (e) {
    log('Config error: ' + e.message + ' — copy config.example.json to config.json and fill it in.');
  }
  setButton();
  state.wakeLock = createWakeLock();
  // Web Bluetooth missing (e.g. iOS Safari) — point the user to a supported browser.
  if (!navigator.bluetooth) els('btnotice').style.display = 'block';
  els('btnConnect').addEventListener('click', () => {
    if (state.connected) { disconnectAll(); return; }
    state.wakeLock.enable(); // acquire in the user gesture (iOS needs it for video.play())
    connectAll();
  });
  els('btnClear').addEventListener('click', () => { els('log').textContent = ''; });
  els('chkVerbose').addEventListener('change', (e) => { state.verbose = e.target.checked; });
  els('btnPush').addEventListener('click', pushNow);
  els('btnShareLog').addEventListener('click', async () => {
    const text = Array.from(els('log').childNodes).map((n) => n.textContent).join('\n');
    try { await shareLog(text || '(empty log)'); } catch (e) { dbg('share failed: ' + e.message, 'no'); }
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
  switchView('home');
  // Network came back (e.g. cellular→WiFi handoff) — kick a drain so backlog flushes
  // without waiting for the 5 s loop.
  window.addEventListener('online', () => { drain().then(refreshCounters).catch(() => {}); });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});
