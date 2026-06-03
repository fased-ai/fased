#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$ROOT_DIR/install.sh"

echo "[legacy] scripts/fased-onboard.sh now delegates to install.sh (canonical onboarding path)."
echo "[legacy] use: ./install.sh [--wallet-mode ...] [--non-interactive] [--no-start]"

if [[ ! -x "$INSTALLER" ]]; then
  echo "Missing installer at $INSTALLER" >&2
  exit 1
fi

exec "$INSTALLER" "$@"
