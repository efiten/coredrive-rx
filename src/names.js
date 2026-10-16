// On-the-fly node-name resolution: per heard prefix/pubkey, one tiny request to
// the CoreScope resolve endpoint configured as `resolveUrl` in config.json (a
// CORS-enabled URL). Cached in memory for the session, so each distinct node is
// fetched at most once. When resolveUrl is empty the app skips resolution and
// the caller shows the prefix. A name is returned only when the prefix resolves
// uniquely; ambiguous/not-found → '' (caller shows the prefix).
//
// One exception to "ambiguous → ''": a path hash (see isPathHash). Only a node that
// forwards can put its hash in a path, and companions and sensors do not forward by
// default (companion_radio/MyMesh.cpp:486 returns isRepeatEn(), off unless the user
// turns client-repeat on). So when the resolve endpoint calls a path hash ambiguous,
// the candidates are fetched from `searchUrl` and the companions and sensors among
// them are discarded. Exactly one forwarder left → that is the node.
import { getConfig } from './config.js';

const cache = new Map(); // key (lowercase hex) -> { pubkey, name }
const EMPTY = Object.freeze({ pubkey: '', name: '' });

// Roles that retransmit, and so can appear in a path: simple_repeater and
// simple_room_server both implement allowPacketForward.
const FORWARDER_ROLES = new Set(['repeater', 'room']);
// /api/nodes/search returns at most this many rows (CoreScope cmd/server
// handleNodeSearch), newest first, and matches names as well as pubkeys. A full page
// may have cut off a candidate, so it never decides anything.
const SEARCH_LIMIT = 10;

// isPathHash: heard keys of 4 bytes or fewer only come from a path hop (rxlog).
// An advert carries the full 32-byte pubkey and a discover reply at least 8 bytes.
export function isPathHash(key) {
  return key.length <= 8;
}

// pickForwarder chooses the one forwarding node among search results whose pubkey
// starts with `prefix`. Returns { pubkey, name } or EMPTY when none, several, or the
// page was full.
export function pickForwarder(nodes, prefix) {
  if (!Array.isArray(nodes) || nodes.length >= SEARCH_LIMIT) return EMPTY;
  const hits = nodes.filter((n) => n && typeof n.public_key === 'string'
    && n.public_key.toLowerCase().startsWith(prefix) && FORWARDER_ROLES.has(n.role));
  if (hits.length !== 1) return EMPTY;
  return { pubkey: hits[0].public_key.toLowerCase(), name: hits[0].name || '' };
}

// lookup resolves one key to { pubkey, name }. Returns null on a network error, which
// is not cached so a later call retries; every other outcome is cached.
async function lookup(k) {
  if (cache.has(k)) return cache.get(k);
  const c = getConfig();
  try {
    const r = await fetch(c.resolveUrl + '?prefix=' + encodeURIComponent(k));
    let hit = EMPTY;
    if (r.ok) {
      const j = await r.json();
      if (!j.ambiguous) hit = { pubkey: j.pubkey || '', name: j.name || '' };
      else if (isPathHash(k) && c.searchUrl) {
        const s = await fetch(c.searchUrl + '?q=' + encodeURIComponent(k));
        if (s.ok) hit = pickForwarder((await s.json()).nodes, k);
      }
    }
    cache.set(k, hit);
    return hit;
  } catch (e) {
    return null; // transient — leave uncached so it can retry
  }
}

function configured() {
  const c = getConfig();
  return !!(c && c.resolveUrl);
}

// resolveName resolves a heard key (2-3 byte prefix or full pubkey) to a name.
// Returns '' when unconfigured, ambiguous, or unknown. Network errors are not
// cached (retry later).
export async function resolveName(key) {
  if (!configured()) return '';
  const hit = await lookup(key.toLowerCase());
  return hit ? hit.name : '';
}

// resolvePubkey resolves a heard key (prefix or full pubkey) to the full 32-byte
// pubkey, via the same resolve endpoint as resolveName. Returns '' when
// unconfigured, ambiguous, or unknown. A key that is already a full 64-hex pubkey
// is returned as-is with no request. Network errors are not cached (retry later).
export async function resolvePubkey(key) {
  const k = key.toLowerCase();
  if (/^[0-9a-f]{64}$/.test(k)) return k;
  if (!configured()) return '';
  const hit = await lookup(k);
  return hit ? hit.pubkey : '';
}
