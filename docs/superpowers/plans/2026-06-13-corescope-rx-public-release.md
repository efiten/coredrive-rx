# corescope-rx Public Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `corescope-rx` a public, generic, self-hostable CoreScope companion app — runtime `config.json` instead of build-time `VITE_*`, no on8ar-specific values, a sysop install howto, AGENTS.md, and a GPLv3 license.

**Architecture:** The app fetches a `config.json` (served next to `index.html`) at startup; `src/config.js` loads + validates it and exposes it to `app.js` (MQTT) and `names.js` (resolve URL). All `VITE_*`/`.env` deployment machinery is removed. The real `config.json` (with the publish password) is gitignored; a `config.example.json` is committed.

**Tech Stack:** vanilla JS + Vite, MQTT.js (WSS), Web Bluetooth, IndexedDB; tests via `node --test`.

**Spec:** `docs/superpowers/specs/2026-06-13-corescope-rx-public-release-design.md`

**Working dir:** `C:\dev\meshcore\corescope-rx` (its own git repo; branch `master`; remote `origin = github.com/efiten/corescope-rx`, currently PRIVATE).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src/config.js` | Fetch + validate runtime `config.json`; expose `getConfig()` | **Create** |
| `test/config.test.mjs` | Unit-test `normalizeConfig` | **Create** |
| `test/names.test.mjs` | Unit-test `resolveName` short-circuit when no `resolveUrl` | **Create** |
| `src/names.js` | Read `resolveUrl` from config instead of hardcoded `BASE` | **Modify** |
| `src/app.js` | Load config at startup; build Publisher from config; genericize UI strings | **Modify** |
| `public/config.example.json` | Documented placeholder config | **Create** |
| `public/config.json` | Local-dev config (gitignored copy of example) | **Create (gitignored)** |
| `.gitignore` | Ignore `config.json`, `public/config.json` | **Modify** |
| `.env.example` | Removed (replaced by `config.example.json`) | **Delete** |
| `deploy.sh` | Env-driven, on8ar stripped, don't clobber server `config.json` | **Modify** |
| `package.json` | `private:false`, `license`, `repository`, `homepage`/`bugs` | **Modify** |
| `LICENSE` | GPLv3 full text | **Create** |
| `AGENTS.md` | Contributor rules | **Create** |
| `README.md` | Generic + sysop self-host howto | **Rewrite** |

---

## Task 1: Runtime config loader

**Files:**
- Create: `src/config.js`
- Test: `test/config.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/config.test.mjs`:

```js
// Unit tests for the runtime config loader's pure validation/normalization.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeConfig } from '../src/config.js';

test('normalizeConfig requires mqttUrl', () => {
  assert.throws(() => normalizeConfig({ mqttUsername: 'x' }), /mqttUrl/);
});

test('normalizeConfig trims fields and defaults resolveUrl to empty', () => {
  const c = normalizeConfig({ mqttUrl: '  wss://b:8084/ws  ', mqttUsername: ' u ' });
  assert.strictEqual(c.mqttUrl, 'wss://b:8084/ws');
  assert.strictEqual(c.mqttUsername, 'u');
  assert.strictEqual(c.resolveUrl, '');
});

test('normalizeConfig keeps resolveUrl when provided', () => {
  const c = normalizeConfig({ mqttUrl: 'wss://b/ws', resolveUrl: 'https://x/api/nodes/resolve' });
  assert.strictEqual(c.resolveUrl, 'https://x/api/nodes/resolve');
});

test('normalizeConfig rejects a non-object', () => {
  assert.throws(() => normalizeConfig(null), /JSON object/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/config.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/config.js`:

```js
// Runtime deployment config, fetched from config.json (served next to
// index.html) at startup. Nothing is baked into the bundle — sysops edit
// config.json, not source. See config.example.json for the shape.
let cfg = null;

// normalizeConfig validates + normalizes a parsed config.json object. Throws on
// a missing required field (mqttUrl). resolveUrl is optional (empty = node-name
// resolution disabled).
export function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('config.json: expected a JSON object');
  const c = {
    mqttUrl: String(raw.mqttUrl || '').trim(),
    mqttUsername: String(raw.mqttUsername || '').trim(),
    mqttPassword: raw.mqttPassword == null ? '' : String(raw.mqttPassword),
    resolveUrl: String(raw.resolveUrl || '').trim(),
  };
  if (!c.mqttUrl) throw new Error('config.json: "mqttUrl" is required');
  return c;
}

// loadConfig fetches + normalizes config.json once and caches it. Throws if the
// file is missing/unreadable or invalid JSON.
export async function loadConfig(url = 'config.json') {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('config.json not found (HTTP ' + r.status + ')');
  let raw;
  try { raw = await r.json(); } catch (e) { throw new Error('config.json: invalid JSON'); }
  cfg = normalizeConfig(raw);
  return cfg;
}

export function getConfig() { return cfg; }
export function setConfig(c) { cfg = c; } // test seam
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (the 4 config tests, plus existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.mjs
git commit -m "feat(config): runtime config.json loader + validation"
```

---

## Task 2: Resolve node names via config.resolveUrl

**Files:**
- Modify: `src/names.js`
- Test: `test/names.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/names.test.mjs`:

```js
// resolveName must short-circuit (no network) when resolveUrl is unconfigured.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { setConfig } from '../src/config.js';
import { resolveName } from '../src/names.js';

test('resolveName returns "" and does not fetch when resolveUrl is empty', async () => {
  setConfig({ mqttUrl: 'wss://b/ws', resolveUrl: '' });
  let called = false;
  const orig = globalThis.fetch;
  globalThis.fetch = () => { called = true; throw new Error('should not fetch'); };
  try {
    const name = await resolveName('aabb');
    assert.strictEqual(name, '');
    assert.strictEqual(called, false);
  } finally {
    globalThis.fetch = orig;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `resolveName` still uses the hardcoded `BASE` and calls `fetch` (so `called` becomes true / it throws).

- [ ] **Step 3: Modify `src/names.js`**

Replace the entire file with:

```js
// On-the-fly node-name resolution: per heard prefix/pubkey, one tiny request to
// the CoreScope resolve endpoint configured as `resolveUrl` in config.json (a
// CORS-enabled URL). Cached in memory for the session, so each distinct node is
// fetched at most once. When resolveUrl is empty the app skips resolution and
// the caller shows the prefix. A name is returned only when the prefix resolves
// uniquely; ambiguous/not-found → '' (caller shows the prefix).
import { getConfig } from './config.js';

const cache = new Map(); // key (lowercase hex) -> name | ''

// resolveName resolves a heard key (2-3 byte prefix or full pubkey) to a name.
// Returns '' when unconfigured, ambiguous, or unknown. Network errors are not
// cached (retry later).
export async function resolveName(key) {
  const c = getConfig();
  const base = c && c.resolveUrl ? c.resolveUrl : '';
  if (!base) return '';
  const k = key.toLowerCase();
  if (cache.has(k)) return cache.get(k);
  try {
    const r = await fetch(base + '?prefix=' + encodeURIComponent(k));
    if (!r.ok) { cache.set(k, ''); return ''; }
    const j = await r.json();
    const name = !j.ambiguous && j.name ? j.name : '';
    cache.set(k, name);
    return name;
  } catch (e) {
    return ''; // transient — leave uncached so it can retry
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (new names test + all existing).

- [ ] **Step 5: Commit**

```bash
git add src/names.js test/names.test.mjs
git commit -m "feat(names): resolve URL from runtime config; skip when unset"
```

---

## Task 3: Wire config into app.js (MQTT + bootstrap + genericize UI)

**Files:**
- Modify: `src/app.js`

(No unit test — browser bootstrap; verified by build + dev smoke in Task 9.)

- [ ] **Step 1: Add the config import**

In `src/app.js`, immediately after the line:

```js
import { Publisher } from './publisher.js';
```

add:

```js
import { loadConfig, getConfig } from './config.js';
```

- [ ] **Step 2: Remove the build-time MQTT_CFG block**

Replace this block (currently ~lines 69-75):

```js
// MQTT config from build-time env (Vite); never the UI. Treat as a shared,
// publish-only ingest account (EMQX ACL); not a real secret.
const MQTT_CFG = {
  url: import.meta.env.VITE_MQTT_URL,
  username: import.meta.env.VITE_MQTT_USERNAME,
  password: import.meta.env.VITE_MQTT_PASSWORD,
};
```

with:

```js
// MQTT config comes from the runtime config.json (loaded at startup via
// loadConfig), never the UI. The publish account is a shared, publish-only
// ingest account (EMQX ACL); not a real secret.
```

- [ ] **Step 3: Build the Publisher from runtime config + genericize the UI strings**

Replace this block (currently ~lines 298-307):

```js
    const s3 = step('③ Connecting to ON8AR CoreScope…', 'pending');
    if (MQTT_CFG.url) {
      state.publisher = new Publisher({ ...MQTT_CFG, clientId: state.companionPubkey });
      await state.publisher.connect();
      s3.textContent = '③ ON8AR CoreScope connected ✓';
      s3.className = '';
    } else {
      s3.textContent = '③ MQTT not configured (.env.local)';
      s3.className = 'err';
    }
```

with:

```js
    const s3 = step('③ Connecting to CoreScope…', 'pending');
    const cfg = getConfig();
    if (cfg && cfg.mqttUrl) {
      state.publisher = new Publisher({ url: cfg.mqttUrl, username: cfg.mqttUsername, password: cfg.mqttPassword, clientId: state.companionPubkey });
      await state.publisher.connect();
      s3.textContent = '③ CoreScope connected ✓';
      s3.className = '';
    } else {
      s3.textContent = '③ MQTT not configured (config.json)';
      s3.className = 'err';
    }
```

- [ ] **Step 4: Load config at startup**

In the `window.addEventListener('DOMContentLoaded', ...)` handler, change the callback to `async` and load config first. Replace:

```js
window.addEventListener('DOMContentLoaded', () => {
  els('appver').textContent = 'v' + VERSION;
  setButton();
```

with:

```js
window.addEventListener('DOMContentLoaded', async () => {
  els('appver').textContent = 'v' + VERSION;
  try {
    await loadConfig();
  } catch (e) {
    log('Config error: ' + e.message + ' — copy config.example.json to config.json and fill it in.');
  }
  setButton();
```

- [ ] **Step 5: Verify no stale references remain**

Run: `grep -nE "MQTT_CFG|import\.meta\.env|ON8AR" src/app.js`
Expected: no output (all replaced).

- [ ] **Step 6: Commit**

```bash
git add src/app.js
git commit -m "feat(app): load runtime config.json; build MQTT from it; genericize UI"
```

---

## Task 4: config.example.json, dev config, gitignore, drop .env

**Files:**
- Create: `public/config.example.json`
- Create: `public/config.json` (gitignored, dev only)
- Modify: `.gitignore`
- Delete: `.env.example`

- [ ] **Step 1: Create `public/config.example.json`**

```json
{
  "mqttUrl": "wss://broker.example:8084/ws",
  "mqttUsername": "corescope-rx",
  "mqttPassword": "<publish-only EMQX account password>",
  "resolveUrl": "https://corescope.example/api/nodes/resolve"
}
```

- [ ] **Step 2: Add config.json to `.gitignore`**

Append to `.gitignore` (after the `.env.*.local` line):

```
# Runtime deployment config — holds the publish password; never commit
config.json
public/config.json
```

- [ ] **Step 3: Create the local-dev `public/config.json` (gitignored)**

```bash
cp public/config.example.json public/config.json
```

Then edit `public/config.json` with your real dev values (your broker URL, the publish-only account/password, and your `resolveUrl` or `""`). This file must NOT be committed — Step 5 verifies that.

- [ ] **Step 4: Remove the old build-time env file**

```bash
git rm .env.example
```

(`.env.local` is already gitignored and was never tracked — nothing to remove.)

- [ ] **Step 5: Verify config.json is ignored**

Run: `git check-ignore public/config.json config.json && git status --porcelain | grep -E "config\.json$" || echo "OK: config.json ignored, not staged"`
Expected: `OK: config.json ignored, not staged` (and `public/config.example.json` shows as a new tracked file).

- [ ] **Step 6: Commit**

```bash
git add public/config.example.json .gitignore
git commit -m "feat(config): add config.example.json; gitignore real config.json; drop .env"
```

---

## Task 5: Genericize deploy.sh

**Files:**
- Modify: `deploy.sh`

- [ ] **Step 1: Replace the whole file**

```bash
#!/usr/bin/env bash
# Example helper: build corescope-rx and upload dist/ to a static host over SSH.
# This is OPTIONAL — host the built static files however you like (any HTTPS web
# server). Configure via env vars; nothing here is deployment-specific.
#
#   RX_DEPLOY_HOST   user@host of the web server (required)
#   RX_DEPLOY_DEST   absolute path of the served dir (required, e.g. /var/www/rx/)
#   RX_DEPLOY_KEY    SSH private key (optional; default: ssh-agent / ~/.ssh/id_*)
#
# NOTE: this uploads dist/ only. It does NOT touch the server's config.json —
# that file is owned by the sysop and lives on the host next to index.html.
set -euo pipefail

HOST="${RX_DEPLOY_HOST:?set RX_DEPLOY_HOST=user@host}"
DEST="${RX_DEPLOY_DEST:?set RX_DEPLOY_DEST=/path/on/server/}"
KEY="${RX_DEPLOY_KEY:-}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
[ -n "$KEY" ] && SSH_OPTS+=(-i "$KEY")

echo "[rx] building..."
npm run build

echo "[rx] uploading dist/ -> $HOST:$DEST (config.json left untouched) ..."
scp "${SSH_OPTS[@]}" -r dist/. "$HOST:$DEST"

echo "[rx] done."
```

- [ ] **Step 2: Verify no on8ar/IP remains**

Run: `grep -niE "on8ar|94\.130\.105|\.env\.local" deploy.sh || echo "clean"`
Expected: `clean`

- [ ] **Step 3: Commit**

```bash
git add deploy.sh
git commit -m "chore(deploy): genericize deploy.sh (env-driven, no on8ar, config.json safe)"
```

---

## Task 6: package.json public metadata + GPLv3 LICENSE

**Files:**
- Modify: `package.json`
- Create: `LICENSE`

- [ ] **Step 1: Edit `package.json`**

Set `"private": false`, add `license`/`repository`/`homepage`/`bugs`. The file becomes:

```json
{
  "name": "corescope-rx",
  "version": "0.8.1",
  "private": false,
  "license": "GPL-3.0-or-later",
  "type": "module",
  "description": "Mobile RX coverage capture for CoreScope: BLE companion → MQTT (GPS + SNR/RSSI + multibyte)",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/efiten/corescope-rx.git"
  },
  "homepage": "https://github.com/efiten/corescope-rx#readme",
  "bugs": "https://github.com/efiten/corescope-rx/issues",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "node --test",
    "deploy": "bash deploy.sh"
  },
  "dependencies": {
    "mqtt": "^5.10.1"
  },
  "devDependencies": {
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 2: Add the GPLv3 license text**

Run (downloads the canonical text):

```bash
curl -fsSL https://www.gnu.org/licenses/gpl-3.0.txt -o LICENSE
```

- [ ] **Step 3: Verify**

Run: `head -1 LICENSE; node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json valid')"`
Expected: first line `GNU GENERAL PUBLIC LICENSE` and `package.json valid`.

- [ ] **Step 4: Commit**

```bash
git add package.json LICENSE
git commit -m "chore: public metadata + GPLv3 LICENSE"
```

---

## Task 7: AGENTS.md (contributor rules)

**Files:**
- Create: `AGENTS.md`

- [ ] **Step 1: Create `AGENTS.md`**

```markdown
# AGENTS.md — corescope-rx contributor rules

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
- Commit AND push every change, with a descriptive message. Keep GitHub mirrored.
- PWA cache discipline: the service worker is network-first; `index.html`, `sw.js`, `manifest`, and
  `config.json` must be served `no-cache`; `/assets/` is immutable.
- Web Bluetooth needs a secure context — test over HTTPS or `localhost`.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: add AGENTS.md contributor rules"
```

---

## Task 8: Rewrite README.md (generic + sysop howto)

**Files:**
- Rewrite: `README.md`

- [ ] **Step 1: Replace the whole file**

````markdown
# corescope-rx

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

### 4. Build & host the app
```bash
npm install
npm run build          # outputs static files to dist/
```
Serve `dist/` over **HTTPS on a subdomain** (e.g. `rx.yourdomain`). Requirements:
- **SPA fallback:** unknown paths serve `/index.html` (e.g. nginx `try_files $uri /index.html;`).
- **Cache headers:** `index.html`, `sw.js`, the web-app manifest, and **`config.json`** = `no-cache`;
  `/assets/*` = immutable. Without this, a cached `index.html` pins old assets after an update.

### 5. config.json (runtime config — no rebuild to change)
Copy the example into the served directory (next to `index.html`) and fill it in:
```bash
cp public/config.example.json /var/www/rx.yourdomain/config.json
```
```json
{
  "mqttUrl": "wss://broker.yourdomain:8084/ws",
  "mqttUsername": "corescope-rx",
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

`deploy.sh` is an optional example helper that builds and `scp`s `dist/` to a host:
```bash
RX_DEPLOY_HOST=user@host RX_DEPLOY_DEST=/var/www/rx.yourdomain/ npm run deploy
```
It uploads `dist/` only and never touches the server's `config.json`.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). Companion to
[CoreScope](https://github.com/Kpa-clawbot/CoreScope).
````

- [ ] **Step 2: Verify no on8ar remains anywhere in tracked files**

Run: `git grep -niE "on8ar|94\.130\.105|corsproxy|VITE_" -- . ':!docs/superpowers/*' || echo "CLEAN"`
Expected: `CLEAN`. (The spec/plan under `docs/superpowers/` may mention these historically; that's fine and excluded.)

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: generic README with sysop self-host howto"
```

---

## Task 9: Build + full test + dev smoke

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS — config, names, and all pre-existing tests (`hexgrid`, `meshpacket`, `pipeline`).

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: build succeeds; `dist/` produced; no error about `import.meta.env` or missing modules.

- [ ] **Step 3: Confirm no deployment values were baked into the bundle**

Run: `grep -rniE "on8ar|VITE_MQTT|corsproxy" dist/ || echo "CLEAN BUNDLE"`
Expected: `CLEAN BUNDLE` (config now comes from runtime config.json, not the bundle).

- [ ] **Step 4: Dev smoke (manual)**

Run: `npm run dev`, open the served URL on `localhost`. Confirm:
- No "Config error" banner (since `public/config.json` exists for dev).
- Clicking Connect reaches step ③ showing "Connecting to CoreScope…" (not "ON8AR").
- Temporarily rename `public/config.json`, reload: the status shows the "Config error … copy
  config.example.json to config.json" message. Restore the file afterward.

- [ ] **Step 5: Commit (if any build artifacts/config tweaks were needed)**

No source changes expected here. If Step 4 surfaced a fix, commit it with a descriptive message.

---

## Task 10: Pre-public secret history scan (MANDATORY before going public)

**Files:** none (audit only). Do NOT flip visibility until this passes.

- [ ] **Step 1: Scan full history for any committed secret/config**

Run:
```bash
git log --all --oneline -- .env .env.local config.json public/config.json 'dist/*'
git log -p --all -S 'mqttPassword' -- . | head -40
git rev-list --all | while read c; do git ls-tree -r --name-only "$c"; done | sort -u | grep -E "\.env(\.|$)|config\.json|^dist/" || echo "no secret-bearing path ever tracked"
```
Expected: the path scan prints `no secret-bearing path ever tracked`; the `-S` scan shows nothing (the password string never entered history).

- [ ] **Step 2: If anything is found → STOP**

If a secret or a built bundle with baked creds appears in history: do not go public. Scrub history
(`git filter-repo --invert-paths --path <file>` or BFG), **rotate the leaked EMQX password**, force-push,
then re-run Step 1. Report to the user before proceeding.

- [ ] **Step 3: Confirm working tree is clean and ignores hold**

Run: `git status --porcelain` (expect empty) and `git check-ignore public/config.json config.json` (expect both listed).

- [ ] **Step 4: Push everything**

```bash
git push origin master
git push --tags
```

---

## Task 11: Flip the repo to public (gated on user confirmation)

**Files:** none (GitHub setting). **Do this only after Task 10 passes AND the user explicitly confirms.**

- [ ] **Step 1: Confirm with the user**

Ask the user to confirm flipping `github.com/efiten/corescope-rx` to public. This is outward-facing
and effectively irreversible (clones/caches persist).

- [ ] **Step 2: Flip visibility**

```bash
gh repo edit efiten/corescope-rx --visibility public --accept-visibility-change-consequences
```

- [ ] **Step 3: Verify**

Run: `gh repo view efiten/corescope-rx --json visibility -q .visibility`
Expected: `public`.

- [ ] **Step 4: Final sanity check**

Open the public repo URL in a browser; confirm README renders, LICENSE is detected as GPLv3, and no
`config.json`/`.env` is present.

---

## Self-review notes
- **Spec coverage:** A (runtime config) → Tasks 1-5; package/license → Task 6; AGENTS.md → Task 7;
  README howto → Task 8; build/verify → Task 9; pre-public scan (D) → Task 10; flip public (E) → Task 11.
- **Out of scope (per spec):** SP1 fork merge, SP2 server config flag, SP3 upstream PR, iOS, identity
  hardening — not in this plan.
- **Type/name consistency:** `loadConfig`/`getConfig`/`setConfig`/`normalizeConfig` are defined in
  Task 1 and used identically in Tasks 2-3. config.json keys (`mqttUrl`, `mqttUsername`,
  `mqttPassword`, `resolveUrl`) match across `config.js`, `app.js`, `names.js`,
  `config.example.json`, and the README.
```
