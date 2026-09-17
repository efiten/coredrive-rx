import { defineConfig } from 'vite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readReleaseNotes } from './scripts/changelog-notes.mjs';

// Inject the package.json version so the app can display which build is running.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const ROOT = dirname(fileURLToPath(import.meta.url));

// --mode beta (`vite build --mode beta`) builds the experiment slot at
// rx.on8ar.eu/beta. RX_BETA=1 is kept as a documented escape hatch for anything
// still setting the env var directly. base must be set here and not as
// --base= on the CLI: Git Bash on Windows rewrites /beta/ into a filesystem
// path before Vite ever sees it.
export default defineConfig(({ mode }) => {
  const beta = mode === 'beta' || process.env.RX_BETA === '1';

  return {
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
  };
});
