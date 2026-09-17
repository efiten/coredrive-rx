// test/heardview.test.mjs
// The Heard screen's models. Everything here is a formatting decision on state
// app.js already keeps; no capture logic lives in this file.
import { test } from 'node:test';
import assert from 'node:assert';
import { statusLine, recentRows, countsModel, scopeRows, renderHeard } from '../src/ui/heardview.js';

// A minimal fake DOM for renderHeard: plain objects with the handful of Node/Element
// members it touches. Installed on globalThis.document for the duration of one test
// only, restored in a finally so a failing assertion can never leak it into the next.
function fakeElement() {
  return {
    className: '',
    textContent: '',
    style: {},
    hidden: false,
    children: [],
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
  };
}

function withFakeDocument(fn) {
  const prior = globalThis.document;
  globalThis.document = {
    createElement: () => fakeElement(),
    createTextNode: (text) => ({ nodeValue: text }),
  };
  try {
    return fn();
  } finally {
    globalThis.document = prior;
  }
}

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

test('scopeRows: a plain region list joins the names', () => {
  const rows = scopeRows([{ target: 'aa', name: 'Rpt1', regions: ['be', 'be-vlg'], truncated: false }]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'Rpt1');
  assert.strictEqual(rows[0].text, 'be, be-vlg');
});

test('scopeRows: falls back to the raw target when no name has resolved yet', () => {
  const rows = scopeRows([{ target: 'deadbeef', regions: ['be'] }]);
  assert.strictEqual(rows[0].name, 'deadbeef');
});

test('scopeRows: unscoped (a wildcard match) is tagged onto the region list', () => {
  const rows = scopeRows([{ target: 'aa', regions: ['be', '*'], truncated: false }]);
  assert.strictEqual(rows[0].text, 'be · unscoped');
});

test('scopeRows: a truncated answer is tagged onto the region list', () => {
  const rows = scopeRows([{ target: 'aa', regions: ['be'], truncated: true }]);
  assert.strictEqual(rows[0].text, 'be · …');
});

test('scopeRows: an empty region list declares nothing', () => {
  const rows = scopeRows([{ target: 'aa', regions: [], truncated: false }]);
  assert.strictEqual(rows[0].text, 'declares nothing');
});

test('scopeRows: unscoped alone overrides declares-nothing, even with an empty list', () => {
  const rows = scopeRows([{ target: 'aa', regions: ['*'], truncated: false }]);
  assert.strictEqual(rows[0].text, 'unscoped');
});

test('scopeRows: truncated alone overrides declares-nothing, even with an empty list', () => {
  const rows = scopeRows([{ target: 'aa', regions: [], truncated: true }]);
  assert.strictEqual(rows[0].text, '…');
});

test('renderHeard writes the collapsed counts summary into the fold, so it reads without opening it', () => {
  withFakeDocument(() => {
    const els = {
      gps: { textContent: '' },
      pending: { textContent: '' },
      udot: { className: '', nextSibling: null },
      upload: { appendChild() {} },
      rate: { textContent: '' },
      recent: fakeElement(),
      cNodes: { textContent: '' },
      cHex: { textContent: '' },
      cRx: { textContent: '' },
      cRfLogRow: { hidden: false },
      cRfLog: { textContent: '' },
      countsSummary: { textContent: '' },
      regionsList: fakeElement(),
      foldScopes: { hidden: false },
    };

    const status = statusLine({ fix: null, pending: 0, brokerState: null, lastPublishAt: null, rate: 0, now: 0 });
    const counts = countsModel({ nodes: 142, hex: 88, rx: 1900, rfLog: 40, fullRfLog: true });

    renderHeard(els, { status, recent: [], counts, answers: [] });

    assert.strictEqual(els.countsSummary.textContent, '142 nodes · 88 hex · 1900 rx');

    // The empty state keeps the muted wrapper index.html ships (#recent's static
    // fallback markup), rather than a bare textContent write that would drop it.
    assert.strictEqual(els.recent.children.length, 1);
    assert.strictEqual(els.recent.children[0].className, 'muted');
    assert.strictEqual(els.recent.children[0].textContent, '— nothing yet —');
  });
});

test('renderHeard builds a real row per recent entry: dot tier, name, and the snr/count text', () => {
  withFakeDocument(() => {
    const els = {
      gps: { textContent: '' },
      pending: { textContent: '' },
      udot: { className: '', nextSibling: null },
      upload: { appendChild() {} },
      rate: { textContent: '' },
      recent: fakeElement(),
      cNodes: { textContent: '' },
      cHex: { textContent: '' },
      cRx: { textContent: '' },
      cRfLogRow: { hidden: false },
      cRfLog: { textContent: '' },
      countsSummary: { textContent: '' },
      regionsList: fakeElement(),
      foldScopes: { hidden: false },
    };

    const recent = recentRows([
      { key: 'ab'.repeat(32), name: 'ON8AR-Rpt', snr: 4.25, count: 12 },
      { key: 'cd'.repeat(4), name: null, snr: -11, count: 1 },
    ], 0);
    const status = statusLine({ fix: null, pending: 0, brokerState: null, lastPublishAt: null, rate: 0, now: 0 });
    const counts = countsModel({ nodes: 0, hex: 0, rx: 0, rfLog: 0, fullRfLog: false });

    renderHeard(els, { status, recent, counts, answers: [] });

    assert.strictEqual(els.recent.children.length, 2);

    const [row0, row1] = els.recent.children;
    assert.strictEqual(row0.className, 'row');
    const [left0, right0] = row0.children;
    assert.strictEqual(left0.children[0].className, 'dot fill-warm');
    assert.strictEqual(left0.children[1].nodeValue, 'ON8AR-Rpt');
    assert.strictEqual(right0.textContent, '+4.25 ×12');

    const [left1, right1] = row1.children;
    assert.strictEqual(left1.children[0].className, 'dot fill-cool');
    assert.strictEqual(left1.children[1].nodeValue, 'cdcdcdcd');
    assert.strictEqual(right1.textContent, '-11.00 ×1');
  });
});

test('setTrailingText (via renderHeard) replaces the upload label but never the dot', () => {
  withFakeDocument(() => {
    const initialText = { nodeValue: 'upload', nextSibling: null };
    const udot = { className: '', nextSibling: initialText };
    const removed = [];
    const appended = [];
    const els = {
      gps: { textContent: '' },
      pending: { textContent: '' },
      udot,
      upload: {
        removeChild(n) { removed.push(n); },
        appendChild(n) { appended.push(n); return n; },
      },
      rate: { textContent: '' },
      recent: fakeElement(),
      cNodes: { textContent: '' },
      cHex: { textContent: '' },
      cRx: { textContent: '' },
      cRfLogRow: { hidden: false },
      cRfLog: { textContent: '' },
      countsSummary: { textContent: '' },
      regionsList: fakeElement(),
      foldScopes: { hidden: false },
    };

    const status = statusLine({
      fix: null, pending: 0, brokerState: 'connected', lastPublishAt: 1000, rate: 0, now: 3000,
    });
    const counts = countsModel({ nodes: 0, hex: 0, rx: 0, rfLog: 0, fullRfLog: false });

    renderHeard(els, { status, recent: [], counts, answers: [] });

    assert.strictEqual(udot.className, 'dot on');
    assert.ok(!removed.includes(udot), 'the dot must never be handed to removeChild');
    assert.deepStrictEqual(removed, [initialText]);
    assert.strictEqual(appended.length, 1);
    assert.strictEqual(appended[0].nodeValue, 'up 2s');
  });
});
