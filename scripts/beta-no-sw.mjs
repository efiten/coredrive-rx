// Used by vite.config.js's rx-beta-no-sw plugin. Split into its own module so
// test/manifest.test.mjs can invoke it directly against a temporary directory
// instead of matching the plugin's source text.
//
// A service worker registered from /beta/ claims the ROOT scope and would then
// serve the experiment at the production URL. The build already skips
// registering it (__REGISTER_SW__), but public/sw.js was still copied into
// dist/ and uploaded, so the file only had to be found by something else once
// to become live. It was deleted from the server by hand once already; this is
// that deletion done by the build.
import { rmSync } from 'node:fs';
import { join } from 'node:path';

export function removeBetaServiceWorker(distDir, beta) {
  if (beta) rmSync(join(distDir, 'sw.js'), { force: true });
}
