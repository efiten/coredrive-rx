// Headless smoke config for the built app (Task 10). This runs the real
// `vite build` + `vite preview` pair, not the dev server: the unit suite
// (test/*.test.mjs, run via `npm test`) never loads src/app.js at all, so this
// is the only check that the bundle boots in a browser. Kept out of `npm test`
// on purpose — it needs a browser, node --test does not.
// testDir is `e2e/`, not `test/e2e/`: bare `node --test` recursively treats
// every file under any directory named `test` as a test file, so a Playwright
// spec placed there would break `npm test` itself.
export default {
  testDir: 'e2e',
  use: { baseURL: 'http://localhost:4173' },
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
  },
};
