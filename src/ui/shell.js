import { prefKey } from '../storage.js';

export const TABS = ['drive', 'heard', 'status'];
export const TAB_STORAGE_KEY = prefKey('tab');

// Boot: nothing works without a companion, so an unconnected start lands on
// Status where the Connect button is. A connected start (a reload mid-drive)
// restores the stored tab, defaulting to Drive.
export function nextTab(stored, connected) {
  if (!connected) return 'status';
  return TABS.includes(stored) ? stored : 'drive';
}

// The first connect of a session moves you off Status once, and only once: a
// reconnect while you are reading Heard must not yank the screen away.
export function tabOnConnect(current, firstConnect) {
  return firstConnect ? 'drive' : current;
}

// createShell owns every "which element is visible" decision, so app.js never
// touches hidden/aria itself. `doc` is injected for the smoke test.
export function createShell(doc = document) {
  const el = (id) => doc.getElementById(id);
  let current = 'drive';
  let openId = null;

  function show(tab) {
    if (!TABS.includes(tab)) return;
    current = tab;
    for (const t of TABS) {
      el(`screen-${t}`).hidden = t !== tab;
      el(`tab-${t}`).setAttribute('aria-selected', String(t === tab));
    }
    // The HUD and the recenter FAB belong to the map, not to the page.
    el('hud').hidden = tab !== 'drive';
    el('fab-recenter').hidden = tab !== 'drive';
    try { localStorage.setItem(TAB_STORAGE_KEY, tab); } catch { /* private mode */ }
  }

  function openSheet(id) {
    if (openId) el(openId).hidden = true;
    openId = id;
    el(id).hidden = false;
    el('sheet-backdrop').hidden = false;
  }

  function closeSheet() {
    if (openId) el(openId).hidden = true;
    openId = null;
    el('sheet-backdrop').hidden = true;
  }

  function toast(id, text) {
    const t = el(id);
    if (text) t.textContent = text;
    t.hidden = !text;
  }

  el('sheet-backdrop').addEventListener('click', closeSheet);
  for (const t of TABS) el(`tab-${t}`).addEventListener('click', () => show(t));

  return { show, current: () => current, openSheet, closeSheet, toast };
}
