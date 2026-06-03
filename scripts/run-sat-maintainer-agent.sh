#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${FASED_AGENT_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"

FASED_SAT_MAINTAIN_INTERVAL_SECONDS="${FASED_SAT_MAINTAIN_INTERVAL_SECONDS:-300}"
FASED_SAT_MAINTAIN_JITTER_SECONDS="${FASED_SAT_MAINTAIN_JITTER_SECONDS:-30}"
FASED_SAT_MAINTAIN_MIN_SOL_LAMPORTS="${FASED_SAT_MAINTAIN_MIN_SOL_LAMPORTS:-1}"
FASED_SAT_MAINTAIN_MIN_SAT_RAW="${FASED_SAT_MAINTAIN_MIN_SAT_RAW:-1}"
FASED_SAT_MAINTAIN_CLEANUP_MAX_CYCLES="${FASED_SAT_MAINTAIN_CLEANUP_MAX_CYCLES:-3}"
FASED_SAT_MAINTAIN_LOG_FILE="${FASED_SAT_MAINTAIN_LOG_FILE:-$HOME/.fased/sat-maintainer.jsonl}"
FASED_SAT_MAINTAIN_LOCK_FILE="${FASED_SAT_MAINTAIN_LOCK_FILE:-$HOME/.fased/sat-maintainer.lock}"
FASED_SAT_MAINTAIN_RUNNER_LOCK_FILE="${FASED_SAT_MAINTAIN_RUNNER_LOCK_FILE:-$FASED_SAT_MAINTAIN_LOCK_FILE.runner}"
FASED_SAT_MAINTAIN_RUNNER_LOCK="${FASED_SAT_MAINTAIN_RUNNER_LOCK:-1}"
FASED_SAT_MAINTAIN_STALE_LOCK_SECONDS="${FASED_SAT_MAINTAIN_STALE_LOCK_SECONDS:-900}"
FASED_SAT_MAINTAIN_MAX_ITERATIONS="${FASED_SAT_MAINTAIN_MAX_ITERATIONS:-}"
FASED_SAT_MAINTAIN_TARGET_RESERVE_LAMPORTS="${FASED_SAT_MAINTAIN_TARGET_RESERVE_LAMPORTS:-}"
FASED_SAT_MAINTAIN_GATEWAY_URL="${FASED_SAT_MAINTAIN_GATEWAY_URL:-}"
FASED_SAT_MAINTAIN_GATEWAY_TOKEN="${FASED_SAT_MAINTAIN_GATEWAY_TOKEN:-}"

mkdir -p \
  "$(dirname "$FASED_SAT_MAINTAIN_LOG_FILE")" \
  "$(dirname "$FASED_SAT_MAINTAIN_LOCK_FILE")" \
  "$(dirname "$FASED_SAT_MAINTAIN_RUNNER_LOCK_FILE")"

if [[ "$FASED_SAT_MAINTAIN_RUNNER_LOCK" != "0" ]]; then
  if command -v flock >/dev/null 2>&1; then
    if [[ ! -e "$FASED_SAT_MAINTAIN_RUNNER_LOCK_FILE" ]]; then
      : >"$FASED_SAT_MAINTAIN_RUNNER_LOCK_FILE"
    fi
    exec 9<>"$FASED_SAT_MAINTAIN_RUNNER_LOCK_FILE"
    if ! flock -n 9; then
      echo "SAT maintainer runner already active; lock file $FASED_SAT_MAINTAIN_RUNNER_LOCK_FILE"
      exit 75
    fi
    : >"$FASED_SAT_MAINTAIN_RUNNER_LOCK_FILE"
    printf '{"pid":%s,"startedAt":"%s"}\n' "$$" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >&9 || true
  else
    echo "warning: flock not available; falling back to CLI maintainer lock only" >&2
  fi
fi

args=(
  sat
  maintain
  --json
  --loop
  --interval-seconds
  "$FASED_SAT_MAINTAIN_INTERVAL_SECONDS"
  --jitter-seconds
  "$FASED_SAT_MAINTAIN_JITTER_SECONDS"
  --min-sol-lamports
  "$FASED_SAT_MAINTAIN_MIN_SOL_LAMPORTS"
  --min-sat-raw
  "$FASED_SAT_MAINTAIN_MIN_SAT_RAW"
  --cleanup-max-cycles
  "$FASED_SAT_MAINTAIN_CLEANUP_MAX_CYCLES"
  --log-file
  "$FASED_SAT_MAINTAIN_LOG_FILE"
  --lock-file
  "$FASED_SAT_MAINTAIN_LOCK_FILE"
  --stale-lock-seconds
  "$FASED_SAT_MAINTAIN_STALE_LOCK_SECONDS"
)

if [[ -n "$FASED_SAT_MAINTAIN_MAX_ITERATIONS" ]]; then
  args+=(--max-iterations "$FASED_SAT_MAINTAIN_MAX_ITERATIONS")
fi
if [[ -n "$FASED_SAT_MAINTAIN_TARGET_RESERVE_LAMPORTS" ]]; then
  args+=(--target-reserve-lamports "$FASED_SAT_MAINTAIN_TARGET_RESERVE_LAMPORTS")
fi
if [[ -n "$FASED_SAT_MAINTAIN_GATEWAY_URL" ]]; then
  args+=(--url "$FASED_SAT_MAINTAIN_GATEWAY_URL")
fi
if [[ -n "$FASED_SAT_MAINTAIN_GATEWAY_TOKEN" ]]; then
  args+=(--token "$FASED_SAT_MAINTAIN_GATEWAY_TOKEN")
fi

if [[ -n "${FASED_CLI_BIN:-}" && -x "$FASED_CLI_BIN" ]]; then
  exec "$FASED_CLI_BIN" "${args[@]}"
fi

if [[ -n "${PNPM_BIN:-}" && -x "$PNPM_BIN" ]]; then
  cd "$AGENT_DIR"
  exec "$PNPM_BIN" fased "${args[@]}"
fi

if [[ -x "$HOME/.local/share/pnpm/pnpm" ]]; then
  cd "$AGENT_DIR"
  exec "$HOME/.local/share/pnpm/pnpm" fased "${args[@]}"
fi

if command -v pnpm >/dev/null 2>&1; then
  cd "$AGENT_DIR"
  exec pnpm fased "${args[@]}"
fi

if command -v fased >/dev/null 2>&1; then
  cd "$AGENT_DIR"
  exec fased "${args[@]}"
fi

echo "fased CLI not found; set FASED_CLI_BIN or PNPM_BIN" >&2
exit 127
