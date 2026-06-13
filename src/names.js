// On-the-fly node-name resolution: per heard prefix/pubkey, one tiny request to
// the CoreScope resolve endpoint configured as `resolveUrl` in config.json (a
// CORS-enabled URL). Cached in memory for the session, so each distinct node is
// fetched at most once. When resolveUrl is empty the app skips resolution and
// the caller shows the prefix. A name is returned only when the prefix resolves
// uniquely; ambiguous/not-found → '' (caller shows the prefix).
import { getConfig } from './config.js';

const cache = new Map(); // key (lowercase hex) -> name | ''

// resolveName resolves a heard key (2-3 byte prefix or full pubkey) to a name.
// Returns '' when unconfigured, ambiguous, or unknown. Network errors are not
// cached (retry later).
export async function resolveName(key) {
  const c = getConfig();
  const base = c && c.resolveUrl ? c.resolveUrl : '';
  if (!base) return '';
  const k = key.toLowerCase();
  if (cache.has(k)) return cache.get(k);
  try {
    const r = await fetch(base + '?prefix=' + encodeURIComponent(k));
    if (!r.ok) { cache.set(k, ''); return ''; }
    const j = await r.json();
    const name = !j.ambiguous && j.name ? j.name : '';
    cache.set(k, name);
    return name;
  } catch (e) {
    return ''; // transient — leave uncached so it can retry
  }
}
