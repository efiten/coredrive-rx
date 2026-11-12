// The deployment the native app works for. The web app reads the config.json served
// next to its own index.html; the Android app has no such neighbour, so the user
// gives it the URL of a CoreDrive RX web deployment (https://rx.on8ar.eu) and the app
// reads that deployment's config.json. One APK then serves every deployment, and no
// broker login is ever built into it.
//
// No DOM and no Capacitor here: storage and the HTTP call are passed in.
import { parseConfigText } from './config.js';

export const DEPLOY_KEY = 'coredrive.deployment';
export const DEPLOY_CACHE_KEY = 'coredrive.deploymentConfig';

// normalizeDeploymentUrl returns the deployment folder as https://host/path/ (always
// a trailing slash), or '' when the input is not usable. A missing scheme means
// https; plain http is refused because config.json carries the broker login. A
// pasted link to index.html or config.json resolves to its folder.
export function normalizeDeploymentUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (e) { return ''; }
  if (u.protocol !== 'https:' || !u.hostname) return '';
  let path = u.pathname;
  if (/\.(html?|json)$/i.test(path)) path = path.slice(0, path.lastIndexOf('/') + 1);
  if (!path.endsWith('/')) path += '/';
  return u.origin + path;
}

export function deploymentConfigUrl(base) { return base + 'config.json'; }

export function readDeployment(storage) {
  try { return normalizeDeploymentUrl(storage.getItem(DEPLOY_KEY)); } catch (e) { return ''; }
}

// deploymentCardText is what the Settings card says. Without a deployment the card
// stands out and shows the steps (index.html #deploySteps); with one it is a single line.
export function deploymentCardText(base) {
  if (!base) {
    return {
      setup: true,
      title: 'First step: choose where your data goes',
      info: 'No Coverage in the menu, or no QR code on it? Then that CoreScope does not take CoreDrive data: ask whoever runs it.',
    };
  }
  return {
    setup: false,
    title: 'Deployment: where your data goes',
    info: 'Uploads to ' + base + '. To change it, scan the QR code on another CoreScope\'s Coverage page.',
  };
}

// deploymentChoice decides what choosing `next` does. Switching restarts the app, which
// drops the companion link and clears the log, so the same deployment changes nothing
// and a different one asks first while connected.
//   'same' | 'confirm' | 'switch'
export function deploymentChoice(current, next, connected) {
  if (current && current === next) return 'same';
  return connected ? 'confirm' : 'switch';
}

// saveDeployment stores the chosen deployment. A different one drops the cached
// config, so the old deployment's broker can never be used as the new one's fallback.
export function saveDeployment(storage, base) {
  if (readDeployment(storage) !== base) storage.removeItem(DEPLOY_CACHE_KEY);
  storage.setItem(DEPLOY_KEY, base);
}

function readCache(storage, base) {
  try {
    const c = JSON.parse(storage.getItem(DEPLOY_CACHE_KEY) || 'null');
    return c && c.base === base && typeof c.text === 'string' ? c.text : null;
  } catch (e) { return null; }
}

// fetchDeploymentConfigText fetches <base>config.json with httpGet(url) →
// { status, data }, checks that it is a usable config and caches it. When the fetch or
// the check fails, the last good config of the same deployment is returned instead
// (cached: true, with the error), so a start without network still uploads once the
// network is back. Without such a cache the error is thrown.
export async function fetchDeploymentConfigText({ base, httpGet, storage }) {
  try {
    const res = await httpGet(deploymentConfigUrl(base));
    if (res.status !== 200) throw new Error('config.json not found at ' + base + ' (HTTP ' + res.status + ')');
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    parseConfigText(text);
    try { storage.setItem(DEPLOY_CACHE_KEY, JSON.stringify({ base, text })); } catch (e) { /* storage full: still usable now */ }
    return { text, cached: false };
  } catch (error) {
    const text = readCache(storage, base);
    if (text === null) throw error;
    return { text, cached: true, error };
  }
}
