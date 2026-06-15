// corescope-rx — wiring + minimal field UI + on-screen debug.
// Pipeline: companion BLE 0x88 frame → parse raw packet → direct-heard filter →
// tag with phone GPS → IndexedDB queue → MQTT publish to CoreScope's ingestor.
// The companion's own pubkey (from SELF_INFO) is the identity / clientId / topic;
// the user never types it.
import { WebBluetoothTransport } from './transport.js';
import { parseFrame, PUSH_CODE_LOG_RX_DATA } from './frames.js';
import { parsePacket, deriveHeardKey, bytesToHex, isFloodRoute } from './meshpacket.js';
import { requestSelfInfo, requestDeviceInfo, setPathHashMode } from './selfinfo.js';
import { resolveName } from './names.js';
import { upsertHeard } from './recent.js';
import { createLocalMap } from './localmap.js';
import { Gps } from './gps.js';
import { Queue } from './queue.js';
import { Publisher } from './publisher.js';
import { loadConfig, getConfig } from './config.js';

const els = (id) => document.getElementById(id);
const state = { transport: null, gps: new Gps(), queue: new Queue(), publisher: null, heard: 0, companionPubkey: '', companionName: '', connected: false, recent: [], localMap: null, discoverOn: false, discoverTimer: null, discoverLeft: 0, floodTimer: null, floodLeft: 0, verbose: false };

const DISCOVER_INTERVAL_S = 30;
const FLOOD_COOLDOWN_S = 60;

const RECENT_MAX = 20;
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
  // Resolve the name once per node, keyed on the canonical (longest) key. Look the
  // entry up again in the callback so a later merge can't leave us writing a stale row.
  if (e.name === undefined && !e._req) {
    e._req = true;
    const canon = e.key;
    resolveName(canon)
      .then((nm) => { const cur = state.recent.find((x) => x.key === canon); if (cur) { cur.name = nm || ''; renderRecent(); } })
      .catch(() => { const cur = state.recent.find((x) => x.key === canon); if (cur) cur._req = false; });
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
// 'tx'=orange (our own discover/flood sends), 'no'=red (held back/failed), default=grey (status).
function dbg(msg, level) {
  const el = els('log');
  const line = document.createElement('div');
  line.className = level === 'ok' ? 'lg-ok' : level === 'no' ? 'lg-no' : level === 'tx' ? 'lg-tx' : 'lg-st';
  line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  el.insertBefore(line, el.firstChild);
  while (el.childNodes.length > 200) el.removeChild(el.lastChild);
}

// switchView toggles between the Home view (capture UI) and the full-screen Map
// view via the bottom bar. Leaflet must be invalidated when its container becomes
// visible, otherwise the tiles render at the wrong size.
function switchView(v) {
  els('view-home').style.display = v === 'home' ? 'block' : 'none';
  els('view-map').style.display = v === 'map' ? 'block' : 'none';
  els('tabHome').classList.toggle('active', v === 'home');
  els('tabMap').classList.toggle('active', v === 'map');
  if (v === 'map' && state.localMap) state.localMap.invalidate();
}

// --- Discover (inbound: who can I hear?) ---
// Sends a ZERO-HOP CONTROL/DISCOVER_REQ (CMD_SEND_CONTROL_DATA=0x37). Every node in DIRECT
// RF range (repeater, companion, room server, sensor) replies with a DISCOVER_RESP carrying
// its pubkey, which arrives as a 0x88 frame and is attributed by deriveHeardKey (src=discover).
// Zero-hop, so it is NOT re-broadcast across the mesh (unlike a flood advert) — only local
// airtime. Wire format verified against meshcore_py commands/control_data.py + firmware payloads.md.
const CMD_SEND_CONTROL_DATA = 0x37;
const CTRL_NODE_DISCOVER_REQ = 0x80; // sub_type 0x8 in the upper nibble
const DISCOVER_PREFIX_ONLY = 0x01;   // lowest flag bit: responders send an 8-byte pubkey prefix
const DISCOVER_FILTER_ALL = 0xff;    // type_filter: bit per ADV_TYPE_*; all bits = every node type

function sendNodeDiscover() {
  if (!state.transport || !state.connected) { dbg('not connected — cannot discover', 'no'); return false; }
  const tag = crypto.getRandomValues(new Uint8Array(4)); // reflected back in each DISCOVER_RESP
  const frame = new Uint8Array([CMD_SEND_CONTROL_DATA, CTRL_NODE_DISCOVER_REQ | DISCOVER_PREFIX_ONLY, DISCOVER_FILTER_ALL, ...tag]);
  state.transport.send(frame).catch((e) => dbg('discover send failed: ' + e.message, 'no'));
  return true;
}

function renderDiscoverBtn() {
  const b = els('btnDiscover');
  b.classList.toggle('on', state.discoverOn);
  b.textContent = state.discoverOn ? '🎯 Discovering ' + state.discoverLeft + 's' : '🎯 Discover nearby';
}
function fireDiscover() {
  if (sendNodeDiscover()) dbg('discover → zero-hop node-discover req (all types)', 'tx');
  state.discoverLeft = DISCOVER_INTERVAL_S;
  renderDiscoverBtn();
}
// Discover is a toggle: an immediate sweep, then one every DISCOVER_INTERVAL_S, with the
// countdown ticking down inside the button. Pressing again stops it.
function setDiscover(on) {
  state.discoverOn = on && state.connected;
  clearInterval(state.discoverTimer);
  if (state.discoverOn) {
    fireDiscover();
    state.discoverTimer = setInterval(() => {
      state.discoverLeft--;
      if (state.discoverLeft <= 0) fireDiscover();
      else renderDiscoverBtn();
    }, 1000);
  }
  renderDiscoverBtn();
}

// --- Flood probe (one-shot, wider reach) ---
// Sends a single FLOOD self-advert (CMD_SEND_SELF_ADVERT=7, byte1=1). Every repeater in the mesh
// re-broadcasts it once, appending its path hash; we overhear each re-broadcast (0x88) and attribute
// the forwarder via path[last] — so this maps repeaters BEYOND direct range, unlike the zero-hop
// Discover. A flood propagates network-wide, so it is deliberately one-shot with a cooldown.
function sendFloodAdvert() {
  if (!state.transport || !state.connected) { dbg('not connected — cannot flood', 'no'); return false; }
  state.transport.send(new Uint8Array([0x07, 0x01])).catch((e) => dbg('flood send failed: ' + e.message, 'no'));
  return true;
}

function renderFloodBtn() {
  const b = els('btnFlood');
  const cooling = state.floodLeft > 0;
  b.disabled = cooling || !state.connected;
  b.textContent = cooling ? '📡 Flood ' + state.floodLeft + 's' : '📡 Flood probe';
}
function fireFlood() {
  if (state.floodLeft > 0 || !sendFloodAdvert()) return;
  dbg('flood → network-wide advert (maps repeaters beyond direct range)', 'tx');
  state.floodLeft = FLOOD_COOLDOWN_S;
  renderFloodBtn();
  clearInterval(state.floodTimer);
  state.floodTimer = setInterval(() => {
    state.floodLeft--;
    renderFloodBtn();
    if (state.floodLeft <= 0) clearInterval(state.floodTimer);
  }, 1000);
}

// Enable the action buttons only while a companion is connected.
function setActionsEnabled(on) {
  els('btnDiscover').disabled = !on;
  if (!on) {
    setDiscover(false);
    clearInterval(state.floodTimer);
    state.floodLeft = 0;
  }
  renderFloodBtn();
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

async function refreshCounters() {
  els('heard').textContent = String(state.heard);
  els('pending').textContent = String(await state.queue.count());
  els('gps').textContent = currentFix() ? '✓ fix' : '… no fix';
}

function currentFix() {
  return state.gps.latest();
}

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
  noteHeard(hk.heardKey, hk.heardKeyLen, f.snr, f.rssi, hk.src); // show in the list even without a GPS fix
  const fix = currentFix();
  if (!fix) { dbg('heard ' + hk.heardKey + ' (' + hk.src + ')' + sig + ' — no GPS, not queued', 'no'); return; }
  dbg('heard ' + hk.heardKey + ' (' + hk.heardKeyLen + 'B, ' + hk.src + ')' + sig, 'ok');
  const rec = { rx_at: new Date().toISOString(), raw: rawHex, snr: f.snr, rssi: f.rssi, lat: fix.lat, lon: fix.lon, acc_m: fix.acc_m };
  await state.queue.add(rec);
  if (state.localMap) state.localMap.addPoint(fix.lat, fix.lon, f.snr); // live hex on the map
  state.heard++;
  refreshCounters();
}

async function drainLoop() {
  if (state.publisher && state.publisher.connected() && state.companionPubkey) {
    try {
      const rows = await state.queue.takeAll();
      const done = [];
      for (const r of rows) { await state.publisher.publish(state.companionPubkey, r, state.companionName); done.push(r.id); }
      if (done.length) { await state.queue.remove(done); dbg('published ' + done.length + ' record(s)', 'ok'); }
    } catch (e) { dbg('publish error (kept buffered): ' + e.message, 'no'); }
    refreshCounters();
  }
  setTimeout(drainLoop, 5000);
}

async function connectAll() {
  els('btnConnect').disabled = true;
  progressReset();
  els('companionInfo').textContent = '';
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
    els('companionInfo').textContent = state.companionPubkey.slice(0, 20) + '…';
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

    state.gps.start((fix) => { if (state.localMap) state.localMap.setPosition(fix.lat, fix.lon); });

    const s3 = step('③ Connecting to CoreScope…', 'pending');
    const cfg = getConfig();
    if (cfg && cfg.mqttUrl) {
      state.publisher = new Publisher({ url: cfg.mqttUrl, username: cfg.mqttUsername, password: cfg.mqttPassword, clientId: state.companionPubkey });
      await state.publisher.connect();
      s3.textContent = '③ CoreScope connected ✓';
      s3.className = '';
    } else {
      s3.textContent = '③ MQTT not configured (config.json)';
      s3.className = 'err';
    }

    step('✅ All connected — capturing');
    state.connected = true;
    setButton();
    setActionsEnabled(true);
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
  setActionsEnabled(false); // also stops discover + flood cooldown
  if (state.publisher) { state.publisher.end(); state.publisher = null; }
  try { state.gps.stop(); } catch (e) {}
  if (state.transport) { try { await state.transport.disconnect(); } catch (e) {} state.transport = null; }
  state.connected = false;
  els('companionInfo').textContent = '';
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
  els('btnConnect').addEventListener('click', () => (state.connected ? disconnectAll() : connectAll()));
  els('btnClear').addEventListener('click', () => { els('log').textContent = ''; });
  els('chkVerbose').addEventListener('change', (e) => { state.verbose = e.target.checked; });
  els('btnDiscover').addEventListener('click', () => setDiscover(!state.discoverOn));
  els('btnFlood').addEventListener('click', () => fireFlood());
  els('btnDbg').addEventListener('click', () => {
    const log = els('log');
    const show = log.style.display === 'none';
    log.style.display = show ? 'block' : 'none';
    els('btnDbg').textContent = show ? 'Hide debug log' : 'Show debug log';
  });
  renderRecent();
  refreshCounters();
  drainLoop();
  state.localMap = createLocalMap('liveMap');
  els('tabHome').addEventListener('click', () => switchView('home'));
  els('tabMap').addEventListener('click', () => switchView('map'));
  switchView('home');
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});
