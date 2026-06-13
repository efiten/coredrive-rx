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

Config model is **build-time** `VITE_*` (injected by Vite, embedded in the bundle). This is settled
and kept — the publish credential is a shared, publish-only MQTT account constrained by an EMQX ACL,
not a real secret (soft attribution; companion-signed challenge is a later hardening). No runtime
config.json and no in-app settings screen.

## Scope (what changes)

### A. Genericize configuration (single source: `.env.local`)
The deployment-specific values live in exactly three tracked files plus `package.json`:

- **`src/names.js`** — the only hardcoded endpoint in code. Replace the constant
  `BASE` (the CORS-proxied CoreScope `/api/nodes/resolve` URL) with `import.meta.env.VITE_RESOLVE_URL`.
  When unset/empty, node-name resolution is disabled gracefully and the UI shows the heard-key prefix
  instead of a name.
- **`.env.example`** — generic placeholders: `VITE_MQTT_URL` (e.g. `wss://broker.example:8084/ws`),
  `VITE_MQTT_USERNAME`, `VITE_MQTT_PASSWORD`, and optional `VITE_RESOLVE_URL`. Keep the existing
  warning that `VITE_*` values are embedded in the bundle (use a publish-only ACL'd account).
- **`deploy.sh`** — fully env-driven (`RX_DEPLOY_HOST`, `RX_DEPLOY_DEST`, `RX_DEPLOY_KEY`); strip
  deployment-specific host/path/URL from code and comments; document it as an *example* helper
  (sysops may host the static `dist/` however they like).
- **`package.json`** — set `"private": false` (or remove), add `license` (GPL-3.0-or-later),
  `repository`, `homepage`/`bugs`.

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
   4. **Host the app** — `npm install`, set `.env.local`, `npm run build`, serve `dist/` over
      **HTTPS on a subdomain** (e.g. `rx.<yourdomain>`). SPA fallback (`try_files … /index.html`).
      Cache headers: `index.html` + `sw.js` + `manifest` = `no-cache`; `/assets/` = immutable —
      required so new builds reach clients instead of a pinned stale `index.html`.
   5. **CORS (optional, for node names)** — the PWA calls the CoreScope `/api/nodes/resolve` endpoint
      cross-origin. Set `VITE_RESOLVE_URL` to either a CORS-enabled reverse-proxy location in front
      of the CoreScope API, or the API directly if it sends `Access-Control-Allow-Origin` for the
      app's origin. Without it the app still works — it shows prefixes instead of names.
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
- **Secrets only in `.env.local`** — never commit, never surface in the UI.
- Build-time `VITE_*` configuration model (no runtime config, no in-app secrets entry).
- **Direct-only capture rule**: record only `path[last]` (last forwarder) or a 0-hop advert's full
  pubkey; ≥2-byte path-hash; discard upstream hops. This is the data-integrity invariant.
- MQTT payload contract = CoreScope `docs/client-rx-coverage.md` (changing it is a breaking/major bump).
- PWA cache discipline (service worker network-first; `no-cache` on index/sw/manifest).

### D. Pre-public safety gate (mandatory, before flipping visibility)
- Deep-scan the **entire git history** for the MQTT password, deployment credentials, and any
  committed built `dist/` bundle that embeds `VITE_*` secrets. If anything is found → stop and scrub
  (history rewrite) before going public.
- Confirm `.env`, `.env.local`, `dist/`, `announce*.txt`, `promo*.txt` remain gitignored.
- `.env.local` is already confirmed never tracked; `dist/` is gitignored.

### E. Flip to public
`gh repo edit --visibility public` — performed **last**, only after D passes, with explicit user
confirmation (irreversible / outward-facing).

## Out of scope
- SP1 (fork v3.9.2 merge), SP2 (server config flag), SP3 (upstream PR) — separate sub-projects.
- iOS support (later: swap `WebBluetoothTransport` for a Capacitor BLE plugin behind the same interface).
- Identity hardening (companion-signed challenge) — future.

## Success criteria
- Repo builds and runs from a fresh clone using only a documented `.env.local`; no on8ar-specific
  value remains in tracked files.
- A sysop can follow the README to self-host against their own CoreScope + EMQX, end to end.
- LICENSE (GPLv3) and AGENTS.md present; `package.json` public-ready.
- Git history verified free of secrets; repo visibility flipped to public.
