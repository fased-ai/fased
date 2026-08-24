#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${1:-}"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT_DIR/package.json")"
COMMIT="${FASED_RELEASE_SOURCE_COMMIT:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
TREE="$(git -C "$ROOT_DIR" rev-parse "${COMMIT}^{tree}")"
GO_BIN="${FASED_GO_BIN:-$(command -v go || true)}"
NODE_ARCH="$(node -p process.arch)"
case "$NODE_ARCH" in
  x64) GO_ARCH=amd64 ;;
  arm64) GO_ARCH=arm64 ;;
  *) echo "Unsupported native macOS architecture: $NODE_ARCH" >&2; exit 1 ;;
esac

[[ "$OUTPUT_DIR" == /* ]] || { echo "usage: build-darwin-release-supplement.sh EMPTY_ABSOLUTE_OUTPUT_DIR" >&2; exit 2; }
[[ "$(node -p process.platform)" == "darwin" ]] || {
  echo "The macOS supplement must be built on a native macOS runner." >&2
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
  pnpm --dir "$ROOT_DIR" build:app
fi

release_dir="$ROOT_DIR/dist-native/release"
mkdir -p "$release_dir"
find "$release_dir" -maxdepth 1 -type f \( -name "*-darwin-${GO_ARCH}" -o -name "fased-bootstrap-darwin-${NODE_ARCH}" \) -delete
go_tmp="${GOTMPDIR:-${TMPDIR:-/tmp}/fased-release-go-tmp}"
go_cache="${GOCACHE:-${TMPDIR:-/tmp}/fased-release-go-cache}"
mkdir -p "$go_tmp" "$go_cache"
GOTMPDIR="$go_tmp" GOCACHE="$go_cache" \
FASED_SIGNER_BUILD_COMMIT="$COMMIT" FASED_SIGNER_TARGETS="darwin/${GO_ARCH}" \
FASED_LIFECYCLE_BUILD_COMMIT="$COMMIT" FASED_LIFECYCLE_BUILD_TREE="$TREE" \
FASED_LIFECYCLE_TARGETS="darwin/${GO_ARCH}" \
  bash "$ROOT_DIR/scripts/build-native-release-assets.sh"

pnpm --dir "$ROOT_DIR" hosted:artifact:from-dist --output "$OUTPUT_DIR"
install -m 0755 "$release_dir/fased-signerd-darwin-${GO_ARCH}" "$OUTPUT_DIR/fased-signerd-darwin-${GO_ARCH}"
install -m 0755 "$release_dir/fased-lifecycled-darwin-${GO_ARCH}" "$OUTPUT_DIR/fased-lifecycled-darwin-${GO_ARCH}"
install -m 0755 "$release_dir/fased-bootstrap-darwin-${NODE_ARCH}" "$OUTPUT_DIR/fased-bootstrap-darwin-${NODE_ARCH}"
for executable in \
  "$OUTPUT_DIR/fased-signerd-darwin-${GO_ARCH}" \
  "$OUTPUT_DIR/fased-lifecycled-darwin-${GO_ARCH}" \
  "$OUTPUT_DIR/fased-bootstrap-darwin-${NODE_ARCH}"; do
  codesign --force --sign - "$executable"
  codesign --verify --strict "$executable"
done
node_binary="$(node -p process.execPath)"
node_root="$(dirname "$(dirname "$node_binary")")"
install -m 0755 "$node_binary" "$OUTPUT_DIR/fased-node-darwin-${NODE_ARCH}"
install -m 0644 "$node_root/LICENSE" "$OUTPUT_DIR/fased-node-license-darwin-${NODE_ARCH}"

for required in \
  "fased-bootstrap-darwin-${NODE_ARCH}" \
  "fased-lifecycled-darwin-${GO_ARCH}" \
  "fased-signerd-darwin-${GO_ARCH}" \
  "fased-node-darwin-${NODE_ARCH}" \
  "fased-node-license-darwin-${NODE_ARCH}" \
  "fased-hosted-app-v2-darwin-${NODE_ARCH}-v${VERSION}.tar.gz" \
  "fased-hosted-app-v2-darwin-${NODE_ARCH}-v${VERSION}.tar.gz.release.json"; do
  test -s "$OUTPUT_DIR/$required"
done
echo "macOS-${NODE_ARCH} release supplement: commit=$COMMIT tree=$TREE"
