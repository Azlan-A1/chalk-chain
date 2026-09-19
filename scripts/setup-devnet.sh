#!/usr/bin/env bash
# Devnet: same flow as setup-localnet.sh, but no validator and no scripted airdrops.
# Keys in keys/ must be funded first; the script prints what to fund and stops if balances are low.
#
#   scripts/setup-devnet.sh                       # uses https://api.devnet.solana.com
#   RPC_URL=https://<your-devnet-rpc> scripts/setup-devnet.sh
#   SKIP_BUILD=1 scripts/setup-devnet.sh
#
# Writes shared/deploy.json with cluster=devnet (this replaces the localnet config; run
# setup-localnet.sh again to switch back). Safe to re-run: it upgrades the program in place,
# keeps the mint, and skips init-config if the config exists.
set -euo pipefail
source "$(dirname "$0")/env.sh"

RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
VAULT_USDC="${VAULT_USDC:-1000}"
# Rough needs: program deploy ~2.2 SOL (300 KB .so, buffer + programdata rent) plus mint/config;
# relayer pays rent for Teacher (~0.0013 SOL) and Day (~0.006 SOL) accounts; oracle pays attest/settle fees + teacher ATAs.
NEED_ADMIN=3.0
NEED_RELAYER=0.5
NEED_ORACLE=0.3

build_program
log "program id $PROGRAM_ID"
solana -u "$RPC_URL" cluster-version >/dev/null || die "cannot reach $RPC_URL"

write_deploy devnet "$RPC_URL"
admin keygen

short=0
for pair in "admin:$NEED_ADMIN" "relayer:$NEED_RELAYER" "oracle:$NEED_ORACLE"; do
  name=${pair%%:*}; need=${pair#*:}
  addr=$(solana address -k "$KEYS_DIR/$name.json")
  bal=$(solana balance -u "$RPC_URL" "$addr" | awk '{print $1}')
  printf '  %-8s %s  %s SOL (need %s)\n' "$name" "$addr" "$bal" "$need"
  if awk -v b="$bal" -v n="$need" 'BEGIN{exit !(b < n)}'; then short=1; fi
done
if [[ "$short" == "1" ]]; then
  cat <<EOF

Fund the keys above before continuing, e.g.:
  - https://faucet.solana.com (GitHub login raises the limit), or
  - solana airdrop 2 <address> -u devnet   (rate limited; often fails), or
  - solana transfer <address> <SOL> -u devnet --allow-unfunded-recipient  from a funded wallet
Then re-run scripts/setup-devnet.sh.
EOF
  exit 1
fi

log "deploying program to devnet (upgrades in place if it exists)"
solana program deploy -u "$RPC_URL" --keypair "$KEYS_DIR/admin.json" \
  --program-id "$PROGRAM_KEYPAIR" --upgrade-authority "$KEYS_DIR/admin.json" \
  --with-compute-unit-price 10000 --max-sign-attempts 20 "$PROGRAM_SO"

admin create-mint
admin init-config --slot-ms "${SLOT_MS:-400}"
admin fund-vault "$VAULT_USDC"
admin status

log "devnet ready; start the services with scripts/dev.sh (backend uses shared/deploy.json)"
