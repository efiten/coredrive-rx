// Companion battery percentage, copied from core-hunter's app/src/battery.js
// (mvToPercent, isMultiCell, isLowBattery, and their constants, comments
// included). The request path is deliberately NOT copied: src/rfstats.js
// already owns CMD_GET_STATS (56) / RESP_CODE_STATS (24) and a second
// requester would install a second listener for the same frame. This module
// only turns a battery_mv reading — however it arrived — into a line of text.

// AGENTS.md §7: firmware owns this, so these are firmware's numbers, not a
// curve of our own. The companion computes its own on-screen percentage with
// exactly this linear map:
//
//   examples/companion_radio/ui-new/UITask.cpp
//     #ifndef BATT_MIN_MILLIVOLTS
//       #define BATT_MIN_MILLIVOLTS 3000
//     #endif
//     #ifndef BATT_MAX_MILLIVOLTS
//       #define BATT_MAX_MILLIVOLTS 4200
//     #endif
//     batteryPercentage = ((mv - min) * 100) / (max - min)
//
// Using anything else means the companion's own screen and this app disagree
// about the same pack, which is worse than showing no percentage at all.
const MV_FULL = 4200
const MV_EMPTY = 3000

// Both defines are #ifndef-guarded, so a variant overrides them — and one does:
//   variants/lilygo_tbeam_1w/platformio.ini
//     -D BATT_MIN_MILLIVOLTS=6000
//     -D BATT_MAX_MILLIVOLTS=8400
// i.e. a 2S pack. We cannot read a build flag over the wire, so the endpoints
// are unknowable for such a board. Rather than clamping a 2S reading to a
// confident 100%, anything above a single cell's ceiling is reported as
// "voltage known, percentage unknown" and the caller shows volts only.
// The threshold sits above MV_FULL with headroom for a charging 1S pack
// (~4.3V) and well below a 2S pack's empty point (6000).
const MULTI_CELL_MV = 5000

// Firmware's number, not ours (#380):
//
//   examples/companion_radio/ui-orig/UITask.cpp
//     #ifndef LOW_BATT_MILLIVOLTS
//       #define LOW_BATT_MILLIVOLTS 3500
//     #endif
//     low_batt = _board->getBattMilliVolts() < LOW_BATT_MILLIVOLTS;
//
// This module exists so the companion's own screen and this app do not disagree
// about the same pack, and until now they did: the old rule warned at 20% of
// the curve below, which is 3240mV on a 1S pack — 260mV UNDER firmware's — so
// on a ui-orig board this app called a pack healthy after the companion had
// already flagged it. That is the exact failure the module was written to
// prevent, so firmware's threshold wins.
//
// Two honest caveats, neither of which changes the answer:
//
//   - ui-new has no equivalent (grep: neither LOW_BATT nor low_batt), so on a
//     companion running the newer UI there is nothing to agree WITH and 3500 is
//     our own choice, roughly 8 percentage points earlier than the old rule.
//   - the define is #ifndef-guarded, i.e. a per-board build flag we cannot read
//     over the wire (§7). 3500 is its default, not a reading.
//
// So this is firmware's default rather than a measurement, and it is not
// claimed as more than that. What it is NOT is a second invented voltage: the
// alternative was keeping a percentage of our own curve, which is further from
// what the hardware does, not closer.
//
// Strictly-less, matching the firmware line above: at exactly 3500 the
// companion does not warn, so neither do we.
const LOW_BATT_MV = 3500

// True when the reading is above what a single cell can be, i.e. a multi-cell
// pack whose real endpoints are a build flag we cannot see.
export function isMultiCell(mv) {
  return Number.isFinite(mv) && mv >= MULTI_CELL_MV
}

// null means "no percentage can honestly be given" — no reading, or a pack
// whose endpoints we do not know. Callers show the raw voltage in that case.
export function mvToPercent(mv) {
  if (!Number.isFinite(mv)) return null
  if (isMultiCell(mv)) return null
  const pct = ((mv - MV_EMPTY) / (MV_FULL - MV_EMPTY)) * 100
  return Math.max(0, Math.min(100, Math.round(pct)))
}

// Unknown percentage is not "low": a multi-cell pack at 6100mV is genuinely
// flat, but we cannot tell, and a warning that fires on a guess is the same
// failure as one that never fires. mvToPercent is what knows that — it answers
// null for a missing reading and for a pack whose endpoints we do not have —
// so the threshold below only ever sees a 1S pack on the firmware curve.
//
// It does NOT know the one sentinel: a literal 0 is firmware's "no VBAT sense",
// and mvToPercent clamps it to 0% rather than answering null. batteryLine has
// always caught that itself, but src/app.js's renderDots calls isLowBattery
// directly, so a companion with no battery sense sat behind a permanent amber
// BLE dot for the whole drive. The sentinel is handled here, where every caller
// gets it.
export function isLowBattery(mv) {
  if (!Number.isFinite(mv) || mv === 0) return false
  if (mvToPercent(mv) === null) return false
  return mv < LOW_BATT_MV
}

// batteryLine is the Status screen's one line. A percentage is only claimed
// where the pack's endpoints are known; otherwise the raw voltage is shown,
// because inventing a curve for an unknown pack reads as precision we do not
// have. A literal 0 is rfstats.js's raw reading for firmware's "no VBAT sense"
// sentinel (parseStats does not null it out the way core-hunter's
// parseStatsCore does), so batteryLine treats 0 as "not reported" itself.
export function batteryLine(mv) {
  if (!Number.isFinite(mv) || mv === 0) return { text: 'Battery — not reported', low: false }
  const pct = mvToPercent(mv)
  const volts = (mv / 1000).toFixed(2)
  return {
    text: pct === null ? `Battery ${volts} V` : `Battery ${volts} V (${pct}%)`,
    low: isLowBattery(mv),
  }
}
