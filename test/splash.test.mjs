// test/splash.test.mjs
// Ported from core-hunter's app/src/__tests__/splash.test.js (vitest ->
// node:test). splashState/splashRows/dismissBanner are ported unchanged
// (generic connect/GPS state machine, no hunter-specific behaviour).
//
// Dropped from the ported suite, with reasons:
//   - splashRows' `sf` (LoRa spreading factor) cases: this app has no SF
//     readout (grepped src/*.js, src/ui/*.js — nothing tracks it), so the
//     Bluetooth row only ever carries a name. Re-asserted below without `sf`.
//   - SPLASH_DISCLAIMER / SPLASH_DISCLAIMER_SHORT: core-hunter's "we map
//     radio signal, not GPS tracking of the target" statement is about
//     triangulating another node's position. CoreDrive RX maps its OWN
//     coverage as you drive; there is no "target" to disclaim tracking of,
//     and no About sheet to host the sentence. Not ported.
//   - SPLASH_CALLOUTS / SPLASH_CALLOUTS.fabs copy / SPLASH_FAB_IDS: these
//     describe core-hunter's map FAB stack (layer-toggle, sound-toggle,
//     nodepos-toggle, etc.) and its spotlight-ring CSS. None of those ids or
//     that ring/scrim system exist in this app's index.html or app.css. Not
//     ported.
//   - The cold-start coach-mark tour (COACH_MARKS, positionCoachMarks,
//     calloutPosition.js) shipped briefly on this branch, pointing at
//     #btnConnect/#tab-drive/#tab-heard, and was removed again: all three
//     marks rendered at once, two overlapped above the tab bar and the third
//     sat over the connect steps rather than beside Connect. The gate is the
//     centred card (splashRows) alone now.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  splashState, splashRows, dismissBanner, SPLASH_ERRORS, APP_NAME,
} from '../src/ui/splash.js';

test('splashState hides once a GPS fix has been acquired, regardless of other state', () => {
  assert.strictEqual(splashState({ hasFix: true, connected: false, bleError: true, gpsError: true }), 'hidden');
});

test('splashState shows intro before connecting', () => {
  assert.strictEqual(splashState({ hasFix: false, connected: false, bleError: false, gpsError: false }), 'intro');
});

test('splashState shows ble-error when the last connect attempt failed, even if previously connected', () => {
  assert.strictEqual(splashState({ hasFix: false, connected: false, bleError: true, gpsError: false }), 'ble-error');
});

test('splashState shows waiting-gps once connected but no fix yet and no GPS error', () => {
  assert.strictEqual(splashState({ hasFix: false, connected: true, bleError: false, gpsError: false }), 'waiting-gps');
});

test('splashState shows gps-error once connected and the GPS watch reported an error', () => {
  assert.strictEqual(splashState({ hasFix: false, connected: true, bleError: false, gpsError: true }), 'gps-error');
});

// The dismiss control closes the gate for this session; connecting is not required.
test('splashState hides once dismissed, whatever else is going on', () => {
  assert.strictEqual(splashState({ hasFix: false, connected: false, bleError: true, gpsError: false, dismissed: true }), 'hidden');
  assert.strictEqual(splashState({ hasFix: false, connected: true, bleError: false, gpsError: true, dismissed: true }), 'hidden');
});

test('splashRows starts both rows grey with nothing claimed', () => {
  assert.deepStrictEqual(splashRows('intro', {}), [
    { key: 'Bluetooth', dot: 'off', text: 'No companion' },
    { key: 'GPS', dot: 'off', text: 'No fix yet' },
  ]);
});

test('splashRows ticks Bluetooth with the companion name once connected, GPS still working', () => {
  assert.deepStrictEqual(splashRows('waiting-gps', { name: 'Kas -2' }), [
    { key: 'Bluetooth', dot: 'on', text: 'Kas -2' },
    { key: 'GPS', spin: true, text: 'Waiting for a fix…' },
  ]);
});

test('splashRows falls back to a plain Connected when the companion has no name yet', () => {
  const [bt] = splashRows('waiting-gps', { name: '' });
  assert.deepStrictEqual(bt, { key: 'Bluetooth', dot: 'on', text: 'Connected' });
});

test('splashRows marks the failing row for each error state and leaves the other honest', () => {
  assert.deepStrictEqual(splashRows('ble-error', {}), [
    { key: 'Bluetooth', dot: 'err', text: 'Not connected' },
    { key: 'GPS', dot: 'off', text: 'No fix yet' },
  ]);
  assert.deepStrictEqual(splashRows('gps-error', { name: 'Kas -2' }), [
    { key: 'Bluetooth', dot: 'on', text: 'Kas -2' },
    { key: 'GPS', dot: 'err', text: 'No fix' },
  ]);
});

test('dismissBanner names the missing radio when nothing is connected', () => {
  assert.strictEqual(dismissBanner({ connected: false }), 'No companion connected. Nothing is captured until you connect.');
});

test('dismissBanner names the missing fix when the radio is already on', () => {
  assert.strictEqual(dismissBanner({ connected: true }), 'No GPS fix yet. Nothing is logged without a position.');
});

test('SPLASH_ERRORS has a fallback line for exactly the two retryable states', () => {
  assert.deepStrictEqual(Object.keys(SPLASH_ERRORS).sort(), ['ble-error', 'gps-error']);
  for (const v of Object.values(SPLASH_ERRORS)) assert.ok(v.length > 0);
});

test('APP_NAME is the CoreDrive RX display name', () => {
  assert.strictEqual(APP_NAME, 'CoreDrive RX');
});

// --- The gate must not eat the taps it tells you to make --------------------
// .splash is a full-viewport fixed layer at z-index 800. The comment above it in
// app.css promises the real controls stay tappable underneath, and only
// pointer-events makes that true. Without it the gate was a dead end: connectAll
// is the sole caller of state.gps.start, #btnConnect is the sole way into
// connectAll, and it sits under this layer — so `connected` and `hasFix` could
// never become true while the gate was up, splashState could only ever answer
// 'intro', and Skip was the one way out.
test('the splash backdrop passes taps through, and its card takes them back', () => {
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  const rule = (selector) => {
    const at = css.indexOf(selector + ' {');
    assert.notStrictEqual(at, -1, `app.css must define ${selector}`);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.match(rule('.splash'), /pointer-events:\s*none/);
  assert.match(rule('.splash-card'), /pointer-events:\s*auto/);
});

// With the taps passing through, each of splashState's inputs has a real source
// again: connected is bleLinkUp() after connectAll's transport.connect(),
// bleError is connectAll's catch, and hasFix is the gps.start callback
// connectAll installs. gpsError has no source — src/gps.js swallows
// watchPosition's error callback and app.js's splashArgs pins it false — so
// three of the four are reachable in the field and the fourth stays a tested
// state with no trigger.
test('the three states the app can actually produce are all distinct', () => {
  const base = { hasFix: false, dismissed: false, gpsError: false };
  assert.strictEqual(splashState({ ...base, connected: false, bleError: false }), 'intro');
  assert.strictEqual(splashState({ ...base, connected: true, bleError: false }), 'waiting-gps');
  assert.strictEqual(splashState({ ...base, connected: false, bleError: true }), 'ble-error');
  assert.strictEqual(splashState({ ...base, hasFix: true, connected: true, bleError: false }), 'hidden');
});
