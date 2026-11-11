// Update notice for the Android app. Google Play updates apps silently, often a day later,
// and a GitHub APK never updates by itself, so the app says when a newer version exists.
//
// Two sources, in order:
//   1. Google Play's in-app update check. It only answers for an install from Play; then
//      it decides alone, also when it says "no update yet" (Play may still be rolling out).
//   2. Otherwise (a GitHub APK, or Play could not be asked): version.json of the
//      deployment the app uses, written by every web build (vite.config.js).

export const PLAY_UPDATE_AVAILABLE = 2; // AppUpdateAvailability.UPDATE_AVAILABLE
export const RELEASES_URL = 'https://github.com/efiten/coredrive-rx/releases';

// cmpVersion compares "x.y.z" strings: >0 when a is newer. Anything unparsable is 0.
export function cmpVersion(a, b) {
  const p = (v) => (/^\d+\.\d+\.\d+$/.test(String(v)) ? String(v).split('.').map(Number) : null);
  const x = p(a), y = p(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// updateNotice returns { kind: 'play' | 'info', text } or null.
//   play: the Play update info, or null when Play could not be asked (not a Play install)
//   deployVersion: version from the deployment's version.json, or null
export function updateNotice({ appVersion, play, deployVersion }) {
  if (play) {
    if (play.updateAvailability !== PLAY_UPDATE_AVAILABLE) return null;
    return { kind: 'play', text: 'A new version of CoreDrive RX is ready in Google Play. Tap to update.' };
  }
  if (cmpVersion(deployVersion, appVersion) <= 0) return null;
  return {
    kind: 'info',
    text: 'CoreDrive RX ' + deployVersion + ' is out, you have ' + appVersion + '. Update in Google Play, or install the APK from '
      + RELEASES_URL + '. Tap to dismiss.',
  };
}

// parseVersionJson reads {"version":"x.y.z"}; null for anything else.
export function parseVersionJson(text) {
  try {
    const v = JSON.parse(text).version;
    return cmpVersion(v, v) === 0 && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch (e) { return null; }
}
