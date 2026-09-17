import { defineConfig } from 'vite';
import { readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readReleaseNotes } from './scripts/changelog-notes.mjs';
import { buildManifest, themeColorFromHtml } from './scripts/manifest.mjs';

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
  const base = beta ? '/beta/' : '/';

  // The manifest's colours are index.html's own theme-color literal, read at
  // build time so the two cannot drift (index.html says they must match).
  function manifestSource() {
    const themeColor = themeColorFromHtml(readFileSync(join(ROOT, 'index.html'), 'utf8'));
    if (!themeColor) throw new Error('index.html has no <meta name="theme-color">; the manifest takes its colours from it');
    return buildManifest(base, themeColor);
  }

  return {
    base,
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
      {
        // The manifest is built, not copied from public/: a static one cannot
        // follow `base`, and its "/" start_url and scope made add-to-home-screen
        // from /beta install the PRODUCTION app. scripts/manifest.mjs holds the
        // shape and the reasons; the colours come from index.html's own
        // theme-color literal so the two cannot drift apart.
        name: 'rx-manifest',
        // The <link> is injected rather than written in index.html, so its href
        // carries `base` too — a "/manifest.webmanifest" in the markup made the
        // /beta build link the production manifest, start_url "/" and all.
        transformIndexHtml() {
          return [{
            tag: 'link',
            attrs: { rel: 'manifest', href: base + 'manifest.webmanifest' },
            injectTo: 'head',
          }];
        },
        // `npm run dev` runs no build, so the file has to be served live.
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if ((req.url || '').split('?')[0] !== base + 'manifest.webmanifest') return next();
            res.setHeader('Content-Type', 'application/manifest+json');
            res.end(JSON.stringify(manifestSource()));
          });
        },
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'manifest.webmanifest',
            source: JSON.stringify(manifestSource(), null, 2),
          });
        },
      },
      {
        // A service worker registered from /beta/ claims the ROOT scope and
        // would then serve the experiment at the production URL. The build
        // already skips registering it (__REGISTER_SW__), but public/sw.js was
        // still copied into dist/ and uploaded, so the file only had to be found
        // by something else once to become live. It was deleted from the server
        // by hand once already; this is that deletion done by the build.
        name: 'rx-beta-no-sw',
        apply: 'build',
        closeBundle() {
          if (beta) rmSync(join(ROOT, 'dist', 'sw.js'), { force: true });
        },
      },
    ],
  };
});
