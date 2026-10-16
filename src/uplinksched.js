// When to send an uplink ping. Every ping is a flood the whole region carries, so the
// rules below exist to keep airtime down: a minimum interval and distance between
// pings, an hourly cap, and "smart skip" of hex cells pinged in the last N days.
// Pure functions of their inputs; app.js owns the state.
import { hexCellAt } from './hexgrid.js';

// Cells of ~180 m (the coverage map's res-9 hexes), so one skip covers about the
// distance between two pings at the default 250 m.
export const SKIP_CELL_RES = 9;
// A position worse than this cannot place a ping in the right cell.
export const MAX_FIX_ACC_M = 100;
const HOUR_MS = 3600 * 1000;

function distanceM(a, b) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad, dLon = (b.lon - a.lon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function skipCell(fix) {
  return hexCellAt(fix.lat, fix.lon, SKIP_CELL_RES);
}

// pingDecision returns { send: true, cell } or { send: false, reason }.
//   last        { at, lat, lon } of the previous ping, or null
//   sentTimes   ms timestamps of pings sent, any age (pruned here by the caller's use)
//   recentCells { cellId: ms } of cells pinged, any age
//   cfg         uplinkIntervalSec, uplinkMinMoveM, uplinkMaxPerHour, uplinkSkipDays
export function pingDecision({ now, fix, last, sentTimes, recentCells, cfg }) {
  if (!fix) return { send: false, reason: 'no GPS fix' };
  if (fix.acc_m != null && fix.acc_m > MAX_FIX_ACC_M) return { send: false, reason: 'GPS accuracy ' + Math.round(fix.acc_m) + ' m' };
  if (last) {
    if (now - last.at < cfg.uplinkIntervalSec * 1000) return { send: false, reason: 'interval' };
    if (distanceM(last, fix) < cfg.uplinkMinMoveM) return { send: false, reason: 'not moved ' + cfg.uplinkMinMoveM + ' m' };
  }
  const lastHour = sentTimes.filter((t) => now - t < HOUR_MS).length;
  if (lastHour >= cfg.uplinkMaxPerHour) return { send: false, reason: 'hourly cap ' + cfg.uplinkMaxPerHour };
  const cell = skipCell(fix);
  const seen = recentCells[cell];
  if (seen != null && now - seen < cfg.uplinkSkipDays * 24 * HOUR_MS) return { send: false, reason: 'cell pinged recently' };
  return { send: true, cell };
}

// pruneCells drops cells older than the skip window, so the stored map stays bounded.
export function pruneCells(recentCells, now, skipDays) {
  const out = {};
  const max = skipDays * 24 * HOUR_MS;
  for (const [cell, at] of Object.entries(recentCells || {})) if (now - at < max) out[cell] = at;
  return out;
}
