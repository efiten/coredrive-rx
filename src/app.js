// corescope-rx — wiring + minimal field UI + on-screen debug.
// Pipeline: companion BLE 0x88 frame → parse raw packet → direct-heard filter →
// tag with phone GPS → IndexedDB queue → MQTT publish to CoreScope's ingestor.
import { WebBluetoothTransport } from './transport.js';
import { parseFrame, PUSH_CODE_LOG_RX_DATA } from './frames.js';
import { parsePacket, deriveHeardKey, bytesToHex, hexToBytes } from './meshpacket.js';
import { Gps } from './gps.js';
import { Queue } from './queue.js';
import { Publisher } from './publisher.js';

const els = (id) => document.getElementById(id);
const state = { transport: null, gps: new Gps(), queue: new Queue(), publisher: null, heard: 0, companionPubkey: '' };

// A real relayed-advert fixture (last hop 152c) for the simulate button.
const SIM_RAW =
  '11451000D818206D3AAC152C8A91F89957E6D30CA51F36E28790228971C473B755F244F718754CF5EE4A2FD58D944466E42CDED140C66D0CC590183E32BAF40F112BE8F3F2BDF6012B4B2793C52F1D36F69EE054D9A05593286F78453E56C0EC4A3EB95DDA2A7543FCCC00B939CACC009278603902FC12BCF84B706120526F6F6620536F6C6172';

function log(msg) { els('status').textContent = msg; }

function dbg(msg) {
  const el = els('log');
  const ts = new Date().toLocaleTimeString();
  el.textContent = '[' + ts + '] ' + msg + '\n' + el.textContent;
  if (el.textContent.length > 8000) el.textContent = el.textContent.slice(0, 8000);
}

async function refreshCounters() {
  els('heard').textContent = String(state.heard);
  els('pending').textContent = String(await state.queue.count());
  els('gps').textContent = currentFix() ? '✓ fix' : '… no fix';
}

function currentFix() {
  return state.gps.latest() || (els('mockGps').checked ? { lat: 51.05, lon: 3.72, acc_m: 10 } : null);
}

// processFrame runs the FULL pipeline for one incoming frame (DataView) and
// logs every step to the debug panel, including the exact MQTT payload.
async function processFrame(dv) {
  const f = parseFrame(dv);
  if (!f) { dbg('frame: empty/invalid'); return; }
  if (f.code !== PUSH_CODE_LOG_RX_DATA) { dbg('frame 0x' + f.code.toString(16) + ' (ignored)'); return; }

  const rawHex = bytesToHex(f.raw);
  dbg('0x88 RX  snr=' + f.snr + ' rssi=' + f.rssi + ' raw=' + rawHex.slice(0, 32) + (rawHex.length > 32 ? '…' : ''));

  const pkt = parsePacket(f.raw);
  const hk = deriveHeardKey('rx', pkt);
  if (!hk) { dbg('  → not attributable (tx / 1-byte hop / no advert) — skip'); return; }
  dbg('  → heard ' + hk.heardKey + ' (' + hk.heardKeyLen + 'B, ' + hk.src + ')');

  const fix = currentFix();
  if (!fix) { dbg('  → no GPS fix — skip (enable "mock GPS" to test layout)'); return; }

  const rec = {
    rx_at: new Date().toISOString(),
    raw: rawHex, snr: f.snr, rssi: f.rssi,
    lat: fix.lat, lon: fix.lon, acc_m: fix.acc_m,
  };
  // Show the EXACT payload that will be published (server re-derives heard_key from raw).
  const payload = Publisher.buildPayload(state.companionPubkey || 'SIM-PUBKEY', rec);
  dbg('  payload → ' + JSON.stringify(payload));

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

async function connectCompanion() {
  try {
    state.transport = new WebBluetoothTransport();
    state.transport.onFrame(processFrame);
    await state.transport.connect();
    state.gps.start();
    log('companion connected. capturing…');
    dbg('BLE connected');
    // TODO (spike): query SELF_INFO over BLE to auto-fill the companion pubkey.
  } catch (e) { log('connect failed: ' + e.message); dbg('connect failed: ' + e.message); }
  refreshCounters();
}

async function connectBroker() {
  state.companionPubkey = els('pubkey').value.trim().toLowerCase();
  state.publisher = new Publisher({
    url: els('mqttUrl').value.trim(), username: els('mqttUser').value.trim(), password: els('mqttPass').value,
  });
  try { await state.publisher.connect(); log('broker connected.'); dbg('MQTT connected'); }
  catch (e) { log('broker failed: ' + e.message); dbg('MQTT failed: ' + e.message); }
}

// simulate injects the fixture as a 0x88 frame through the real pipeline.
function simulate() {
  const raw = hexToBytes(SIM_RAW);
  const frame = new Uint8Array(3 + raw.length);
  frame[0] = PUSH_CODE_LOG_RX_DATA;
  frame[1] = (-7 * 4) & 0xff; // snr = -7.0
  frame[2] = -92 & 0xff;      // rssi = -92
  frame.set(raw, 3);
  dbg('— simulate 0x88 —');
  processFrame(new DataView(frame.buffer));
}

window.addEventListener('DOMContentLoaded', () => {
  els('btnConnect').addEventListener('click', connectCompanion);
  els('btnBroker').addEventListener('click', connectBroker);
  els('btnSim').addEventListener('click', simulate);
  els('btnClear').addEventListener('click', () => { els('log').textContent = ''; });
  refreshCounters();
  drainLoop();
});
