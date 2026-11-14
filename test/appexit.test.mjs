import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopAndClose, STOP_CONFIRM_TEXT } from '../src/appexit.js';

function deps(over = {}) {
  const calls = [];
  return {
    calls,
    args: {
      connected: true,
      confirm: (text) => { calls.push(['confirm', text]); return true; },
      disconnect: async () => { calls.push(['disconnect']); },
      exitApp: async () => { calls.push(['exit']); },
      ...over,
    },
  };
}

test('connected: asks, then disconnects before it exits', async () => {
  const d = deps();
  assert.equal(await stopAndClose(d.args), 'closed');
  assert.deepEqual(d.calls, [['confirm', STOP_CONFIRM_TEXT], ['disconnect'], ['exit']]);
});

test('connected and the user says no: nothing stops', async () => {
  const calls = [];
  const d = deps({ confirm: () => { calls.push('confirm'); return false; }, disconnect: async () => calls.push('disconnect'), exitApp: async () => calls.push('exit') });
  assert.equal(await stopAndClose(d.args), 'cancelled');
  assert.deepEqual(calls, ['confirm']);
});

test('not connected: closes without asking', async () => {
  const d = deps({ connected: false });
  assert.equal(await stopAndClose(d.args), 'closed');
  assert.deepEqual(d.calls, [['disconnect'], ['exit']]);
});

test('a failing disconnect still closes the app', async () => {
  let exited = false;
  const d = deps({ disconnect: async () => { throw new Error('link gone'); }, exitApp: async () => { exited = true; } });
  assert.equal(await stopAndClose(d.args), 'closed');
  assert.ok(exited);
});

test('the question says queued receptions are kept', () => {
  assert.match(STOP_CONFIRM_TEXT, /kept/);
});
