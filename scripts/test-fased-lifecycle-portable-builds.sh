#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO_BIN="${FASED_GO_BIN:-$(command -v go || true)}"
[[ -n "$GO_BIN" && -x "$GO_BIN" ]] || { echo "Go is required." >&2; exit 1; }
OUTPUT="$(mktemp -d "${TMPDIR:-/tmp}/fased-lifecycle-portable.XXXXXX")"
trap 'rm -rf -- "$OUTPUT"' EXIT INT TERM HUP
mkdir -p "${GOCACHE:-${TMPDIR:-/tmp}/fased-lifecycle-portable-cache}" "${GOTMPDIR:-${TMPDIR:-/tmp}/fased-lifecycle-portable-tmp}"
export GOCACHE="${GOCACHE:-${TMPDIR:-/tmp}/fased-lifecycle-portable-cache}"
export GOTMPDIR="${GOTMPDIR:-${TMPDIR:-/tmp}/fased-lifecycle-portable-tmp}"

for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64; do
  operating_system="${target%/*}"
  architecture="${target#*/}"
  for command in fased-lifecycled fased-bootstrap; do
    package="./cmd/$command"
    (
      cd "$ROOT/tools/fased-lifecycled"
      CGO_ENABLED=0 GOOS="$operating_system" GOARCH="$architecture" \
        "$GO_BIN" build -buildvcs=false -trimpath \
        -o "$OUTPUT/${command}-${operating_system}-${architecture}" "$package"
    )
  done
done

for binary in "$OUTPUT"/*; do
  test -s "$binary"
done
echo "Portable lifecycle compilation passed: linux/amd64, linux/arm64, darwin/amd64, darwin/arm64"
