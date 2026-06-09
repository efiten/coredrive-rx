# corescope-rx — Implementation Plan (Plan 2: capture app)

> Companion app to CoreScope's "Plan 1" (server/ingestor side, already implemented). Interface =
> the MQTT contract in CoreScope `docs/client-rx-coverage.md`. This repo is NOT governed by
> CoreScope's AGENTS.md (separate project); it may use Vite + MQTT.js freely.

**Goal:** Android PWA that turns a BLE-connected MeshCore companion into a roaming coverage probe.

**Tech:** vanilla JS + Vite, Web Bluetooth, `navigator.geolocation`, IndexedDB, MQTT.js over WSS.

**Already scaffolded & unit-tested in this repo:**
- `src/meshpacket.js` — packet parse + `deriveHeardKey` (direct-only rule). Tested (`test/`).
- `src/frames.js` — 0x88 frame parse (snr/rssi/raw).
- `src/transport.js` — `WebBluetoothTransport` (NUS) behind a swappable interface.
- `src/gps.js`, `src/queue.js` (IndexedDB), `src/publisher.js` (MQTT), `src/app.js` (wiring + UI).

The plan below is finish + harden + verify, in dependency order. Each task: write test (where
testable) → implement → verify → commit.

---

## Phase 0 — Spikes (verify reality before hardening)

### Task 0.1: Web Bluetooth proof-of-connect (Android Chrome)
- Serve over HTTPS/localhost, run `npm run dev`, open on an Android phone.
- Click "Connect companion", pick the MeshCore device, confirm `characteristicvaluechanged`
  notifications arrive. Log raw frame bytes; confirm `0x88` frames appear with plausible snr/rssi.
- **Verify the NOTIFY characteristic UUID** (`src/transport.js` `NUS_NOTIFY` = `…003`). If wrong,
  fix from the actual GATT table. Confirm one notification == one full frame (no reassembly).
- Done when 0x88 frames decode to sane heard_keys via `meshpacket.js`.

### Task 0.2: SELF_INFO → companion pubkey
- On connect, send the companion `CMD_APP_START`/login then the SELF_INFO query; parse the response
  for the device pubkey (see firmware `examples/companion_radio/MyMesh.cpp` RESP frames + CoreScope
  `firmware/docs/companion_protocol.md`).
- Auto-fill `state.companionPubkey` and the topic; remove the manual pubkey field in the UI.
- Add `src/selfinfo.js` with a `requestSelfInfo(transport)` that resolves `{ pubkey, name }`; unit
  test the response parser against a captured RESP byte fixture.

### Task 0.3: EMQX WSS + ACL
- Enable the EMQX WebSocket/TLS listener (port 8084, path `/mqtt`).
- Create a per-client credential and an ACL that allows publish only to
  `meshcore/client/{itsOwnPubkey}/packets`.
- Confirm `publisher.connect()` + a test publish lands and is rejected for a foreign topic.
- Confirm CoreScope's ingestor (default `meshcore/#`) ingests it into `client_receptions`.

---

## Phase 1 — Harden the BLE transport

### Task 1.1: MTU + auto-reconnect
- Request a larger MTU where supported; the companion MAX_FRAME_SIZE is 176, so the default Android
  MTU is usually enough — verify large frames aren't truncated.
- Handle `gattserverdisconnected`: auto-reconnect with backoff, keep the IndexedDB buffer intact.
- Test: simulate disconnect (toggle BLE), assert capture resumes and no buffered rows are lost.

### Task 1.2: Frame-stream robustness
- Guard against malformed/short frames (already partially in `parseFrame`); add tests for truncated
  0x88 frames and non-0x88 codes (ignored).

---

## Phase 2 — Capture pipeline correctness

### Task 2.1: Local filter parity with the server
- Confirm `app.js` only enqueues when `deriveHeardKey` is non-null AND a GPS fix exists.
- Add a test that a `tx`/unattributable/no-fix frame produces no queue row. (The server re-derives
  authoritatively from `raw`; the local filter only saves bandwidth + drives the live counter.)

### Task 2.2: Dedup / idempotency
- The server dedups on `(rx_pubkey, heard_key, rx_at)`. Ensure `rx_at` is per-reception (ISO ms) so
  distinct receptions aren't collapsed; retries of the same buffered row are naturally idempotent.

---

## Phase 3 — Offline & publish reliability

### Task 3.1: Drain loop hardening
- `drainLoop` currently publishes all then deletes acked ids. Add: cap batch size, backoff on
  failure, and a connectivity listener (online/offline) to trigger an immediate drain on reconnect.
- Test the queue add → takeAll → remove cycle (fake IndexedDB or jsdom) and a publish-failure path
  that keeps rows buffered.

---

## Phase 4 — PWA & field UX

### Task 4.1: PWA installability
- Add `manifest.webmanifest` (name, icons, `display: standalone`) and a minimal service worker that
  caches the app shell (NOT the BLE/MQTT data). Wire `<link rel="manifest">`.
- Verify "Add to Home screen" works on Android and the app launches offline (shell only).

### Task 4.2: Field UI polish
- Show: connection state (BLE + MQTT), live "nodes heard" + "pending upload" counters (present),
  last GPS accuracy, and a simple recent-receptions list. Keep it glanceable for in-the-field use.
- Optional: a small local map of the current track (Leaflet) — defer if it bloats the bundle.

---

## Phase 5 — Verify end-to-end

### Task 5.1: Loopback test
- Point the app at a staging EMQX + a staging CoreScope ingestor. Walk a short route; confirm
  `client_receptions` fills with sane lat/lon/snr/rssi and that the Reach page coverage layer
  (`?coverage=1`) renders hexes for a node you heard.

### Task 5.2: README + screenshots
- Document the phone setup (HTTPS requirement, pairing, broker creds) and add a screenshot.

---

## Notes / open questions
- iOS later: implement `CapacitorBleTransport` with the same `connect()/onFrame()/send()` API; no
  other module changes.
- Signed identity (optional hardening): have the companion `sign()` a broker-issued nonce so identity
  is cryptographic, not just ACL-bound. Not needed for MVP.
- Bundle size: keep deps to MQTT.js only; avoid h3-js (server does the hex binning).
