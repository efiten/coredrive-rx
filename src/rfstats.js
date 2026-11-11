// Companion radio statistics (CMD_GET_STATS = 56 / RESP_CODE_STATS = 24, v8+).
// Frame layouts are fixed by meshcore-firmware/docs/stats_binary_frames.md —
// all multi-byte integers little-endian. These are LOCAL BLE queries: reading
// them puts nothing on the air.

export const CMD_GET_STATS = 56;
export const RESP_CODE_STATS = 24;

export const STATS_CORE = 0;
export const STATS_RADIO = 1;
export const STATS_PACKETS = 2;

// buildStatsRequest returns the 2-byte command frame for one sub-type.
export function buildStatsRequest(subType) {
  return new Uint8Array([CMD_GET_STATS, subType]);
}

function dv(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// parseStats decodes one RESP_CODE_STATS frame, or returns null when the frame
// is not a stats response or is shorter than its sub-type requires.
export function parseStats(bytes) {
  if (!bytes || bytes.length < 2 || bytes[0] !== RESP_CODE_STATS) return null;
  const v = dv(bytes);
  const subType = bytes[1];

  if (subType === STATS_CORE) {
    if (bytes.length < 11) return null;
    return {
      subType,
      battery_mv: v.getUint16(2, true),
      uptime_secs: v.getUint32(4, true),
      errors: v.getUint16(8, true),
      queue_len: v.getUint8(10),
    };
  }

  if (subType === STATS_RADIO) {
    if (bytes.length < 14) return null;
    return {
      subType,
      noise_floor: v.getInt16(2, true),
      last_rssi: v.getInt8(4),
      last_snr: v.getInt8(5) / 4.0,
      tx_air_secs: v.getUint32(6, true),
      rx_air_secs: v.getUint32(10, true),
    };
  }

  if (subType === STATS_PACKETS) {
    if (bytes.length < 26) return null;
    const out = {
      subType,
      recv: v.getUint32(2, true),
      sent: v.getUint32(6, true),
      flood_tx: v.getUint32(10, true),
      direct_tx: v.getUint32(14, true),
      flood_rx: v.getUint32(18, true),
      direct_rx: v.getUint32(22, true),
    };
    // recv_errors exists ONLY in the 30-byte frame. Absent must stay absent —
    // reporting 0 would look like a clean channel on firmware that cannot count.
    if (bytes.length >= 30) out.recv_errors = v.getUint32(26, true);
    return out;
  }

  return null;
}

// mergeSample flattens the three responses plus the GPS fix into one queued
// record. Whole-sample-or-nothing: a partial tick would skew the delta chain it
// lands in, so any missing part discards the tick.
export function mergeSample(core, radio, packets, fix, atISO, stationary) {
  if (!core || !radio || !packets || !fix) return null;
  const s = {
    kind: 'rf',
    at: atISO,
    lat: fix.lat,
    lon: fix.lon,
    acc_m: fix.acc_m,
    stationary: !!stationary,
    uptime_secs: core.uptime_secs,
    battery_mv: core.battery_mv,
    errors: core.errors,
    queue_len: core.queue_len,
    noise_floor: radio.noise_floor,
    last_rssi: radio.last_rssi,
    last_snr: radio.last_snr,
    tx_air_secs: radio.tx_air_secs,
    rx_air_secs: radio.rx_air_secs,
    recv: packets.recv,
    sent: packets.sent,
    flood_tx: packets.flood_tx,
    direct_tx: packets.direct_tx,
    flood_rx: packets.flood_rx,
    direct_rx: packets.direct_rx,
  };
  if ('recv_errors' in packets) s.recv_errors = packets.recv_errors;
  return s;
}

// Cadence. A stationary RF sample is NOT redundant the way a stationary
// reception is — the noise floor at one spot genuinely changes over the day —
// so the sampler slows down instead of stopping. The `stationary` flag on each
// sample keeps a long park from swamping its hex cell's median.
export const MOVING_MS = 15000;
export const PARKED_MS = 300000;

export function nextSampleDelay(paused) {
  return paused ? PARKED_MS : MOVING_MS;
}

// resumeDelay: on moving again, a sample still armed on the parked cadence would leave the
// first minutes of the drive unsampled (seen: 4 min 19 s). Returns the moving delay to
// re-arm with, or null when the armed sample is due sooner anyway or none is armed.
export function resumeDelay(dueAt, now) {
  if (dueAt == null || dueAt - now <= MOVING_MS) return null;
  return MOVING_MS;
}
