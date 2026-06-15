// Real-time local coverage map: aggregates this session's received packets into
// hex cells and draws them on Leaflet, live. Pure client-side, no server round-trip
// — instant + works offline. The live grid is deliberately clamped one step coarser
// than the analytical server grid (liveRes below) so cells stay visible while driving.
import { hexCellAt, hexBoundary, hexResForZoom } from './hexgrid.js';

function snrColor(snr) {
  if (snr == null) return '#95a5a6';
  if (snr >= 5) return '#2ecc71';
  if (snr >= -3) return '#f1c40f';
  if (snr >= -10) return '#e67e22';
  return '#e74c3c';
}

// liveRes clamps the server-grid resolution to a coarser maximum so live cells are
// big enough to see on the move (res 11 = 40 m hexes render too small at driving zoom).
function liveRes(zoom) {
  return Math.min(10, hexResForZoom(zoom));
}

const POINT_CAP = 5000;

export function createLocalMap(containerId) {
  if (typeof L === 'undefined') return { addPoint() {}, invalidate() {}, destroy() {} };
  const map = L.map(containerId, { zoomControl: true, attributionControl: false }).setView([50.85, 4.5], 8);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  const points = [];        // session raw points {lat,lon,snr}
  let cells = new Map();     // id -> {count, best, poly}
  let res = liveRes(map.getZoom());
  let me = null;             // current-position marker
  let centered = false;
  let follow = true;         // pan to keep current GPS centred (zoom preserved)

  // Stop following when the user drags the map (so they can inspect the trail);
  // the 📍 button re-enables follow.
  map.on('dragstart', () => { follow = false; });
  // Use Leaflet's own control markup (leaflet-bar + <a>) so it looks exactly like
  // the zoom buttons and isn't hit by the app's global `button {}` styles.
  const FollowCtl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const c = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
      c.style.margin = '10px 0 0 10px'; // align under the zoom control (corner margin)
      const a = L.DomUtil.create('a', '', c);
      a.href = '#';
      a.title = 'Follow GPS';
      a.setAttribute('role', 'button');
      a.innerHTML = '📍';
      a.style.cssText = 'font-size:18px;line-height:30px;text-align:center';
      L.DomEvent.on(a, 'click', (e) => { L.DomEvent.stop(e); follow = true; if (me) map.panTo(me.getLatLng()); });
      return c;
    },
  });
  map.addControl(new FollowCtl());

  function styleFor(best) {
    return { color: '#000', weight: 1, opacity: 0.5, fillColor: snrColor(best), fillOpacity: 0.65 };
  }

  function upsert(lat, lon, snr) {
    const id = hexCellAt(lat, lon, res);
    let a = cells.get(id);
    if (!a) {
      const ring = hexBoundary(id);
      if (!ring) return;
      a = { count: 0, best: null, poly: L.polygon(ring, styleFor(null)).addTo(layer) };
      cells.set(id, a);
    }
    a.count++;
    if (snr != null && (a.best == null || snr > a.best)) a.best = snr;
    a.poly.setStyle(styleFor(a.best));
    a.poly.bindTooltip('n=' + a.count + (a.best != null ? ' · SNR ' + a.best : ''));
  }

  function rebuild() {
    layer.clearLayers();
    cells = new Map();
    points.forEach((p) => upsert(p.lat, p.lon, p.snr));
  }

  map.on('zoomend', () => {
    const nr = liveRes(map.getZoom());
    if (nr !== res) { res = nr; rebuild(); }
  });

  // setPos moves the "you are here" marker and (when following) keeps it centred.
  // Called continuously from GPS — independent of RX — so the position is live.
  function setPos(lat, lon) {
    if (lat == null || lon == null) return;
    if (!me) me = L.circleMarker([lat, lon], { radius: 5, color: '#fff', weight: 2, fillColor: '#3b82f6', fillOpacity: 1 }).addTo(map);
    else me.setLatLng([lat, lon]);
    if (!centered) { centered = true; map.setView([lat, lon], 15); } // initial zoom
    else if (follow) map.panTo([lat, lon]); // follow GPS, keep current zoom
  }

  return {
    setPosition(lat, lon) { setPos(lat, lon); }, // live GPS, no hex
    addPoint(lat, lon, snr) {                     // an RX: add a hex + sync position
      points.push({ lat, lon, snr });
      if (points.length > POINT_CAP) points.shift();
      upsert(lat, lon, snr);
      setPos(lat, lon);
    },
    invalidate() { setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 150); },
    destroy() { try { map.remove(); } catch (e) {} },
  };
}
