// Phone GPS. Each reception is tagged with the latest fix; no fix → no row
// (coverage without a position is useless).
export class Gps {
  constructor() { this._last = null; this._watchId = null; }

  start() {
    if (!navigator.geolocation) throw new Error('geolocation unavailable');
    this._watchId = navigator.geolocation.watchPosition(
      (p) => { this._last = { lat: p.coords.latitude, lon: p.coords.longitude, acc_m: p.coords.accuracy }; },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  stop() { if (this._watchId != null) navigator.geolocation.clearWatch(this._watchId); this._watchId = null; }

  // latest() returns the most recent fix or null.
  latest() { return this._last; }
}
