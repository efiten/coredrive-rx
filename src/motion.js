// Pure "idle gate": decides whether the probe is moving or stationary from the
// stream of GPS fixes, so capture/upload can pause when parked and resume on
// movement. No DOM, no GPS API, no clock — the caller passes `now` (ms epoch).
// Detection is displacement from an anchor point: this absorbs GPS jitter (which
// stays inside the radius) without the cell-edge flicker a hex-dwell would have.
// Run: node --test

// Haversine distance in metres between two {lat, lon} points.
export function distanceM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ~10–30 m GPS scatter while parked stays inside this; driving exceeds it in seconds.
export const DEFAULT_RADIUS_M = 75;
export const DEFAULT_DWELL_MS = 5 * 60 * 1000;

// initMotion(fix, now): seed the gate at the first fix (active, not paused).
export function initMotion(fix, now) {
  return { anchor: { lat: fix.lat, lon: fix.lon }, anchorTime: now, paused: false };
}

// updateMotion(state, fix, now, opts): advance the gate with a new fix. Returns a
// NEW state. Moving (> radiusM from the anchor) re-anchors and unpauses; staying
// within the radius past dwellMs pauses (anchor + anchorTime unchanged, so the
// dwell clock runs from arrival and jitter doesn't reset it).
export function updateMotion(state, fix, now, opts = {}) {
  const radiusM = opts.radiusM ?? DEFAULT_RADIUS_M;
  const dwellMs = opts.dwellMs ?? DEFAULT_DWELL_MS;
  if (!state) return initMotion(fix, now);
  if (distanceM(state.anchor, fix) > radiusM) {
    return { anchor: { lat: fix.lat, lon: fix.lon }, anchorTime: now, paused: false };
  }
  return { anchor: state.anchor, anchorTime: state.anchorTime, paused: now - state.anchorTime >= dwellMs };
}
