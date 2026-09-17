// test/heardview.test.mjs
// The Heard screen's models. Everything here is a formatting decision on state
// app.js already keeps; no capture logic lives in this file.
import { test } from 'node:test';
import assert from 'node:assert';
import { statusLine, recentRows, countsModel, renderHeard } from '../src/ui/heardview.js';

test('the status line says what the strip said before it', () => {
  const m = statusLine({
    fix: { lat: 1, lon: 2, acc_m: 4.4 }, pending: 0, brokerState: 'connected',
    lastPublishAt: 9000, rate: 14, now: 11000,
  });
  assert.strictEqual(m.gpsText, 'GPS 4 m');
  assert.strictEqual(m.pendingText, '0 pending');
  assert.strictEqual(m.uploadText, 'up 2s');
  assert.strictEqual(m.uploadClass, 'on');
  assert.strictEqual(m.rateText, '14 pkt/min');
});

test('no fix is said plainly, and no publisher is a grey dot', () => {
  const m = statusLine({ fix: null, pending: 3, brokerState: null, lastPublishAt: null, rate: 0, now: 1 });
  assert.strictEqual(m.gpsText, 'no fix');
  assert.strictEqual(m.pendingText, '3 pending');
  assert.strictEqual(m.uploadText, 'upload');
  assert.strictEqual(m.uploadClass, '');
});

test('reconnecting is amber and anything else is red', () => {
  assert.strictEqual(statusLine({ brokerState: 'reconnect', now: 0 }).uploadClass, 'warn');
  assert.strictEqual(statusLine({ brokerState: 'error', now: 0 }).uploadClass, 'bad');
});

test('recent rows carry the tier, not a colour', () => {
  const rows = recentRows([
    { key: 'ab'.repeat(32), name: 'ON8AR-Rpt', snr: 4.25, count: 12 },
    { key: 'cd'.repeat(4), name: null, snr: -11, count: 1 },
  ], 0);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].name, 'ON8AR-Rpt');
  assert.strictEqual(rows[0].tier, 'warm');
  assert.strictEqual(rows[0].snrText, '+4.25');
  assert.strictEqual(rows[0].countText, '×12');
  assert.strictEqual(rows[1].name, 'cdcdcdcd');
  assert.strictEqual(rows[1].tier, 'cool');
});

test('the counters fold shows its summary closed, and the RF-log row only when logging', () => {
  const on = countsModel({ nodes: 142, hex: 88, rx: 1900, rfLog: 40, fullRfLog: true });
  assert.strictEqual(on.summary, '142 nodes · 88 hex · 1900 rx');
  assert.strictEqual(on.showRfLog, true);
  const off = countsModel({ nodes: 1, hex: 1, rx: 1, rfLog: 0, fullRfLog: false });
  assert.strictEqual(off.showRfLog, false);
});

test('renderHeard writes the collapsed counts summary into the fold, so it reads without opening it', () => {
  // node:test has no DOM; renderHeard's non-empty-list branches build real elements,
  // so give it just enough of a fake document for the empty-list case exercised here.
  const priorDocument = globalThis.document;
  globalThis.document = { createTextNode: (text) => ({ textContent: text }) };
  try {
    const els = {
      gps: { textContent: '' },
      pending: { textContent: '' },
      udot: { className: '', nextSibling: null },
      upload: { appendChild() {} },
      rate: { textContent: '' },
      recent: { textContent: '', replaceChildren() {} },
      cNodes: { textContent: '' },
      cHex: { textContent: '' },
      cRx: { textContent: '' },
      cRfLogRow: { hidden: false },
      cRfLog: { textContent: '' },
      countsSummary: { textContent: '' },
      regionsList: { replaceChildren() {} },
      foldScopes: { hidden: false },
    };

    const status = statusLine({ fix: null, pending: 0, brokerState: null, lastPublishAt: null, rate: 0, now: 0 });
    const counts = countsModel({ nodes: 142, hex: 88, rx: 1900, rfLog: 40, fullRfLog: true });

    renderHeard(els, { status, recent: [], counts, answers: [] });

    assert.strictEqual(els.countsSummary.textContent, '142 nodes · 88 hex · 1900 rx');
  } finally {
    globalThis.document = priorDocument;
  }
});
