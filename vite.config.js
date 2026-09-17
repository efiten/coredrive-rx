import { defineConfig } from 'vite';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { compareTags } from './scripts/release-notes.mjs';

// Inject the package.json version so the app can display which build is running.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const ROOT = dirname(fileURLToPath(import.meta.url));

// parseReleaseNote reads one docs/releases/vX.Y.Z.md (AGENTS.md's mandated
// one file per release): the first line is its "# CoreDrive RX vX.Y.Z"
// heading, the next non-blank line is the release's own one-line summary
// (every release file carries one), and everything after that — What's new
// AND Upgrade notes — is the body, kept as raw Markdown text: the "What's
// new" sheet renders it as text, never parses it.
function parseReleaseNote(file, text) {
  const version = file.replace(/\.md$/, '');
  const lines = text.split('\n');
  let i = 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  const title = (lines[i] || '').trim();
  const body = lines.slice(i + 1).join('\n').trim();
  return { id: version, version, title, body };
}

// readReleaseNotes turns docs/releases/*.md into changelog.json's array,
// newest first. Ordering reuses compareTags (scripts/release-notes.mjs)
// rather than re-sorting by string, since that is the one existing place a
// wrong order was already a shipped bug (v1.9.1 sorting above v1.10.0).
function readReleaseNotes(dir) {
  return readdirSync(dir)
    .filter((f) => /^v\d+\.\d+\.\d+\.md$/.test(f))
    .map((f) => parseReleaseNote(f, readFileSync(join(dir, f), 'utf8')))
    .sort((a, b) => compareTags(a.version, b.version));
}

// RX_BETA=1 builds the experiment slot at rx.on8ar.eu/beta. base must be set
// here and not as --base= on the CLI: Git Bash on Windows rewrites /beta/ into
// a filesystem path before Vite ever sees it.
const beta = process.env.RX_BETA === '1';

export default defineConfig({
  base: beta ? '/beta/' : '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __STORAGE_NS__: JSON.stringify(beta ? '-beta' : ''),
    // A service worker registered from /beta/ claims the ROOT scope and would
    // then serve the experiment at the production URL.
    __REGISTER_SW__: JSON.stringify(!beta),
  },
  plugins: [
    {
      name: 'rx-version-json',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: pkg.version }) });
      },
    },
    {
      name: 'rx-changelog-json',
      generateBundle() {
        const entries = readReleaseNotes(join(ROOT, 'docs', 'releases'));
        this.emitFile({ type: 'asset', fileName: 'changelog.json', source: JSON.stringify(entries) });
      },
    },
  ],
});
