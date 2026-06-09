// corescope-rx — wiring + minimal field UI.
// Pipeline: companion BLE 0x88 frame → parse raw packet → direct-heard filter →
// tag with phone GPS → IndexedDB queue → MQTT publish to CoreScope's ingestor.
import { WebBluetoothTransport } from './transport.js';
import { parseFrame, PUSH_CODE_LOG_RX_DATA } from './frames.js';
import { parsePacket, deriveHeardKey, bytesToHex } from './meshpacket.js';
import { Gps } from './gps.js';
import { Queue } from './queue.js';
import { Publisher } from './publisher.js';

const els = (id) => document.getElementById(id);
const state = { transport: null, gps: new Gps(), queue: new Queue(), publisher: null, heard: 0, companionPubkey: '' };

function log(msg) {
  const el = els('status');
  el.textContent = msg;
}

async function refreshCounters() {
  els('heard').textContent = String(state.heard);
  els('pending').textContent = String(await state.queue.count());
  els('gps').textContent = state.gps.latest() ? '✓ fix' : '… no fix';
}

async function onFrame(dv) {
  const f = parseFrame(dv);
  if (!f || f.code !== PUSH_CODE_LOG_RX_DATA) return;
  const pkt = parsePacket(f.raw);
  const hk = deriveHeardKey('rx', pkt); // local filter; server re-derives authoritatively from raw
  if (!hk) return;
  const fix = state.gps.latest();
  if (!fix) return; // no position → not coverage; drop
  await state.queue.add({
    rx_at: new Date().toISOString(),
    raw: bytesToHex(f.raw),
    snr: f.snr,
    rssi: f.rssi,
    lat: fix.lat,
    lon: fix.lon,
    acc_m: fix.acc_m,
  });
  state.heard++;
  refreshCounters();
}

async function drainLoop() {
  if (state.publisher && state.publisher.connected() && state.companionPubkey) {
    try {
      const rows = await state.queue.takeAll();
      const done = [];
      for (const r of rows) {
        await state.publisher.publish(state.companionPubkey, r);
        done.push(r.id);
      }
      if (done.length) await state.queue.remove(done);
    } catch (e) { /* keep buffered; retry next tick */ }
    refreshCounters();
  }
  setTimeout(drainLoop, 5000);
}

async function connectCompanion() {
  try {
    state.transport = new WebBluetoothTransport();
    state.transport.onFrame(onFrame);
    await state.transport.connect();
    state.gps.start();
    log('companion connected. capturing…');
    // TODO (spike): query SELF_INFO over BLE to auto-fill the companion pubkey
    // instead of the manual field. See docs/plan.md.
  } catch (e) { log('connect failed: ' + e.message); }
  refreshCounters();
}

async function connectBroker() {
  state.companionPubkey = els('pubkey').value.trim().toLowerCase();
  state.publisher = new Publisher({
    url: els('mqttUrl').value.trim(),
    username: els('mqttUser').value.trim(),
    password: els('mqttPass').value,
  });
  try { await state.publisher.connect(); log('broker connected.'); }
  catch (e) { log('broker failed: ' + e.message); }
}

window.addEventListener('DOMContentLoaded', () => {
  els('btnConnect').addEventListener('click', connectCompanion);
  els('btnBroker').addEventListener('click', connectBroker);
  refreshCounters();
  drainLoop();
});
