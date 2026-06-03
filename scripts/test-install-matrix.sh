#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$ROOT_DIR/install.sh"

if [[ ! -x "$INSTALLER" ]]; then
  echo "Missing executable installer: $INSTALLER" >&2
  exit 1
fi

run_case() {
  local name="$1"
  shift
  local out
  out="$(mktemp)"
  if ! "$@" >"$out" 2>&1; then
    cat "$out"
    rm -f "$out"
    echo "Case failed: $name" >&2
    exit 1
  fi
  cat "$out"
  rm -f "$out"
}

echo "== install.sh matrix tests =="

echo "-- case: no-start + non-interactive local-signer"
run_case no_start_local_signer \
  env FASED_INSTALL_TEST_MODE=1 \
  "$INSTALLER" --non-interactive --wallet-mode local-signer --no-start

echo "-- case: skip-wallet-setup + no-start"
run_case skip_wallet_setup \
  env FASED_INSTALL_TEST_MODE=1 \
  "$INSTALLER" --skip-wallet-setup --no-start

echo "-- case: turnkey env-missing remediation"
set +e
turnkey_out="$(mktemp)"
env FASED_INSTALL_TEST_MODE=1 FASED_INSTALL_TEST_WALLET_SETUP_FAIL=1 \
  "$INSTALLER" --non-interactive --wallet-mode turnkey --no-start >"$turnkey_out" 2>&1
turnkey_rc=$?
set -e
cat "$turnkey_out"
if [[ $turnkey_rc -eq 0 ]]; then
  rm -f "$turnkey_out"
  echo "Expected turnkey remediation path to fail in test mode." >&2
  exit 1
fi
if ! grep -q "Turnkey non-interactive requires env/flags" "$turnkey_out"; then
  rm -f "$turnkey_out"
  echo "Missing turnkey remediation text." >&2
  exit 1
fi
rm -f "$turnkey_out"

echo "install matrix tests: OK"
