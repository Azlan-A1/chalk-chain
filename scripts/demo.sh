#!/usr/bin/env bash
# One command to a stage-ready demo on this laptop:
#   fresh local chain + program + test USDC, demo re-check settings, vision/backend/app over HTTPS
#   with automatic surprise re-checks, "last week's photo" seeded for the edited-photo cheat,
#   and a QR code for the phone.
#
#   scripts/demo.sh                    # fresh chain (the phone app re-registers by itself)
#   scripts/demo.sh --keep-chain       # restart services only, keep teachers and days
#   scripts/demo.sh --manual-rechecks  # no automatic re-checks; use the app's Demo panel instead
#   scripts/demo.sh --every=60 --chance=96   # re-check boundary every N slots, hit if roll < chance (0-255)
#   scripts/demo.sh --keep-photos      # keep the vision reuse index from earlier rehearsals
#
# Then: pnpm demo:cheat late|screen|edited|all, pnpm demo:cheat projector, scripts/stop.sh
set -euo pipefail
source "$(dirname "$0")/env.sh"

KEEP_CHAIN=0; AUTO=1; EVERY=60; CHANCE=96; KEEP_PHOTOS=0
for a in "$@"; do
  case "$a" in
    --keep-chain) KEEP_CHAIN=1 ;;
    --manual-rechecks) AUTO=0 ;;
    --every=*) EVERY="${a#*=}" ;;
    --chance=*) CHANCE="${a#*=}" ;;
    --keep-photos) KEEP_PHOTOS=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "unknown option $a (see --help)" ;;
  esac
done

if [[ "$KEEP_CHAIN" == "1" ]]; then
  bash "$ROOT/scripts/stop.sh" dev >/dev/null 2>&1 || true
else
  bash "$ROOT/scripts/stop.sh" >/dev/null 2>&1 || true
  [[ -f "$PROGRAM_SO" && -z "${SKIP_BUILD:-}" ]] && export SKIP_BUILD=1
  bash "$ROOT/scripts/setup-localnet.sh"
fi

# Real photos of the same room from earlier rehearsals would look like reuse; start clean.
if [[ "$KEEP_PHOTOS" == "0" ]]; then rm -f "$ROOT/vision/data/reuse.json"; fi

log "demo re-checks: boundary every $EVERY slots, $(( CHANCE * 100 / 256 ))% chance each"
admin update-config --recheck-interval-slots "$EVERY" --recheck-threshold "$CHANCE" >/dev/null

DEV_ARGS=(--bg)
[[ "$AUTO" == "1" ]] && DEV_ARGS+=(--auto-roll)
VITE_HTTPS=1 bash "$ROOT/scripts/dev.sh" "${DEV_ARGS[@]}"

for i in $(seq 1 60); do curl -skf https://localhost:5173 >/dev/null && break; sleep 0.5; done
curl -skf https://localhost:5173 >/dev/null || die "app did not start (see $RUN_DIR/app.log)"

IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo localhost)
PHONE_URL="https://$IP:5173"
log "seeding last week's photo (warms up the vision model)"
(cd "$ROOT" && DEMO_APP_URL="$PHONE_URL" pnpm --silent demo:cheat seed)

ENGINE=$(curl -s http://127.0.0.1:8001/health | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).engine')
echo
log "Phone (same Wi-Fi): $PHONE_URL   — accept the certificate warning"
(cd "$ROOT" && pnpm --silent demo:cheat qr "$PHONE_URL")
cat <<EOF
Laptop / projector:  https://localhost:5173   (accept the certificate once)
Vision engine:       $ENGINE$([[ "$ENGINE" == "mock" ]] && echo "   (mock: every photo passes; set a key or CHALK_OLLAMA_MODEL in .env)")
Re-checks:           $([[ "$AUTO" == "1" ]] && echo "automatic" || echo "manual (Demo panel on the phone)")

Demo flow
  1. Phone: set up the teacher, Start check-in, chalk the 3 words, take the photo.
  2. pnpm demo:cheat projector   → opens that teacher's proof page on the laptop (updates live)
  3. pnpm demo:cheat late        → rejected by the Solana program (photo sealed too late)
  4. pnpm demo:cheat screen      → photo of a laptop screen: caught by the photo check
  5. pnpm demo:cheat edited      → last week's photo with today's words pasted on: caught as reused
  6. A surprise re-check fires on the phone: add 3 new words under the old ones, photograph again.
  7. Phone: End school day → USDC bonus paid, visible on the proof page.

Stop everything: scripts/stop.sh
EOF
