#!/usr/bin/env bash
set -euo pipefail

cd /repo

export FASED_STATE_DIR="/tmp/fased-test"
export FASED_CONFIG_PATH="${FASED_STATE_DIR}/fased.json"

echo "==> Build"
pnpm build

echo "==> Seed state"
mkdir -p "${FASED_STATE_DIR}/credentials"
mkdir -p "${FASED_STATE_DIR}/agents/main/sessions"
echo '{}' >"${FASED_CONFIG_PATH}"
echo 'creds' >"${FASED_STATE_DIR}/credentials/marker.txt"
echo 'session' >"${FASED_STATE_DIR}/agents/main/sessions/sessions.json"

echo "==> Reset (config+creds+sessions)"
pnpm fased reset --scope config+creds+sessions --yes --non-interactive

test ! -f "${FASED_CONFIG_PATH}"
test ! -d "${FASED_STATE_DIR}/credentials"
test ! -d "${FASED_STATE_DIR}/agents/main/sessions"

echo "==> Recreate minimal config"
mkdir -p "${FASED_STATE_DIR}/credentials"
echo '{}' >"${FASED_CONFIG_PATH}"

echo "==> Uninstall (state only)"
pnpm fased uninstall --state --yes --non-interactive

test ! -d "${FASED_STATE_DIR}"

echo "OK"
