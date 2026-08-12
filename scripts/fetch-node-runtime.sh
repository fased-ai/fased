#!/usr/bin/env bash
set -euo pipefail

architecture="${1:?usage: fetch-node-runtime.sh <x64|arm64> <output-directory>}"
output_directory="${2:?usage: fetch-node-runtime.sh <x64|arm64> <output-directory>}"
node_version=24.10.0

case "$architecture" in
  x64) archive_sha256=2642f4428869aca32443660fd71b3918e2be1277a899bdcaeb64c93b54b5af17 ;;
  arm64) archive_sha256=07f0558316ebb8977dd6fb29b4de8d369a639d3d8cef544293852a6f5eea6af8 ;;
  *) echo "unsupported Node runtime architecture: $architecture" >&2; exit 1 ;;
esac

archive="node-v${node_version}-linux-${architecture}.tar.xz"
workspace="$(mktemp -d "${TMPDIR:-/tmp}/fased-node-runtime.XXXXXX")"
trap 'rm -rf -- "$workspace"' EXIT

curl --fail --location --silent --show-error \
  "https://nodejs.org/dist/v${node_version}/${archive}" \
  --output "$workspace/$archive"
printf '%s  %s\n' "$archive_sha256" "$workspace/$archive" | sha256sum --check --status
tar -xJf "$workspace/$archive" -C "$workspace" \
  "node-v${node_version}-linux-${architecture}/bin/node" \
  "node-v${node_version}-linux-${architecture}/LICENSE"

install -d -m 0755 "$output_directory"
install -m 0755 \
  "$workspace/node-v${node_version}-linux-${architecture}/bin/node" \
  "$output_directory/node"
install -m 0644 \
  "$workspace/node-v${node_version}-linux-${architecture}/LICENSE" \
  "$output_directory/LICENSE"
