// src/ui/reading.js
// One reception, ready to paint: the Heard hero and the Drive HUD show the same
// numbers at different sizes, so the model is shared and only the elements
// differ. The fill mapping stays in monitor.js, which is already tested.
import { snrToPct } from '../monitor.js';

export function snrTier(snr) {
  if (!Number.isFinite(snr)) return 'none';
  if (snr >= 5) return 'hot';
  if (snr >= -3) return 'warm';
  if (snr >= -10) return 'mid';
  return 'cool';
}

function ago(at, now) {
  if (!Number.isFinite(at)) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function readingModel({ snr, rssi, name, at, now, peakPct = 0 }) {
  const hasSnr = Number.isFinite(snr);
  const fillPct = hasSnr ? snrToPct(snr) : 0;
  return {
    snrText: hasSnr ? `${snr > 0 ? '+' : ''}${snr.toFixed(2)} dB` : '',
    rssiText: Number.isFinite(rssi) ? `${rssi} dBm` : '',
    sinceText: ago(at, now),
    name: name || '',
    tier: snrTier(snr),
    fillPct,
    peakPct: Math.max(fillPct, Number.isFinite(peakPct) ? peakPct : 0),
  };
}

// renderReading writes the model into whichever set of elements it is given.
// Tier goes on as a class so the colour comes from tokens.css, never from JS.
export function renderReading(els, m) {
  els.snr.textContent = m.snrText;
  els.snr.className = `mono tier-${m.tier}`;
  if (els.rssi) els.rssi.textContent = m.rssiText;
  if (els.since) els.since.textContent = m.sinceText;
  if (els.name) els.name.textContent = m.name;
  if (els.fill) {
    els.fill.style.width = `${m.fillPct}%`;
    els.fill.className = `meter-fill fill-${m.tier}`;
  }
  if (els.peak) els.peak.style.left = `${m.peakPct}%`;
}
