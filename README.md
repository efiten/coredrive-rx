# coredrive-rx

Mobile RX-coverage capture for [CoreScope](https://github.com/Kpa-clawbot/CoreScope). An Android PWA
that connects over BLE to a MeshCore **companion** radio, captures which nodes it hears (SNR/RSSI),
tags each reception with the phone's GPS, and publishes to MQTT so a CoreScope ingestor stores it in
`client_receptions` and renders per-node hex coverage on the Reach page.

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
- **GPS:** the phone's (`navigator.geolocation`), not the companion's.
- **Trust:** the companion pubkey is the identity; the EMQX ACL binds each client to its own topic.

## Self-hosting (for a CoreScope sysop)

You host this app for your own CoreScope environment so your users can contribute RX coverage. There
is **no central server** — you point the app at your own MQTT broker and CoreScope.

### 1. Prerequisites
- A running **CoreScope** deployment with its ingestor.
- An **MQTT broker (EMQX)** reachable over **WSS with a valid TLS certificate** — Web Bluetooth and
  PWA install both require a secure (HTTPS) context. Connect via the hostname (not an IP).

### 2. EMQX: a publish-only account
Create a dedicated account and an ACL so a client can only publish to its own topic:
- **Allow** `publish` to `meshcore/client/${clientid}/packets`
- **Deny** everything else (publish `#`, subscribe `#`)
- Enable the WebSocket/TLS listener (default port `8084`, path `/ws`).

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
  "resolveUrl": "https://corescope.yourdomain/api/nodes/resolve"
}
```
> `mqttPassword` is a **publish-only, ACL-constrained** account — it is shipped to browsers, so treat
> it as shared, not a secret. `resolveUrl` is optional (see CORS below); omit it and the app shows
> heard-key prefixes instead of node names.

Changing any value later is just a `config.json` edit + page refresh — no rebuild.

### 6. CORS (optional, for node names)
The app calls CoreScope's `GET /api/nodes/resolve?prefix=…` cross-origin. Set `resolveUrl` to either:
- a **CORS-enabled reverse-proxy** location in front of the CoreScope API (adds
  `Access-Control-Allow-Origin` for the app's origin), or
- the CoreScope API directly, if it already sends CORS headers for your app's origin.

Leave `resolveUrl` empty to disable name resolution entirely.

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
