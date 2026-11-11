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
- Every release tag MUST have a "What's New" body, written as `docs/releases/vX.Y.Z.md` in the SAME
  commit as the version bump. One file, one release: a `# CoreDrive RX vX.Y.Z` heading, a one-line
  summary, a "What's new" bullet list (user-facing changes), and "Upgrade notes" (SW cache bump, any
  data/config migration). So anyone reading the tag sees what changed without diffing.
- The release job enforces this: `.github/workflows/release.yml` runs
  `scripts/release-notes.mjs <tag>`, which publishes that tag's own file plus one link to the
  releases list as the body. A tag whose file is missing FAILS the release job instead of shipping
  a changelog link. This rule was a human convention for nine tags in a row and was missed on
  every one of them, which left v1.5.0 as the last release anyone could read while region
  discovery landed unannounced. Bodies used to repeat every older release too; that was dropped
  because GitHub shows the assets below the body and the releases list already shows them all.
- To change a published body, edit the file under `docs/releases/` and re-post it:
  `node scripts/release-notes.mjs vX.Y.Z | gh release edit vX.Y.Z --repo efiten/coredrive-rx --notes-file -`.
- Commit AND push every change, with a descriptive message. Keep GitHub mirrored.
- Releases are batched. A fix or feature PR carries no version bump, no `docs/releases/` file,
  no SW cache bump and no tag; it lands on master with its tests. A separate release PR bumps
  the version, writes `docs/releases/vX.Y.Z.md` covering everything since the last tag, bumps
  the SW cache, and is then tagged, deployed to rx.on8ar.eu, built (APK on the GitHub release)
  and uploaded to Play as a draft (`scripts/play-upload.mjs`). Each Play upload goes through
  Google's review and updates every tester, so one release per batch, not per fix. Exception:
  a fix for something that breaks capture now gets its own release right away. A fix that must
  be live between releases goes to `/beta`, never to the live root without a cache bump.
- Every fix PR body starts with one line: `Release: now` when the bug stops capture or upload, or
  records wrong data, so users must update; otherwise `Release: next batch`. The maintainer can
  ask for a release at any time.
- PWA cache discipline: the service worker is network-first; `index.html`, `sw.js`, `manifest`, and
  `config.json` must be served `no-cache`; `/assets/` is immutable.
- Web Bluetooth needs a secure context — test over HTTPS or `localhost`.
