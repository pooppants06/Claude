#!/usr/bin/env bash
#
# tunnel.sh — start OddsEdge and expose it on a public URL via a Cloudflare
# Quick Tunnel (https://*.trycloudflare.com — no account/authtoken needed).
#
# REQUIREMENT: the cloud environment must be on **Full** network access
# (claude.ai/code -> cloud icon -> edit environment -> Network access -> Full),
# and you must start a FRESH session after changing it. On the default
# "Trusted" allowlist the tunnel relay is blocked and this script will hang.
#
# Usage:
#   bash scripts/tunnel.sh          # foreground; prints the public URL
#   PORT=3000 bash scripts/tunnel.sh
#
set -euo pipefail

PORT="${PORT:-3000}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { printf '[tunnel] %s\n' "$*"; }

# 1) Ensure dependencies + a healthy server on $PORT --------------------------
if ! curl -sf -o /dev/null "http://localhost:${PORT}"; then
  log "no server on :${PORT} — starting it"
  [ -d node_modules ] || npm install
  POLYMARKET_DEMO_ON_ERROR=true PORT="$PORT" nohup npm start >/tmp/oddsedge.log 2>&1 &
  for _ in $(seq 1 30); do
    curl -sf -o /dev/null "http://localhost:${PORT}" && break
    sleep 1
  done
fi
if curl -sf -o /dev/null "http://localhost:${PORT}"; then
  log "server healthy on :${PORT}"
else
  log "server failed to start — see /tmp/oddsedge.log"; exit 1
fi

# 2) Fetch cloudflared (binary lives on GitHub, allowlisted even on Trusted) ---
BIN="/tmp/cloudflared"
if command -v cloudflared >/dev/null 2>&1; then
  CF="$(command -v cloudflared)"
elif [ -x "$BIN" ]; then
  CF="$BIN"
else
  log "downloading cloudflared"
  arch="$(uname -m)"; case "$arch" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; esac
  curl -fsSL -o "$BIN" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}"
  chmod +x "$BIN"; CF="$BIN"
fi

# 3) Open the quick tunnel and surface the public URL -------------------------
log "starting Cloudflare quick tunnel -> http://localhost:${PORT}"
log "watch for the https://<random>.trycloudflare.com URL below:"
exec "$CF" tunnel --no-autoupdate --url "http://localhost:${PORT}"
