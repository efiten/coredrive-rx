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

function fillColorExpr() {
  const expr = ['match', ['get', 'tier']];
  for (const t of TIERS) expr.push(t, cssVar(`--ch-sig-${t}`));
  expr.push(cssVar('--ch-sig-none')); // fallback for an unexpected tier
  return expr;
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
  map.on('mousemove', 'hex-fill', (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    const s = cellStats.get(f.properties.id);
    const text = s ? `n=${s.count}${s.best != null ? ' · SNR ' + s.best : ''}` : '';
    if (!popup) popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
    popup.setLngLat(e.lngLat).setText(text).addTo(map);
  });
  map.on('mouseleave', 'hex-fill', () => { if (popup) { popup.remove(); popup = null; } });

  map.on('zoomend', () => {
    const nr = Math.min(10, hexResForZoom(map.getZoom()));
    if (nr === res) return;
    res = nr;
    cellStats = new Map();
    for (const p of points) applyPoint(p.lat, p.lon, p.snr);
    syncHexes();
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
    syncPosition();
    if (!centered) { centered = true; map.jumpTo({ center: [lon, lat], zoom: 15 }); } // first fix
    else if (following) map.panTo([lon, lat]); // follow GPS, keep the user's zoom
  }

  return {
    addPoint(lat, lon, snr) {                // an RX: bin into a hex + sync position
      points.push({ lat, lon, snr });
      if (points.length > POINT_CAP) points.shift();
      applyPoint(lat, lon, snr);
      syncHexes();
      moveTo(lat, lon);
    },
    setPosition(nextFix) {                   // live GPS, no hex — independent of RX
      if (!nextFix) return;
      moveTo(nextFix.lat, nextFix.lon);
    },
    follow(on) {
      following = !!on;
      if (following && fix) map.panTo([fix.lon, fix.lat]);
    },
    isFollowing() { return following; },
    setTheme(nextTheme) { map.setStyle(basemapUrl(nextTheme)); },
    resize() { try { map.resize(); } catch (e) {} },
  };
}
