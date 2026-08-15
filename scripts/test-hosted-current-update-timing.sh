#!/usr/bin/env bash
set -euo pipefail

host="${1:-${FASED_HOSTED_TIMING_HOST:-}}"
max_seconds="${FASED_HOSTED_CURRENT_UPDATE_MAX_SECONDS:-15}"

if [[ -z "$host" ]]; then
  echo "usage: $0 app@HOST" >&2
  echo "or set FASED_HOSTED_TIMING_HOST=app@HOST" >&2
  exit 2
fi

started_at="$(date +%s)"
output="$(
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" \
    'export PATH="$HOME/.fased/bin:$PATH"; fased update'
)"
elapsed="$(( $(date +%s) - started_at ))"

printf '%s\n' "$output"

if ! grep -Eq '^Already current: [0-9]+\.[0-9]+\.[0-9]+' <<<"$output"; then
  echo "hosted current-version update did not take the no-op path" >&2
  exit 1
fi

if (( elapsed > max_seconds )); then
  echo "hosted current-version update took ${elapsed}s; budget is ${max_seconds}s" >&2
  exit 1
fi

gateway_status="$(
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" \
    'export PATH="$HOME/.fased/bin:$PATH"; fased gateway status'
)"
printf '%s\n' "$gateway_status"

if ! grep -q 'RPC probe: ok' <<<"$gateway_status"; then
  echo "gateway RPC probe is not healthy after the no-op update check" >&2
  exit 1
fi

echo "hosted current-version update passed in ${elapsed}s (budget ${max_seconds}s)"
