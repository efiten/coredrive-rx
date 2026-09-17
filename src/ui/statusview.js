// src/ui/statusview.js
// The Status screen. uplink.js owns every uplink sentence; this file owns the
// numbered connect steps, which diagnostics lines are visible, and the one
// DOM writer.
import { regionInertReason } from '../uplink.js';

const STEP_LABELS = ['Companion', 'Identity', 'CoreScope'];

// A failure is already visible in the states array, so there is no separate
// `failed` flag: once a step's own state is 'failed', every step after it is
// forced to 'pending' regardless of what was passed in for it — a failure
// stops the walk, it does not just decorate one step.
export function connectSteps({ companion, id, broker }) {
  const states = [companion, id, broker];
  let stopped = false;
  return STEP_LABELS.map((label, i) => {
    const state = stopped ? 'pending' : states[i];
    if (state === 'failed') stopped = true;
    return { label, state };
  });
}

// diagnosticsLines({ config, flags, fwVer, supported, connected }):
//   - config is the RAW config object or null, passed straight through to
//     regionInertReason (src/uplink.js:97) — its first gate needs the real
//     "not loaded yet" case, which a pre-resolved flags object would hide.
//   - flags is { fullRfLog, rfSampler }, already resolved by app.js via
//     featureEnabled(cfg, name) (src/config.js) — this file does not read
//     config.fullRfLog/config.rfSampler itself, so it cannot drift from what
//     FEATURE_DEFAULTS/NO_CONFIG_DEFAULTS decide a missing key means.
//   - connected is whether a companion is connected, which is the one thing
//     regionInertReason cannot know; see regionsText.
export function diagnosticsLines({ config, flags, fwVer, supported, connected }) {
  const inert = regionInertReason({ config, supported, fwVer });
  return [
    { id: 'fullRfLog', show: !!flags.fullRfLog, text: 'Full RF logging: on' },
    { id: 'rfSampler', show: !!flags.rfSampler, text: 'RF sampler: on' },
    { id: 'regions', show: true, text: regionsText({ config, fwVer, connected, inert }) },
  ];
}

// Before a companion has ever been read there is no evidence either way:
// `supported` is still false and fwVer unknown, so regionInertReason's firmware
// sentence would be a verdict on nothing gathered. v1.18.2 guarded exactly this
// case and said "checked on connect"; that wording is kept. The config gate is
// read raw here because regionInertReason's own gate (src/uplink.js:99) reads
// the same field the same way, and normalizeConfig always fills it in.
function regionsText({ config, fwVer, connected, inert }) {
  if (config && config.regionDiscovery && fwVer == null && !connected) {
    return 'Region discovery: on (firmware checked on connect)';
  }
  return inert ? `Region discovery: off — ${inert}` : 'Region discovery: on';
}

// --- The debug log ---------------------------------------------------------
// dbg(msg, level) has always distinguished four kinds of line, and that
// colouring is how a shared field log is read at a glance: 'ok' is what was
// captured or published, 'no' what was held back or failed, 'tx' what this app
// transmitted, and anything else plain status. The classes are defined in
// src/styles/app.css; this file only picks one.
const LOG_CLASS = { ok: 'lg-ok', no: 'lg-no', tx: 'lg-tx' };

export function logClass(level) {
  return LOG_CLASS[level] || 'lg-st';
}

// appendLogLine puts one newest-first line in the log element and drops the
// oldest beyond `cap`, so a busy log costs one element per line rather than a
// re-render of the whole buffer.
export function appendLogLine(el, { text, level }, cap) {
  const line = document.createElement('div');
  line.className = logClass(level);
  line.textContent = text;
  el.insertBefore(line, el.firstChild);
  while (el.childNodes.length > cap) el.removeChild(el.lastChild);
  return line;
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
