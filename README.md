# coredrive-rx

Mobile RX-coverage capture for [CoreScope](https://github.com/Kpa-clawbot/CoreScope). A mobile PWA
that connects over BLE to a MeshCore **companion** radio, captures which nodes it hears (SNR/RSSI),
tags each reception with the phone's GPS, and publishes to MQTT so a CoreScope ingestor stores it in
`client_receptions` and renders per-node hex coverage on the Reach page.

## Supported browsers

The app needs **Web Bluetooth**, which not every browser has:

- **Android:** Chrome.
- **iOS / iPadOS:** the **[Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055)**
  browser — Safari (and every other normal iOS browser) has **no Web Bluetooth**, so the app cannot
  connect there. Opening the app in plain iOS Safari shows an in-app notice pointing to Bluefy.
- **Desktop (for testing):** Chrome or Edge.

The screen is kept awake while capturing (native Screen Wake Lock where available, with a video
fallback for Bluefy), so the phone won't dim/lock mid-drive.

## How it works

```
companion ──BLE 0x88 (snr+rssi+raw)──▶ frames.js ──▶ meshpacket.js (path[last] / advert pubkey)
                                                          │
phone GPS (gps.js) ───────────────────────────────────────┤
                                                          ▼
                                          queue.js (IndexedDB, offline) ──▶ publisher.js (MQTT/WSS)
                                                          │
                                          meshcore/client/{PUBLIC_KEY}/packets ──▶ CoreScope ingestor
```

- **Capture source:** the companion's `PUSH_CODE_LOG_RX_DATA` (0x88) frame — emitted for every
  received packet on stock firmware, carrying SNR + RSSI + the raw packet.
- **Direct-only rule:** records only `path[last]` (last forwarder, FLOOD routes) or a 0-hop advert's
  full pubkey. Upstream hops are discarded.
- **Auto-discover:** a zero-hop node-discover request is sent automatically while connected so nodes
  in direct range reply with their ID. It backs off for 15 s whenever organic traffic is overheard
  (no point polling a busy channel) and is suspended while stationary.
- **GPS:** the phone's (`navigator.geolocation`), not the companion's.
- **Trust:** the companion pubkey is the identity; the EMQX ACL binds each client to its own topic.

## Screens

- **🏠 Home** — a live monitor: session counters (distinct nodes / hex cells covered / total
  receptions), a status strip (GPS accuracy, pending uploads, upload health + last-upload age,
  capture rate), the last reception's SNR on a peak-hold meter, and the recently-heard list.
- **🗺️ Map** — live per-cell coverage for this session.
- **⚙️ Settings** — the **Connect/Disconnect** button (with connection progress), CoreScope broker
  status + a **Push pending now** button, the **CoreScope account** card (only when CoreScope has
  user management on, see section 7), companion info, and diagnostics (verbose toggle, debug log,
  share/mail the log). The app opens here until a companion is connected, then jumps to Home.

## Self-hosting (for a CoreScope sysop)

You host this app for your own CoreScope environment so your users can contribute RX coverage. There
is **no central server** — you point the app at your own MQTT broker and CoreScope.

### 1. Prerequisites
- A running **CoreScope** deployment with its ingestor.
- An **MQTT broker (EMQX)** reachable over **WSS with a valid TLS certificate** — Web Bluetooth and
  PWA install both require a secure (HTTPS) context. Connect via the hostname (not an IP).

### 2. EMQX: a publish-only account
Create a dedicated account and an ACL so a client can only publish to its own topics:
- **Allow** `publish` to `meshcore/client/${clientid}/packets` — receptions (always used)
- **Allow** `publish` to `meshcore/client/${clientid}/rf` — RF samples (`rfSampler`, on by default)
- **Allow** `publish` to `meshcore/client/${clientid}/regions` — region answers (`regionDiscovery`)
- **Deny** everything else (publish `#`, subscribe `#`)
- Enable the WebSocket/TLS listener (default port `8084`, path `/ws`).

> **All three subtopics belong in the ACL from the start**, even if you intend to leave a
> feature off: the flags default to on, so a client will try. What a denied publish does
> depends on your EMQX `authorization.deny_action` — with the default `ignore` the message
> is silently dropped and still PUBACKed (the app logs `published N record(s)` while the
> server stores nothing, see the flag warnings below); with `disconnect` the broker **kicks
> the client**, which produces an endless connect→drop→reconnect loop and a queue that never
> drains. Adding the rules up front avoids both.

The app sets `clientId` = the companion's pubkey, so the ACL binds each user to their own topic.

### 3. CoreScope server
- Enable the coverage screen via its config flag (see CoreScope docs).
- Ensure the ingestor subscribes to the client topic (`meshcore/#` or `meshcore/client/#`) so
  receptions land in `client_receptions`.

### 4. Get the app and host it
Choose **(A) a prebuilt release** (no Node/npm) or **(B) build from source**:

**(A) Download a release — recommended, no build:**
Grab `coredrive-rx-<version>.zip` from
[Releases](https://github.com/efiten/coredrive-rx/releases) and unzip it into your web root.

**(B) Build from source:**
```bash
npm install
npm run build          # outputs static files to dist/
```
Copy the contents of `dist/` to your web root.

Either way, serve the files over **HTTPS on a subdomain** (e.g. `rx.yourdomain`). Requirements:
- **SPA fallback:** unknown paths serve `/index.html` (e.g. nginx `try_files $uri /index.html;`).
- **Cache headers:** `index.html`, `sw.js`, the web-app manifest, and **`config.json`** = `no-cache`;
  `/assets/*` = immutable. Without this, a cached `index.html` pins old assets after an update.

### 5. config.json (runtime config — no rebuild to change)
Put a `config.json` in the served directory (next to `index.html`). Start from the example:
```json
{
  "mqttUrl": "wss://broker.yourdomain:8084/ws",
  "mqttUsername": "coredrive-rx",
  "mqttPassword": "<your publish-only EMQX account password>",
  "resolveUrl": "https://corescope.yourdomain/api/nodes/resolve",
  "corescopeUrl": "https://corescope.yourdomain",
  "fullRfLog": true,
  "rfSampler": true,
  "regionDiscovery": true,
  "verifyAdverts": false
}
```
> `mqttPassword` is a **publish-only, ACL-constrained** account — it is shipped to browsers, so treat
> it as shared, not a secret. `resolveUrl` is optional (see CORS below); omit it and the app shows
> heard-key prefixes instead of node names. `fullRfLog` is optional and **defaults to `true` when the key is absent**; when on,
> packets the direct-only rule can't attribute (a DIRECT-route path, or noise) are queued and
> published too, as diagnostic-only rows — never coverage. **This is pure waste unless the CoreScope
> ingestor also has `clientRxObservations.enabled: true`**: with it off, the ingestor decodes and
> discards every one of these packets, writing no row and logging no warning, while `fullRfLog`
> multiplies your normal upload volume. Confirm the ingestor-side flag with your CoreScope sysop
> before turning this on. `rfSampler` is optional and **defaults to `true` when the key is absent**; when on, the app polls the
> companion's own radio counters (noise floor, RX/TX airtime, CRC errors) over local Bluetooth and
> publishes them on `meshcore/client/<pubkey>/rf`. **Enable it only after your broker's ACL permits
> that `/rf` subtopic for this client** — this app negotiates MQTT 3.1.1, whose PUBACK carries no
> reason code, so a publish denied by the ACL is still acknowledged: the app logs `published N
> record(s)` and looks healthy while the server receives zero rows. Confirm the topic is allowed
> (and that the CoreScope ingestor has `clientRfSamples.enabled: true`) with your CoreScope sysop
> before turning this on. `regionDiscovery` is optional and **defaults to `true` when the key is absent from an existing `config.json`** (but never when no config loaded at all — see below); when on, this is the
> **only** part of the app that transmits: once connected it addresses one repeater at a time,
> round-robin, asking for its declared flood-allowed region list roughly every 60 seconds, and
> publishes the answer on `meshcore/client/<pubkey>/regions`. It requires companion firmware **v13+**
> — on older firmware the app logs why and never sends. **Enable it only after your broker's ACL
> permits that `/regions` subtopic for this client**, for the same silent-PUBACK reason as `rfSampler`
> above. Confirm the topic is allowed (and that the CoreScope ingestor has `clientRegions.enabled:
> true`) with your CoreScope sysop before turning this on — otherwise the ingestor decodes and
> discards every upload, same as `fullRfLog` off. `verifyAdverts` is optional and **defaults to
> `false`, absent or not** (the one flag that does — see below); when on, a 0-hop advert's Ed25519
> signature is checked against the bytes the firmware signed before its pubkey is recorded as the
> node heard. An advert that fails loses its identity: the reception is still published, with its
> SNR, RSSI and position, but unattributed, and the node is not asked for its regions either. This
> costs nothing on the air and runs on roughly 3% of captured traffic, but it is the only flag that
> makes the app record **less** than it heard, so turn it on deliberately.

> **Why an absent flag means ON — and the two places it does not.** An absent flag used to mean
> off, which made two failures invisible: a `config.json` cached before these keys existed
> reported the features off while the served file said on, and a config that failed to fetch
> stopped data *collection* as well as uploading. Data never collected is gone for good; data
> collected and discarded server-side costs only bandwidth. So in a `config.json` that **exists**,
> silence on any of the three flags is read as "on", and an explicit `false` always wins. Set them
> to `false` if your ingestor or broker ACL is not ready — per the warnings above the uploads are
> otherwise pure volume.
>
> When **no config has loaded at all** (a cold start with no connection — `config.json` is
> deliberately never served from the offline cache), the two logging flags still apply, so the
> session keeps capturing and the queue publishes once config arrives. `regionDiscovery` does
> **not**: it is the only feature that TRANSMITS, and repeaters rate-limit anonymous requests to
> 4 per 180 s shared across every requester and type — one client asking once a minute already
> claims most of that budget. An existing `config.json` is a deployment whose operator owns the
> repeaters being asked; no config means the app knows nothing about whose mesh it is on.
> Collecting on an assumption spends your own bandwidth, transmitting on one spends a stranger's
> airtime, so only the former is assumed.
>
> `verifyAdverts` is the second exception, and the only flag that is off in **both** cases. The rule
> above assumes more data is the safe default; this flag inverts that, because a failed check
> removes an identity the capture would otherwise have recorded. Inheriting that silently would look
> like adverts going missing, so it is opt-in.

Changing any value later is just a `config.json` edit + page refresh — no rebuild.

> **`config.json` is never cached offline, so starting the app needs a live connection once.**
> The service worker deliberately excludes it (both directions): a copy cached in an earlier
> era silently disables every flag added since, because an absent flag normalizes to `false`.
> That failure is invisible — it looks exactly like the feature being broken — whereas *no*
> config is a state the app detects, warns about on the Home screen, and retries (every minute
> and on the `online` event) until it loads. Capture and buffering are unaffected by a cold
> start with no network; only uploading waits, and the queue drains as soon as config arrives.
>
> Because the effective flags are what matter, they are stamped into the header of every
> exported debug log (**Share log** in Settings), together with the app version, the companion
> firmware version, whether region discovery can transmit at all, and the queue depth. Compare
> that header against the served `config.json` to spot a client running on something else.

### 6. CORS (optional, for node names)
The app calls CoreScope's `GET /api/nodes/resolve?prefix=…` cross-origin. Set `resolveUrl` to either:
- a **CORS-enabled reverse-proxy** location in front of the CoreScope API (adds
  `Access-Control-Allow-Origin` for the app's origin), or
- the CoreScope API directly, if it already sends CORS headers for your app's origin.

Leave `resolveUrl` empty to disable name resolution entirely.

### 7. CoreScope accounts and companion linking (optional)
When your CoreScope has user management on (`userManagement.enabled`, with companion linking,
sub-project F), Settings shows a **CoreScope account** card. A user logs in with their CoreScope
email and password; the app stores only a device token (it appears under **Devices** on their
CoreScope account page and can be revoked there). Every companion they connect while logged in is
linked to their account: the companion signs a server challenge with its own key, so only someone
holding the companion can link it. Linked companions show under **Companions** on the user's
CoreScope account page, and the coverage they collect is attributed to that user. The MQTT topics and payload do not change.

- `corescopeUrl` (optional) is CoreScope's origin. Without it the app uses the origin of
  `resolveUrl`; set it when `resolveUrl` goes through a proxy. It does not have to match
  CoreScope's `publicBaseUrl`: CoreScope tells the app which host to sign.
- When this app runs on another origin than CoreScope, add this app's origin to CoreScope's
  `corsAllowedOrigins`. Without it the card stays hidden and the debug log says why.
- If CoreScope has `clientRxCoverage.requireLinkedCompanion` on, it drops data from unlinked
  companions. The app then holds an unlinked companion's queue (nothing is lost) and sends it once
  the companion is linked. Upgrade every client to v1.19.0 or later before turning that on.

```
## Develop

```bash
npm install
cp public/config.example.json public/config.json   # fill in your dev broker; gitignored
npm run dev      # Vite dev server (Android Chrome; Web Bluetooth needs HTTPS or localhost)
npm test         # node --test
```

Web Bluetooth requires a secure context (HTTPS or `localhost`). For phone testing over LAN, serve via
HTTPS (e.g. a dev tunnel) — Chrome blocks Web Bluetooth on plain HTTP origins.

## Deploy

Two optional SSH helpers — both leave the server's `config.json` intact:

**From a prebuilt release — no Node/npm** (`deploy-release.sh`, needs only `curl` + `unzip`):
```bash
RX_DEPLOY_HOST=user@host RX_DEPLOY_DEST=/var/www/rx.yourdomain/ bash deploy-release.sh
# defaults to the latest release; pin one with  RX_VERSION=v0.9.0
```
Downloads the latest release zip and `scp`s the static files to the host. The release zip
contains no `config.json`, so your server config is never overwritten.

**From source** (`deploy.sh`, builds locally then uploads):
```bash
RX_DEPLOY_HOST=user@host RX_DEPLOY_DEST=/var/www/rx.yourdomain/ npm run deploy
```
Builds, drops `dist/config.json`, and uploads `dist/` — never touching the server's `config.json`.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). Companion to
[CoreScope](https://github.com/Kpa-clawbot/CoreScope).
