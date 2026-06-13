# corescope-rx — public release design (SP4)

**Date:** 2026-06-13
**Goal:** Make `corescope-rx` a public, generic, self-hostable companion app for any CoreScope
deployment — removing all deployment-specific (on8ar) values, documenting a step-by-step sysop
install, adding contributor rules (AGENTS.md) and a GPLv3 license.

This is sub-project **SP4** of the larger effort (the others: SP1 fork v3.9.2 merge, SP2 server
config-gating of the coverage screen, SP3 upstream PR of the coverage feature). SP4 is independent
and ships first because SP3's install docs link to this public repo.

## Background

`corescope-rx` is an Android PWA (Vite + vanilla JS + MQTT.js) that connects over BLE to a MeshCore
companion radio, captures directly-heard nodes (SNR/RSSI) tagged with the phone's GPS, and publishes
to MQTT so a CoreScope ingestor stores it in `client_receptions` and renders per-node hex coverage.
It currently lives in a **private** repo and is hard-wired to one deployment.

Config model is **runtime `config.json`**: the app ships as a prebuilt static bundle and fetches a
`config.json` (sitting next to `index.html`) at startup. All per-deployment values live there — no
build needed to configure, no values baked into the bundle, no source edits. A sysop drops in their
`config.json` and serves the files; changing a value is a file edit + refresh. The publish credential
is a shared, publish-only MQTT account constrained by an EMQX ACL, not a real secret (soft
attribution; companion-signed challenge is a later hardening). No in-app settings screen.

(This supersedes the earlier build-time `VITE_*` model the app was first built with — `VITE_*`/`.env`
for deployment config is removed.)

## Scope (what changes)

### A. Runtime config (single source: `config.json`)
Switch from build-time `VITE_*` to a runtime `config.json` the app fetches at startup. Sysops never
edit source and never build to configure.

- **New `src/config.js`** — a loader that `fetch`es `config.json` (relative to the app root) once at
  startup and exposes the parsed object to the rest of the app. App init **awaits** it before
  connecting MQTT. If `config.json` is missing or invalid, show a clear in-app error (what file is
  expected and where) instead of failing silently.
- **`public/config.example.json`** (committed) — documented placeholders:
  ```json
  {
    "mqttUrl": "wss://broker.example:8084/ws",
    "mqttUsername": "corescope-rx",
    "mqttPassword": "<publish-only EMQX account password>",
    "resolveUrl": "https://corescope.example/api/nodes/resolve"
  }
  ```
  `resolveUrl` is optional — empty/absent disables node-name resolution (UI shows the heard-key
  prefix instead of a name). The real `config.json` is **gitignored** (it holds the publish
  password); sysops copy the example to `config.json` and fill it in.
- **`src/publisher.js`, `src/names.js`, `src/app.js`** — read `mqttUrl`/`mqttUsername`/`mqttPassword`
  and `resolveUrl` from the loaded config object. Remove the hardcoded `BASE` in `names.js` and all
  `import.meta.env.VITE_MQTT_*` usage.
- **Remove `VITE_*`/`.env` deployment machinery** — delete `.env.example`/`.env.local` usage for
  config; `.gitignore` ignores `config.json` (and `public/config.json` used for local dev).
  `vite.config.js` keeps only the version `define` (`__APP_VERSION__` from `package.json`), no MQTT.
- **Dev** — a gitignored `public/config.json` (copied from `config.example.json`) is served by the
  Vite dev server, so `npm run dev` works the same as prod with zero build-time secrets.
- **`deploy.sh`** — fully env-driven (`RX_DEPLOY_HOST`, `RX_DEPLOY_DEST`, `RX_DEPLOY_KEY`); strip
  deployment-specific host/path/URL; document as an *example* helper. It uploads `dist/` but must
  **not** overwrite the server's `config.json` (the sysop owns that file on the host).
- **`package.json`** — `"private": false` (or remove), add `license` (GPL-3.0-or-later),
  `repository`, `homepage`/`bugs`.

**Sysop flow is config-only:** either build once (`npm install && npm run build`) or take a release
artifact → host the static files over HTTPS → drop in `config.json`. No source file is ever touched;
changing a value is a `config.json` edit + page refresh (no rebuild).

### B. README rewrite — generic + sysop self-host howto
Sections:
1. **What it is / how it works** — keep the existing ASCII data-flow diagram (already generic).
2. **Self-host howto** (the core deliverable), step by step:
   1. **Prereqs** — a running CoreScope deployment; an MQTT broker (EMQX) reachable over **WSS with
      a valid TLS cert** (Web Bluetooth and PWA install both require a secure context).
   2. **EMQX** — create a publish-only account + ACL: `allow publish meshcore/client/${clientid}/packets`,
      deny everything else; enable the WSS listener (default port 8084, path `/ws`).
   3. **CoreScope server** — enable the coverage screen via its config flag (delivered by SP2) and
      ensure the ingestor subscribes to the client topic (`meshcore/#` or `meshcore/client/#`) so
      receptions land in `client_receptions`.
   4. **Host the app** — `npm install && npm run build` (or grab a release artifact), serve the
      static files over **HTTPS on a subdomain** (e.g. `rx.<yourdomain>`), then drop in `config.json`
      (copy `config.example.json`, fill in MQTT URL/account/password + optional `resolveUrl`). SPA
      fallback (`try_files … /index.html`). Cache headers: `index.html` + `sw.js` + `manifest` +
      **`config.json`** = `no-cache`; `/assets/` = immutable — so new builds and config edits reach
      clients instead of a pinned stale copy.
   5. **CORS (optional, for node names)** — the PWA calls the CoreScope `/api/nodes/resolve` endpoint
      cross-origin. Set `resolveUrl` in `config.json` to either a CORS-enabled reverse-proxy location
      in front of the CoreScope API, or the API directly if it sends `Access-Control-Allow-Origin`
      for the app's origin. Omit it and the app still works — it shows prefixes instead of names.
3. **Dev / build / deploy** — `npm run dev` (HTTPS/localhost for Web Bluetooth), `npm test`
   (`node --test`), `npm run deploy` (example helper).
4. **Trust model** — publish-only shared account + EMQX ACL; clientId = companion pubkey
   (soft attribution); GPS is the phone's.
5. **License + link to CoreScope.**

### C. AGENTS.md (contributor rules)
A standalone project (not governed by CoreScope's AGENTS.md). Capture the established workflow:
- Stack: vanilla JS + Vite + MQTT.js; tests via `node --test`.
- **Semver** in `package.json`; tag each release `vX.Y.Z` and `git push --tags`.
- Commit **and** push every change with a descriptive message (keep GitHub mirrored).
- **Secrets only in `config.json`** (gitignored) — never commit, never surface in the UI.
- **Runtime `config.json` model** — fetched at startup; no build-time secrets, no `VITE_*`/`.env` for
  deployment config, no in-app secrets entry.
- **Direct-only capture rule**: record only `path[last]` (last forwarder) or a 0-hop advert's full
  pubkey; ≥2-byte path-hash; discard upstream hops. This is the data-integrity invariant.
- MQTT payload contract = CoreScope `docs/client-rx-coverage.md` (changing it is a breaking/major bump).
- PWA cache discipline (service worker network-first; `no-cache` on index/sw/manifest).

### D. Pre-public safety gate (mandatory, before flipping visibility)
- Deep-scan the **entire git history** for the MQTT password, deployment credentials, any real
  `config.json`, and any committed built `dist/` bundle that embedded `VITE_*` secrets (from the old
  build-time model). If anything is found → stop and scrub (history rewrite) before going public.
- Confirm `config.json`, `public/config.json`, `.env*`, `dist/`, `announce*.txt`, `promo*.txt`
  remain gitignored.
- `.env.local` is already confirmed never tracked; `dist/` is gitignored. The old build-time bundles
  may have baked the password — history scan must verify none were committed.

### E. Flip to public
`gh repo edit --visibility public` — performed **last**, only after D passes, with explicit user
confirmation (irreversible / outward-facing).

## Out of scope
- SP1 (fork v3.9.2 merge), SP2 (server config flag), SP3 (upstream PR) — separate sub-projects.
- iOS support (later: swap `WebBluetoothTransport` for a Capacitor BLE plugin behind the same interface).
- Identity hardening (companion-signed challenge) — future.

## Success criteria
- Repo builds and runs from a fresh clone using only a documented `config.json`; no on8ar-specific
  value remains in tracked files; no deployment value is baked into the bundle.
- A sysop can follow the README to self-host against their own CoreScope + EMQX, end to end.
- LICENSE (GPLv3) and AGENTS.md present; `package.json` public-ready.
- Git history verified free of secrets; repo visibility flipped to public.
