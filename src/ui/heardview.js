// src/ui/heardview.js
// The Heard screen: the glance-first order is hero, status, discover, recent,
// then the two folds. This file formats; app.js keeps the state and the hero
// card (rendered separately via reading.js's renderReading — see the report
// for why it stays out of this call).
import { snrTier } from './reading.js';
import { regionsRows } from '../regionsview.js';

const UPLOAD_CLASS = { connected: 'on', reconnect: 'warn' };

export function statusLine({ fix, pending = 0, brokerState, lastPublishAt, rate = 0, now }) {
  const secs = Number.isFinite(lastPublishAt) ? Math.max(0, Math.round((now - lastPublishAt) / 1000)) : null;
  return {
    gpsText: fix ? `GPS ${Math.round(fix.acc_m)} m` : 'no fix',
    pendingText: `${pending} pending`,
    uploadText: secs === null ? 'upload' : `up ${secs}s`,
    uploadClass: brokerState ? (UPLOAD_CLASS[brokerState] || 'bad') : '',
    rateText: `${rate} pkt/min`,
  };
}

// recent.js's upsertHeard entries carry the reception time as `last`, not `at`.
export function recentRows(list, now) {
  return (list || []).map((e) => ({
    name: e.name || e.key.slice(0, 8),
    tier: snrTier(e.snr),
    snrText: Number.isFinite(e.snr) ? `${e.snr > 0 ? '+' : ''}${e.snr.toFixed(2)}` : '',
    countText: `×${e.count}`,
    last: e.last,
  }));
}

export function countsModel({ nodes = 0, hex = 0, rx = 0, rfLog = 0, fullRfLog }) {
  return {
    summary: `${nodes} nodes · ${hex} hex · ${rx} rx`,
    rows: [nodes, hex, rx],
    rfLog,
    showRfLog: !!fullRfLog,
  };
}

// setTrailingText replaces every sibling AFTER `keepEl` inside `container` with a
// single text node. #sl-upload holds the dot (#sl-udot) plus a bare text node for
// the label side by side; a plain textContent write on the container would wipe
// out the dot every render, so only the trailing text is touched.
function setTrailingText(container, keepEl, text) {
  let node = keepEl.nextSibling;
  while (node) {
    const next = node.nextSibling;
    container.removeChild(node);
    node = next;
  }
  container.appendChild(document.createTextNode(text));
}

// renderHeard is the only writer of the Heard screen's DOM. Rows are built with
// textContent/text nodes, never innerHTML: a node name is remote input (mesh or
// the name resolver).
export function renderHeard(els, { status, recent, counts, answers }) {
  els.gps.textContent = status.gpsText;
  els.pending.textContent = status.pendingText;
  els.udot.className = status.uploadClass ? `dot ${status.uploadClass}` : 'dot';
  setTrailingText(els.upload, els.udot, status.uploadText);
  els.rate.textContent = status.rateText;

  els.recent.replaceChildren(...recent.map((r) => {
    const row = document.createElement('div');
    row.className = 'row';
    const left = document.createElement('span');
    const dot = document.createElement('i');
    dot.className = `dot fill-${r.tier}`;
    left.append(dot, document.createTextNode(r.name));
    const right = document.createElement('span');
    right.className = 'mono';
    right.textContent = `${r.snrText} ${r.countText}`;
    row.append(left, right);
    return row;
  }));
  if (!recent.length) els.recent.textContent = '— nothing yet —';

  const [nodes, hex, rx] = counts.rows;
  els.cNodes.textContent = String(nodes);
  els.cHex.textContent = String(hex);
  els.cRx.textContent = String(rx);
  els.cRfLogRow.hidden = !counts.showRfLog;
  els.cRfLog.textContent = String(counts.rfLog);
  els.countsSummary.textContent = counts.summary;

  const rows = regionsRows(answers);
  els.regionsList.replaceChildren(...rows.map((r) => {
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.textContent = r.name || r.target;
    const regions = document.createElement('span');
    regions.className = 'muted';
    const parts = [];
    if (r.regions.length) parts.push(r.regions.join(', '));
    if (r.unscoped) parts.push('unscoped');
    if (r.truncated) parts.push('…');
    regions.textContent = parts.length ? parts.join(' · ') : 'declares nothing';
    row.append(name, regions);
    return row;
  }));
  els.foldScopes.hidden = rows.length === 0;
}
