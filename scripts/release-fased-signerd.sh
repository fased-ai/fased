#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT}/dist-native/release"
TARGETS="${FASED_SIGNER_TARGETS:-linux/amd64,linux/arm64,darwin/amd64,darwin/arm64}"
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

mkdir -p "$OUT_DIR"
mkdir -p "${GOTMPDIR:-$GOTMPDIR_DEFAULT}" "${GOCACHE:-$GOCACHE_DEFAULT}"
export GOTMPDIR="${GOTMPDIR:-$GOTMPDIR_DEFAULT}"
export GOCACHE="${GOCACHE:-$GOCACHE_DEFAULT}"
cd "${ROOT}/tools/fased-signerd"

IFS=',' read -r -a target_list <<< "$TARGETS"
for target in "${target_list[@]}"; do
  os="${target%/*}"
  arch="${target#*/}"
  asset="fased-signerd-${os}-${arch}"
  echo "Building ${asset}..."
  GOOS="$os" GOARCH="$arch" "$GO_BIN" build -trimpath -ldflags='-s -w' -o "${OUT_DIR}/${asset}" .
  chmod +x "${OUT_DIR}/${asset}"
done

(
  cd "$OUT_DIR"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum fased-signerd-* > fased-signerd-checksums.txt
  else
    shasum -a 256 fased-signerd-* > fased-signerd-checksums.txt
  fi
)

echo "Built assets:"
ls -1 "$OUT_DIR"/fased-signerd-* "$OUT_DIR"/fased-signerd-checksums.txt
