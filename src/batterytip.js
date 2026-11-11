// One-time battery tip for the Android app. Some phones close apps in the background to
// save battery even while the capture notification shows (a OnePlus logged "o-kill" with
// the foreground service running). The app cannot prevent that without an extra
// permission, so it tells the user once, before the first Connect, which setting to change.

export const BATTERY_TIP_KEY = 'coredrive.batterytip.seen';

export function needsBatteryTip(storage, native) {
  if (!native) return false;
  try { return storage.getItem(BATTERY_TIP_KEY) !== '1'; } catch (e) { return false; }
}

export function markBatteryTipSeen(storage) {
  try { storage.setItem(BATTERY_TIP_KEY, '1'); } catch (e) { /* shown again next time */ }
}
