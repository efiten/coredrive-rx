import test from 'node:test';
import assert from 'node:assert/strict';
import { pingDecision, pruneCells, skipCell, MAX_FIX_ACC_M } from '../src/uplinksched.js';

const cfg = { uplinkIntervalSec: 60, uplinkMinMoveM: 250, uplinkMaxPerHour: 50, uplinkSkipDays: 7 };
const fix = { lat: 50.99, lon: 5.38, acc_m: 10 };
const base = { now: 10_000_000, fix, last: null, sentTimes: [], recentCells: {}, cfg };
const north = (m) => ({ ...fix, lat: fix.lat + m / 110540 });

test('first ping with a good fix is sent, and names its cell', () => {
  const d = pingDecision(base);
  assert.equal(d.send, true);
  assert.equal(d.cell, skipCell(fix));
});

test('no fix or a poor fix holds the ping', () => {
  assert.equal(pingDecision({ ...base, fix: null }).reason, 'no GPS fix');
  assert.equal(pingDecision({ ...base, fix: { ...fix, acc_m: MAX_FIX_ACC_M + 1 } }).send, false);
});

test('interval and distance both have to be met', () => {
  const last = { at: base.now - 30_000, lat: fix.lat, lon: fix.lon };
  assert.equal(pingDecision({ ...base, fix: north(1000), last }).reason, 'interval');
  const older = { ...last, at: base.now - 61_000 };
  assert.equal(pingDecision({ ...base, fix: north(200), last: older }).send, false);
  assert.equal(pingDecision({ ...base, fix: north(300), last: older }).send, true);
});

test('the hourly cap counts only the last hour', () => {
  const sentTimes = Array.from({ length: 50 }, (_, i) => base.now - i * 1000);
  assert.equal(pingDecision({ ...base, sentTimes }).reason, 'hourly cap 50');
  const old = sentTimes.map((t) => t - 3_600_000);
  assert.equal(pingDecision({ ...base, sentTimes: old }).send, true);
});

test('a cell pinged within the skip window is skipped; older ones are not', () => {
  const cell = skipCell(fix);
  assert.equal(pingDecision({ ...base, recentCells: { [cell]: base.now - 86_400_000 } }).reason, 'cell pinged recently');
  assert.equal(pingDecision({ ...base, recentCells: { [cell]: base.now - 8 * 86_400_000 } }).send, true);
});

test('pruneCells keeps only cells inside the window', () => {
  const now = 100 * 86_400_000;
  assert.deepEqual(pruneCells({ a: now - 86_400_000, b: now - 8 * 86_400_000 }, now, 7), { a: now - 86_400_000 });
});
