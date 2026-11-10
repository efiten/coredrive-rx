# CoreDrive RX privacy policy

Last updated: 2026-11-10

CoreDrive RX is a companion app for [CoreScope](https://github.com/Kpa-clawbot/CoreScope). It
connects over Bluetooth to a MeshCore companion radio, records which MeshCore nodes that radio
hears directly and where, and uploads those records to a CoreScope server. This policy covers the
web app and the Android app.

## Who receives your data

CoreDrive RX has no server of its own. Everything it uploads goes to the **CoreDrive RX
deployment you choose**: on first start the Android app asks for its address, and the web app is
that deployment. Each deployment belongs to the operator of a CoreScope server, who decides how
long the data is kept and who can see it. Ask that operator about their own policy.

For the deployment at `rx.on8ar.eu` (CoreScope at `analyzer.on8ar.eu`) the operator is ON8AR;
contact details are at the end of this policy.

## What the app sends to that deployment

- **Receptions:** for each radio packet your companion hears, the raw packet bytes as received,
  signal strength (SNR, RSSI), the time, and your phone's position with its accuracy. Packets on
  a MeshCore mesh can carry messages of other people; private messages are encrypted and the app
  does not decrypt them.
- **Radio measurements:** noise floor, airtime and packet counters of your companion, with time
  and position.
- **Node information:** names and regions that repeaters report about themselves, and the
  results of uplink pings (whether the mesh heard your companion), with time and position.
- **Your companion's public key and name.** These identify the radio that made the recording.
- **Account login (optional):** if you log in to a CoreScope account, your email address and
  password go to that CoreScope server once; the app then keeps only the access token it gets
  back.

All of this travels encrypted (HTTPS and MQTT over TLS).

## What stays on your phone

Records waiting for upload, your settings, the deployment address and the login token are stored
in the app's own storage on the phone. Uninstalling the app or clearing its data removes them.

## Location

The app uses your precise location to place each reception on a map. On Android it keeps a
location service running while you capture, so recording continues with the screen off; a
notification shows while it runs. Without location nothing is recorded.

## Other services the app contacts

- **OpenStreetMap** (`tile.openstreetmap.org`) for the map tiles on the Map screen. Like any
  website, it sees your IP address and which map area is loaded.
- **unpkg** (`unpkg.com`) for the map library.
- **Google Play services** on Android, only when you scan a QR code. The scanning happens on the
  phone; the app receives only the decoded text and has no camera permission of its own.

## What the app does not do

No advertising, no analytics or tracking, no sale of data. The debug log only leaves the phone
when you share it yourself.

## Deleting your data

To have records removed from a deployment, contact its operator. For `rx.on8ar.eu`, write to the
address below with your companion's name and the start of its public key (shown in the app
under Settings, Companion, while it is connected).

## Contact

ON8AR: CONTACT_EMAIL
