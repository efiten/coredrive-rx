// Scans a CoreDrive RX deployment URL from a QR code (native app only). CoreScope's
// Coverage page shows that QR code when the operator set clientRxCoverage.appUrl.
//
// The scanner is the Google code scanner from Play services
// (@capacitor-mlkit/barcode-scanning, scan()): it brings its own camera screen and
// needs no camera permission, but its module may have to be downloaded once first.
// The plugin is passed in, so this file has no Capacitor import and runs in tests.
import { normalizeDeploymentUrl } from './deployment.js';

// GoogleBarcodeScannerModuleInstallState of the plugin.
export const INSTALL_STATE = { CANCELED: 3, COMPLETED: 4, FAILED: 5 };
const INSTALL_TIMEOUT_MS = 120000;

// A scanned code must spell out https:// itself. Typed input may leave the scheme
// out, but any QR code with a word in it ("hello") would otherwise read as a host.
export function deploymentFromBarcodes(barcodes) {
  for (const b of barcodes || []) {
    const raw = String((b && (b.rawValue || b.displayValue)) || '').trim();
    const url = /^https:\/\//i.test(raw) ? normalizeDeploymentUrl(raw) : '';
    if (url) return url;
  }
  return '';
}

async function ensureModule(scanner, onProgress) {
  const { available } = await scanner.isGoogleBarcodeScannerModuleAvailable();
  if (available) return;
  let handle = null;
  try {
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the QR scanner could not be installed (no answer from Play services)')), INSTALL_TIMEOUT_MS);
      scanner.addListener('googleBarcodeScannerModuleInstallProgress', (ev) => {
        if (typeof ev.progress === 'number' && onProgress) onProgress(ev.progress);
        if (ev.state === INSTALL_STATE.COMPLETED) { clearTimeout(timer); resolve(); }
        if (ev.state === INSTALL_STATE.FAILED || ev.state === INSTALL_STATE.CANCELED) {
          clearTimeout(timer);
          reject(new Error('the QR scanner could not be installed (Play services download ' + (ev.state === INSTALL_STATE.FAILED ? 'failed' : 'cancelled') + ')'));
        }
      }).then((h) => { handle = h; });
    });
    await scanner.installGoogleBarcodeScannerModule();
    await done;
  } finally {
    if (handle) await handle.remove();
  }
}

// scanDeployment resolves to { url, raw } (url '' when the code is not a deployment
// URL) or { url: '', raw: '', cancelled: true } when the user closed the scanner.
export async function scanDeployment(scanner, { onProgress } = {}) {
  await ensureModule(scanner, onProgress);
  let res;
  try {
    res = await scanner.scan({ formats: ['QR_CODE'] });
  } catch (e) {
    if (/cancel/i.test(String(e && e.message))) return { url: '', raw: '', cancelled: true };
    throw e;
  }
  const barcodes = (res && res.barcodes) || [];
  const first = barcodes[0];
  return { url: deploymentFromBarcodes(barcodes), raw: first ? String(first.rawValue || first.displayValue || '') : '' };
}
