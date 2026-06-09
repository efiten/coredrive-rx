// corescope-rx — wiring + minimal field UI + on-screen debug.
// Pipeline: companion BLE 0x88 frame → parse raw packet → direct-heard filter →
// tag with phone GPS → IndexedDB queue → MQTT publish to CoreScope's ingestor.
// The companion's own pubkey (from SELF_INFO) is the identity / clientId / topic;
// the user never types it.
import { WebBluetoothTransport } from './transport.js';
import { parseFrame, PUSH_CODE_LOG_RX_DATA } from './frames.js';
import { parsePacket, deriveHeardKey, bytesToHex, hexToBytes } from './meshpacket.js';
import { requestSelfInfo } from './selfinfo.js';
import { Gps } from './gps.js';
import { Queue } from './queue.js';
import { Publisher } from './publisher.js';

const els = (id) => document.getElementById(id);
const state = { transport: null, gps: new Gps(), queue: new Queue(), publisher: null, heard: 0, companionPubkey: '', connected: false };

const SIM_RAW =
  '11451000D818206D3AAC152C8A91F89957E6D30CA51F36E28790228971C473B755F244F718754CF5EE4A2FD58D944466E42CDED140C66D0CC590183E32BAF40F112BE8F3F2BDF6012B4B2793C52F1D36F69EE054D9A05593286F78453E56C0EC4A3EB95DDA2A7543FCCC00B939CACC009278603902FC12BCF84B706120526F6F6620536F6C6172';

// MQTT config from build-time env (Vite); never the UI. Treat as a shared,
// publish-only ingest account (EMQX ACL); not a real secret.
const MQTT_CFG = {
  url: import.meta.env.VITE_MQTT_URL,
  username: import.meta.env.VITE_MQTT_USERNAME,
  password: import.meta.env.VITE_MQTT_PASSWORD,
};

function log(msg) { els('status').textContent = msg; }

function dbg(msg) {
  const el = els('log');
  el.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg + '\n' + el.textContent;
  if (el.textContent.length > 8000) el.textContent = el.textContent.slice(0, 8000);
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
  return state.gps.latest() || (els('mockGps').checked ? { lat: 51.05, lon: 3.72, acc_m: 10 } : null);
}

async function processFrame(dv) {
  const f = parseFrame(dv);
  if (!f || f.code !== PUSH_CODE_LOG_RX_DATA) return;
  const rawHex = bytesToHex(f.raw);
  dbg('0x88 RX  snr=' + f.snr + ' rssi=' + f.rssi + ' raw=' + rawHex.slice(0, 32) + (rawHex.length > 32 ? '…' : ''));
  const pkt = parsePacket(f.raw);
  const hk = deriveHeardKey('rx', pkt);
  if (!hk) { dbg('  → not attributable (tx / 1-byte hop / no advert) — skip'); return; }
  dbg('  → heard ' + hk.heardKey + ' (' + hk.heardKeyLen + 'B, ' + hk.src + ')');
  const fix = currentFix();
  if (!fix) { dbg('  → no GPS fix — skip'); return; }
  const rec = { rx_at: new Date().toISOString(), raw: rawHex, snr: f.snr, rssi: f.rssi, lat: fix.lat, lon: fix.lon, acc_m: fix.acc_m };
  await state.queue.add(rec);
  state.heard++;
  refreshCounters();
}

async function drainLoop() {
  if (state.publisher && state.publisher.connected() && state.companionPubkey) {
    try {
      const rows = await state.queue.takeAll();
      const done = [];
      for (const r of rows) { await state.publisher.publish(state.companionPubkey, r); done.push(r.id); }
      if (done.length) { await state.queue.remove(done); dbg('published ' + done.length + ' record(s)'); }
    } catch (e) { dbg('publish error (kept buffered): ' + e.message); }
    refreshCounters();
  }
  setTimeout(drainLoop, 5000);
}

async function connectAll() {
  els('btnConnect').disabled = true;
  progressReset();
  els('companionInfo').textContent = '';
  log('');
  const s1 = step('① Connecting to companion…', 'pending');
  try {
    state.transport = new WebBluetoothTransport();
    state.transport.onFrame(processFrame);
    await state.transport.connect();
    s1.textContent = '① Companion connected ✓';
    s1.className = '';

    const s2 = step('② Reading companion ID…', 'pending');
    const info = await requestSelfInfo(state.transport);
    state.companionPubkey = info.pubkey.toLowerCase();
    s2.textContent = '② Companion: ' + (info.name || '(unnamed)') + ' ✓';
    s2.className = '';
    els('companionInfo').textContent = state.companionPubkey.slice(0, 20) + '…';
    dbg('SELF_INFO → ' + (info.name || '(unnamed)') + ' ' + state.companionPubkey);

    state.gps.start();

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
    log('capturing as ' + (info.name || state.companionPubkey.slice(0, 12)));
  } catch (e) {
    step('✗ ' + e.message, 'err');
    dbg('connect failed: ' + e.message);
    log('connect failed: ' + e.message);
    await disconnectAll(true);
  }
  els('btnConnect').disabled = false;
  refreshCounters();
}

async function disconnectAll(keepProgress) {
  if (state.publisher) { state.publisher.end(); state.publisher = null; }
  try { state.gps.stop(); } catch (e) {}
  if (state.transport) { try { await state.transport.disconnect(); } catch (e) {} state.transport = null; }
  state.connected = false;
  els('companionInfo').textContent = '';
  if (!keepProgress) { progressReset(); log('disconnected.'); }
  setButton();
}

function simulate() {
  const raw = hexToBytes(SIM_RAW);
  const frame = new Uint8Array(3 + raw.length);
  frame[0] = PUSH_CODE_LOG_RX_DATA;
  frame[1] = (-7 * 4) & 0xff;
  frame[2] = -92 & 0xff;
  frame.set(raw, 3);
  dbg('— simulate 0x88 —');
  processFrame(new DataView(frame.buffer));
}

window.addEventListener('DOMContentLoaded', () => {
  setButton();
  els('btnConnect').addEventListener('click', () => (state.connected ? disconnectAll() : connectAll()));
  els('btnSim').addEventListener('click', simulate);
  els('btnClear').addEventListener('click', () => { els('log').textContent = ''; });
  refreshCounters();
  drainLoop();
});
