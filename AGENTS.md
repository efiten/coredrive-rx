# AGENTS.md — coredrive-rx contributor rules

Standalone companion app for [CoreScope](https://github.com/Kpa-clawbot/CoreScope). NOT governed by
CoreScope's AGENTS.md — this repo has its own conventions below.

## Stack & layout
- Vanilla JS (ES modules) + Vite. MQTT.js over WSS. Web Bluetooth, `navigator.geolocation`, IndexedDB.
- `src/` is split by responsibility: `transport` (BLE), `frames`/`meshpacket` (parsing), `gps`,
  `queue` (IndexedDB), `publisher` (MQTT), `names` (resolve), `config` (runtime config), `app` (wiring/UI).
- Tests live in `test/*.test.mjs`, run with `node --test` (`npm test`). Add a test with every logic change.

## Configuration (runtime, not build-time)
- All per-deployment values live in a runtime `config.json` (served next to `index.html`), loaded by
  `src/config.js` at startup. Shape: see `config.example.json`.
- Do NOT reintroduce `VITE_*`/`.env` for deployment config, and never hardcode hostnames, URLs, or
  credentials in source.
- Secrets live ONLY in the gitignored `config.json` — never commit them, never surface them in the UI.

## Data-integrity invariant (do not weaken)
- Record only what the companion heard **itself and directly**: a 0-hop advert's full pubkey, or
  `path[last]` (the last forwarder) for FLOOD routes. Discard upstream hops. Require ≥2-byte path-hash.
- The MQTT payload shape is a contract with CoreScope's ingestor (`docs/client-rx-coverage.md` in the
  CoreScope repo). Changing it is a breaking change → major version bump.

## Workflow
- Semantic versioning in `package.json`. Tag each release `git tag vX.Y.Z` and `git push --tags`.
  patch = fix/tweak, minor = backward-compatible feature, major = breaking (e.g. payload contract).
- Every release tag MUST have a "What's New" body on its GitHub Release (the CI auto-creates the
  release with only a changelog link — replace it). Use:
  `gh release edit vX.Y.Z --repo efiten/coredrive-rx --notes-file <notes.md>`. Cover: a one-line
  summary, a "What's new" bullet list (user-facing changes), and "Upgrade notes" (SW cache bump,
  any data/config migration). So anyone reading the tag sees what changed without diffing.
- Notes are CUMULATIVE: each new tag's body includes this release's section PLUS every previous
  release's "What's New", newest first (e.g. v1.0.1's body shows v1.0.1 then v1.0.0). So the latest
  tag always tells the full story; a reader never has to hop between tags.
- Commit AND push every change, with a descriptive message. Keep GitHub mirrored.
- PWA cache discipline: the service worker is network-first; `index.html`, `sw.js`, `manifest`, and
  `config.json` must be served `no-cache`; `/assets/` is immutable.
- Web Bluetooth needs a secure context — test over HTTPS or `localhost`.
