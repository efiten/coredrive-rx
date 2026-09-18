// Tab choice at boot and on first connect, and the sheet/toast plumbing. The
// app opens on Status until a companion is connected (v1.18.2 opened Settings
// for the same reason), then jumps to Drive once.
import { test } from 'node:test';
import assert from 'node:assert';
import { TABS, nextTab, tabOnConnect, createShell } from '../src/ui/shell.js';

// A minimal fake DOM: plain objects with the handful of Node/Element members
// createShell's show() touches, keyed by id via getElementById (same approach
// as test/statusview.test.mjs and test/heardview.test.mjs, adapted for
// getElementById since createShell takes a `doc`, not the global document).
function fakeElement(id) {
  return {
    id,
    hidden: false,
    style: {},
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener() {},
  };
}

function fakeDoc(ids) {
  const els = new Map(ids.map((id) => [id, fakeElement(id)]));
  return { els, getElementById: (id) => els.get(id) };
}

// #map is a body-level layer nothing else hides (src/ui/shell.js's show()
// comment) — .screen sits inset above the tab bar/below the topbar, so
// without this a band of live map showed through on Heard and Status.
test('show hides #map on Heard and Status, shows it on Drive', () => {
  const doc = fakeDoc([
    'screen-drive', 'screen-heard', 'screen-status',
    'tab-drive', 'tab-heard', 'tab-status',
    'hud', 'fab-recenter', 'map', 'sheet-backdrop',
  ]);
  const shell = createShell(doc);
  const map = doc.els.get('map');

  shell.show('heard');
  assert.strictEqual(map.style.visibility, 'hidden');

  shell.show('status');
  assert.strictEqual(map.style.visibility, 'hidden');

  shell.show('drive');
  assert.strictEqual(map.style.visibility, 'visible');
});

test('the three tabs, in order', () => {
  assert.deepStrictEqual(TABS, ['drive', 'heard', 'status']);
});

test('boot opens Status while nothing is connected, whatever was stored', () => {
  assert.strictEqual(nextTab('drive', false), 'status');
  assert.strictEqual(nextTab(null, false), 'status');
});

test('boot restores the stored tab when a companion is already connected', () => {
  assert.strictEqual(nextTab('heard', true), 'heard');
  assert.strictEqual(nextTab('junk', true), 'drive');
  assert.strictEqual(nextTab(null, true), 'drive');
});

test('the first connect jumps to Drive; a reconnect leaves you where you are', () => {
  assert.strictEqual(tabOnConnect('status', true), 'drive');
  assert.strictEqual(tabOnConnect('heard', false), 'heard');
  assert.strictEqual(tabOnConnect('status', false), 'status');
});
