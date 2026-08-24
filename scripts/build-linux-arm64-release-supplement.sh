#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${1:-}"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT_DIR/package.json")"
COMMIT="${FASED_RELEASE_SOURCE_COMMIT:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
TREE="$(git -C "$ROOT_DIR" rev-parse "${COMMIT}^{tree}")"
GO_BIN="${FASED_GO_BIN:-$(command -v go || true)}"

[[ "$OUTPUT_DIR" == /* ]] || { echo "usage: build-linux-arm64-release-supplement.sh EMPTY_ABSOLUTE_OUTPUT_DIR" >&2; exit 2; }
[[ "$(node -p process.platform)" == "linux" && "$(node -p process.arch)" == "arm64" ]] || {
  echo "The Linux-arm64 supplement must be built on a native Linux arm64 runner." >&2
  exit 1
}
[[ "$COMMIT" =~ ^[a-f0-9]{40}$ && -n "$GO_BIN" && -x "$GO_BIN" ]]
[[ -z "$(git -C "$ROOT_DIR" status --porcelain=v1 --untracked-files=normal)" ]]
[[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" == "$COMMIT" ]]
[[ -x "$ROOT_DIR/node_modules/.bin/tsdown" && -x "$ROOT_DIR/ui/node_modules/.bin/vite" ]]
mkdir -p "$OUTPUT_DIR"
[[ -z "$(find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]

if [[ ! -f "$ROOT_DIR/dist/build-info.json" ]] ||
  [[ "$(jq -r .version "$ROOT_DIR/dist/build-info.json")" != "$VERSION" ]] ||
  [[ "$(jq -r .commit "$ROOT_DIR/dist/build-info.json")" != "$COMMIT" ]]; then
  pnpm --dir "$ROOT_DIR" build
fi

release_dir="$ROOT_DIR/dist-native/release"
mkdir -p "$release_dir"
find "$release_dir" -maxdepth 1 -type f \( -name '*-linux-arm64' -o -name 'fased-bootstrap-linux-arm64' \) -delete
go_tmp="${GOTMPDIR:-${TMPDIR:-/tmp}/fased-release-go-tmp}"
go_cache="${GOCACHE:-${TMPDIR:-/tmp}/fased-release-go-cache}"
mkdir -p "$go_tmp" "$go_cache"
GOTMPDIR="$go_tmp" GOCACHE="$go_cache" \
FASED_SIGNER_BUILD_COMMIT="$COMMIT" FASED_SIGNER_TARGETS="linux/arm64" \
FASED_LIFECYCLE_BUILD_COMMIT="$COMMIT" FASED_LIFECYCLE_BUILD_TREE="$TREE" \
FASED_LIFECYCLE_TARGETS="linux/arm64" \
  bash "$ROOT_DIR/scripts/build-native-release-assets.sh"

pnpm --dir "$ROOT_DIR" hosted:artifact:from-dist --output "$OUTPUT_DIR"
install -m 0755 "$release_dir/fased-signerd-linux-arm64" "$OUTPUT_DIR/fased-signerd-linux-arm64"
install -m 0755 "$release_dir/fased-lifecycled-linux-arm64" "$OUTPUT_DIR/fased-lifecycled-linux-arm64"
install -m 0755 "$release_dir/fased-bootstrap-linux-arm64" "$OUTPUT_DIR/fased-bootstrap-linux-arm64"
node_binary="$(readlink -f "$(command -v node)")"
node_root="$(dirname "$(dirname "$node_binary")")"
install -m 0755 "$node_binary" "$OUTPUT_DIR/fased-node-linux-arm64"
install -m 0644 "$node_root/LICENSE" "$OUTPUT_DIR/fased-node-license-linux-arm64"

for required in \
  fased-bootstrap-linux-arm64 \
  fased-lifecycled-linux-arm64 \
  fased-signerd-linux-arm64 \
  fased-node-linux-arm64 \
  fased-node-license-linux-arm64 \
  "fased-hosted-app-v2-linux-arm64-v${VERSION}.tar.gz" \
  "fased-hosted-app-v2-linux-arm64-v${VERSION}.tar.gz.release.json"; do
  test -s "$OUTPUT_DIR/$required"
done
echo "Linux-arm64 release supplement: commit=$COMMIT tree=$TREE"
