#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 IMAGE_REFERENCE [PLATFORM]" >&2
  exit 2
fi

IMAGE_REFERENCE="$1"
PLATFORM="${2:-linux/amd64}"
TRIVY_VERSION="0.70.0"
case "$(uname -m)" in
  x86_64 | amd64)
    TRIVY_ARCHIVE="trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"
    TRIVY_SHA256="8b4376d5d6befe5c24d503f10ff136d9e0c49f9127a4279fd110b727929a5aa9" # pragma: allowlist secret
    ;;
  aarch64 | arm64)
    TRIVY_ARCHIVE="trivy_${TRIVY_VERSION}_Linux-ARM64.tar.gz"
    TRIVY_SHA256="2f6bb988b553a1bbac6bdd1ce890f5e412439564e17522b88a4541b4f364fc8d" # pragma: allowlist secret
    ;;
  *)
    echo "Unsupported Trivy host architecture: $(uname -m)" >&2
    exit 2
    ;;
esac
# Pin each official release archive by digest; do not replace these with a
# mutable installer action or floating release URL.
TRIVY_URL="https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/${TRIVY_ARCHIVE}"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
TRIVY_CACHE_DIR="${TRIVY_CACHE_DIR:-$TEMP_DIR/cache}"
TRIVY_DOWNLOAD_CACHE_DIR="${TRIVY_DOWNLOAD_CACHE_DIR:-$TEMP_DIR/downloads}"
mkdir -p "$TRIVY_CACHE_DIR" "$TRIVY_DOWNLOAD_CACHE_DIR"
TRIVY_ARCHIVE_PATH="$TRIVY_DOWNLOAD_CACHE_DIR/$TRIVY_ARCHIVE"

if ! printf '%s  %s\n' "$TRIVY_SHA256" "$TRIVY_ARCHIVE_PATH" | sha256sum --check --status 2>/dev/null; then
  rm -f "$TRIVY_ARCHIVE_PATH"
  curl --fail --silent --show-error --location "$TRIVY_URL" --output "$TRIVY_ARCHIVE_PATH"
fi
printf '%s  %s\n' "$TRIVY_SHA256" "$TRIVY_ARCHIVE_PATH" | sha256sum --check --status
tar -xzf "$TRIVY_ARCHIVE_PATH" -C "$TEMP_DIR" trivy

echo "==> Scanning image layers for embedded secrets"
"$TEMP_DIR/trivy" --cache-dir "$TRIVY_CACHE_DIR" image \
  --no-progress \
  --platform "$PLATFORM" \
  --scanners secret \
  --exit-code 1 \
  "$IMAGE_REFERENCE"

echo "==> Scanning image for fixable critical vulnerabilities"
"$TEMP_DIR/trivy" --cache-dir "$TRIVY_CACHE_DIR" image \
  --no-progress \
  --platform "$PLATFORM" \
  --scanners vuln \
  --ignore-unfixed \
  --severity CRITICAL \
  --exit-code 1 \
  "$IMAGE_REFERENCE"
