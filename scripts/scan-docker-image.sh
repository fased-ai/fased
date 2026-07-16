#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 IMAGE_REFERENCE [PLATFORM]" >&2
  exit 2
fi

IMAGE_REFERENCE="$1"
PLATFORM="${2:-linux/amd64}"
TRIVY_VERSION="0.70.0"
TRIVY_ARCHIVE="trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"
# Pin the official release archive by digest; do not replace this with a mutable
# installer action or floating release URL.
TRIVY_SHA256="8b4376d5d6befe5c24d503f10ff136d9e0c49f9127a4279fd110b727929a5aa9"
TRIVY_URL="https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/${TRIVY_ARCHIVE}"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

curl --fail --silent --show-error --location "$TRIVY_URL" --output "$TEMP_DIR/$TRIVY_ARCHIVE"
printf '%s  %s\n' "$TRIVY_SHA256" "$TEMP_DIR/$TRIVY_ARCHIVE" | sha256sum --check --status
tar -xzf "$TEMP_DIR/$TRIVY_ARCHIVE" -C "$TEMP_DIR" trivy

echo "==> Scanning image layers for embedded secrets"
"$TEMP_DIR/trivy" --cache-dir "$TEMP_DIR/cache" image \
  --no-progress \
  --platform "$PLATFORM" \
  --scanners secret \
  --exit-code 1 \
  "$IMAGE_REFERENCE"

echo "==> Scanning image for fixable critical vulnerabilities"
"$TEMP_DIR/trivy" --cache-dir "$TEMP_DIR/cache" image \
  --no-progress \
  --platform "$PLATFORM" \
  --scanners vuln \
  --ignore-unfixed \
  --severity CRITICAL \
  --exit-code 1 \
  "$IMAGE_REFERENCE"
