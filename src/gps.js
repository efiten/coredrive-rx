// Phone GPS. Each reception is tagged with the latest fix; no fix → no row
// (coverage without a position is useless).

// gpsErrorKind maps a GeolocationPositionError's numeric code onto the three
// kinds the caller needs to tell apart. PERMISSION_DENIED=1 and
// POSITION_UNAVAILABLE=2 are both dead ends the user (or the device) has to
// do something about; TIMEOUT=3 is not — watchPosition keeps watching after
// a timeout and can still deliver a fix on its own, so callers that treat
// this like the other two would show a permanent-looking error for what may
// be a single slow fix.
export function gpsErrorKind(err) {
  switch (err && err.code) {
    case 1: return 'denied';
    case 2: return 'unavailable';
    case 3: return 'timeout';
    default: return 'unavailable';
  }
}

// gpsErrorTransition decides what a repeating watchPosition outcome is worth
// logging — the same shape as src/monitor.js's linkTransition, and for the
// same reason it exists: a TIMEOUT does not end the watch, so a tunnel, a
// parking garage or an urban canyon fires the error callback again every
// ~15s (this class's own `timeout`) for as long as it lasts. Logged
// unconditionally, that is one line per cycle for the length of the drive —
// exactly linkTransition's "companion link back" field log, but for GPS —
// which at the 200-line ring buffer pushes the RX/region/uplink lines a
// shared debug log is exported to read right out of it.
//
// prevKind/kind are gpsErrorKind() strings or null (no error / a fix in
// hand). 'start': a new error, or a change of kind, worth logging once.
// 'clear': a fix arrived after one or more errors — worth logging once, so
// the log still shows when the trouble ended, not just that it started.
// null: steady — the same kind repeating, or no error before or now — say
// nothing.
export function gpsErrorTransition(prevKind, kind) {
  if (prevKind === kind) return null;
  return kind ? 'start' : 'clear';
}

export class Gps {
  constructor() { this._last = null; this._watchId = null; }

  // start(onFix, onError): begins watching; onFix (optional) fires on every
  // position update so the UI can track GPS continuously, independent of RX
  // packets. onError (optional) fires with a gpsErrorKind() string on every
  // watchPosition error — a denied permission, a position-unavailable, or a
  // timeout — so a caller that only ever passed onFix keeps working unchanged.
  start(onFix, onError) {
    if (!navigator.geolocation) throw new Error('geolocation unavailable');
    this._watchId = navigator.geolocation.watchPosition(
      (p) => {
        this._last = { lat: p.coords.latitude, lon: p.coords.longitude, acc_m: p.coords.accuracy };
        if (onFix) onFix(this._last);
      },
      (err) => { if (onError) onError(gpsErrorKind(err)); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  stop() { if (this._watchId != null) navigator.geolocation.clearWatch(this._watchId); this._watchId = null; }

  // latest() returns the most recent fix or null.
  latest() { return this._last; }
}
