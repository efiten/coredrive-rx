// Tab choice at boot and on first connect, and the sheet/toast plumbing. The
// app opens on Status until a companion is connected (v1.18.2 opened Settings
// for the same reason), then jumps to Drive once.
import { test } from 'node:test';
import assert from 'node:assert';
import { TABS, nextTab, tabOnConnect } from '../src/ui/shell.js';

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
