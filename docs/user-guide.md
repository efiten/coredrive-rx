# CoreDrive RX user guide

For people who drive or walk around with a companion radio to map coverage. Hosting the app
yourself is covered in the [README](../README.md#self-hosting-for-a-corescope-sysop).

## What it is

CoreDrive RX is a coverage mapper. Your MeshCore companion connects to the app over Bluetooth.
The app records which nodes your radio hears **directly**, with the signal strength (SNR/RSSI),
tags each reception with your phone's GPS position, and uploads it to CoreScope. CoreScope turns
that into per-node coverage hexes on its Reach page.

It records only what your own radio heard in one hop: a node's zero-hop advert, or the last
repeater that forwarded a flood packet to you. Nodes further up the path are ignored, so the map
shows real direct links and nothing inferred.

## What you need

- A MeshCore **companion** radio with Bluetooth (BLE) firmware.
- A browser with Web Bluetooth:
  - **Android:** Chrome.
  - **iPhone / iPad:** the [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055)
    browser. Safari and the other iOS browsers cannot do Web Bluetooth.
  - **Desktop:** Chrome or Edge (handy for testing).
- Location permission for the page, and a GPS fix. Without a position nothing is recorded.
- A mobile data connection now and then. Receptions are stored on the phone and uploaded when
  there is a connection, so dead zones are fine.

## Can I still chat?

Not with the same companion at the same time. A companion accepts one Bluetooth connection, and
while CoreDrive RX holds it, the MeshCore app cannot connect. Press **Disconnect** in Settings and
the MeshCore app can connect again. To map and chat at once you need a second companion.

## Does it transmit?

Yes, a little. It is not a pure listener:

- **Discover:** a zero-hop "who is there" request, at most every 30 seconds. It waits 15 seconds
  after any other traffic it hears, and stops while you are stationary.
- **Region questions:** a short request to repeaters it currently hears, asking which regions they
  serve. Limited per repeater so it stays within what the repeater firmware allows.
- **Uplink ping** (only when the deployment turns it on, as rx.on8ar.eu does): a channel message
  `cdrx <random tag>` on the `#coredrive` channel. At most one per minute, at least 250 m apart,
  50 per hour, and a spot already pinged in the last 7 days is skipped. It shows which repeaters
  and observers pick you up. On first use the app adds `#coredrive` to a free channel slot on your
  companion; it never overwrites a slot in use, and with no free slot pinging stays off.

Your position never goes over the mesh. It is only sent to CoreScope over the internet.

## Getting started

1. Open the app in Chrome (Android) or Bluefy (iOS). On Android you can install it to the home
   screen from the browser menu.
2. The app opens on **Settings**. Tap **Connect companion (BLE)** and pick your companion in the
   Bluetooth dialog.
3. Allow location access when asked.
4. The connection steps show their progress: companion, companion ID, CoreScope. Once connected
   the app switches to **Home**.
5. Start moving. The screen stays awake while capturing.

## The screens

**Home**
- Counters: distinct nodes, hex cells covered, total receptions.
- Status strip: GPS accuracy, receptions waiting to upload ("pending"), upload health and the age
  of the last upload, packets per minute.
- **Last reception:** SNR of the latest reception on a meter with a peak marker.
- **Recently heard nodes** with their latest SNR.
- A red warning when receptions are queued but not uploading, and a "Paused, stationary" line when
  you stand still (see below).

**Map:** the cells you covered in this session. They clear when you reload the page.

**Settings**
- **Connect / Disconnect.**
- **CoreScope:** broker status and **Push pending now** to upload the queue immediately.
- **CoreScope account** (only on deployments with user accounts): log in so the companions you
  connect are linked to your account and your coverage is attributed to you.
- **Companion:** name and details of the connected radio.
- **Capture:** *Sound ping when a node is mapped* gives a short beep per mapped reception, so you
  do not have to look at the phone.
- **Diagnostics:** debug log, **Share / mail debug log**, and **Uplink ping now** to send one ping
  by hand.

## Good to know

- **Standing still pauses capture.** After 5 minutes within 75 m of the same spot the app stops
  recording and stops sending discover requests. It resumes by itself as soon as you move.
- **Offline is fine.** Receptions are kept on the phone and uploaded later. They are only removed
  once the server has confirmed them.
- **More than one companion:** receptions are uploaded only while the companion that captured them
  is connected. Another companion's backlog waits until that one is connected again.
- **Phone GPS, not companion GPS.** The position always comes from the phone.

## When something is wrong

| Symptom | Check |
|---|---|
| "Web Bluetooth isn't available" | Wrong browser: use Chrome on Android, Bluefy on iOS. |
| Companion not in the Bluetooth list | Disconnect it in the MeshCore app first, or close that app. |
| Nothing is recorded | GPS fix (Home status strip), and whether you are paused as stationary. |
| Pending count keeps growing | Mobile data, then **Push pending now** in Settings. |
| Anything else | **Share / mail debug log** in Settings and send it to the operator of your deployment. |
