// test/statusview.test.mjs
// The Status screen's models: the numbered connect steps and the diagnostics
// lines, plus renderStatus's DOM writes. The texts for uplink states stay in
// uplink.js; this only chooses what is shown.
import { test } from 'node:test';
import assert from 'node:assert';
import { connectSteps, diagnosticsLines, renderStatus, logClass, appendLogLine } from '../src/ui/statusview.js';
import { readFileSync } from 'node:fs';

// A minimal fake DOM: plain objects with the handful of Node/Element members
// renderStatus touches. Installed on globalThis.document for one test only,
// restored in a finally so a failing assertion can never leak it into the next
// (same approach as test/heardview.test.mjs).
function fakeElement() {
  return {
    className: '',
    textContent: '',
    style: {},
    hidden: false,
    children: [],
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    // appendLogLine works on childNodes/insertBefore/removeChild, the way the
    // real #sheet-log element does; children mirrors it so both are readable.
    childNodes: [],
    get firstChild() { return this.childNodes[0] || null; },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; },
    insertBefore(node, ref) {
      const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
      this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node);
      return node;
    },
    removeChild(node) {
      const i = this.childNodes.indexOf(node);
      if (i >= 0) this.childNodes.splice(i, 1);
      return node;
    },
  };
}

function withFakeDocument(fn) {
  const prior = globalThis.document;
  globalThis.document = { createElement: () => fakeElement() };
  try {
    return fn();
  } finally {
    globalThis.document = prior;
  }
}

test('the three numbered steps walk from pending to done', () => {
  const s = connectSteps({ companion: 'done', id: 'active', broker: 'pending' });
  assert.deepStrictEqual(s.map((x) => x.state), ['done', 'active', 'pending']);
  assert.deepStrictEqual(s.map((x) => x.label), ['Companion', 'Identity', 'CoreScope']);
});

test('a failure marks the step it happened on and forces every later step to pending', () => {
  // broker is passed as 'done', not 'pending': without the truncation this would
  // come back 'done' and the test would fail.
  const s = connectSteps({ companion: 'done', id: 'failed', broker: 'done' });
  assert.strictEqual(s[1].state, 'failed');
  assert.strictEqual(s[2].state, 'pending');
});

test('a failure on the first step forces both later steps to pending too', () => {
  const s = connectSteps({ companion: 'failed', id: 'done', broker: 'active' });
  assert.deepStrictEqual(s.map((x) => x.state), ['failed', 'pending', 'pending']);
});

test('diagnostics hide what is off and name why regions are inert', () => {
  // supported mirrors app.js's real computation (state.regions.supported =
  // di.fwVer >= REGION_DISCOVERY_MIN_FW): firmware 12 is below the v13 floor,
  // so supported is false here, which is what actually reaches the firmware
  // sentence in regionInertReason (src/uplink.js:97..102).
  const lines = diagnosticsLines({
    config: { regionDiscovery: true },
    flags: { fullRfLog: true, rfSampler: false },
    fwVer: 12,
    supported: false,
  });
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.strictEqual(byId.fullRfLog.show, true);
  assert.strictEqual(byId.fullRfLog.text, 'Full RF logging: on');
  assert.strictEqual(byId.rfSampler.show, false);
  assert.strictEqual(byId.regions.show, true);
  assert.match(byId.regions.text, /firmware/i);
});

test('with everything on and firmware new enough, regions read as on', () => {
  const lines = diagnosticsLines({
    config: { regionDiscovery: true },
    flags: { fullRfLog: false, rfSampler: true },
    fwVer: 13,
    supported: true,
  });
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.strictEqual(byId.regions.text, 'Region discovery: on');
  assert.strictEqual(byId.rfSampler.show, true);
});

test('an unloaded config names itself, not the firmware, as the reason regions are off', () => {
  // Controller ruling: config is the RAW config-or-null, passed straight through
  // to regionInertReason, whose first gate (src/uplink.js:98) must stay reachable.
  const lines = diagnosticsLines({
    config: null,
    flags: { fullRfLog: true, rfSampler: true },
    fwVer: null,
    supported: false,
  });
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.match(byId.regions.text, /config\.json/i);
  assert.doesNotMatch(byId.regions.text, /firmware/i);
});

test('renderStatus builds the three numbered steps and toggles diagnostics visibility', () => {
  withFakeDocument(() => {
    const els = {
      progress: fakeElement(),
      fullRfLog: fakeElement(),
      rfSampler: fakeElement(),
      regions: fakeElement(),
      battery: fakeElement(),
      broker: fakeElement(),
      companion: fakeElement(),
    };

    const steps = connectSteps({ companion: 'done', id: 'active', broker: 'pending' });
    const diagnostics = diagnosticsLines({
      config: { regionDiscovery: true },
      flags: { fullRfLog: true, rfSampler: false },
      fwVer: 13,
      supported: true,
    });

    renderStatus(els, {
      steps,
      diagnostics,
      battery: { text: 'Battery 3.90 V (75%)', low: false },
      broker: 'connected',
      companion: 'ON8AR-Rpt',
    });

    assert.strictEqual(els.progress.children.length, 3);
    assert.strictEqual(els.progress.children[0].className, 'step done');
    assert.strictEqual(els.progress.children[0].textContent, '① Companion');
    assert.strictEqual(els.progress.children[1].className, 'step active');
    assert.strictEqual(els.progress.children[2].className, 'step pending');

    assert.strictEqual(els.fullRfLog.hidden, false);
    assert.strictEqual(els.fullRfLog.textContent, 'Full RF logging: on');
    assert.strictEqual(els.rfSampler.hidden, true);
    assert.strictEqual(els.regions.hidden, false);
    assert.strictEqual(els.regions.textContent, 'Region discovery: on');

    assert.strictEqual(els.battery.textContent, 'Battery 3.90 V (75%)');
    assert.strictEqual(els.battery.className, 'muted');
    assert.strictEqual(els.broker.textContent, 'connected');
    assert.strictEqual(els.companion.textContent, 'ON8AR-Rpt');
  });
});

test('renderStatus marks a low battery with the warn class, never a colour', () => {
  withFakeDocument(() => {
    const els = {
      progress: fakeElement(),
      fullRfLog: fakeElement(),
      rfSampler: fakeElement(),
      regions: fakeElement(),
      battery: fakeElement(),
      broker: fakeElement(),
      companion: fakeElement(),
    };

    renderStatus(els, {
      steps: connectSteps({ companion: 'pending', id: 'pending', broker: 'pending' }),
      diagnostics: diagnosticsLines({
        config: null,
        flags: { fullRfLog: true, rfSampler: true },
        fwVer: null,
        supported: false,
      }),
      battery: { text: 'Battery 3.40 V (33%)', low: true },
      broker: '— not connected —',
      companion: '— not connected —',
    });

    assert.strictEqual(els.battery.className, 'muted warn');
  });
});

test('with no companion yet, regions read as on and say the firmware is checked on connect', () => {
  // Controller ruling (fix round 2): before a companion has been read, supported
  // is false and fwVer null, so regionInertReason's firmware sentence would be a
  // verdict on nothing gathered. v1.18.2 guarded this case and this is its wording.
  const lines = diagnosticsLines({
    config: { regionDiscovery: true },
    flags: { fullRfLog: true, rfSampler: true },
    fwVer: null,
    supported: false,
    connected: false,
  });
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.strictEqual(byId.regions.show, true);
  assert.strictEqual(byId.regions.text, 'Region discovery: on (firmware checked on connect)');
});

test('once a companion IS connected, an unreadable firmware version is a real reason', () => {
  // Same inputs as the test above apart from `connected`: without that flag
  // reaching regionsText, this would read "checked on connect" forever.
  const lines = diagnosticsLines({
    config: { regionDiscovery: true },
    flags: { fullRfLog: true, rfSampler: true },
    fwVer: null,
    supported: false,
    connected: true,
  });
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.match(byId.regions.text, /^Region discovery: off — /);
  assert.match(byId.regions.text, /firmware version could not be read/);
});

test('the pre-connect wording never hides a config that has regions switched off', () => {
  // regionDiscovery off plus no companion: the config's own answer wins, and the
  // line still shows rather than being hidden the way v1.18.2 hid it.
  const lines = diagnosticsLines({
    config: { regionDiscovery: false },
    flags: { fullRfLog: true, rfSampler: true },
    fwVer: null,
    supported: false,
    connected: false,
  });
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.strictEqual(byId.regions.show, true);
  assert.match(byId.regions.text, /regionDiscovery is off in config\.json/);
});

test('logClass maps each dbg level to its own class, and anything else to status', () => {
  assert.strictEqual(logClass('ok'), 'lg-ok');
  assert.strictEqual(logClass('no'), 'lg-no');
  assert.strictEqual(logClass('tx'), 'lg-tx');
  assert.strictEqual(logClass('st'), 'lg-st');
  assert.strictEqual(logClass(undefined), 'lg-st');
  assert.strictEqual(logClass('nonsense'), 'lg-st');
});

test('every class logClass can emit exists in src/styles/app.css', () => {
  // The colours are tokens in the stylesheet, never picked in JS, so a rename
  // there would otherwise silently drop the level colouring a shared field log
  // is read by.
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  for (const level of ['ok', 'no', 'tx', 'st', undefined]) {
    const selector = '.' + logClass(level) + ' {';
    assert.ok(css.includes(selector), selector + ' must be defined in app.css');
  }
});

test('appendLogLine puts the newest line first, with its level class', () => {
  withFakeDocument(() => {
    const el = fakeElement();
    appendLogLine(el, { text: 'first', level: 'st' }, 200);
    appendLogLine(el, { text: 'second', level: 'ok' }, 200);
    assert.deepStrictEqual(el.childNodes.map((n) => n.textContent), ['second', 'first']);
    assert.deepStrictEqual(el.childNodes.map((n) => n.className), ['lg-ok', 'lg-st']);
  });
});

test('appendLogLine drops the oldest line beyond the cap', () => {
  withFakeDocument(() => {
    const el = fakeElement();
    for (let i = 1; i <= 5; i++) appendLogLine(el, { text: 'line ' + i, level: 'no' }, 3);
    assert.strictEqual(el.childNodes.length, 3);
    assert.deepStrictEqual(el.childNodes.map((n) => n.textContent), ['line 5', 'line 4', 'line 3']);
  });
});
