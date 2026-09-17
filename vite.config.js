import { defineConfig } from 'vite';
import { readFileSync } from 'fs';

// Inject the package.json version so the app can display which build is running.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

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
});
