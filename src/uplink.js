// Pure decisions about the uplink chain (config → publisher → broker → queue),
// plus the diagnostic header stamped onto an exported debug log. No DOM, no
// network — unit-testable.
//
// This module exists because of two field failures that were far harder to
// diagnose than they should have been:
//
//  1. A session captured for an hour and published nothing. `config.json` failed
//     to load once at startup, so no Publisher was ever constructed — yet the
//     progress list said "✅ All connected — capturing" and the Push button
//     answered "nothing pending / not connected". Every symptom pointed away
//     from the cause, and the one message that named it was written to a status
//     line that the next connect attempt overwrote.
//
//  2. A session published fine but never ran region discovery or the RF sampler.
//     It was running on a `config.json` cached before those flags existed;
//     normalizeConfig turns an absent flag into `false`, so both features were
//     off while the served config said on. Nothing anywhere reported it.
//
// The lesson driving the shapes below: a degraded uplink must be a NAMED state
// that the UI shows continuously and the exported log records, never an absence
// of log lines.

import { featureEnabled } from './config.js';

// Region discovery needs FIRMWARE_VER_CODE >= 13 to address a repeater that is
// not already a saved contact (CMD_SEND_ANON_REQ, companion_radio/MyMesh.cpp).
export const REGION_DISCOVERY_MIN_FW = 13;

// Feature defaults live in config.js (FEATURE_DEFAULTS); the header reports the ones
// actually in force so a no-config session still says what it is collecting.

// uplinkState collapses the chain into one name. Order matters: a missing config
// is reported ahead of everything downstream because it is the upstream cause and
// the only link in the chain the app can repair by itself (by re-fetching).
//   { hasConfig, hasPublisher, brokerState } → 'no-config'|'no-publisher'|'down'|'ok'
export function uplinkState({ hasConfig, hasPublisher, brokerState }) {
  if (!hasConfig) return 'no-config';
  if (!hasPublisher) return 'no-publisher';
  return brokerState === 'connect' ? 'ok' : 'down';
}

// uplinkWarning returns the persistent banner text for an unhealthy uplink, or
// null when it is healthy. Every variant states two things the user needs: that
// uploading has stopped, and that nothing is being thrown away — a driver who
// thinks the data is lost stops driving.
//
// `connected` is whether the companion session is up. Before the user has connected
// anything, "no broker connection" and "link down" are the NORMAL resting state and
// warning about them would cry wolf on every cold open. A missing config still warns
// then, because it is actionable immediately and blocks the session that follows.
export function uplinkWarning(state, connected = true) {
  if (state === 'ok') return null;
  if (!connected && state !== 'no-config') return null;
  // The no-config text names the internet requirement explicitly: config.json is
  // deliberately never served from the offline cache (a stale copy silently
  // disables feature flags), so the app needs a working connection ONCE to fetch
  // its settings. Capture and buffering do not need it — only uploading does.
  const why = state === 'no-config' ? 'config.json could not be loaded; the app needs internet once to fetch its settings (retrying automatically)'
    : state === 'no-publisher' ? 'no broker connection was set up (retrying)'
    : 'the CoreScope link is down (reconnecting)';
  return '⚠️ Receptions are kept, but NOT being uploaded — ' + why;
}

// pushOutcome decides what the "Push pending now" button reports and what it
// should do about it. Queue depth is reported INDEPENDENTLY of link health: the
// old single message could not distinguish a healthy empty queue from a dead
// uplink sitting on hundreds of buffered records, and its recovery branch was
// skipped in exactly the case that needed it (no publisher at all).
//   { uplink, pending, published } → { message, level, reconnect, reloadConfig }
export function pushOutcome({ uplink, pending, published }) {
  const recs = (n) => n + ' record(s)';
  if (uplink === 'no-config') {
    return { message: 'config.json was never loaded — ' + recs(pending) + ' buffered; needs internet to fetch settings, retrying…', level: 'no', reconnect: false, reloadConfig: true };
  }
  if (uplink === 'no-publisher') {
    return { message: 'no broker connection was set up — ' + recs(pending) + ' buffered; connecting…', level: 'no', reconnect: true, reloadConfig: false };
  }
  if (uplink === 'down') {
    return { message: 'CoreScope not connected — ' + recs(pending) + ' buffered; forcing reconnect…', level: 'no', reconnect: true, reloadConfig: false };
  }
  if (published > 0) {
    return { message: 'pushed ' + recs(published), level: 'ok', reconnect: false, reloadConfig: false };
  }
  if (pending > 0) {
    // Connected, asked to push, published nothing, yet records are queued. This
    // was previously indistinguishable from an empty queue.
    return { message: recs(pending) + ' buffered but none published — the broker accepted nothing', level: 'no', reconnect: false, reloadConfig: false };
  }
  return { message: 'nothing to push — the queue is empty', level: 'st', reconnect: false, reloadConfig: false };
}

// regionInertReason names why region discovery — the only transmitting feature —
// cannot fire, or null when it can. Each gate that silently returned early now
// has a sentence, because "no regions lines in the log" was the only symptom and
// it is consistent with four different causes.
export function regionInertReason({ config, supported, fwVer }) {
  if (!config) return 'config.json is not loaded (needs internet once to fetch it)';
  if (!config.regionDiscovery) return 'regionDiscovery is off in config.json';
  if (supported) return null;
  if (fwVer == null) return "the companion's firmware version could not be read, so region discovery stays off";
  return 'companion firmware v' + fwVer + ' is older than the v' + REGION_DISCOVERY_MIN_FW + ' region discovery needs';
}

// buildLogHeader returns the preamble prepended to an exported debug log. Built at
// share time, never logged as a line, so it can NEVER roll out of the ring buffer
// the way a startup line does — which is precisely what made two field logs
// unattributable to a version.
//
// Reads only the four feature flags by name and never iterates the config, so the
// broker password cannot reach an exported file no matter what is passed in.
export function buildLogHeader(info) {
  const {
    version, nowISO, config, fwVer, regionsSupported,
    companionName, companionPubkey, uplink, pending, lineCount, lineCap, pathResolve, beta,
  } = info;
  const row = (k, v) => k.padEnd(10) + ' ' + v;
  const onOff = (b) => (b ? 'on' : 'off');

  const lines = [
    '=== CoreDrive RX debug log ===',
    row('app', 'v' + version),
    row('generated', nowISO),
  ];

  // verifyAdverts goes through featureEnabled rather than being read off the config
  // directly, so the header reports what the capture gate in app.js actually did. The
  // three above predate that helper and keep their raw reads.
  lines.push(config
    ? row('config', 'loaded — fullRfLog=' + onOff(config.fullRfLog) + ' rfSampler=' + onOff(config.rfSampler) + ' regionDiscovery=' + onOff(config.regionDiscovery)
        + ' verifyAdverts=' + onOff(featureEnabled(config, 'verifyAdverts')))
    : row('config', 'NOT LOADED — nothing can be published; collecting on defaults '
        + 'fullRfLog=' + onOff(featureEnabled(null, 'fullRfLog'))
        + ' rfSampler=' + onOff(featureEnabled(null, 'rfSampler'))
        + ' regionDiscovery=' + onOff(featureEnabled(null, 'regionDiscovery'))
        + ' verifyAdverts=' + onOff(featureEnabled(null, 'verifyAdverts'))));

  lines.push(row('firmware', fwVer == null ? 'unknown (device info not read)' : 'v' + fwVer));

  const inert = regionInertReason({ config, supported: regionsSupported, fwVer });
  lines.push(row('regions', inert ? 'inert — ' + inert : 'active'));

  // A forwarder is heard as a 2-4 byte path-hash prefix and has to be resolved to a
  // full pubkey before it can be asked anything. Whether that resolve usually lands
  // is what decides if the path-hash candidate source pays for itself, and a
  // per-prefix log line cannot answer it — the ring buffer rolls those out long
  // before a drive ends. Omitted entirely when nothing was tried, because "0 of 0"
  // reads as a failure rather than as an absence.
  if (pathResolve && pathResolve.attempted > 0) {
    const unresolved = pathResolve.attempted - pathResolve.resolved;
    lines.push(row('path keys', pathResolve.resolved + ' of ' + pathResolve.attempted
      + ' path-hash prefixes resolved to a pubkey'
      + (unresolved > 0 ? ' (' + unresolved + ' ambiguous or unknown)' : '')));
  }

  // The unthrottled experiment lives or dies on these ratios, and its per-ask lines are
  // the first thing the ring buffer rolls out: it transmits far more than the
  // production scheduler ever did. Two separate denominators on purpose — how many
  // repeaters answered at all, and how many asks that took.
  if (beta) {
    lines.push(row('beta', beta.answered + ' of ' + beta.queued + ' repeaters answered, '
      + beta.asks + ' asks sent (' + beta.replies + ' answered)'));
    lines.push(row('beta q', beta.queue + ' queued, ' + beta.outstanding + ' awaiting a reply, '
      + beta.dropped + ' timed out, ' + beta.unmatched + ' unmatched replies, ' + beta.flooded + ' sent as FLOOD'));
  }

  if (companionPubkey) {
    lines.push(row('companion', (companionName ? companionName + ' · ' : '') + companionPubkey.slice(0, 20) + '…'));
  }
  lines.push(row('uplink', uplink + ' — ' + pending + ' pending'));

  // A full buffer means the session started earlier than the oldest line shown, so
  // the absence of a startup line proves nothing about what happened at startup.
  const cap = lineCap ?? 200;
  lines.push(row('log lines', lineCount + (lineCount >= cap ? ' (buffer full — older lines have rolled out)' : '')));

  lines.push('==============================', '');
  return lines.join('\n');
}
