#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fased-native-release.XXXXXX")"
trap 'rm -rf -- "$LOG_ROOT"' EXIT INT TERM HUP

bash "$ROOT/scripts/release-fased-signerd.sh" >"$LOG_ROOT/signer.log" 2>&1 &
signer_pid="$!"
bash "$ROOT/scripts/release-fased-lifecycled.sh" >"$LOG_ROOT/lifecycle.log" 2>&1 &
lifecycle_pid="$!"

signer_status=0
lifecycle_status=0
wait "$signer_pid" || signer_status="$?"
wait "$lifecycle_pid" || lifecycle_status="$?"

printf '%s\n' 'native-release: signer log'
cat "$LOG_ROOT/signer.log"
printf '%s\n' 'native-release: lifecycle log'
cat "$LOG_ROOT/lifecycle.log"

if [[ "$signer_status" -ne 0 || "$lifecycle_status" -ne 0 ]]; then
  echo "native-release: parallel build failed (signer=$signer_status lifecycle=$lifecycle_status)" >&2
  exit 1
fi
echo "native-release: parallel build passed"
