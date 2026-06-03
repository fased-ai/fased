#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR_DEFAULT="${HOME}/.fased/bin"
INSTALL_DIR="${FASED_LOCAL_SIGNER_BIN_DIR:-$INSTALL_DIR_DEFAULT}"
VERSION="${FASED_LOCAL_SIGNER_VERSION:-latest}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac

case "$OS" in
  linux|darwin) ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

mkdir -p "$INSTALL_DIR"
BIN_PATH="${INSTALL_DIR}/fased-signerd"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BASE_URL="${FASED_LOCAL_SIGNER_BASE_URL:-https://github.com/fased-ai/fased/releases/download}"
if [[ "$VERSION" == "latest" ]]; then
  VERSION_TAG="${FASED_LOCAL_SIGNER_LATEST_TAG-latest}"
else
  VERSION_TAG="$VERSION"
fi

ASSET="fased-signerd-${OS}-${ARCH}"
if [[ -n "${VERSION_TAG}" ]]; then
  URL="${BASE_URL}/${VERSION_TAG}/${ASSET}"
  SUMS_URL="${BASE_URL}/${VERSION_TAG}/fased-signerd-checksums.txt"
else
  URL="${BASE_URL}/${ASSET}"
  SUMS_URL="${BASE_URL}/fased-signerd-checksums.txt"
fi

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fL "$URL" -o "${TMP}/fased-signerd"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -O "${TMP}/fased-signerd" "$URL"
    return
  fi
  echo "Need curl or wget to download fased-signerd" >&2
  exit 1
}

download_to() {
  local src="$1"
  local dst="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fL "$src" -o "$dst"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -O "$dst" "$src"
    return
  fi
  echo "Need curl or wget to download fased-signerd" >&2
  exit 1
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return
  fi
  echo "Need sha256sum or shasum for checksum verification" >&2
  exit 1
}

echo "Installing fased-signerd (${OS}/${ARCH}) from:"
echo "  $URL"
download
echo "Verifying checksum from:"
echo "  $SUMS_URL"
download_to "$SUMS_URL" "${TMP}/checksums.txt"
EXPECTED="$(awk -v asset="$ASSET" '$2==asset {print $1}' "${TMP}/checksums.txt" | head -n1)"
if [[ -z "$EXPECTED" ]]; then
  echo "Checksum entry not found for $ASSET in checksums file" >&2
  exit 1
fi
ACTUAL="$(sha256_file "${TMP}/fased-signerd")"
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
  echo "Checksum mismatch for $ASSET" >&2
  echo "expected: $EXPECTED" >&2
  echo "actual:   $ACTUAL" >&2
  exit 1
fi
echo "Checksum OK: $ACTUAL"
install -m 0755 "${TMP}/fased-signerd" "$BIN_PATH"

echo "Installed: $BIN_PATH"
echo "Export for Fased:"
echo "  export FASED_WALLET_LOCAL_SIGNER_BIN=\"$BIN_PATH\""
