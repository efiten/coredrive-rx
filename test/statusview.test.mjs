// test/statusview.test.mjs
// The Status screen's models: the numbered connect steps and the diagnostics
// lines, plus renderStatus's DOM writes. The texts for uplink states stay in
// uplink.js; this only chooses what is shown.
import { test } from 'node:test';
import assert from 'node:assert';
import { connectSteps, diagnosticsLines, renderStatus } from '../src/ui/statusview.js';

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
