#!/usr/bin/env bash
set -euo pipefail

umask 077

if [[ "${EUID}" == "0" ]]; then
  echo "Local signer policy setup must run as the non-root user that owns the signer." >&2
  exit 1
fi

INSTALL_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
HELPER="${INSTALL_DIR}/fased-signer-owner-policy.mjs"

if [[ ! -f "$HELPER" || -L "$HELPER" ]]; then
  echo "Installed Local signer policy helper is missing or unsafe: $HELPER" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to run the Local signer policy helper." >&2
  exit 1
fi
if [[ $# -eq 1 && "$1" == "--help" ]]; then
  exec node "$HELPER" --help
fi

exec node "$HELPER" --profile local "$@"
