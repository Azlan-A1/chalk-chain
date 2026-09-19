#!/usr/bin/env bash
# Stop what the scripts started.
#   scripts/stop.sh        # dev services and the validator
#   scripts/stop.sh dev    # only vision, backend, app (validator keeps running)
source "$(dirname "$0")/env.sh"
names=(vision backend app validator)
[[ "${1:-}" == "dev" ]] && names=(vision backend app)
for name in "${names[@]}"; do
  f="$RUN_DIR/$name.pid"
  [[ -e "$f" ]] || continue
  pid=$(cat "$f")
  if kill -0 "$pid" 2>/dev/null; then
    # dev services run in their own process group; the validator is a single process.
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null
    log "stopped $name (pid $pid)"
  fi
  rm -f "$f"
done

bash "$(dirname "$0")/tunnel.sh" --stop >/dev/null 2>&1 || true
