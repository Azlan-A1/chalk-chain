#!/usr/bin/env bash
# Fresh local chain: solana-test-validator (real SlotHashes), program deploy, keys, mint, config, vault.
# Leaves the validator running in the background; stop it with scripts/stop.sh.
#
#   scripts/setup-localnet.sh              # reset ledger, build, deploy, configure
#   SKIP_BUILD=1 scripts/setup-localnet.sh # reuse program/target/deploy/chalk_chain.so
#   WINDOW_SLOTS=40 scripts/setup-localnet.sh   # extra init-config overrides (see below)
set -euo pipefail
source "$(dirname "$0")/env.sh"

RPC_URL="http://127.0.0.1:8899"
LEDGER="$PROGRAM_DIR/test-ledger"
PID_FILE="$RUN_DIR/validator.pid"

# 1. validator
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  log "stopping previous validator (pid $(cat "$PID_FILE"))"
  kill "$(cat "$PID_FILE")"; sleep 2
fi
if lsof -iTCP:8899 -sTCP:LISTEN >/dev/null 2>&1; then
  die "port 8899 is already in use (another validator or surfpool?). Stop it first."
fi
log "starting solana-test-validator (ledger $LEDGER, log $RUN_DIR/validator.log)"
nohup solana-test-validator --reset --quiet --ledger "$LEDGER" --rpc-port 8899 \
  >"$RUN_DIR/validator.log" 2>&1 &
echo $! >"$PID_FILE"
for i in $(seq 1 60); do
  if solana -u "$RPC_URL" cluster-version >/dev/null 2>&1; then break; fi
  kill -0 "$(cat "$PID_FILE")" 2>/dev/null || die "validator exited; see $RUN_DIR/validator.log"
  sleep 1
done
solana -u "$RPC_URL" cluster-version >/dev/null 2>&1 || die "validator did not come up in 60 s"
log "validator up: $(solana -u "$RPC_URL" cluster-version)"

# 2. build
build_program
log "program id $PROGRAM_ID"

# 3. keys + deploy.json
write_deploy localnet "$RPC_URL"
admin keygen
admin airdrop --sol 20

# 4. deploy (admin pays and is the upgrade authority)
log "deploying program"
solana program deploy -u "$RPC_URL" --keypair "$KEYS_DIR/admin.json" \
  --program-id "$PROGRAM_KEYPAIR" --upgrade-authority "$KEYS_DIR/admin.json" "$PROGRAM_SO"

# 5. mint, config, vault
admin create-mint
CFG=()
[[ -n "${WINDOW_SLOTS:-}" ]] && CFG+=(--window-slots "$WINDOW_SLOTS")
[[ -n "${RECHECK_WINDOW_SLOTS:-}" ]] && CFG+=(--recheck-window-slots "$RECHECK_WINDOW_SLOTS")
[[ -n "${RECHECK_INTERVAL_SLOTS:-}" ]] && CFG+=(--recheck-interval-slots "$RECHECK_INTERVAL_SLOTS")
[[ -n "${BONUS_PER_LINK:-}" ]] && CFG+=(--bonus-per-link "$BONUS_PER_LINK")
[[ -n "${MIN_HEADCOUNT:-}" ]] && CFG+=(--min-headcount "$MIN_HEADCOUNT")
admin init-config ${CFG[@]+"${CFG[@]}"}
admin fund-vault 1000
admin status

log "localnet ready. deploy.json:"
cat "$DEPLOY_JSON"
log "next: scripts/dev.sh   (validator keeps running; scripts/stop.sh stops it)"
