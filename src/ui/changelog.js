// Release notes for the "What's new" sheet. unseenEntryCount, hasUnseenEntries
// and migratedSeenId are ported unchanged from core-hunter's app/src/changelog.js
// — their logic (a position in a newest-first list, keyed on an id) does not
// depend on where the entries came from.
//
// The entries themselves do NOT come from core-hunter's changelog.d/*.json build
// step, which this repo does not have. This repo's mandated source is one
// hand-written file per release, docs/releases/vX.Y.Z.md (AGENTS.md), and
// vite.config.js's rx-changelog-json plugin turns those into changelog.json at
// build time — newest first, ordered with scripts/release-notes.mjs's
// compareTags, id being the version string.
//
// whereLabel is dropped: core-hunter tags each entry app/map/both for its two
// deploy surfaces (the hunter PWA and the shared web map); this app ships only
// the one surface, so there is nothing to label.

// Index of the acknowledged entry, or -1 when there is no position to count
// from: nothing acknowledged (a first run), or an id the file no longer
// contains because the entry was edited or dropped. Guessing a position in
// either case marks the whole file new.
function seenIndex(entries, seenId) {
  if (!Array.isArray(entries) || !seenId) return -1;
  return entries.findIndex((e) => e && e.id === seenId);
}

// unseenEntryCount is how many entries sit above the acknowledged one, i.e.
// how many to mark as new in the panel.
export function unseenEntryCount(entries, seenId) {
  const i = seenIndex(entries, seenId);
  return i === -1 ? 0 : i;
}

// hasUnseenEntries drives the "New" badge: the newest entry is not the one
// this reader acknowledged. Deliberately not `unseenEntryCount > 0` — an
// acknowledged id that has fallen out of the file badges nothing (no
// position) but is also not "up to date", and the two answers are allowed to
// differ.
export function hasUnseenEntries(entries, seenId) {
  if (!Array.isArray(entries) || !entries.length || !seenId) return false;
  return entries[0].id !== seenId;
}

// migratedSeenId decides what to store at boot. Three readers, three answers:
//
//   - already on the id scheme -> keep their id, nothing changes
//   - acknowledged under some earlier scheme -> carry that value over
//   - never acknowledged anything -> record the newest id silently, because a
//     first-time reader has no "since you were last here"
//
// This app has no earlier acknowledgement scheme to migrate FROM (this is the
// feature's first version), so the middle case is unreachable today — callers
// pass null for legacyAck — but the function stays generic rather than
// special-cased to "no legacy", since a caller that never has one is exactly
// what the first-time-reader case already covers, and dropping the parameter
// would leave nothing to widen if this app ever grows a second acknowledgement
// store.
export function migratedSeenId(storedId, legacyAck, newestId) {
  if (storedId) return storedId;
  if (legacyAck) return legacyAck;
  return newestId;
}

// renderWhatsNew is the sheet's one DOM writer: the newest entry's title and
// body as text (the body is Markdown, rendered verbatim rather than parsed —
// no innerHTML), with the older entries listed below it by version.
export function renderWhatsNew(el, entries) {
  el.replaceChildren();
  if (!Array.isArray(entries) || !entries.length) {
    const p = document.createElement('div');
    p.className = 'muted';
    p.textContent = 'No release notes available.';
    el.appendChild(p);
    return;
  }
  const [newest, ...older] = entries;
  const title = document.createElement('div');
  title.className = 'wn-title';
  title.textContent = entryLabel(newest);
  el.appendChild(title);
  const body = document.createElement('pre');
  body.className = 'mono wn-body';
  body.textContent = newest.body;
  el.appendChild(body);
  if (older.length) {
    const list = document.createElement('div');
    list.className = 'wn-older';
    for (const e of older) {
      const row = document.createElement('div');
      row.className = 'wn-row';
      row.textContent = entryLabel(e);
      list.appendChild(row);
    }
    el.appendChild(list);
  }
}

// entryLabel is "version — title" when a release carries a summary line, or
// just the version when it does not — some early release files go straight
// from the heading into "## What's new" or their first bullet with no
// summary of their own (scripts/changelog-notes.mjs's parseReleaseNote
// leaves `title` empty rather than mistaking that markup for one).
function entryLabel(entry) {
  return entry.title ? `${entry.version} — ${entry.title}` : entry.version;
}
