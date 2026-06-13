#!/usr/bin/env bash
# Example helper: build corescope-rx and upload dist/ to a static host over SSH.
# This is OPTIONAL — host the built static files however you like (any HTTPS web
# server). Configure via env vars; nothing here is deployment-specific.
#
#   RX_DEPLOY_HOST   user@host of the web server (required)
#   RX_DEPLOY_DEST   absolute path of the served dir on the server (required)
#   RX_DEPLOY_KEY    SSH private key (optional; default: ssh-agent / ~/.ssh/id_*)
#
# NOTE: this uploads dist/ only. It does NOT touch the server's config.json —
# that file is owned by the sysop and lives on the host next to index.html.
set -euo pipefail

HOST="${RX_DEPLOY_HOST:?set RX_DEPLOY_HOST=user@host}"
DEST="${RX_DEPLOY_DEST:?set RX_DEPLOY_DEST to the absolute path on the server}"
KEY="${RX_DEPLOY_KEY:-}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
[ -n "$KEY" ] && SSH_OPTS+=(-i "$KEY")

echo "[rx] building..."
npm run build

echo "[rx] uploading dist/ -> $HOST:$DEST (config.json left untouched) ..."
scp "${SSH_OPTS[@]}" -r dist/. "$HOST:$DEST"

echo "[rx] done."
