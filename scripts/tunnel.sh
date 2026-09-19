#!/usr/bin/env bash
# Publish the demo over HTTPS so judges can open it (and check the chain) on their own phones.
#
#   scripts/tunnel.sh          # tunnel the app and the local validator's RPC, print URLs + QR
#   scripts/tunnel.sh --stop   # close the tunnels
#
# Two Cloudflare quick tunnels are opened: one for the app (:5173) and one for the RPC (:8899),
# so Solana Explorer links resolve from any device. The RPC tunnel exposes a throwaway local
# chain with fake USDC; never point this at a wallet that holds anything real.
#
# Run scripts/demo.sh first. The app must be served over plain HTTP for the tunnel to reach it
# (Cloudflare terminates TLS), which scripts/demo.sh --tunnel arranges.
set -euo pipefail
source "$(dirname "$0")/env.sh"

TUNNEL_ENV="$RUN_DIR/tunnel.env"

stop() {
  for name in tunnel-app tunnel-rpc; do
    local pid="$RUN_DIR/$name.pid"
    [[ -f "$pid" ]] && kill "$(cat "$pid")" 2>/dev/null || true
    rm -f "$pid"
  done
  pkill -f "cloudflared tunnel --url http://localhost:5173" 2>/dev/null || true
  pkill -f "cloudflared tunnel --url http://127.0.0.1:8899" 2>/dev/null || true
  rm -f "$TUNNEL_ENV"
  log "tunnels closed"
}

[[ "${1:-}" == "--stop" ]] && { stop; exit 0; }
command -v cloudflared >/dev/null || die "cloudflared is not installed (brew install cloudflared)"
curl -sf http://127.0.0.1:8787/health >/dev/null || die "backend is not running; start it with scripts/demo.sh --tunnel"

start_tunnel() {           # name, url -> prints the public https URL
  local name="$1" url="$2" logf="$RUN_DIR/$name.log"
  : >"$logf"
  cloudflared tunnel --url "$url" --no-autoupdate >"$logf" 2>&1 &
  echo $! >"$RUN_DIR/$name.pid"
  for _ in $(seq 1 60); do
    local found
    found=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$logf" | head -1 || true)
    [[ -n "$found" ]] && { echo "$found"; return 0; }
    sleep 1
  done
  die "$name did not come up (see $logf)"
}

stop >/dev/null 2>&1 || true
log "opening tunnels (Cloudflare quick tunnels, no account needed)"
APP_URL=$(start_tunnel tunnel-app http://localhost:5173)
RPC_URL=$(start_tunnel tunnel-rpc http://127.0.0.1:8899)

cat >"$TUNNEL_ENV" <<EOF
CHALK_PUBLIC_APP_URL=$APP_URL
CHALK_PUBLIC_RPC_URL=$RPC_URL
EOF

# The backend reports the public RPC in GET /health so the app's Explorer links work off-laptop,
# and trusts the proxy's forwarded IP so rate limits are per visitor, not per tunnel.
log "restarting the backend with the public RPC URL"
CHALK_PUBLIC_RPC_URL="$RPC_URL" CHALK_TRUST_PROXY=1 bash "$ROOT/scripts/dev.sh" --bg --restart-backend >/dev/null

echo
log "App (judges, phones, anywhere): $APP_URL"
(cd "$ROOT" && pnpm --silent demo:cheat qr "$APP_URL")
cat <<EOF
Proof page for a teacher:  $APP_URL/#/t/<wallet>
Chain RPC (Explorer):      $RPC_URL
Close the tunnels:         scripts/tunnel.sh --stop

Notes
  · Anyone with the app link can use the app; the oracle routes stay behind CHALK_ADMIN_TOKEN.
  · The links die when the tunnels are closed or this laptop sleeps.
EOF
