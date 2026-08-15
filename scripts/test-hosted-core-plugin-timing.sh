#!/usr/bin/env bash
set -euo pipefail

host="${1:-${FASED_HOSTED_TIMING_HOST:-}}"
max_ms="${FASED_HOSTED_CORE_PLUGIN_MAX_MS:-10000}"

if [[ -z "$host" ]]; then
  echo "usage: $0 app@HOST" >&2
  echo "or set FASED_HOSTED_TIMING_HOST=app@HOST" >&2
  exit 2
fi

remote='export PATH="$HOME/.fased/bin:$PATH"; fased gateway restart >/dev/null; for attempt in $(seq 1 30); do status="$(fased gateway status 2>&1 || true)"; if grep -q "RPC probe: ok" <<<"$status"; then break; fi; sleep 1; done; sudo -n journalctl -u fased-gateway.service --since "2 minutes ago" --no-pager'
output="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" "$remote")"
printf '%s\n' "$output"

plugin_ms="$({ grep -oE 'plugins\.load(\.deferred)?=[0-9]+ms' <<<"$output" || true; } | tail -1 | grep -oE '[0-9]+' || true)"
if [[ -z "$plugin_ms" ]]; then
  echo "hosted plugin timing was not present in gateway logs" >&2
  exit 1
fi

if (( plugin_ms > max_ms )); then
  echo "hosted core plugin loading took ${plugin_ms}ms; budget is ${max_ms}ms" >&2
  exit 1
fi

echo "hosted core plugin loading passed in ${plugin_ms}ms (budget ${max_ms}ms)"
