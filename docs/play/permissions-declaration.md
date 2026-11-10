# Play Console: permissions and foreground service declaration

## What the app requests (merged release manifest, 2026-11-10)

| Permission | From | Use |
|---|---|---|
| ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION | background-geolocation plugin | Position of each reception |
| FOREGROUND_SERVICE, FOREGROUND_SERVICE_LOCATION | background-geolocation plugin | Keep location updates while the screen is off |
| POST_NOTIFICATIONS | app / plugin | The ongoing notification of that service; direct message notice |
| BLUETOOTH_SCAN, BLUETOOTH_CONNECT (BLUETOOTH, BLUETOOTH_ADMIN on Android 11 and older) | bluetooth-le plugin | Find and link to the MeshCore companion radio |
| INTERNET, ACCESS_NETWORK_STATE | Capacitor | Upload to CoreScope, map tiles |

**Not requested:** ACCESS_BACKGROUND_LOCATION. Location runs in a foreground service started
while the app is in use, so the separate background location declaration should not apply. The
foreground service declaration below does.

## Foreground service declaration (type: location)

Play asks, per foreground service type, what the feature does, why it must run in the
foreground, and for a video.

**Feature description**

CoreDrive RX maps the radio coverage of a MeshCore mesh network. While the user drives or walks
with a MeshCore companion radio connected over Bluetooth, the app records each radio packet the
radio hears directly together with the phone's current position, and uploads these records to the
CoreScope server the user chose. The user starts capturing with "Connect companion (BLE)" and stops it
with "Disconnect"; a notification shows while capturing runs.

**Why it needs a foreground service**

Users capture while driving, usually with the phone in a holder and the screen off. Without the
location foreground service the system stops location updates as soon as the screen turns off,
and every reception after that is recorded without a position, which makes it useless for the
coverage map. The service runs only between Connect and Disconnect, which the user starts and
stops.

**What happens if it is denied**

Capturing still works with the screen on. With the screen off, receptions get no position and are
not recorded.

**Video (to record)**

1. Open the app, tap Connect companion, pick the radio, allow location.
2. Show the notification that appears.
3. Turn the screen off for a minute while moving, turn it on, show new receptions on Home with
   their times.
4. Tap Disconnect and show the notification is gone.

Upload as an unlisted YouTube video and paste the link in the form.
