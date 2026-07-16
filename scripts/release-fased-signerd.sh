#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT}/dist-native/release"
TARGETS="${FASED_SIGNER_TARGETS:-linux/amd64,linux/arm64,darwin/amd64,darwin/arm64}"
GO_BIN="${FASED_GO_BIN:-}"
MIN_GO_VERSION="1.25.7"
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
  echo "Go binary not found. Install Go >= ${MIN_GO_VERSION}." >&2
  exit 1
fi

GO_VER="$("$GO_BIN" version 2>/dev/null | awk '{print $3}' | sed 's/^go//')"
GO_MAJ="$(echo "$GO_VER" | cut -d. -f1)"
GO_MIN="$(echo "$GO_VER" | cut -d. -f2)"
GO_PATCH="$(echo "$GO_VER" | cut -d. -f3 | sed 's/[^0-9].*$//')"
if ! [[ "${GO_MAJ:-0}" -gt 1 || ( "${GO_MAJ:-0}" -eq 1 && ( "${GO_MIN:-0}" -gt 25 || ( "${GO_MIN:-0}" -eq 25 && "${GO_PATCH:-0}" -ge 7 ) ) ) ]]; then
  echo "Go >= ${MIN_GO_VERSION} required (found: $GO_VER at $GO_BIN)." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
mkdir -p "${GOTMPDIR:-$GOTMPDIR_DEFAULT}" "${GOCACHE:-$GOCACHE_DEFAULT}"
export GOTMPDIR="${GOTMPDIR:-$GOTMPDIR_DEFAULT}"
export GOCACHE="${GOCACHE:-$GOCACHE_DEFAULT}"
cd "${ROOT}/tools/fased-signerd"

IFS=',' read -r -a target_list <<< "$TARGETS"
release_assets=()
for target in "${target_list[@]}"; do
  os="${target%/*}"
  arch="${target#*/}"
  asset="fased-signerd-${os}-${arch}"
  echo "Building ${asset}..."
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" "$GO_BIN" build -buildvcs=false -trimpath -ldflags='-s -w' -o "${OUT_DIR}/${asset}" .
  chmod +x "${OUT_DIR}/${asset}"
  release_assets+=("$asset")
done

NOTICE_ASSET="fased-signerd-third-party-licenses.txt"
cp "${ROOT}/tools/fased-signerd/THIRD_PARTY_LICENSES/go-webauthn-BSD-3-Clause.txt" \
  "${OUT_DIR}/${NOTICE_ASSET}"
release_assets+=("${NOTICE_ASSET}")

(
  cd "$OUT_DIR"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${release_assets[@]}" > fased-signerd-checksums.txt
  else
    shasum -a 256 "${release_assets[@]}" > fased-signerd-checksums.txt
  fi
)

echo "Built assets:"
ls -1 "$OUT_DIR"/fased-signerd-*
