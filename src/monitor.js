// Pure monitoring/state helpers for the Home monitor + auto-discover.
// No DOM, no timers, no network — caller passes `now` (ms epoch). Unit-testable.

// --- Auto-discover scheduling -------------------------------------------------
// Discover runs automatically while connected. It backs off whenever organic mesh
// traffic is arriving (we already see those packets, so polling is wasteful and adds
// airtime), and only sweeps after a quiet gap. Standstill pauses it entirely.
export const DISCOVER_INTERVAL_MS = 30000; // base cadence when the channel is quiet
export const DISCOVER_BACKOFF_MS = 15000;  // silence required after organic traffic

// discoverDecision decides, on each tick, whether to fire a discover sweep now and
// what status to surface. `lastHeardAt` = ms of the last ORGANIC reception (an
// overheard forwarder/advert — NOT our own discover response); null if none yet.
// `lastFireAt` = ms of the last sweep (0 = never). Returns:
//   { fire, state: 'paused'|'backoff'|'active', secs }
// where `secs` is the backoff seconds remaining (backoff) or seconds until the next
// sweep (active). On fire the caller sets lastFireAt = now.
export function discoverDecision(now, lastHeardAt, lastFireAt, paused, opts = {}) {
  const interval = opts.intervalMs ?? DISCOVER_INTERVAL_MS;
  const backoff = opts.backoffMs ?? DISCOVER_BACKOFF_MS;
  if (paused) return { fire: false, state: 'paused', secs: 0 };
  if (lastHeardAt != null && now - lastHeardAt < backoff) {
    return { fire: false, state: 'backoff', secs: Math.ceil((backoff - (now - lastHeardAt)) / 1000) };
  }
  const dueIn = interval - (now - lastFireAt);
  if (lastFireAt === 0 || dueIn <= 0) return { fire: true, state: 'active', secs: 0 };
  return { fire: false, state: 'active', secs: Math.ceil(dueIn / 1000) };
}

// isOrganicHeard reports whether an attributed reception (deriveHeardKey result)
// counts as organic mesh traffic for the backoff: anything we heard that is NOT a
// reply to our own discover poll (those are 8-byte 'discover' prefixes). A 2-byte
// path-hash forwarder ('rxlog') or a 0-hop advert means we're in an active area.
export function isOrganicHeard(hk) {
  return !!hk && hk.src !== 'discover';
}

// --- SNR volume meter ---------------------------------------------------------
// Maps an SNR (dB) to a 0..100 bar fill over a fixed display range, with a
// peak-hold marker that decays back toward the live bar.
export const SNR_MIN_DB = -20;
export const SNR_MAX_DB = 10;
export const PEAK_DECAY_PCT_PER_S = 25; // how fast the peak marker sinks back

export function snrToPct(snr) {
  if (snr == null) return 0;
  const f = (snr - SNR_MIN_DB) / (SNR_MAX_DB - SNR_MIN_DB);
  return Math.max(0, Math.min(1, f)) * 100;
}

// decayPeak moves the peak marker toward `targetPct` by PEAK_DECAY_PCT_PER_S, never
// below the target (the live bar pushes it up, decay only lowers a stale peak).
export function decayPeak(peakPct, targetPct, dtMs, opts = {}) {
  const rate = opts.ratePctPerS ?? PEAK_DECAY_PCT_PER_S;
  const decayed = peakPct - rate * (dtMs / 1000);
  return Math.max(targetPct, decayed);
}

// --- Capture rate (rolling window) -------------------------------------------
// pruneTimestamps drops entries older than windowMs. With the default 60 s window the
// surviving length is the packets-per-minute rate.
export function pruneTimestamps(times, now, windowMs = 60000) {
  const cutoff = now - windowMs;
  return times.filter((t) => t >= cutoff);
}
