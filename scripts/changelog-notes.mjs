// Parses docs/releases/vX.Y.Z.md into changelog.json's entries (used by
// vite.config.js's rx-changelog-json plugin). Split into its own module so
// test/changelog.test.mjs can run it over every real release file without
// pulling in vite.config.js's build setup.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compareTags } from './release-notes.mjs';

// A release file's own one-line summary (AGENTS.md's template) is plain
// prose. It is NOT a summary when that first line is itself markup: a `##`
// sub-heading (some early releases go straight from the `#` heading into
// "## What's new" with no summary line of their own) or a `- **Bold**`/
// `* text` bullet (others open directly with their first change). Treating
// either as a title produced rows like "v1.1.0 — ## What's new" in the
// sheet, and silently dropped the bullet's own lead clause out of the body.
function looksLikeSummary(line) {
  return !!line && !/^[#\-*]/.test(line);
}

// parseReleaseNote reads one release file: the first line is its
// "# CoreDrive RX vX.Y.Z" heading, the next non-blank line is the release's
// summary IF it looks like one (see looksLikeSummary) — otherwise there is no
// title, and the body keeps that heading/bullet line intact rather than
// discarding it. Everything after the title (or after the `#` heading, when
// there is none) is the body, kept as raw Markdown text: the "What's new"
// sheet renders it as text, never parses it.
export function parseReleaseNote(file, text) {
  const version = file.replace(/\.md$/, '');
  const lines = text.split('\n');
  let i = 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  const first = (lines[i] || '').trim();
  const hasTitle = looksLikeSummary(first);
  const title = hasTitle ? first : '';
  const body = lines.slice(hasTitle ? i + 1 : i).join('\n').trim();
  return { id: version, version, title, body };
}

// readReleaseNotes turns docs/releases/*.md into changelog.json's array,
// newest first. Ordering reuses compareTags (scripts/release-notes.mjs)
// rather than re-sorting by string, since that is the one existing place a
// wrong order was already a shipped bug (v1.9.1 sorting above v1.10.0).
export function readReleaseNotes(dir) {
  return readdirSync(dir)
    .filter((f) => /^v\d+\.\d+\.\d+\.md$/.test(f))
    .map((f) => parseReleaseNote(f, readFileSync(join(dir, f), 'utf8')))
    .sort((a, b) => compareTags(a.version, b.version));
}
