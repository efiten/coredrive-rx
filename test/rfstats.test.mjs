import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStatsRequest, parseStats, mergeSample, nextSampleDelay, resumeDelay, MOVING_MS, PARKED_MS,
  CMD_GET_STATS, STATS_CORE, STATS_RADIO, STATS_PACKETS,
} from '../src/rfstats.js';

const u8 = (...b) => new Uint8Array(b);
// little-endian helpers for building golden frames
const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];

test('buildStatsRequest is [56, subType]', () => {
  assert.deepEqual(Array.from(buildStatsRequest(STATS_RADIO)), [CMD_GET_STATS, 1]);
});

test('parseStats CORE (11 bytes)', () => {
  // [24][0][battery_mv u16][uptime u32][errors u16][queue_len u8]
  const f = u8(24, 0, ...le16(4021), ...le32(84213), ...le16(0), 3);
  const s = parseStats(f);
  assert.equal(s.subType, STATS_CORE);
  assert.equal(s.battery_mv, 4021);
  assert.equal(s.uptime_secs, 84213);
  assert.equal(s.errors, 0);
  assert.equal(s.queue_len, 3);
});

test('parseStats RADIO (14 bytes) handles signed values and SNR scaling', () => {
  // [24][1][noise_floor i16][last_rssi i8][last_snr i8][tx_air u32][rx_air u32]
  const f = u8(24, 1, ...le16(0x10000 - 119), 0x100 - 104, 0x100 - 29, ...le32(341), ...le32(20877));
  const s = parseStats(f);
  assert.equal(s.subType, STATS_RADIO);
  assert.equal(s.noise_floor, -119);
  assert.equal(s.last_rssi, -104);
  assert.equal(s.last_snr, -7.25);   // -29 / 4
  assert.equal(s.tx_air_secs, 341);
  assert.equal(s.rx_air_secs, 20877);
});

test('parseStats PACKETS: 26 bytes omits recv_errors, 30 bytes includes it', () => {
  const body = [...le32(18422), ...le32(290), ...le32(212), ...le32(78), ...le32(17110), ...le32(1312)];
  const legacy = parseStats(u8(24, 2, ...body));
  assert.equal(legacy.recv, 18422);
  assert.equal(legacy.direct_rx, 1312);
  assert.equal('recv_errors' in legacy, false, 'must be absent, not 0');

  const modern = parseStats(u8(24, 2, ...body, ...le32(4471)));
  assert.equal(modern.recv_errors, 4471);
});

test('parseStats rejects wrong code and short frames', () => {
  assert.equal(parseStats(u8(0x88, 1, 2, 3)), null);
  assert.equal(parseStats(u8(24, 1, 0, 0)), null);       // RADIO needs 14
  assert.equal(parseStats(u8(24, 2, 0, 0, 0, 0)), null); // PACKETS needs >= 26
  assert.equal(parseStats(u8()), null);
});

test('mergeSample requires all three parts', () => {
  const core = { subType: STATS_CORE, uptime_secs: 1, battery_mv: 4000, errors: 0, queue_len: 0 };
  const radio = { subType: STATS_RADIO, noise_floor: -119, last_rssi: -100, last_snr: 1, tx_air_secs: 1, rx_air_secs: 2 };
  const packets = { subType: STATS_PACKETS, recv: 1, sent: 1, flood_tx: 1, direct_tx: 0, flood_rx: 1, direct_rx: 0 };
  const fix = { lat: 51.2, lon: 4.4, acc_m: 8 };

  assert.equal(mergeSample(core, radio, null, fix, '2026-08-17T10:00:00.000Z', false), null);
  assert.equal(mergeSample(core, radio, packets, null, '2026-08-17T10:00:00.000Z', false), null);

  const s = mergeSample(core, radio, packets, fix, '2026-08-17T10:00:00.000Z', true);
  assert.equal(s.kind, 'rf');
  assert.equal(s.stationary, true);
  assert.equal(s.noise_floor, -119);
  assert.equal(s.lat, 51.2);
  assert.equal('recv_errors' in s, false, 'absent upstream stays absent downstream');
});

test('cadence is 15s moving, 5min parked', () => {
  assert.equal(MOVING_MS, 15000);
  assert.equal(PARKED_MS, 300000);
  assert.equal(nextSampleDelay(false), MOVING_MS);
  assert.equal(nextSampleDelay(true), PARKED_MS);
});

test('moving again re-arms a parked-cadence sample to the moving cadence', () => {
  const now = 1_000_000;
  assert.equal(resumeDelay(now + PARKED_MS - 20000, now), MOVING_MS); // seen: 4 min 19 s left
  assert.equal(resumeDelay(now + MOVING_MS, now), null); // due soon anyway: leave it
  assert.equal(resumeDelay(now + 3000, now), null);
  assert.equal(resumeDelay(null, now), null); // none armed, or one running
});
