// Assembles a GitHub Release body from docs/releases/vX.Y.Z.md, newest first.
//
// AGENTS.md requires every tag to carry its own "What's new" plus every earlier
// release's (folded, see assembleBody), so the latest tag always tells the full story.
// That rule was a human convention and it was missed on nine tags in a row, which left
// v1.5.0 as the last release anyone could read while region discovery landed
// unannounced. Here the rule is mechanical: the workflow calls this before publishing,
// so a tag whose notes file is missing fails the job instead of shipping a body that is
// only a changelog link.
//
// Usage: node scripts/release-notes.mjs v1.12.0 > RELEASE_BODY.md
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const SEPARATOR = '\n\n---\n\n';

// compareTags orders tags newest first. Ordering by string puts v1.9.1 above v1.10.0,
// which is the one mistake that would silently drop a release out of the middle of a
// body, so the comparison is on the numeric components.
export function compareTags(a, b) {
  const na = a.replace(/^v/, '').split('.').map(Number);
  const nb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (nb[i] || 0) - (na[i] || 0);
    if (d) return d;
  }
  return 0;
}

// assembleBody returns the body for `tag`: its own section in full, then every OLDER one
// folded into a closed <details> block under "Earlier releases", newest first. GitHub
// shows the assets below the body, so with every release written out in full the APK
// sat many screens down; folded, the history is still in every body at one line per
// release. Newer sections are excluded so that re-publishing an old tag stays truthful
// about what that release contained.
export function assembleBody(entries, tag) {
  if (!entries.some((e) => e.tag === tag)) {
    throw new Error('no release notes for ' + tag + ' — expected docs/releases/' + tag + '.md');
  }
  const [current, ...older] = entries
    .filter((e) => compareTags(e.tag, tag) >= 0)
    .sort((x, y) => compareTags(x.tag, y.tag));
  let body = current.text.trim() + '\n';
  if (older.length) {
    body += SEPARATOR + '## Earlier releases\n\n' + older.map(foldEntry).join('\n\n') + '\n';
  }
  return body;
}

// foldEntry renders one older release as a closed <details> block. The summary is the
// tag plus the first sentence of the file's summary paragraph; the "# CoreDrive RX vX.Y.Z" heading is dropped
// because the summary already names the version. Backticks and asterisks are removed
// from the summary because GitHub does not render Markdown inside <summary>.
export function foldEntry(e) {
  const lines = e.text.trim().split('\n');
  if (/^#\s/.test(lines[0])) lines.shift();
  const rest = lines.join('\n').trim();
  const firstPara = rest.split(/\n\s*\n/)[0];
  const para = /^[#-]/.test(firstPara) ? '' : firstPara.replace(/\s+/g, ' ').replace(/[`*]/g, '').trim();
  const blurb = para.split(/(?<=[.:!?])\s+(?=[A-Z0-9])/)[0];
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const summary = '<b>' + e.tag + '</b>' + (blurb ? ': ' + esc(blurb) : '');
  return '<details>\n<summary>' + summary + '</summary>\n\n' + rest + '\n\n</details>';
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
