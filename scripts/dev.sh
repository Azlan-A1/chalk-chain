#!/usr/bin/env bash
# Start vision (:8001), backend (:8787) and the app (:5173) against the chain in shared/deploy.json.
#
#   scripts/dev.sh              # foreground; Ctrl-C stops all three
#   scripts/dev.sh --bg         # background; logs in .run/*.log, stop with scripts/stop.sh
#   scripts/dev.sh --no-app     # vision + backend only (what scripts/e2e.ts needs)
#   VITE_HTTPS=1 scripts/dev.sh # app over HTTPS on the LAN (phone camera testing)
#
# Vision runs with CHALK_VISION_MODE=mock unless ANTHROPIC_API_KEY is set (then Claude reads the board).
set -euo pipefail
source "$(dirname "$0")/env.sh"

BG=0; APP=1
for a in "$@"; do
  case "$a" in
    --bg) BG=1 ;;
    --no-app) APP=0 ;;
    *) die "unknown option $a" ;;
  esac
done

[[ -f "$DEPLOY_JSON" ]] || die "no shared/deploy.json; run scripts/setup-localnet.sh first"
RPC_URL=$(node -p 'require(process.argv[1]).rpcUrl' "$DEPLOY_JSON")
solana -u "$RPC_URL" cluster-version >/dev/null 2>&1 || die "RPC $RPC_URL is not answering; run scripts/setup-localnet.sh"

if [[ -z "${CHALK_VISION_MODE:-}" ]]; then
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then export CHALK_VISION_MODE=auto; else export CHALK_VISION_MODE=mock; fi
fi
[[ -x "$ROOT/vision/.venv/bin/uvicorn" ]] || die "vision venv missing: cd vision && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"

for port in 8001 8787; do
  lsof -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1 && die "port $port is busy (scripts/stop.sh?)"
done

# Each service runs in its own process group so scripts/stop.sh can kill the whole tree.
start() {
  local name="$1"; shift
  if [[ "$BG" == "1" ]]; then
    set -m
    ( "$@" ) >"$RUN_DIR/$name.log" 2>&1 &
    set +m
  else
    set -m
    ( "$@" 2>&1 | sed -u "s/^/[$name] /" ) &
    set +m
  fi
  echo $! >"$RUN_DIR/$name.pid"
}

log "vision  :8001  mode=$CHALK_VISION_MODE"
start vision bash -c "cd '$ROOT/vision' && exec .venv/bin/uvicorn chalkvision.app:app --host 127.0.0.1 --port 8001"
log "backend :8787  rpc=$RPC_URL"
start backend bash -c "cd '$ROOT' && exec pnpm --silent --filter backend start"
if [[ "$APP" == "1" ]]; then
  if [[ "${VITE_HTTPS:-}" == "1" ]]; then log "app     https://<this-machine-ip>:5173 (accept the self-signed cert on the phone)"; else log "app     http://localhost:5173"; fi
  start app bash -c "cd '$ROOT' && exec pnpm --silent --filter app dev --host"
fi

for i in $(seq 1 40); do
  curl -sf http://127.0.0.1:8001/health >/dev/null && curl -sf http://127.0.0.1:8787/health >/dev/null && break
  sleep 0.5
done
curl -sf http://127.0.0.1:8001/health >/dev/null || die "vision did not start (see $RUN_DIR/vision.log)"
curl -sf http://127.0.0.1:8787/health >/dev/null || die "backend did not start (see $RUN_DIR/backend.log)"
log "health: vision $(curl -s http://127.0.0.1:8001/health)"
log "health: backend $(curl -s http://127.0.0.1:8787/health)"

if [[ "$BG" == "1" ]]; then
  log "running in background; logs in $RUN_DIR; stop with scripts/stop.sh"
else
  trap 'bash "$ROOT/scripts/stop.sh" dev >/dev/null 2>&1; exit 0' INT TERM
  wait
fi
