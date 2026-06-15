#!/usr/bin/env bash
# deploy-release.sh — install/update coredrive-rx from a PREBUILT GitHub Release,
# over SSH. Same idea as deploy.sh, but it downloads a release zip instead of
# building from source — so it needs NO Node/npm, only curl + unzip locally.
#
#   RX_DEPLOY_HOST   user@host of the web server (required)
#   RX_DEPLOY_DEST   absolute path of the served dir on the server (required)
#   RX_DEPLOY_KEY    SSH private key (optional; default: ssh-agent / ~/.ssh/id_*)
#   RX_VERSION       release tag to install (optional; default = latest release)
#   RX_REPO          GitHub repo (optional; default below)
#
# The server's config.json is left intact: release zips contain no config.json,
# so the upload never overwrites it. On a FIRST install, create config.json on the
# server yourself (copy config.example.json) or the app shows a config error.
#
# Example:
#   RX_DEPLOY_HOST=root@1.2.3.4 RX_DEPLOY_DEST=/var/www/rx.example/ bash deploy-release.sh
set -euo pipefail

REPO="${RX_REPO:-efiten/coredrive-rx}"
HOST="${RX_DEPLOY_HOST:?set RX_DEPLOY_HOST=user@host}"
DEST="${RX_DEPLOY_DEST:?set RX_DEPLOY_DEST to the absolute served path on the server}"
KEY="${RX_DEPLOY_KEY:-}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
[ -n "$KEY" ] && SSH_OPTS+=(-i "$KEY")

for t in curl unzip; do command -v "$t" >/dev/null || { echo "[rx] need '$t' installed"; exit 1; }; done

# Resolve the version (latest release unless pinned via RX_VERSION).
VER="${RX_VERSION:-}"
if [ -z "$VER" ]; then
  VER=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
        | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
fi
[ -n "$VER" ] || { echo "[rx] could not resolve a release tag for $REPO"; exit 1; }

ZIP="coredrive-rx-${VER}.zip"
URL="https://github.com/$REPO/releases/download/${VER}/${ZIP}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "[rx] downloading $REPO $VER ($URL) ..."
curl -fsSL "$URL" -o "$TMP/$ZIP"
unzip -q "$TMP/$ZIP" -d "$TMP/site"
[ -f "$TMP/site/index.html" ] || { echo "[rx] release zip missing index.html — aborting"; exit 1; }

echo "[rx] uploading $VER -> $HOST:$DEST (server config.json left untouched) ..."
scp "${SSH_OPTS[@]}" -r "$TMP/site/." "$HOST:$DEST"

echo "[rx] done. $VER deployed to $HOST:$DEST"
echo "[rx] first install? ensure $DEST/config.json exists on the server (copy config.example.json)."
