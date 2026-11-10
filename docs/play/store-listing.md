# Play Console: store listing

## App details

- **App name** (max 30): CoreDrive RX
- **Short description** (max 80): Map MeshCore radio coverage while you drive, with your companion radio.
- **Category:** Tools
- **Contact email:** erwin@fiten.eu
- **Website:** https://github.com/efiten/coredrive-rx
- **Privacy policy:** https://github.com/efiten/coredrive-rx/blob/master/docs/play/privacy-policy.md

## Full description (max 4000)

CoreDrive RX maps where a MeshCore mesh network can be heard.

Connect your MeshCore companion radio over Bluetooth and drive, cycle or walk. The app records
every node your radio hears directly, with signal strength and your position, and uploads it to
a CoreScope server. CoreScope turns those records from all users into coverage maps.

What it records:
- Which repeaters and nodes your companion hears directly, with SNR and RSSI
- The radio's noise floor along your route
- Whether the mesh hears you back (uplink pings)
- Names and regions repeaters report about themselves

How it works:
- Choose your CoreScope deployment: type its address, or scan the QR code on the CoreScope
  Coverage page
- Tap Connect companion and pick your radio
- Capture keeps running with the screen off; a notification shows while it runs
- No signal? Records wait on the phone and upload when you are back online

You need a MeshCore companion radio with Bluetooth firmware and a CoreScope deployment that
accepts uploads. The app has no server of its own, no ads and no tracking.

CoreDrive RX is open source: https://github.com/efiten/coredrive-rx

## Graphics

| Asset | Size | Source |
|---|---|---|
| App icon | 512x512 PNG | `public/icon-512.png` |
| Feature graphic | 1024x500 PNG | `docs/play/feature-graphic.png` (scripts/play-graphics.ps1) |
| Phone screenshots | 2 to 8, max 2:1 | `docs/play/screenshots/*.png`, 1080x1920 (9:16): Home, Map, Settings with made-up demo data, rendered by headless Chrome at phone size (432x768 CSS px, 2.5x) |
