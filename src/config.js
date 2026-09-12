// Runtime deployment config, fetched from config.json (served next to
// index.html) at startup. Nothing is baked into the bundle — sysops edit
// config.json, not source. See config.example.json for the shape.
// Feature-flag defaults, in two tables because the safe answer depends on WHERE
// the silence comes from.
//
// FEATURE_DEFAULTS applies to an absent key in a config.json that EXISTS. Two field
// failures made the case for reading silence as "on": a config cached before these
// keys existed reported the features off while the served file said on, and that is
// indistinguishable from the features being broken. An explicit `false` still wins.
export const FEATURE_DEFAULTS = { fullRfLog: true, rfSampler: true, regionDiscovery: true, verifyAdverts: false };

// NO_CONFIG_DEFAULTS applies when NO config loaded at all. The two logging features
// stay on: data never collected is gone for good, while data collected and discarded
// server-side costs only bandwidth, and the queue publishes once config arrives.
//
// regionDiscovery is the one flag that differs, and only here, because it is the only
// feature that TRANSMITS. An existing config.json is a deployment whose operator owns
// the repeaters being asked; no config means the app knows nothing about whose mesh it
// is on. Repeaters rate-limit anonymous requests to 4 per 180s SHARED across every
// requester and type, so one client asking once a minute already claims most of that
// budget. Collecting on an assumption spends our own bandwidth; transmitting on one
// spends a stranger's airtime.
export const NO_CONFIG_DEFAULTS = { fullRfLog: true, rfSampler: true, regionDiscovery: false, verifyAdverts: false };

// verifyAdverts is the one flag listed as false in BOTH maps, and deliberately so: it is
// the only flag that makes the app record LESS than it heard. An advert whose Ed25519
// signature does not check out loses its identity, so turning it on silently would look
// like adverts going missing. A deployment opts into that; it should not inherit it.

// featureEnabled resolves one flag from whatever is known, INCLUDING the case every
// gate in app.js used to get wrong: `config === null`. Those gates read
// `!cfg || !cfg.X`, treating "we do not know yet" as "off" — the reading that cost a
// whole session's RF data on top of its uploads.
export function featureEnabled(config, name) {
  if (!config) return NO_CONFIG_DEFAULTS[name] === true;
  if (config[name] === undefined) return FEATURE_DEFAULTS[name] === true;
  return !!config[name];
}

let cfg = null;
let inFlight = null; // in-flight loadConfig promise, so concurrent retries share one fetch

// normalizeConfig validates + normalizes a parsed config.json object. Throws on
// a missing required field (mqttUrl). resolveUrl is optional (empty = node-name
// resolution disabled).
// positiveSeconds reads a tuning value that must be a real number of seconds. A
// missing key takes the default; anything unusable (a string, a negative, NaN) also
// takes it rather than disabling the throttle it configures — a typo in config.json
// must never turn into "no limit at all" on a transmitting path.
function positiveSeconds(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config.json: expected a JSON object');
  const c = {
    mqttUrl: String(raw.mqttUrl || '').trim(),
    mqttUsername: String(raw.mqttUsername || '').trim(),
    mqttPassword: raw.mqttPassword == null ? '' : String(raw.mqttPassword),
    resolveUrl: String(raw.resolveUrl || '').trim(),
    // Absent → FEATURE_DEFAULTS; present → coerced. See FEATURE_DEFAULTS above for
    // why the two logging flags and the transmitting one differ.
    fullRfLog: featureEnabled(raw, 'fullRfLog'),
    rfSampler: featureEnabled(raw, 'rfSampler'),
    regionDiscovery: featureEnabled(raw, 'regionDiscovery'),
    // Two separate throttles for the beta experiment (src/regionsprint.js), both
    // seconds, both tunable on the server without a rebuild — that is the point of a
    // measurement rig. They answer different questions and must not be conflated:
    //
    //   betaAskGapSec      minimum gap between ANY two transmitted asks. Keeps two
    //                      rounds from overlapping and bounds total airtime.
    //   betaTargetGapSec   minimum gap between two asks to the SAME repeater. A node
    //                      held in range is heard many times a minute; this is what
    //                      decides how often each reception is allowed to become an
    //                      ask, and simple_repeater drops anon requests past 4 per
    //                      180s, so asking one node faster than that cannot help.
    //
    // Ignored entirely by a production build, where neither throttle exists.
    betaAskGapSec: positiveSeconds(raw.betaAskGapSec, 2),
    betaTargetGapSec: positiveSeconds(raw.betaTargetGapSec, 15),
    // And the two that END the asking. Without them the only exit is a reply, so a
    // repeater held in range that never answers is asked every betaTargetGapSec for
    // the rest of the session.
    //
    //   betaMaxAsks     unanswered asks one repeater gets per encounter
    //   betaForgetMin   silence after which the next reception is a NEW encounter and
    //                   the count starts over
    betaMaxAsks: positiveSeconds(raw.betaMaxAsks, 6),
    betaForgetMin: positiveSeconds(raw.betaForgetMin, 5),
  };
  if (!c.mqttUrl) throw new Error('config.json: "mqttUrl" is required');
  return c;
}

// loadConfig fetches + normalizes config.json and caches it on SUCCESS ONLY, so a
// failed load can be retried. It is safe to call repeatedly and concurrently: the
// app retries it at startup, on every connect attempt, on the `online` event and
// from the monitor tick, because a single transient failure at startup used to
// leave the whole session without config — nothing published, and fullRfLog,
// rfSampler and regionDiscovery all silently off. Throws on a missing/unreadable
// file, an HTML body, or invalid JSON.
export function loadConfig(url = 'config.json') {
  if (cfg) return Promise.resolve(cfg);
  // Dedupe concurrent callers into one request. `finally` clears the slot whether
  // the attempt succeeded or failed, so a rejected attempt never poisons the next
  // retry (which is the entire point of retrying).
  if (!inFlight) inFlight = fetchConfig(url).finally(() => { inFlight = null; });
  return inFlight;
}

async function fetchConfig(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('config.json not found (HTTP ' + r.status + ')');
  const text = await r.text();
  // A 200 carrying HTML means something served the app shell instead of the config:
  // a web server with an SPA fallback (`try_files $uri /index.html`), or a service
  // worker answering a failed request with index.html. Read as JSON that produced
  // "Unexpected token '<'", which reads like a corrupt config file and sent a field
  // diagnosis down the wrong path entirely. Name it.
  if (text.trimStart().startsWith('<')) {
    throw new Error('config.json: got an HTML page instead of JSON — the web server or service worker served the app shell instead of the config (usually means the device is offline)');
  }
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new Error('config.json: invalid JSON — ' + e.message); }
  cfg = normalizeConfig(raw);
  return cfg;
}

export function getConfig() { return cfg; }
export function setConfig(c) { cfg = c; inFlight = null; } // test seam
