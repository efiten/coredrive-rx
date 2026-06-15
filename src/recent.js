// Pure merge logic for the "recently heard nodes" list.
//
// A node can be heard under several key representations: the 2-byte path hash
// (rxlog, path[last]) and the full/8-byte pubkey (advert/discover). In MeshCore the
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

  const merged = { key, keylen, count: 0, src };
  for (const m of matches) {
    merged.count += m.count;
    if (m.key.length > merged.key.length) { merged.key = m.key; merged.keylen = m.keylen; }
    if (m.name !== undefined) merged.name = m.name;
    if (m._req) merged._req = m._req;
  }
  merged.count += 1;
  merged.snr = snr;
  merged.rssi = rssi;
  merged.last = now;
  merged.src = src;
  return [merged, ...rest].slice(0, max);
}
