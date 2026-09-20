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
