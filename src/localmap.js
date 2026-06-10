// Real-time local coverage map: aggregates this session's received packets into
// hex cells (same grid as the server) and draws them on Leaflet, live. Pure
// client-side, no server round-trip — instant + works offline.
import { hexCellAt, hexBoundary, hexResForZoom } from './hexgrid.js';

function snrColor(snr) {
  if (snr == null) return '#95a5a6';
  if (snr >= 5) return '#2ecc71';
  if (snr >= -3) return '#f1c40f';
  if (snr >= -10) return '#e67e22';
  return '#e74c3c';
}

const POINT_CAP = 5000;

export function createLocalMap(containerId) {
  if (typeof L === 'undefined') return { addPoint() {}, invalidate() {}, destroy() {} };
  const map = L.map(containerId, { zoomControl: true, attributionControl: false }).setView([50.85, 4.5], 8);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  const points = [];        // session raw points {lat,lon,snr}
  let cells = new Map();     // id -> {count, best, poly}
  let res = hexResForZoom(map.getZoom());
  let me = null;             // current-position marker
  let centered = false;
  let follow = true;         // pan to keep current GPS centred (zoom preserved)

  // Stop following when the user drags the map (so they can inspect the trail);
  // the 📍 button re-enables follow.
  map.on('dragstart', () => { follow = false; });
  const FollowCtl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const b = L.DomUtil.create('button', '');
      b.innerHTML = '📍';
      b.title = 'Follow GPS';
      b.style.cssText = 'width:34px;height:34px;font-size:17px;line-height:34px;cursor:pointer;background:#fff;border:2px solid rgba(0,0,0,.2);border-radius:4px';
      L.DomEvent.on(b, 'click', (e) => { L.DomEvent.stop(e); follow = true; if (me) map.panTo(me.getLatLng()); });
      return b;
    },
  });
  map.addControl(new FollowCtl());

  function styleFor(best) {
    return { color: '#000', weight: 0.5, opacity: 0.25, fillColor: snrColor(best), fillOpacity: 0.5 };
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
    const nr = hexResForZoom(map.getZoom());
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
