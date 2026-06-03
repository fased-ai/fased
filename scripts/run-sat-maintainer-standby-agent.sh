#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

export FASED_SAT_MAINTAIN_MAX_ITERATIONS=1
export FASED_SAT_MAINTAIN_INTERVAL_SECONDS=0
export FASED_SAT_MAINTAIN_JITTER_SECONDS=0

set +e
OUTPUT="$(/bin/bash "$SCRIPT_DIR/run-sat-maintainer-agent.sh" 2>&1)"
RC=$?
set -e

if (( RC != 0 )) && {
  [[ "$OUTPUT" == *"SAT maintenance loop already running; lock file"* ]] ||
    [[ "$OUTPUT" == *"SAT maintainer runner already active; lock file"* ]]
}; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') - SAT maintainer standby skipped; primary lock is active"
  exit 0
fi

if [[ -n "$OUTPUT" ]]; then
  printf '%s\n' "$OUTPUT"
fi
exit "$RC"
