// src/ui/statusview.js
// The Status screen. uplink.js owns every uplink sentence; this file owns the
// numbered connect steps, which diagnostics lines are visible, and the one
// DOM writer.
import { regionInertReason } from '../uplink.js';

const STEP_LABELS = ['Companion', 'Identity', 'CoreScope'];

export function connectSteps({ companion, id, broker, failed }) {
  const states = [companion, id, broker];
  return STEP_LABELS.map((label, i) => ({
    label,
    state: failed && states[i] === 'failed' ? 'failed' : states[i],
  }));
}

// diagnosticsLines({ config, flags, fwVer, supported }):
//   - config is the RAW config object or null, passed straight through to
//     regionInertReason (src/uplink.js:97) — its first gate needs the real
//     "not loaded yet" case, which a pre-resolved flags object would hide.
//   - flags is { fullRfLog, rfSampler }, already resolved by app.js via
//     featureEnabled(cfg, name) (src/config.js) — this file does not read
//     config.fullRfLog/config.rfSampler itself, so it cannot drift from what
//     FEATURE_DEFAULTS/NO_CONFIG_DEFAULTS decide a missing key means.
export function diagnosticsLines({ config, flags, fwVer, supported }) {
  const inert = regionInertReason({ config, supported, fwVer });
  return [
    { id: 'fullRfLog', show: !!flags.fullRfLog, text: 'Full RF logging: on' },
    { id: 'rfSampler', show: !!flags.rfSampler, text: 'RF sampler: on' },
    {
      id: 'regions',
      show: true,
      text: inert ? `Region discovery: off — ${inert}` : 'Region discovery: on',
    },
  ];
}

// renderStatus is the only writer of the Status screen's DOM. `els` is an
// element set the caller looked up; this file never touches ids itself. Rows
// are built with textContent/createElement, never innerHTML.
export function renderStatus(els, { steps, diagnostics, battery, broker, companion }) {
  els.progress.replaceChildren(...steps.map((s, i) => {
    const d = document.createElement('div');
    d.className = `step ${s.state}`;
    d.textContent = `${'①②③'[i]} ${s.label}`;
    return d;
  }));
  for (const line of diagnostics) {
    els[line.id].hidden = !line.show;
    els[line.id].textContent = line.text;
  }
  els.battery.textContent = battery.text;
  els.battery.className = battery.low ? 'muted warn' : 'muted';
  els.broker.textContent = broker;
  els.companion.textContent = companion;
}
