// Pure merge logic for the "recently heard nodes" list.
//
// A node can be heard under several key representations: the 2-byte path hash
// (rxlog, path[last]) and the pubkey (32-byte advert, or 8-byte discover prefix). In MeshCore the
// path hash is the leading byte(s) of the node's public key, so one key is a prefix of
// the other when they are the same node — exactly how names.js resolves prefixes.
// We collapse prefix-related entries into one row: longest (most-specific) key kept,
// counts summed, newest reception shown. No DOM, no network — unit-testable.

// sameNode reports whether two lowercase-hex heard keys refer to the same node,
// i.e. one is a prefix of the other (or they are equal). Case-insensitive.
export function sameNode(a, b) {
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  return x === y || x.startsWith(y) || y.startsWith(x);
}

// upsertHeard returns a NEW list with `reception` merged in, most-recent first,
// capped at `max`. reception = { key, keylen, snr, rssi, src, now }.
// Any existing entries that refer to the same node (prefix-related) are merged into
// a single entry at the front. A carried `name`/`_req` (set by the caller after name
// resolution) is preserved so resolution is not re-triggered needlessly.
export function upsertHeard(list, reception, max) {
  const { key, keylen, snr, rssi, src, now } = reception;
  const matches = list.filter((e) => sameNode(e.key, key));
  const rest = list.filter((e) => !sameNode(e.key, key));

  // Identity/count come from the merged set; snr/rssi/src/last are the new reception's.
  const merged = { key, keylen, count: 0, snr, rssi, src, last: now };
  for (const m of matches) {
    merged.count += m.count;
    if (m.key.length > merged.key.length) { merged.key = m.key; merged.keylen = m.keylen; }
    // A resolved name is per-node, so any match's name is valid; later matches win (harmless).
    if (m.name !== undefined) merged.name = m.name;
    if (m._req) merged._req = m._req;
  }
  merged.count += 1;
  return [merged, ...rest].slice(0, max);
}
