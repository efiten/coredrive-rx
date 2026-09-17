// test/manifest.test.mjs
// The web app manifest is built (vite.config.js's rx-manifest plugin) instead of
// shipped from public/, because a static file cannot follow the build's `base`.
// A new file rather than a case appended to an existing one, so "no existing
// test file was edited" stays checkable with `git diff --stat origin/master`.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { buildManifest, themeColorFromHtml } from '../scripts/manifest.mjs';

const INDEX_HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const VITE_CONFIG = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');

// The bug this replaces: start_url and scope were both "/", so add-to-home-screen
// from /beta installed a shortcut that launched the production app.
test('each build installs itself, not the other one', () => {
  assert.strictEqual(buildManifest('/beta/', '#0b0e14').start_url, '/beta/');
  assert.strictEqual(buildManifest('/beta/', '#0b0e14').scope, '/beta/');
  assert.strictEqual(buildManifest('/', '#0b0e14').start_url, '/');
  assert.strictEqual(buildManifest('/', '#0b0e14').scope, '/');
});

// A manifest's URLs resolve against the manifest's own address, so a relative
// icon path follows the slot the manifest was served from. An absolute "/icon-…"
// would point every build at the production icons.
test('the icons are relative, so they follow the manifest', () => {
  for (const base of ['/', '/beta/']) {
    for (const icon of buildManifest(base, '#0b0e14').icons) {
      assert.doesNotMatch(icon.src, /^\//, `${icon.src} must not be root-absolute`);
    }
  }
});

test('the colours come from index.html, which is the tag that says they must match', () => {
  const color = themeColorFromHtml(INDEX_HTML);
  assert.strictEqual(color, '#0b0e14');
  const m = buildManifest('/', color);
  assert.strictEqual(m.theme_color, color);
  assert.strictEqual(m.background_color, color);
});

test('a page with no theme-color yields null, which the build refuses', () => {
  assert.strictEqual(themeColorFromHtml('<head></head>'), null);
  assert.match(VITE_CONFIG, /no <meta name="theme-color">/);
});

// index.html must not carry its own manifest link: written there the href is the
// same in every build, and the /beta build then linked the production manifest.
test('index.html leaves the manifest link to the build', () => {
  assert.doesNotMatch(INDEX_HTML, /<link[^>]+rel="manifest"/);
  assert.match(VITE_CONFIG, /rel: 'manifest', href: base \+ 'manifest\.webmanifest'/);
});

// "no sw.js in /beta" was a rule enforced by nothing: `vite build --mode beta`
// copied public/sw.js into dist/ and deploy.sh removed only dist/config.json, so
// the file had to be deleted from the server by hand. The build removes it now.
test('the beta build deletes the service worker it must never ship', () => {
  assert.match(VITE_CONFIG, /name: 'rx-beta-no-sw'/);
  assert.match(VITE_CONFIG, /if \(beta\) rmSync\(join\(ROOT, 'dist', 'sw\.js'\), \{ force: true \}\)/);
});
