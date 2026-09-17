// The session map: the hexes this drive has covered, coloured by the best SNR
// heard in each. Replaces the Leaflet map this app had; the hex maths stays in
// hexgrid.js, which is a port of CoreScope's own binning and is tested.
//
// maplibre-gl (and its CSS) is loaded lazily, inside createMap, via a dynamic
// import(). That keeps this module importable under `node --test`, where
// there is no DOM and no WebGL: the pure functions below (basemapUrl,
// hexFeature, hexCollection) never touch maplibre-gl, so requiring this file
// for their tests never requires a browser.
import { hexBoundary, hexCellAt, hexResForZoom } from '../hexgrid.js';
import { snrTier } from './reading.js';

const BASEMAPS = {
  dark: 'https://tiles.openfreemap.org/styles/dark',
  light: 'https://tiles.openfreemap.org/styles/positron',
};

export function basemapUrl(theme) {
  return BASEMAPS[theme] || BASEMAPS.dark;
}

// hexFeature: hexBoundary already returns a closed ring ([lat,lon] pairs, with
// ring[0] repeated at the end) or null for a malformed id. So all this does is
// flip each pair to GeoJSON's [lon,lat] and pass a null id straight through
// instead of throwing.
export function hexFeature(cellId, bestSnr) {
  const boundary = hexBoundary(cellId);
  if (!boundary) return null;
  const ring = boundary.map(([lat, lon]) => [lon, lat]);
  return {
    type: 'Feature',
    properties: { id: cellId, tier: snrTier(bestSnr) },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

export function hexCollection(cells) {
  const features = [];
  for (const [id, snr] of cells) {
    const f = hexFeature(id, snr);
    if (f) features.push(f);
  }
  return { type: 'FeatureCollection', features };
}

// ---- Instance half: the live MapLibre map ---------------------------------

const POINT_CAP = 5000;
// The six tiers app.css actually paints (tokens.css also has --ch-sig-faint,
// unused by snrTier's SNR bands and so left out here).
const TIERS = ['hot', 'warm', 'mid', 'cool', 'cold', 'none'];

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// --rx-sig-*, not --ch-sig-*: app.css owns the RX ramp and tokens.css is
// core-hunter's file kept byte-identical, whose thermal ramp runs the other way
// (its strongest tier is red, which is also this app's failure colour). The
// tiers are SNR bands from src/ui/reading.js, not the RSSI dBm bands tokens.css
// documents. The fill and the hero meter must paint the same tier the same
// colour, so both read from the same variables.
function fillColorExpr() {
  const expr = ['match', ['get', 'tier']];
  for (const t of TIERS) expr.push(t, cssVar(`--rx-sig-${t}`));
  expr.push(cssVar('--rx-sig-none')); // fallback for an unexpected tier
  return expr;
}

// hexPopupText: the per-cell readout, from that cell's accumulated stats. Pure,
// so what a tap says is testable without a map.
export function hexPopupText(stats) {
  if (!stats) return '';
  return `n=${stats.count}${stats.best != null ? ' · SNR ' + stats.best : ''}`;
}

// createSyncGate defers the map's work while another tab is shown. #map is a
// body-level layer that nothing hides, so before this every GPS fix panned a map
// nobody was looking at — a GL repaint and a round of vector-tile fetches per
// fix, for the whole drive, while Heard or Status was open.
//
// Closed, a job is remembered instead of run; opening replays each job that was
// missed exactly once, so the map is correct the moment Drive comes back. Jobs
// are named and idempotent (each syncs from current state, it does not apply a
// delta), which is what makes collapsing a drive's worth of them into one safe.
export function createSyncGate(jobs) {
  let open = true;
  const pending = new Set();
  return {
    isOpen: () => open,
    // run: performed now, or noted for the reopen. Returns whether it ran.
    run(name) {
      if (open) { jobs[name](); return true; }
      pending.add(name);
      return false;
    },
    // setOpen: returns the names replayed, so a caller (and a test) can see what
    // the closed period had deferred.
    setOpen(next) {
      if (!!next === open) return [];
      open = !!next;
      if (!open) return [];
      const replayed = [...pending];
      pending.clear();
      for (const name of replayed) jobs[name]();
      return replayed;
    },
  };
}

function positionCollection(fix) {
  if (!fix) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [fix.lon, fix.lat] } }],
  };
}

// createMap builds the live map: a hex fill layer fed by this session's
// received packets, and a dot for the current GPS fix. Async because loading
// maplibre-gl is itself async (see the module comment above).
export async function createMap({ container, theme }) {
  const [{ default: maplibregl }] = await Promise.all([
    import('maplibre-gl'),
    import('maplibre-gl/dist/maplibre-gl.css'),
  ]);

  const map = new maplibregl.Map({
    container,
    style: basemapUrl(theme),
    center: [4.5, 50.85],
    zoom: 8,
    attributionControl: false,
  });

  const points = [];           // this session's raw {lat,lon,snr}, capped at POINT_CAP
  let cellStats = new Map();   // cellId -> {count, best}
  let res = Math.min(10, hexResForZoom(map.getZoom()));
  let following = true;        // pan to keep the GPS fix centred (zoom preserved)
  let centered = false;        // first fix recentres+zooms once, then it's just panning
  let fix = null;               // last known GPS fix, {lat,lon}

  function bestMap() {
    const m = new Map();
    for (const [id, s] of cellStats) m.set(id, s.best);
    return m;
  }

  function syncHexes() {
    const src = map.getSource('hexes');
    if (src) src.setData(hexCollection(bestMap()));
  }

  function syncPosition() {
    const src = map.getSource('position');
    if (src) src.setData(positionCollection(fix));
  }

  // panToFix: the first fix recentres and zooms once; after that it is follow
  // mode panning, which the user's own drag turns off.
  function panToFix() {
    if (!fix) return;
    if (!centered) { centered = true; map.jumpTo({ center: [fix.lon, fix.lat], zoom: 15 }); }
    else if (following) map.panTo([fix.lon, fix.lat]);
  }

  // Every repaint-causing job goes through the gate, which app.js closes while
  // a tab other than Drive is shown (setActive below).
  const gate = createSyncGate({ hexes: syncHexes, position: syncPosition, pan: panToFix });

  function addLayers() {
    if (!map.getSource('hexes')) map.addSource('hexes', { type: 'geojson', data: hexCollection(bestMap()) });
    if (!map.getLayer('hex-fill')) {
      map.addLayer({
        id: 'hex-fill',
        type: 'fill',
        source: 'hexes',
        paint: { 'fill-color': fillColorExpr(), 'fill-opacity': 0.65 },
      });
    }
    if (!map.getLayer('hex-outline')) {
      map.addLayer({
        id: 'hex-outline',
        type: 'line',
        source: 'hexes',
        paint: { 'line-color': cssVar('--ch-border'), 'line-width': 1 },
      });
    }
    if (!map.getSource('position')) map.addSource('position', { type: 'geojson', data: positionCollection(fix) });
    if (!map.getLayer('position-dot')) {
      map.addLayer({
        id: 'position-dot',
        type: 'circle',
        source: 'position',
        paint: {
          'circle-radius': 6,
          'circle-color': cssVar('--ch-accent'),
          'circle-stroke-width': 2,
          'circle-stroke-color': cssVar('--ch-bg'),
        },
      });
    }
  }

  let popup = null;
  map.on('style.load', addLayers);
  map.on('dragstart', () => { following = false; });
  // The readout for one cell. mousemove/mouseleave are a desktop pair that a
  // touch device never fires, which left the per-hex numbers unreachable on the
  // phone this app is driven on; 'click' is what a tap does fire, and it is the
  // tap-to-open the deleted Leaflet map had through bindTooltip. The popup's own
  // close button is what dismisses it on touch (there is no mouseleave).
  // sticky: opened by a tap, so only its close button dismisses it. A touch
  // device also emits compatibility mouse events, and without this the
  // mouseleave below could take the readout away again on the way out of the
  // tap. closeOnClick stays off: the layer's own click handler would race it.
  let sticky = false;
  function showPopup(e, tapped) {
    const f = e.features && e.features[0];
    if (!f) return;
    const text = hexPopupText(cellStats.get(f.properties.id));
    if (!popup) popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false });
    popup.setLngLat(e.lngLat).setText(text).addTo(map);
    sticky = tapped;
  }
  map.on('click', 'hex-fill', (e) => showPopup(e, true));
  map.on('mousemove', 'hex-fill', (e) => showPopup(e, false));
  map.on('mouseleave', 'hex-fill', () => {
    if (sticky) return;
    if (popup) { popup.remove(); popup = null; }
  });

  map.on('zoomend', () => {
    const nr = Math.min(10, hexResForZoom(map.getZoom()));
    if (nr === res) return;
    res = nr;
    cellStats = new Map();
    for (const p of points) applyPoint(p.lat, p.lon, p.snr);
    gate.run('hexes');
  });

  function applyPoint(lat, lon, snr) {
    const id = hexCellAt(lat, lon, res);
    const s = cellStats.get(id) || { count: 0, best: null };
    s.count++;
    if (snr != null && (s.best == null || snr > s.best)) s.best = snr;
    cellStats.set(id, s);
  }

  function moveTo(lat, lon) {
    if (lat == null || lon == null) return;
    fix = { lat, lon };
    gate.run('position');
    gate.run('pan');
  }

  return {
    addPoint(lat, lon, snr) {                // an RX: bin into a hex + sync position
      points.push({ lat, lon, snr });
      if (points.length > POINT_CAP) points.shift();
      applyPoint(lat, lon, snr);
      gate.run('hexes');
      moveTo(lat, lon);
    },
    setPosition(nextFix) {                   // live GPS, no hex — independent of RX
      if (!nextFix) return;
      moveTo(nextFix.lat, nextFix.lon);
    },
    follow(on) {
      following = !!on;
      if (following && fix) gate.run('pan');
    },
    isFollowing() { return following; },
    // setActive(false) while another tab is shown: receptions and fixes are
    // still recorded, but nothing repaints or fetches a tile until Drive is
    // back, when exactly the deferred work is replayed.
    setActive(on) { return gate.setOpen(on); },
    isActive() { return gate.isOpen(); },
    setTheme(nextTheme) { map.setStyle(basemapUrl(nextTheme)); },
    resize() { try { map.resize(); } catch (e) {} },
  };
}
