// Builds a GitHub Release body from docs/releases/vX.Y.Z.md.
//
// AGENTS.md requires every tag to carry its own "What's new". That rule was a human
// convention and it was missed on nine tags in a row, which left v1.5.0 as the last
// release anyone could read while region discovery landed unannounced. Here the rule is
// mechanical: the workflow calls this before publishing, so a tag whose notes file is
// missing fails the job instead of shipping a body that is only a changelog link.
//
// The body holds only that tag's own notes plus one link to the releases list. Earlier
// bodies carried every older release too; with 45 releases the assets, which GitHub shows
// below the body, sat far down the page, and the releases list already shows them all.
//
// Usage: node scripts/release-notes.mjs v1.12.0 > RELEASE_BODY.md
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

export const RELEASES_URL = 'https://github.com/efiten/coredrive-rx/releases';

// assembleBody returns the body for `tag`: its own notes and a link to earlier releases.
export function assembleBody(entries, tag) {
  const entry = entries.find((e) => e.tag === tag);
  if (!entry) {
    throw new Error('no release notes for ' + tag + ' — expected docs/releases/' + tag + '.md');
  }
  return entry.text.trim() + '\n\n---\n\nEarlier releases: ' + RELEASES_URL + '\n';
}

export function readEntries(dir) {
  return readdirSync(dir)
    .filter((f) => /^v\d+\.\d+\.\d+\.md$/.test(f))
    .map((f) => ({ tag: f.replace(/\.md$/, ''), text: readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n') }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tag = process.argv[2];
  if (!tag) { console.error('usage: node scripts/release-notes.mjs <tag>'); process.exit(2); }
  const dir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'docs', 'releases');
  try {
    process.stdout.write(assembleBody(readEntries(dir), tag));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
