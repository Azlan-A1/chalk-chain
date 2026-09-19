# Sourced by the other scripts: toolchain PATH and repo paths.
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$HOME/.cargo/bin:$HOME/.nvm/versions/node/v24.10.0/bin:$PATH"
export NO_DNA=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROGRAM_DIR="$ROOT/program"
KEYS_DIR="$ROOT/keys"
export CHALK_DEPLOY="${CHALK_DEPLOY:-$ROOT/shared/deploy.json}"
DEPLOY_JSON="$CHALK_DEPLOY"
PROGRAM_SO="$PROGRAM_DIR/target/deploy/chalk_chain.so"
PROGRAM_KEYPAIR="$PROGRAM_DIR/target/deploy/chalk_chain-keypair.json"
RUN_DIR="$ROOT/.run"   # pid files and logs (gitignored)
mkdir -p "$RUN_DIR"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

admin() { (cd "$ROOT" && pnpm --silent --filter backend admin "$@"); }

# Build the SBF program and refresh the shared IDL (skip with SKIP_BUILD=1).
build_program() {
  if [[ "${SKIP_BUILD:-0}" == "1" && -f "$PROGRAM_SO" ]]; then
    log "SKIP_BUILD=1: using existing $PROGRAM_SO"
  else
    log "anchor build"
    (cd "$PROGRAM_DIR" && anchor build) || die "anchor build failed"
  fi
  mkdir -p "$ROOT/shared/idl"
  cp "$PROGRAM_DIR/target/idl/chalk_chain.json" "$ROOT/shared/idl/chalk_chain.json"
  local declared keyfile
  declared=$(grep -o 'declare_id!("[^"]*")' "$PROGRAM_DIR/programs/chalk_chain/src/lib.rs" | cut -d'"' -f2)
  keyfile=$(solana address -k "$PROGRAM_KEYPAIR")
  [[ "$declared" == "$keyfile" ]] || die "declare_id ($declared) != program keypair ($keyfile); run 'anchor keys sync' and rebuild"
  PROGRAM_ID="$keyfile"
}

# Write shared/deploy.json for this cluster. Fields from the same cluster (usdcMint, ...) are kept;
# a file from another cluster is replaced. The admin CLI re-creates a mint that no longer exists.
write_deploy() {
  local cluster="$1" rpc="$2"
  mkdir -p "$(dirname "$DEPLOY_JSON")"
  node -e '
    const fs = require("fs"); const [f, c, r, p] = process.argv.slice(1);
    let old = {}; try { old = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    const keep = old.cluster === c ? old : {};
    fs.writeFileSync(f, JSON.stringify({ ...keep, cluster: c, rpcUrl: r, programId: p }, null, 2) + "\n");
  ' "$DEPLOY_JSON" "$cluster" "$rpc" "$PROGRAM_ID"
}
