import { defineConfig } from 'vite';
import { readFileSync } from 'fs';

// Inject the package.json version so the app can display which build is running.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
