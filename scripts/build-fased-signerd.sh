#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT}/dist-native"
BIN="${OUT_DIR}/fased-signerd"
GO_BIN="${FASED_GO_BIN:-}"
GOTMPDIR_DEFAULT="${HOME:-$ROOT}/.cache/fased/go-tmp"
GOCACHE_DEFAULT="${HOME:-$ROOT}/.cache/fased/go-build-cache"

if [[ -z "$GO_BIN" ]]; then
  if [[ -x /usr/local/go/bin/go ]]; then
    GO_BIN="/usr/local/go/bin/go"
  else
    GO_BIN="$(command -v go || true)"
  fi
fi

if [[ -z "$GO_BIN" || ! -x "$GO_BIN" ]]; then
  echo "Go binary not found. Install Go >= 1.21." >&2
  exit 1
fi

GO_VER="$("$GO_BIN" version 2>/dev/null | awk '{print $3}' | sed 's/^go//')"
GO_MAJ="$(echo "$GO_VER" | cut -d. -f1)"
GO_MIN="$(echo "$GO_VER" | cut -d. -f2)"
if ! [[ "${GO_MAJ:-0}" -gt 1 || ( "${GO_MAJ:-0}" -eq 1 && "${GO_MIN:-0}" -ge 21 ) ]]; then
  echo "Go >= 1.21 required (found: $GO_VER at $GO_BIN)." >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"
mkdir -p "${GOTMPDIR:-$GOTMPDIR_DEFAULT}" "${GOCACHE:-$GOCACHE_DEFAULT}"
export GOTMPDIR="${GOTMPDIR:-$GOTMPDIR_DEFAULT}"
export GOCACHE="${GOCACHE:-$GOCACHE_DEFAULT}"
cd "${ROOT}/tools/fased-signerd"

"$GO_BIN" build -o "${BIN}" .
chmod +x "${BIN}"
echo "Built ${BIN}"
