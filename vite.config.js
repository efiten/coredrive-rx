import { defineConfig } from 'vite';
import { readFileSync } from 'fs';

// Inject the package.json version so the app can display which build is running.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// REGION_BETA=1 builds the unthrottled region-discovery experiment (src/regionsprint.js)
// instead of the production scheduler. It is a separate deployment (rx.on8ar.eu/beta),
// never the default: a normal build compiles the flag to false and drops that code.
const beta = process.env.REGION_BETA === '1';

export default defineConfig({
  // The beta is served from /beta/ on the same host as the production app, so its
  // asset URLs have to be rewritten. Set here rather than passed as --base=/beta/,
  // which Git Bash on Windows rewrites into a filesystem path before Vite sees it.
  base: beta ? '/beta/' : '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version + (beta ? '-beta-sprint' : '')),
    __REGION_BETA__: JSON.stringify(beta),
  },
});
