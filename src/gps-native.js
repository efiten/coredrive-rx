// Phone GPS for the native (Capacitor) app, same API as Gps (src/gps.js). Uses
// @capacitor-community/background-geolocation: with a backgroundMessage set it runs
// a foreground service (persistent notification), so fixes keep coming with the
// screen off or another app in front. That is the reason the native app exists.
// The plugin object is injected (src/platform.js) so this file is testable in Node.

export const BACKGROUND_TITLE = 'CoreDrive RX is mapping';
export const BACKGROUND_MESSAGE = 'Recording coverage. Disconnect in the app to stop.';

export class NativeGps {
  constructor(plugin, notifications) { this.plugin = plugin; this.notifications = notifications; this._last = null; this._watchId = null; }

  async start(onFix) {
    // Android 13+ hides the foreground service notification until the user allows
    // notifications, and the location plugin does not ask. A refusal must not stop
    // capture: the service runs either way.
    if (this.notifications) await this.notifications.requestPermissions().catch(() => {});
    this._watchId = await this.plugin.addWatcher(
      {
        backgroundTitle: BACKGROUND_TITLE,
        backgroundMessage: BACKGROUND_MESSAGE,
        requestPermissions: true,
        stale: false,
        distanceFilter: 0,
      },
      (loc, err) => {
        if (err || !loc) return;
        this._last = { lat: loc.latitude, lon: loc.longitude, acc_m: loc.accuracy };
        if (onFix) onFix(this._last);
      },
    );
  }

  stop() {
    if (this._watchId != null) this.plugin.removeWatcher({ id: this._watchId }).catch(() => {});
    this._watchId = null;
  }

  latest() { return this._last; }
}
