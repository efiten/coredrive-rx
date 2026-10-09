import { defineConfig } from 'vite';
import { readFileSync } from 'fs';

// Inject the package.json version so the app can display which build is running.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// RX_SLOT=staging builds a test deployment served from /staging/ on the same host as
// production (rx.on8ar.eu/staging, branch slot/staging, never merged). It must not
// register the service worker (registered from /staging/ it claims the ROOT scope and
// would serve this build at /), and keeps its own IndexedDB queue. Base is set here,
// not as --base on the CLI: Git Bash on Windows rewrites that into a filesystem path.
const slot = (process.env.RX_SLOT || '').replace(/[^a-z0-9-]/g, '');

export default defineConfig({
  base: slot ? '/' + slot + '/' : '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version + (slot ? '-' + slot : '')),
    __RX_SLOT__: JSON.stringify(slot),
  },
});
