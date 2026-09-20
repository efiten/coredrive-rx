// test/gps.test.mjs
// Gps wraps navigator.geolocation.watchPosition. Until now it passed no error
// callback at all, so a denied permission, a position-unavailable or a
// timeout was silently swallowed: the splash gate's gps-error state
// (src/ui/splash.js) could never fire, and a user who denied location saw
// "no fix" forever with nothing saying why. Verified with a fake
// navigator.geolocation (no real browser) — run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { Gps, gpsErrorKind, gpsErrorTransition } from '../src/gps.js';

// fakeGeolocation: watchPosition fires onFix (if a fix is given) or onError
// (if an error code is given), synchronously, and records what stop() does.
function fakeGeolocation({ fix, errorCode } = {}) {
  const calls = { cleared: 0 };
  return {
    calls,
    watchPosition(onFix, onError) {
      if (fix) onFix(fix);
      if (errorCode != null) onError({ code: errorCode });
      return 7;
    },
    clearWatch(id) { calls.cleared++; assert.strictEqual(id, 7); },
  };
}

// Node's own global `navigator` is a getter-only property (Node 21+), so a
// plain assignment throws; redefine it for the duration of one test instead.
function withFakeNavigator(geolocation, fn) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { geolocation }, configurable: true, writable: true });
  try { return fn(); } finally { Object.defineProperty(globalThis, 'navigator', prior); }
}

const FIX = { coords: { latitude: 50.85, longitude: 4.35, accuracy: 5.5 } };

test('gpsErrorKind names the three GeolocationPositionError codes', () => {
  assert.strictEqual(gpsErrorKind({ code: 1 }), 'denied');
  assert.strictEqual(gpsErrorKind({ code: 2 }), 'unavailable');
  assert.strictEqual(gpsErrorKind({ code: 3 }), 'timeout');
});

test('gpsErrorKind treats an unrecognised code as unavailable, not a throw', () => {
  assert.strictEqual(gpsErrorKind({ code: 99 }), 'unavailable');
  assert.strictEqual(gpsErrorKind(undefined), 'unavailable');
});

test('a fix reaches onFix and becomes latest()', () => {
  withFakeNavigator(fakeGeolocation({ fix: FIX }), () => {
    const gps = new Gps();
    let got = null;
    gps.start((f) => { got = f; });
    assert.deepStrictEqual(got, { lat: 50.85, lon: 4.35, acc_m: 5.5 });
    assert.deepStrictEqual(gps.latest(), got);
  });
});

test('the single-argument call (no onError) still works: no throw on a watch error', () => {
  withFakeNavigator(fakeGeolocation({ errorCode: 1 }), () => {
    const gps = new Gps();
    assert.doesNotThrow(() => gps.start(() => {}));
  });
});

test('a denied permission reaches onError as "denied"', () => {
  withFakeNavigator(fakeGeolocation({ errorCode: 1 }), () => {
    const gps = new Gps();
    let kind = null;
    gps.start(() => {}, (k) => { kind = k; });
    assert.strictEqual(kind, 'denied');
  });
});

test('position-unavailable reaches onError as "unavailable"', () => {
  withFakeNavigator(fakeGeolocation({ errorCode: 2 }), () => {
    const gps = new Gps();
    let kind = null;
    gps.start(() => {}, (k) => { kind = k; });
    assert.strictEqual(kind, 'unavailable');
  });
});

test('a timeout reaches onError as "timeout", distinct from the other two', () => {
  withFakeNavigator(fakeGeolocation({ errorCode: 3 }), () => {
    const gps = new Gps();
    let kind = null;
    gps.start(() => {}, (k) => { kind = k; });
    assert.strictEqual(kind, 'timeout');
  });
});

test('an error does not touch latest(): the last real fix, if any, stands', () => {
  withFakeNavigator(fakeGeolocation({ errorCode: 2 }), () => {
    const gps = new Gps();
    gps.start(() => {}, () => {});
    assert.strictEqual(gps.latest(), null);
  });
});

test('stop() clears the watch returned by watchPosition', () => {
  const geolocation = fakeGeolocation({});
  withFakeNavigator(geolocation, () => {
    const gps = new Gps();
    gps.start(() => {});
    gps.stop();
    assert.strictEqual(geolocation.calls.cleared, 1);
  });
});

test('geolocation missing entirely throws, same as before', () => {
  withFakeNavigator(undefined, () => {
    assert.throws(() => new Gps().start(() => {}), /geolocation unavailable/);
  });
});

// --- gpsErrorTransition -------------------------------------------------
// A repeating TIMEOUT does not end the watch, so without this a poor-reception
// stretch (tunnel, parking garage, urban canyon) logs one line every ~15s
// (Gps.start's own `timeout`) for as long as it lasts — the same shape as
// src/monitor.js's linkTransition, and for the same field-log reason.
test('the same kind repeating logs nothing: this is the timeout spam that stops', () => {
  assert.strictEqual(gpsErrorTransition('timeout', 'timeout'), null);
  assert.strictEqual(gpsErrorTransition('denied', 'denied'), null);
});

test('no error before or now logs nothing (the ordinary steady "waiting for a fix" state)', () => {
  assert.strictEqual(gpsErrorTransition(null, null), null);
});

test('a new error, or a change of kind, is worth logging once', () => {
  assert.strictEqual(gpsErrorTransition(null, 'denied'), 'start');
  assert.strictEqual(gpsErrorTransition('timeout', 'denied'), 'start');
  assert.strictEqual(gpsErrorTransition('denied', 'unavailable'), 'start');
});

test('a fix after one or more errors is worth logging once, so the log shows when it ended', () => {
  assert.strictEqual(gpsErrorTransition('denied', null), 'clear');
  assert.strictEqual(gpsErrorTransition('timeout', null), 'clear');
});
