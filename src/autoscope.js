// Automatic flood scope for uplink pings: which region to send the next ping in,
// chosen from what the repeaters around the companion actually forward.
//
// A repeater forwards a TRANSPORT_FLOOD only for a region it has flood-allowed, and
// an unscoped FLOOD only when '*' is flood-allowed; the regions it declares
// (ANON_REQ_TYPE_REGIONS) are exactly those, since exportNamesTo is called with
// REGION_DENY_FLOOD inverted (simple_repeater/MyMesh.cpp:160, RegionMap.cpp:318-324).
// So a fixed scope fails wherever the repeaters in range do not declare it: a 'be'
// ping just over the border in NL reaches only the few repeaters that also list 'be'.
//
// Sources of declared regions, newest wins per repeater:
//   - CoreScope GET /api/nodes/declared-regions, every companion's answers together
//   - this session's own region-discovery answers (state.regions.answers in app.js)
//
// No DOM, no transport: app.js does the wiring.

export const HEARD_WINDOW_MS = 5 * 60000; // "around the companion" = heard directly in the last 5 minutes

// Firmware gates (companion_radio/MyMesh.cpp): CMD_GET_DEFAULT_FLOOD_SCOPE landed with
// FIRMWARE_VER_CODE 10 (efdd2b6a), the explicit un-scoped variant of
// CMD_SET_FLOOD_SCOPE_KEY with 12 (69793263).
export const DEFAULT_SCOPE_MIN_FW = 10;
export const UNSCOPED_MIN_FW = 12;

const CMD_SET_FLOOD_SCOPE = 54;
const CMD_GET_DEFAULT_FLOOD_SCOPE = 64;
export const RESP_CODE_DEFAULT_FLOOD_SCOPE = 28;

export function normRegion(r) {
  return String(r || '').trim().toLowerCase().replace(/^#/, '');
}

// parseScopeList reads config.uplinkScope: one region or a comma-separated
// preference list ("de,nl,be"). Order breaks ties.
export function parseScopeList(v) {
  const out = [];
  for (const s of String(v || '').split(',')) {
    const n = normRegion(s);
    if (n && n !== '*' && !out.includes(n)) out.push(n);
  }
  return out;
}

// buildUnscopedFrame makes the next flood go out un-scoped, whatever the companion's
// default scope (MyMesh.cpp:1937-1939, v12+). buildScopeFrame(null) resets it again.
export function buildUnscopedFrame() {
  return new Uint8Array([CMD_SET_FLOOD_SCOPE, 1]);
}

export function buildGetDefaultScope() {
  return new Uint8Array([CMD_GET_DEFAULT_FLOOD_SCOPE]);
}

// parseDefaultScope reads [28][name 31][key 16], or [28] alone for "no default"
// (MyMesh.cpp:1957-1965). Returns the region name without '#', '' for none, or null
// when the frame is not that reply.
export function parseDefaultScope(frame) {
  if (!frame || frame[0] !== RESP_CODE_DEFAULT_FLOOD_SCOPE) return null;
  if (frame.length < 2) return '';
  const raw = frame.slice(1, 32);
  const end = raw.indexOf(0);
  return normRegion(new TextDecoder().decode(end >= 0 ? raw.slice(0, end) : raw));
}

// mergeRegionTable builds pubkey -> { regions: Set, wildcard, at } from the server
// list and this session's answers. A session answer is newer than anything the
// server has from before the session, so it replaces the server's entry.
export function mergeRegionTable(serverNodes, sessionAnswers) {
  const t = new Map();
  for (const n of serverNodes || []) {
    if (!n || typeof n.pubkey !== 'string') continue;
    t.set(n.pubkey.toLowerCase(), {
      regions: new Set((n.regions || []).map(normRegion)),
      wildcard: !!n.wildcard,
      at: 0,
    });
  }
  for (const a of sessionAnswers || []) {
    if (!a || typeof a.target !== 'string') continue;
    const regions = (a.regions || []).map(normRegion);
    t.set(a.target.toLowerCase(), {
      regions: new Set(regions.filter((r) => r && r !== '*')),
      wildcard: regions.includes('*'),
      at: a.at || 0,
    });
  }
  return t;
}

// matchHeard maps heard keys (2+ byte prefixes or full pubkeys, hex) to table
// entries. A prefix that fits more than one repeater in the table is skipped: it
// could be either, and guessing would count the wrong repeater's regions.
export function matchHeard(heardKeys, table) {
  const out = new Map();
  for (const k of heardKeys) {
    const key = String(k || '').toLowerCase();
    if (key.length < 4) continue;
    let hit = null;
    let n = 0;
    for (const [pk, e] of table) {
      if (pk.startsWith(key)) { hit = [pk, e]; if (++n > 1) break; }
    }
    if (n === 1) out.set(hit[0], hit[1]);
  }
  return out;
}

// chooseScope picks the scope of the next ping.
//
//   prefs            parseScopeList(config.uplinkScope)
//   companionDefault the companion's own default scope ('' none, null unknown)
//   heardKeys        repeaters heard directly within HEARD_WINDOW_MS
//   table            mergeRegionTable(...)
//
// Candidates are the companion's default first, then prefs in order. The candidate
// the most heard repeaters forward wins; order breaks ties, so the user's own default
// wins a draw. Counting, not "first that fits": just over the border one Belgian
// repeater that also lists 'nl' must not outvote the Dutch ones around it.
// No candidate forwarded but '*' is: un-scoped. Nothing known: the companion's
// default, which is what a reset override sends anyway.
//
// Returns { mode: 'scope'|'unscoped'|'default', scope, reason }.
export function chooseScope({ prefs, companionDefault, heardKeys, table }) {
  const matched = matchHeard(heardKeys, table);
  const fallback = (reason) => ({ mode: 'default', scope: companionDefault || '', reason });
  if (!matched.size) return fallback('no declared regions for the repeaters heard');
  const cands = [];
  if (companionDefault) cands.push(companionDefault);
  for (const p of prefs) if (!cands.includes(p)) cands.push(p);
  let best = null;
  let bestN = 0;
  const counts = [];
  for (const c of cands) {
    let n = 0;
    for (const e of matched.values()) if (e.regions.has(c)) n++;
    counts.push(c + ' ' + n);
    if (n > bestN) { best = c; bestN = n; }
  }
  const of = ' of ' + matched.size + ' repeaters (' + counts.join(', ') + ')';
  if (best) return { mode: 'scope', scope: best, reason: bestN + of };
  let wild = 0;
  for (const e of matched.values()) if (e.wildcard) wild++;
  if (wild) return { mode: 'unscoped', scope: '', reason: 'none of ' + cands.join(',') + '; ' + wild + of.replace(' (', ' flood unscoped (') };
  return fallback('none of ' + cands.join(',') + ' nor unscoped' + of);
}

// pruneHeard keeps the heard map inside the window.
export function pruneHeard(heard, now, windowMs = HEARD_WINDOW_MS) {
  for (const [k, at] of heard) if (now - at > windowMs) heard.delete(k);
  return heard;
}
