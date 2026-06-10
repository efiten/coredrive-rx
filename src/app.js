// corescope-rx — wiring + minimal field UI + on-screen debug.
// Pipeline: companion BLE 0x88 frame → parse raw packet → direct-heard filter →
// tag with phone GPS → IndexedDB queue → MQTT publish to CoreScope's ingestor.
// The companion's own pubkey (from SELF_INFO) is the identity / clientId / topic;
// the user never types it.
import { WebBluetoothTransport } from './transport.js';
import { parseFrame, PUSH_CODE_LOG_RX_DATA } from './frames.js';
import { parsePacket, deriveHeardKey, bytesToHex } from './meshpacket.js';
import { requestSelfInfo, requestDeviceInfo, setPathHashMode } from './selfinfo.js';
import { resolveName } from './names.js';
import { createLocalMap } from './localmap.js';
import { Gps } from './gps.js';
import { Queue } from './queue.js';
import { Publisher } from './publisher.js';

const els = (id) => document.getElementById(id);
const state = { transport: null, gps: new Gps(), queue: new Queue(), publisher: null, heard: 0, companionPubkey: '', companionName: '', connected: false, recent: [], localMap: null, pingOn: false, pingTimer: null };

const PING_INTERVAL_MS = 15000;

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

// noteHeard upserts a heard node into the recent list (most-recent first).
function noteHeard(key, keylen, snr, rssi, src) {
  let e = state.recent.find((x) => x.key === key);
  if (e) state.recent = state.recent.filter((x) => x !== e);
  else e = { key, keylen, count: 0, src }; // name resolved on the fly below
  e.count++; e.snr = snr; e.rssi = rssi; e.last = Date.now();
  state.recent.unshift(e);
  state.recent = state.recent.slice(0, RECENT_MAX);
  // Resolve the name once per node (ID shown first, replaced when it arrives).
  if (e.name === undefined && !e._req) {
    e._req = true;
    resolveName(key).then((nm) => { e.name = nm || ''; renderRecent(); }).catch(() => { e._req = false; });
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

// MQTT config from build-time env (Vite); never the UI. Treat as a shared,
// publish-only ingest account (EMQX ACL); not a real secret.
const MQTT_CFG = {
  url: import.meta.env.VITE_MQTT_URL,
  username: import.meta.env.VITE_MQTT_USERNAME,
  password: import.meta.env.VITE_MQTT_PASSWORD,
};

function log(msg) { els('status').textContent = msg; }

// dbg(msg, level): newest-first log line. level 'ok'=green (forwarded/sent),
// 'no'=red (held back/failed), default=grey (status).
function dbg(msg, level) {
  const el = els('log');
  const line = document.createElement('div');
  line.className = level === 'ok' ? 'lg-ok' : level === 'no' ? 'lg-no' : 'lg-st';
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

// --- Discover / Ping ---
// Both send a ZERO-HOP self-advert (CMD_SEND_SELF_ADVERT=7, byte1=0): only the
// directly-surrounding nodes hear it (and can reply/advert back). Deliberately
// NOT flood, which would propagate network-wide.
function sendSelfAdvert() {
  if (!state.transport || !state.connected) { dbg('not connected — cannot send', 'no'); return false; }
  state.transport.send(new Uint8Array([0x07, 0x00])).catch((e) => dbg('advert send failed: ' + e.message, 'no'));
  return true;
}

function schedulePing() {
  clearTimeout(state.pingTimer);
  state.pingTimer = setTimeout(firePing, PING_INTERVAL_MS);
}
function firePing() {
  if (!state.pingOn) return;
  if (sendSelfAdvert()) dbg('ping → zero-hop advert (no packet heard in 15s)', 'ok');
  schedulePing();
}
function setPing(on) {
  state.pingOn = on && state.connected;
  const b = els('btnPing');
  b.classList.toggle('on', state.pingOn);
  b.textContent = state.pingOn ? 'Ping: ON' : 'Ping: off';
  clearTimeout(state.pingTimer);
  if (state.pingOn) schedulePing();
}
// Enable Discover/Ping only while a companion is connected.
function setActionsEnabled(on) {
  els('btnDiscover').disabled = !on;
  els('btnPing').disabled = !on;
  if (!on) setPing(false);
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
  dbg('0x88 RX  snr=' + f.snr + ' rssi=' + f.rssi + ' raw=' + rawHex.slice(0, 32) + (rawHex.length > 32 ? '…' : ''));
  const pkt = parsePacket(f.raw);
  const hk = deriveHeardKey('rx', pkt);
  if (!hk) { dbg('  → not attributable (tx / 1-byte hop / no advert) — skip', 'no'); return; }
  dbg('  → heard ' + hk.heardKey + ' (' + hk.heardKeyLen + 'B, ' + hk.src + ')', 'ok');
  noteHeard(hk.heardKey, hk.heardKeyLen, f.snr, f.rssi, hk.src); // show in the list even without a GPS fix
  if (state.pingOn) schedulePing(); // a heard multibyte packet resets the ping timer
  const fix = currentFix();
  if (!fix) { dbg('  → no GPS fix — skip', 'no'); return; }
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

    const s3 = step('③ Connecting to ON8AR CoreScope…', 'pending');
    if (MQTT_CFG.url) {
      state.publisher = new Publisher({ ...MQTT_CFG, clientId: state.companionPubkey });
      await state.publisher.connect();
      s3.textContent = '③ ON8AR CoreScope connected ✓';
      s3.className = '';
    } else {
      s3.textContent = '③ MQTT not configured (.env.local)';
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
  setActionsEnabled(false); // also stops ping
  if (state.publisher) { state.publisher.end(); state.publisher = null; }
  try { state.gps.stop(); } catch (e) {}
  if (state.transport) { try { await state.transport.disconnect(); } catch (e) {} state.transport = null; }
  state.connected = false;
  els('companionInfo').textContent = '';
  els('hashinfo').textContent = '';
  if (!keepProgress) { progressReset(); log('disconnected.'); }
  setButton();
}

window.addEventListener('DOMContentLoaded', () => {
  els('appver').textContent = 'v' + VERSION;
  setButton();
  els('btnConnect').addEventListener('click', () => (state.connected ? disconnectAll() : connectAll()));
  els('btnClear').addEventListener('click', () => { els('log').textContent = ''; });
  els('btnDiscover').addEventListener('click', () => { if (sendSelfAdvert()) dbg('discover → zero-hop advert sent', 'ok'); });
  els('btnPing').addEventListener('click', () => setPing(!state.pingOn));
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
