#!/usr/bin/env bash
# Example helper: build coredrive-rx and upload dist/ to a static host over SSH.
# This is OPTIONAL — host the built static files however you like (any HTTPS web
# server). Configure via env vars; nothing here is deployment-specific.
#
#   RX_DEPLOY_HOST   user@host of the web server (required)
#   RX_DEPLOY_DEST   absolute path of the served dir on the server (required)
#   RX_DEPLOY_KEY    SSH private key (optional; default: ssh-agent / ~/.ssh/id_*)
#   RX_BUILD         npm script to build (optional; default: build). Use `build:beta`
#                    for the /beta slot: that build sets base=/beta/, suffixes the
#                    IndexedDB and localStorage names, and registers no service
#                    worker. Deploying a default build into /beta uploads an app
#                    whose asset paths point at the production slot and whose SW
#                    registration claims the ROOT scope.
#
# NOTE: this uploads dist/ only. It does NOT touch the server's config.json —
# that file is owned by the sysop and lives on the host next to index.html.
set -euo pipefail

HOST="${RX_DEPLOY_HOST:?set RX_DEPLOY_HOST=user@host}"
DEST="${RX_DEPLOY_DEST:?set RX_DEPLOY_DEST to the absolute path on the server}"
KEY="${RX_DEPLOY_KEY:-}"
BUILD="${RX_BUILD:-build}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
[ -n "$KEY" ] && SSH_OPTS+=(-i "$KEY")

echo "[rx] building (npm run $BUILD)..."
npm run "$BUILD"

# Never ship a config.json: the sysop owns it on the server (next to index.html).
# A local public/config.json (used for `npm run dev`) is copied into dist/ by Vite,
# so drop it here to avoid overwriting the server's real config on upload.
rm -f dist/config.json

echo "[rx] uploading dist/ -> $HOST:$DEST (server config.json left untouched) ..."
scp "${SSH_OPTS[@]}" -r dist/. "$HOST:$DEST"

echo "[rx] done."
