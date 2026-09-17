// test/heardview.test.mjs
// The Heard screen's models. Everything here is a formatting decision on state
// app.js already keeps; no capture logic lives in this file.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  statusLine, recentRows, countsModel, scopeRows, renderHeard,
  SCOPE_NOTHING_TEXT, SCOPE_TRUNCATED_TEXT,
} from '../src/ui/heardview.js';

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

// scopeRows returns three separate fields plus the declares-nothing state, not
// one joined string. These cases were written against that joined string and are
// kept case for case, asserting the same facts on the fields that replaced it.
test('scopeRows: a plain region list joins the names', () => {
  const rows = scopeRows([{ target: 'aa', name: 'Rpt1', regions: ['be', 'be-vlg'], truncated: false }]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'Rpt1');
  assert.strictEqual(rows[0].regions, 'be, be-vlg');
  assert.strictEqual(rows[0].unscoped, false);
  assert.strictEqual(rows[0].truncated, false);
  assert.strictEqual(rows[0].declaresNothing, false);
});

test('scopeRows: falls back to the raw target when no name has resolved yet', () => {
  const rows = scopeRows([{ target: 'deadbeef', regions: ['be'] }]);
  assert.strictEqual(rows[0].name, 'deadbeef');
});

test('scopeRows: unscoped (a wildcard match) is its own field, never a region name', () => {
  const rows = scopeRows([{ target: 'aa', regions: ['be', '*'], truncated: false }]);
  assert.strictEqual(rows[0].regions, 'be');
  assert.strictEqual(rows[0].unscoped, true);
});

test('scopeRows: a truncated answer is its own field, not a mark in the list', () => {
  const rows = scopeRows([{ target: 'aa', regions: ['be'], truncated: true }]);
  assert.strictEqual(rows[0].regions, 'be');
  assert.strictEqual(rows[0].truncated, true);
});

test('scopeRows: an empty region list declares nothing', () => {
  const rows = scopeRows([{ target: 'aa', regions: [], truncated: false }]);
  assert.strictEqual(rows[0].declaresNothing, true);
  assert.strictEqual(rows[0].regions, '');
});

// The three facts are orthogonal: a repeater that names no region can still
// flood-allow the unscoped root, and can still have had its reply truncated.
// The old single string could only ever show one of the two.
test('scopeRows: unscoped and declares-nothing are both true together', () => {
  const rows = scopeRows([{ target: 'aa', regions: ['*'], truncated: false }]);
  assert.strictEqual(rows[0].declaresNothing, true);
  assert.strictEqual(rows[0].unscoped, true);
  assert.strictEqual(rows[0].truncated, false);
});

test('scopeRows: truncated and declares-nothing are both true together', () => {
  const rows = scopeRows([{ target: 'aa', regions: [], truncated: true }]);
  assert.strictEqual(rows[0].declaresNothing, true);
  assert.strictEqual(rows[0].truncated, true);
  assert.strictEqual(rows[0].unscoped, false);
});

test('scopeRows: all three facts at once stay all three facts', () => {
  const rows = scopeRows([{ target: 'aa', regions: ['be', '*'], truncated: true }]);
  assert.strictEqual(rows[0].regions, 'be');
  assert.strictEqual(rows[0].unscoped, true);
  assert.strictEqual(rows[0].truncated, true);
  assert.strictEqual(rows[0].declaresNothing, false);
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

// --- The declared-scopes card's DOM -----------------------------------------
// scopeRows keeps the three facts apart; these check renderHeard keeps them
// apart on screen too — each in its own element, with its own class, so the
// stylesheet can colour "declares nothing" differently from a region list and
// the truncation warning can sit on its own line.
function scopeEls() {
  return {
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
}

function renderScopes(els, answers) {
  const status = statusLine({ fix: null, pending: 0, brokerState: null, lastPublishAt: null, rate: 0, now: 0 });
  const counts = countsModel({ nodes: 0, hex: 0, rx: 0, rfLog: 0, fullRfLog: false });
  renderHeard(els, { status, recent: [], counts, answers });
}

test('renderHeard: a plain answer is one row, name and regions, no extra elements', () => {
  withFakeDocument(() => {
    const els = scopeEls();
    renderScopes(els, [{ target: 'aa', name: 'Rpt1', regions: ['be', 'be-vlg'], truncated: false }]);

    assert.strictEqual(els.regionsList.children.length, 1);
    const [wrap] = els.regionsList.children;
    assert.strictEqual(wrap.className, 'rg-row');
    assert.strictEqual(wrap.children.length, 1, 'no truncation line without truncation');
    const [row] = wrap.children;
    const [name, scope] = row.children;
    assert.strictEqual(name.textContent, 'Rpt1');
    assert.strictEqual(scope.children.length, 1, 'no unscoped marker without the wildcard');
    assert.strictEqual(scope.children[0].className, 'rg-regions');
    assert.strictEqual(scope.children[0].textContent, 'be, be-vlg');
  });
});

test('renderHeard: the wildcard gets its own marker element beside the list', () => {
  withFakeDocument(() => {
    const els = scopeEls();
    renderScopes(els, [{ target: 'aa', regions: ['be', '*'], truncated: false }]);

    const [row] = els.regionsList.children[0].children;
    const [, scope] = row.children;
    assert.strictEqual(scope.children.length, 2);
    assert.strictEqual(scope.children[0].textContent, 'be', 'the wildcard is never in the region text');
    assert.strictEqual(scope.children[1].className, 'rg-unscoped');
    assert.strictEqual(scope.children[1].textContent, '+ unscoped');
  });
});

test('renderHeard: declares-nothing is its own class, so it can be coloured amber', () => {
  withFakeDocument(() => {
    const els = scopeEls();
    renderScopes(els, [{ target: 'aa', regions: [], truncated: false }]);

    const [row] = els.regionsList.children[0].children;
    const [, scope] = row.children;
    assert.strictEqual(scope.children[0].className, 'rg-nothing');
    assert.strictEqual(scope.children[0].textContent, SCOPE_NOTHING_TEXT);
  });
});

test('renderHeard: truncation is a line of its own under the answer, not a "…" in it', () => {
  withFakeDocument(() => {
    const els = scopeEls();
    renderScopes(els, [{ target: 'aa', regions: ['be'], truncated: true }]);

    const [wrap] = els.regionsList.children;
    assert.strictEqual(wrap.children.length, 2);
    const warn = wrap.children[1];
    assert.strictEqual(warn.className, 'rg-truncated');
    assert.strictEqual(warn.textContent, SCOPE_TRUNCATED_TEXT);
    // The region text itself is untouched by the warning.
    const [, scope] = wrap.children[0].children;
    assert.strictEqual(scope.children[0].textContent, 'be');
  });
});

test('renderHeard: all three facts at once each keep their own element', () => {
  withFakeDocument(() => {
    const els = scopeEls();
    renderScopes(els, [{ target: 'aa', regions: ['*'], truncated: true }]);

    const [wrap] = els.regionsList.children;
    assert.strictEqual(wrap.children.length, 2);
    const [, scope] = wrap.children[0].children;
    assert.strictEqual(scope.children[0].className, 'rg-nothing');
    assert.strictEqual(scope.children[0].textContent, SCOPE_NOTHING_TEXT);
    assert.strictEqual(scope.children[1].className, 'rg-unscoped');
    assert.strictEqual(wrap.children[1].className, 'rg-truncated');
  });
});

test('renderHeard: with no answers at all the whole fold is hidden', () => {
  withFakeDocument(() => {
    const els = scopeEls();
    renderScopes(els, []);
    assert.strictEqual(els.regionsList.children.length, 0);
    assert.strictEqual(els.foldScopes.hidden, true);
  });
});

test('every class the declared-scopes card emits exists in app.css', () => {
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  for (const cls of ['rg-row', 'rg-regions', 'rg-unscoped', 'rg-nothing', 'rg-truncated']) {
    assert.ok(css.includes(`.${cls} {`), `CSS must define .${cls}`);
  }
});
