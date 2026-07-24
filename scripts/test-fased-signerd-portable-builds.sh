#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO_BIN="${FASED_GO_BIN:-$(command -v go || true)}"
OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fased-signerd-portable.XXXXXX")"

cleanup() {
  rm -rf -- "$OUT_DIR"
}
trap cleanup EXIT INT TERM HUP

[[ -n "$GO_BIN" && -x "$GO_BIN" ]] || {
  echo "Go is required for portable signer build validation." >&2
  exit 1
}
command -v file >/dev/null 2>&1 || {
  echo "The file utility is required for portable signer build validation." >&2
  exit 1
}

mkdir -p \
  "${GOTMPDIR:-${TMPDIR:-/tmp}/fased-go-tmp}" \
  "${GOCACHE:-${TMPDIR:-/tmp}/fased-go-cache}"
export GOTMPDIR="${GOTMPDIR:-${TMPDIR:-/tmp}/fased-go-tmp}"
export GOCACHE="${GOCACHE:-${TMPDIR:-/tmp}/fased-go-cache}"

cd "$ROOT/tools/fased-signerd"
targets=(
  "linux amd64 ELF.*x86-64"
  "linux arm64 ELF.*ARM aarch64"
  "darwin amd64 Mach-O.*x86_64"
  "darwin arm64 Mach-O.*arm64"
)

for entry in "${targets[@]}"; do
  read -r target_os target_arch expected <<<"$entry"
  output="$OUT_DIR/fased-signerd-${target_os}-${target_arch}.test"
  echo "Compiling signer tests for ${target_os}/${target_arch}..."
  CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" \
    "$GO_BIN" test -c -buildvcs=false -trimpath -o "$output" .
  description="$(file -b "$output")"
  [[ "$description" =~ $expected ]] || {
    echo "Unexpected ${target_os}/${target_arch} test binary: $description" >&2
    exit 1
  }
done

echo "Portable signer test compilation passed: linux/amd64, linux/arm64, darwin/amd64, darwin/arm64"
