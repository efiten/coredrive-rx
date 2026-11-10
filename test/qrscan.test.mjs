import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deploymentFromBarcodes, scanDeployment, INSTALL_STATE } from '../src/qrscan.js';

test('the first barcode that is a usable deployment URL wins', () => {
  assert.equal(deploymentFromBarcodes([
    { rawValue: 'WIFI:S:home;T:WPA;P:secret;;' },
    { rawValue: 'https://rx.on8ar.eu' },
    { rawValue: 'https://other.example/' },
  ]), 'https://rx.on8ar.eu/');
});

test('displayValue is used when rawValue is missing', () => {
  assert.equal(deploymentFromBarcodes([{ displayValue: 'https://rx.on8ar.eu/staging/' }]), 'https://rx.on8ar.eu/staging/');
});

test('no usable URL, an http URL or no barcodes give an empty answer', () => {
  assert.equal(deploymentFromBarcodes([{ rawValue: 'http://rx.on8ar.eu' }]), '');
  assert.equal(deploymentFromBarcodes([{ rawValue: 'rx.on8ar.eu' }]), '', 'a scanned code must carry https:// itself');
  assert.equal(deploymentFromBarcodes([]), '');
  assert.equal(deploymentFromBarcodes(undefined), '');
});

function fakeScanner({ available = true, finalState = INSTALL_STATE.COMPLETED, barcodes = [], cancel = false } = {}) {
  const calls = [];
  let listener = null;
  return {
    calls,
    async isGoogleBarcodeScannerModuleAvailable() { calls.push('available?'); return { available }; },
    async installGoogleBarcodeScannerModule() {
      calls.push('install');
      setTimeout(() => {
        listener({ state: INSTALL_STATE.DOWNLOADING, progress: 50 });
        listener({ state: finalState });
      }, 1);
    },
    async addListener(name, fn) { calls.push('listen:' + name); listener = fn; return { remove: async () => { calls.push('unlisten'); } }; },
    async scan(opts) {
      calls.push(['scan', opts]);
      if (cancel) throw new Error('scan canceled.');
      return { barcodes };
    },
  };
}

test('scanDeployment scans for QR codes only and returns the deployment', async () => {
  const s = fakeScanner({ barcodes: [{ rawValue: 'https://rx.on8ar.eu' }] });
  const r = await scanDeployment(s);
  assert.deepEqual(r, { url: 'https://rx.on8ar.eu/', raw: 'https://rx.on8ar.eu' });
  assert.deepEqual(s.calls.find((c) => Array.isArray(c)), ['scan', { formats: ['QR_CODE'] }]);
  assert.ok(!s.calls.includes('install'));
});

test('a missing scanner module is installed first, then the scan runs', async () => {
  const s = fakeScanner({ available: false, barcodes: [{ rawValue: 'https://rx.on8ar.eu' }] });
  const progress = [];
  const r = await scanDeployment(s, { onProgress: (p) => progress.push(p) });
  assert.equal(r.url, 'https://rx.on8ar.eu/');
  assert.ok(s.calls.indexOf('install') < s.calls.findIndex((c) => Array.isArray(c)));
  assert.ok(s.calls.includes('unlisten'));
  assert.deepEqual(progress, [50]);
});

test('a failed module install is reported and no scan starts', async () => {
  const s = fakeScanner({ available: false, finalState: INSTALL_STATE.FAILED });
  await assert.rejects(scanDeployment(s), /scanner could not be installed/);
  assert.ok(!s.calls.some((c) => Array.isArray(c)));
});

test('a cancelled scan is not an error', async () => {
  const r = await scanDeployment(fakeScanner({ cancel: true }));
  assert.deepEqual(r, { url: '', raw: '', cancelled: true });
});

test('a QR code that is not a deployment returns what it read, without a url', async () => {
  const r = await scanDeployment(fakeScanner({ barcodes: [{ rawValue: 'hello' }] }));
  assert.deepEqual(r, { url: '', raw: 'hello' });
});
