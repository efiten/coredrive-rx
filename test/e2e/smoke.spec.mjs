// One headless pass over the built app. It cannot connect a companion (no Web
// Bluetooth in headless Chromium), so it checks what is true without one: the
// shell renders, the tabs switch, the theme cycles, a sheet opens and closes,
// and the console stays clean. This is the only check that app.js renders at
// all — the 401-test unit suite (node --test) never loads it.
import { test, expect } from '@playwright/test';

// External noise MapLibre logs with no listener for its own 'error' event
// (src/ui/map.js registers none), so a "no console errors" assertion would
// otherwise be at the mercy of OpenFreeMap's sprite and tile server. Both
// patterns name that external service specifically — nothing from our own
// code matches either one.
const ALLOWED_CONSOLE_ERRORS = [
  // OpenFreeMap's own style sprite is missing a "circle-11" image; MapLibre
  // warns about it on every style load, tile availability notwithstanding.
  /circle-11/,
  // Style/tile fetches to the basemap host fail outright on a machine with no
  // internet access (AJAXError, "Failed to fetch", etc. — the message text
  // varies, the host in it does not).
  /tiles\.openfreemap\.org/,
];

test('the shell renders, switches tabs, cycles theme and opens a sheet without console errors', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (ALLOWED_CONSOLE_ERRORS.some((re) => re.test(text))) return;
    errors.push(text);
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  // The cold-start splash (Task 9, #splash) gates the whole shell behind a
  // coach-mark tour on a genuine first run. That gate is its own feature with
  // its own unit test (test/splash.test.mjs); driving it here would make this
  // a splash test wearing a smoke test's name, and a failure inside the tour
  // would say nothing about whether the app itself renders. Pre-seed the
  // localStorage key it reads (storage.js's prefKey('splashSeen'), unnamespaced
  // in this non-beta build: 'coredrive.splashSeen') so the run starts on the
  // second-launch experience every other assertion here is about.
  await page.addInitScript(() => {
    try { window.localStorage.setItem('coredrive.splashSeen', '1'); } catch (e) { /* ignore */ }
  });

  await page.goto('/');
  await expect(page.locator('#screen-status')).toBeVisible();
  await expect(page.locator('#btnConnect')).toBeVisible();

  const html = page.locator('html');
  const themeBefore = await html.getAttribute('data-theme');
  await page.locator('#btnTheme').click();
  await expect(html).not.toHaveAttribute('data-theme', themeBefore ?? '');
  const themeAfter = await html.getAttribute('data-theme');
  await page.locator('#btnTheme').click();
  await expect(html).not.toHaveAttribute('data-theme', themeAfter ?? '');

  await page.locator('#tab-heard').click();
  await expect(page.locator('#screen-heard')).toBeVisible();
  await expect(page.locator('#recent')).toContainText('nothing yet');

  await page.locator('#tab-drive').click();
  await expect(page.locator('#hud')).toBeVisible();
  // createMap() lazy-loads maplibre-gl via a dynamic import, so the canvas can
  // take a moment to appear — give it a real timeout rather than asserting
  // immediately.
  await expect(page.locator('#map canvas')).toBeVisible({ timeout: 15000 });

  await page.locator('#tab-status').click();
  await page.locator('#btnDbg').click();
  await expect(page.locator('#sheet-log')).toBeVisible();
  await page.locator('#sheet-backdrop').click();
  await expect(page.locator('#sheet-log')).toBeHidden();

  expect(errors).toEqual([]);
});
