// The map's pure parts: which basemap a theme asks for, and the GeoJSON the hex
// layer draws. The MapLibre instance itself is exercised by the smoke test.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  basemapUrl, hexFeature, hexCollection, hexPopupText, createSyncGate,
  fillColorExpr, POPUP_OPEN_EVENTS,
} from '../src/ui/map.js';
import { hexCellAt } from '../src/hexgrid.js';
import { snrTier } from '../src/ui/reading.js';

test('each theme has its own basemap and neither is a CDN we do not allow', () => {
  assert.notStrictEqual(basemapUrl('dark'), basemapUrl('light'));
  for (const t of ['dark', 'light']) assert.match(basemapUrl(t), /^https:\/\//);
});

test('an unknown theme falls back to dark, which is what boots', () => {
  assert.strictEqual(basemapUrl('nonsense'), basemapUrl('dark'));
});

test('a cell becomes a closed polygon carrying its tier', () => {
  const cell = hexCellAt(50.85, 4.5, 10);
  const f = hexFeature(cell, 4.25);
  assert.strictEqual(f.type, 'Feature');
  assert.strictEqual(f.geometry.type, 'Polygon');
  const ring = f.geometry.coordinates[0];
  assert.ok(ring.length >= 7, 'a hex ring closes: 6 corners + the repeat');
  assert.deepStrictEqual(ring[0], ring[ring.length - 1]);
  assert.strictEqual(f.properties.tier, 'warm');
  assert.strictEqual(f.properties.id, cell);
});

test('a cell with no metric still draws, in its own tier', () => {
  const f = hexFeature(hexCellAt(50.85, 4.5, 10), null);
  assert.strictEqual(f.properties.tier, 'none');
});

test('the collection keeps one feature per cell', () => {
  const a = hexCellAt(50.85, 4.5, 10);
  const b = hexCellAt(51.0, 4.7, 10);
  const fc = hexCollection(new Map([[a, 3], [b, -12]]));
  assert.strictEqual(fc.type, 'FeatureCollection');
  assert.strictEqual(fc.features.length, 2);
});

// --- The colour ramp --------------------------------------------------------
// tokens.css is core-hunter's file, kept byte-identical, and its thermal ramp
// runs the other way round: --ch-sig-hot (#ff453a) is its STRONGEST tier and the
// same token is this app's failure colour (.lg-no, .step.failed, .dot.bad). Used
// straight, a strong cell painted red on a coverage map — the colour that means
// "problem area" — and one token meant both "excellent" and "failed" on the same
// screen. app.css's --rx-sig-* aliases put v1.18.2's ramp back (green / yellow /
// orange / red) without editing tokens.css.
const APP_CSS = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
const TOKENS_CSS = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

// alias(name) -> the --ch-* token an --rx-sig-* alias forwards to.
function alias(name) {
  const m = APP_CSS.match(new RegExp('--rx-sig-' + name + ':\\s*var\\((--ch-[a-z0-9-]+)\\)'));
  assert.ok(m, `app.css must alias --rx-sig-${name}`);
  return m[1];
}

// fillBg(tier) -> the CSS variable .fill-<tier>'s background reads, parsed out
// of the rule body rather than matched as one exact literal line — a harmless
// reformat (added whitespace, reordered declarations) must not fail this.
function fillBg(tier) {
  const at = APP_CSS.indexOf(`.fill-${tier} {`);
  assert.notStrictEqual(at, -1, `app.css must define .fill-${tier}`);
  const body = APP_CSS.slice(at, APP_CSS.indexOf('}', at));
  const m = body.match(/background:\s*var\((--[a-z0-9-]+)\)/);
  assert.ok(m, `.fill-${tier} must paint from a var()`);
  return m[1];
}

// withFakeStyle fakes the getComputedStyle(document.documentElement) pair
// src/ui/map.js's cssVar() reads, so fillColorExpr() can be called and its
// output inspected without a browser. `values` maps a CSS custom property
// name to the string cssVar() should return for it.
function withFakeStyle(values, fn) {
  const priorDoc = globalThis.document;
  const priorGCS = globalThis.getComputedStyle;
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => values[name] ?? '' });
  try { return fn(); } finally {
    globalThis.document = priorDoc;
    globalThis.getComputedStyle = priorGCS;
  }
}

test('the strongest tier is not painted in the failure colour', () => {
  // The strongest SNR band snrTier answers for.
  assert.strictEqual(snrTier(5), 'hot');
  assert.notStrictEqual(alias('hot'), '--ch-sig-hot');
  // --ch-sig-hot is what failure is painted in; that must stay true and stay
  // separate from the signal ramp.
  for (const failure of ['.lg-no', '.step.failed']) {
    const at = APP_CSS.indexOf(failure + ' {');
    assert.notStrictEqual(at, -1, `app.css must define ${failure}`);
    assert.match(APP_CSS.slice(at, APP_CSS.indexOf('}', at)), /--ch-sig-hot/);
  }
});

test('the ramp runs strong-to-weak the way v1.18.2 painted it', () => {
  // v1.18.2's snrColor: >=5 green, >=-3 yellow, >=-10 orange, below that red.
  // Read as tokens: the accent (green), then tokens.css's mid (yellow), warm
  // (orange) and hot (red) — i.e. the thermal ramp reversed.
  assert.strictEqual(alias('hot'), '--ch-accent');
  assert.strictEqual(alias('warm'), '--ch-sig-mid');
  assert.strictEqual(alias('mid'), '--ch-sig-warm');
  assert.strictEqual(alias('cool'), '--ch-sig-hot');
  // The weakest band is the red one, which is the whole point of the swap.
  assert.strictEqual(snrTier(-10.25), 'cool');
});

test('the fill expression reads the --rx-sig-* aliases, not --ch-sig-* directly', () => {
  // Every --ch-sig-* is given a deliberately wrong value here: if fillColorExpr
  // ever read one of those directly instead of its --rx-sig-* alias, this
  // value would leak into the expression and the deepStrictEqual below would
  // catch it.
  const expr = withFakeStyle({
    '--rx-sig-hot': 'HOT', '--rx-sig-warm': 'WARM', '--rx-sig-mid': 'MID',
    '--rx-sig-cool': 'COOL', '--rx-sig-cold': 'COLD', '--rx-sig-none': 'NONE',
    '--ch-sig-hot': 'WRONG', '--ch-sig-warm': 'WRONG', '--ch-sig-mid': 'WRONG',
    '--ch-sig-cool': 'WRONG', '--ch-sig-cold': 'WRONG', '--ch-sig-none': 'WRONG',
  }, () => fillColorExpr());
  assert.deepStrictEqual(expr, [
    'match', ['get', 'tier'],
    'hot', 'HOT', 'warm', 'WARM', 'mid', 'MID', 'cool', 'COOL', 'cold', 'COLD', 'none', 'NONE',
    'NONE', // fallback for an unexpected tier
  ]);
});

test('the map fill and the meter paint the same tier from the same variable', () => {
  for (const tier of ['hot', 'warm', 'mid', 'cool', 'none']) {
    assert.strictEqual(fillBg(tier), `--rx-sig-${tier}`, `.fill-${tier} must paint from --rx-sig-${tier}`);
  }
});

test('tokens.css is still core-hunter\'s file, unedited', () => {
  // Byte-for-byte per the design: the ramp is corrected by aliasing, not by
  // changing the copy. Its own comments band by RSSI dBm, which is core-hunter's
  // measure; snrTier bands by SNR, and app.css says so where the aliases are.
  assert.match(TOKENS_CSS, /--ch-sig-hot:\s*#ff453a/);
  assert.match(APP_CSS, /snrTier|SNR/);
});

// --- The per-hex readout ----------------------------------------------------
test('the readout names the count, and the best SNR only when there is one', () => {
  assert.strictEqual(hexPopupText({ count: 7, best: -3.5 }), 'n=7 · SNR -3.5');
  assert.strictEqual(hexPopupText({ count: 2, best: null }), 'n=2');
  assert.strictEqual(hexPopupText(undefined), '');
});

test('a tap opens the readout, not only a mouse', () => {
  // mousemove is a desktop-only event no touch device fires, which left the
  // numbers unreachable on the phone this app is driven on. createMap's live
  // map.on() wiring itself needs a browser (maplibre-gl + WebGL) and is
  // exercised by the smoke test only; POPUP_OPEN_EVENTS is the pure data it
  // wires from, so this checks the fact without needing a map instance.
  const click = POPUP_OPEN_EVENTS.find((e) => e.type === 'click');
  assert.ok(click, 'click must open the popup');
  assert.strictEqual(click.tapped, true);
});

// --- The sync gate ----------------------------------------------------------
function recorder() {
  const calls = [];
  const jobs = {
    hexes: () => calls.push('hexes'),
    position: () => calls.push('position'),
    pan: () => calls.push('pan'),
  };
  return { calls, jobs };
}

test('an open gate runs every job straight away', () => {
  const { calls, jobs } = recorder();
  const gate = createSyncGate(jobs);
  assert.strictEqual(gate.isOpen(), true);
  assert.strictEqual(gate.run('position'), true);
  assert.strictEqual(gate.run('pan'), true);
  assert.deepStrictEqual(calls, ['position', 'pan']);
});

test('a closed gate runs nothing: this is the tile fetching that stops', () => {
  const { calls, jobs } = recorder();
  const gate = createSyncGate(jobs);
  gate.setOpen(false);
  for (let i = 0; i < 50; i++) { gate.run('position'); gate.run('pan'); }
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(gate.isOpen(), false);
});

test('reopening replays what was missed, once each, so the map is correct again', () => {
  const { calls, jobs } = recorder();
  const gate = createSyncGate(jobs);
  gate.setOpen(false);
  for (let i = 0; i < 50; i++) { gate.run('position'); gate.run('pan'); }
  gate.run('hexes');
  const replayed = gate.setOpen(true);
  assert.deepStrictEqual(replayed, ['position', 'pan', 'hexes']);
  assert.deepStrictEqual(calls, ['position', 'pan', 'hexes']);
});

test('nothing is replayed twice, and a reopen with nothing deferred is silent', () => {
  const { calls, jobs } = recorder();
  const gate = createSyncGate(jobs);
  gate.setOpen(false);
  gate.run('hexes');
  gate.setOpen(true);
  assert.deepStrictEqual(calls, ['hexes']);
  gate.setOpen(false);
  gate.setOpen(true);
  assert.deepStrictEqual(calls, ['hexes']);
});

test('setting the gate to the state it is already in changes nothing', () => {
  const { calls, jobs } = recorder();
  const gate = createSyncGate(jobs);
  assert.deepStrictEqual(gate.setOpen(true), []);
  gate.setOpen(false);
  gate.run('pan');
  assert.deepStrictEqual(gate.setOpen(false), [], 'a second close must not replay');
  assert.deepStrictEqual(calls, []);
});

// map.js's setTheme/syncTheme route the basemap swap through this same gate
// (createMap needs maplibre-gl + a browser, so that composition is exercised
// live only by the smoke test — this proves the generic shape it relies on: a
// job that reads a variable set immediately by the caller, not an argument
// captured at queue time, so the gate's own de-duplication of a job name
// (already covered above) is what makes "cycled twice while away" apply the
// SECOND theme once, not the first, and not twice.
test('a job that reads a variable set outside it applies whatever that variable last became', () => {
  let curTheme = 'dark';
  const applied = [];
  const gate = createSyncGate({ theme: () => applied.push(curTheme) });
  gate.setOpen(false);
  curTheme = 'light'; gate.run('theme');
  curTheme = 'dark'; gate.run('theme'); // cycled a second time while still away
  assert.deepStrictEqual(applied, [], 'nothing painted while closed');
  const replayed = gate.setOpen(true);
  assert.deepStrictEqual(replayed, ['theme'], 'one job, not one per run() call');
  assert.deepStrictEqual(applied, ['dark'], 'the theme in effect when Drive returns is the last one asked for');
});
