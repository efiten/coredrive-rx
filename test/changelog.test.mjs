// test/changelog.test.mjs
// Ported from core-hunter's app/src/__tests__/changelog.test.js (vitest ->
// node:test). unseenEntryCount/hasUnseenEntries/migratedSeenId are ported
// unchanged — pure position-in-a-list logic, keyed on an id, independent of
// where the entries came from.
//
// whereLabel and its describe block are DROPPED: core-hunter tags each entry
// app/map/both for its two deploy surfaces (the hunter PWA and the shared web
// map); coredrive-rx ships only the one surface, so there is no "where" to
// label, and whereLabel does not exist in src/ui/changelog.js.
import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasUnseenEntries, unseenEntryCount, migratedSeenId, renderWhatsNew } from '../src/ui/changelog.js';
import { parseReleaseNote } from '../scripts/changelog-notes.mjs';

// Entries as changelog.json actually ships them: newest first, one per change
// a user could notice, ids being the release's own version string (see the
// controller ruling: this repo's changelog.json is built from
// docs/releases/vX.Y.Z.md, id = version).
const ENTRIES = [
  { id: 'v1.18.2', version: 'v1.18.2', title: 'C', body: 'c' },
  { id: 'v1.18.1', version: 'v1.18.1', title: 'B', body: 'b' },
  { id: 'v1.18.0', version: 'v1.18.0', title: 'A', body: 'a' },
];

test('unseenEntryCount counts the entries published above the acknowledged one', () => {
  assert.strictEqual(unseenEntryCount(ENTRIES, 'v1.18.0'), 2);
  assert.strictEqual(unseenEntryCount(ENTRIES, 'v1.18.1'), 1);
  assert.strictEqual(unseenEntryCount(ENTRIES, 'v1.18.2'), 0);
});

// Nothing acknowledged means a first run, which is deliberately silent —
// marking every entry new would announce a history the reader was never here
// for.
test('unseenEntryCount is 0 when nothing was acknowledged', () => {
  assert.strictEqual(unseenEntryCount(ENTRIES, null), 0);
  assert.strictEqual(unseenEntryCount(ENTRIES, ''), 0);
});

// An id that is not in the file any more (an entry was edited or dropped) has
// no position to count from, and guessing one marks everything new.
test('unseenEntryCount is 0 for an acknowledged id the file no longer contains', () => {
  assert.strictEqual(unseenEntryCount(ENTRIES, 'gone'), 0);
});

test('unseenEntryCount is 0 for an empty or missing file', () => {
  assert.strictEqual(unseenEntryCount([], 'x'), 0);
  assert.strictEqual(unseenEntryCount(undefined, 'x'), 0);
});

// The file is hand-written, so an entry can ship without an id. Without the
// explicit guard on the acknowledgement, a first run (seenId null/undefined)
// matches that entry by === and reports a position, which would mark the
// entries above it new to a reader who has never been here.
test('unseenEntryCount is 0 on a first run even when an entry is missing its id', () => {
  const malformed = [ENTRIES[0], { version: 'v1.18.1', title: 'no id' }, ...ENTRIES.slice(1)];
  assert.strictEqual(unseenEntryCount(malformed, undefined), 0);
  assert.strictEqual(unseenEntryCount(malformed, null), 0);
  assert.strictEqual(unseenEntryCount(malformed, ''), 0);
});

test('hasUnseenEntries is true while the newest entry is not the acknowledged one', () => {
  assert.strictEqual(hasUnseenEntries(ENTRIES, 'v1.18.1'), true);
});

test('hasUnseenEntries is false once the newest entry has been acknowledged', () => {
  assert.strictEqual(hasUnseenEntries(ENTRIES, 'v1.18.2'), false);
});

test('hasUnseenEntries is false on a first run and for an empty file', () => {
  assert.strictEqual(hasUnseenEntries(ENTRIES, null), false);
  assert.strictEqual(hasUnseenEntries([], null), false);
});

// The one case where this and unseenEntryCount deliberately disagree: an
// acknowledged id that has fallen out of the file is not "up to date", so the
// badge shows — but there is no position to count from, so nothing is marked
// new.
test('hasUnseenEntries still shows the badge for an acknowledged id the file no longer contains', () => {
  assert.strictEqual(hasUnseenEntries(ENTRIES, 'gone'), true);
  assert.strictEqual(unseenEntryCount(ENTRIES, 'gone'), 0);
});

test('migratedSeenId leaves an existing entry-id acknowledgement alone', () => {
  const newest = 'v1.18.2';
  assert.strictEqual(migratedSeenId('v1.18.0', null, newest), 'v1.18.0');
});

// The distinction this function exists for. A reader who acknowledged under
// an earlier scheme has been here before, so the curated notes are genuinely
// new to them: return that legacy value, which stores something other than
// the newest id and leaves the badge showing until they open the panel. The
// legacy value ('v1.9.0') is deliberately NOT one of ENTRIES' ids, mirroring
// core-hunter's own fixture (an old version string is not a changelog entry
// id) — coredrive-rx has no earlier scheme (this is changelog.js's first
// version), so legacyAck is always null in this app's own wiring, but the
// case is still tested because the function itself is generic.
test('migratedSeenId gives a reader from an earlier scheme the badge exactly once', () => {
  const newest = 'v1.18.2';
  assert.strictEqual(migratedSeenId(null, 'v1.9.0', newest), 'v1.9.0');
});

test('migratedSeenId lands a migrated reader in the state that shows a badge over an unmarked list', () => {
  const newest = 'v1.18.2';
  const migrated = migratedSeenId(null, 'v1.9.0', newest);
  assert.strictEqual(hasUnseenEntries(ENTRIES, migrated), true);
  assert.strictEqual(unseenEntryCount(ENTRIES, migrated), 0);
});

test('migratedSeenId leaves a first-time reader silent, by the same composition', () => {
  const newest = 'v1.18.2';
  const migrated = migratedSeenId(null, null, newest);
  assert.strictEqual(hasUnseenEntries(ENTRIES, migrated), false);
  assert.strictEqual(unseenEntryCount(ENTRIES, migrated), 0);
});

test('migratedSeenId stays silent for a reader who has never acknowledged anything', () => {
  const newest = 'v1.18.2';
  assert.strictEqual(migratedSeenId(null, null, newest), newest);
  assert.strictEqual(migratedSeenId(null, '', newest), newest);
});

// --- renderWhatsNew: not in core-hunter's ported suite (that DOM wiring lived
// untested in core-hunter's app.js) but added here since app.js may not build
// DOM itself (test/appdom.test.mjs) and this is the sheet's one writer.
function fakeElement() {
  return {
    className: '', textContent: '', children: [],
    replaceChildren(...nodes) { this.children = nodes; },
    appendChild(node) { this.children.push(node); return node; },
  };
}

function withFakeDocument(fn) {
  const prior = globalThis.document;
  globalThis.document = { createElement: () => fakeElement() };
  try { return fn(); } finally { globalThis.document = prior; }
}

test('renderWhatsNew shows the newest entry as text with the older ones listed by version', () => {
  withFakeDocument(() => {
    const el = fakeElement();
    renderWhatsNew(el, ENTRIES);
    assert.strictEqual(el.children[0].textContent, 'v1.18.2 — C');
    assert.strictEqual(el.children[1].className, 'mono wn-body');
    assert.strictEqual(el.children[1].textContent, 'c');
    const older = el.children[2];
    assert.strictEqual(older.className, 'wn-older');
    assert.deepStrictEqual(older.children.map((r) => r.textContent), ['v1.18.1 — B', 'v1.18.0 — A']);
  });
});

test('renderWhatsNew says so when there are no entries at all', () => {
  withFakeDocument(() => {
    const el = fakeElement();
    renderWhatsNew(el, []);
    assert.strictEqual(el.children.length, 1);
    assert.strictEqual(el.children[0].textContent, 'No release notes available.');
  });
});

// --- parseReleaseNote against every real docs/releases/*.md file -----------
// Regression coverage for fix round 1: 19 of the 36 release files do NOT
// open with a plain-prose summary line — 9 go straight from the "#" heading
// into a "## What's new" sub-heading, 10 open directly with a "- **Bold**"
// bullet — and the old parser (first non-blank line, unconditionally) took
// either as the title, producing sheet rows like "v1.1.0 — ## What's new"
// and silently dropping the bullet's own lead clause out of the body. Reads
// the directory rather than listing filenames, so a new release file is
// covered automatically.
const RELEASES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'releases');

test('parseReleaseNote never mistakes markup for a title, over every real release file', () => {
  const files = readdirSync(RELEASES_DIR).filter((f) => /^v\d+\.\d+\.\d+\.md$/.test(f));
  assert.ok(files.length > 0, 'docs/releases has release files to check');
  for (const file of files) {
    const text = readFileSync(join(RELEASES_DIR, file), 'utf8');
    const entry = parseReleaseNote(file, text);
    assert.doesNotMatch(entry.title, /^[#\-*]/, `${file}: title must not be a heading or a bullet`);
    assert.ok(entry.body.length > 0, `${file}: body must not be empty`);
    // Independently re-derive "the first non-blank line after the heading",
    // the same way parseReleaseNote does, so this checks the file itself
    // rather than trusting the parser's own bookkeeping.
    const lines = text.split('\n');
    let i = 1;
    while (i < lines.length && lines[i].trim() === '') i++;
    const first = (lines[i] || '').trim();
    if (/^[-*]/.test(first)) {
      assert.ok(entry.body.includes(first), `${file}: the opening bullet's own text must survive into the body`);
    }
  }
});
