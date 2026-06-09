// On-the-fly node-name resolution: per heard prefix/pubkey, one tiny request to
// the CoreScope resolve endpoint (via corsproxy.on8ar.eu/cs, CORS-enabled). The
// result is cached in memory for the session, so each distinct node is fetched
// at most once. No bulk node-list download. A name is returned only when the
// prefix resolves uniquely; ambiguous/not-found → '' (caller shows the prefix).
const BASE = 'https://corsproxy.on8ar.eu/cs/api/nodes/resolve';
const cache = new Map(); // key (lowercase hex) -> name | ''

// resolveName resolves a heard key (2-3 byte prefix or full pubkey) to a name.
// Returns '' when ambiguous/unknown. Network errors are not cached (retry later).
export async function resolveName(key) {
  const k = key.toLowerCase();
  if (cache.has(k)) return cache.get(k);
  try {
    const r = await fetch(BASE + '?prefix=' + encodeURIComponent(k));
    if (!r.ok) { cache.set(k, ''); return ''; }
    const j = await r.json();
    const name = !j.ambiguous && j.name ? j.name : '';
    cache.set(k, name);
    return name;
  } catch (e) {
    return ''; // transient — leave uncached so it can retry
  }
}
