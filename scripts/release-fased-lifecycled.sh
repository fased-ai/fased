#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO_BIN="${FASED_GO_BIN:-$(command -v go || true)}"
OUT="${ROOT}/dist-native/release"
TARGETS="${FASED_LIFECYCLE_TARGETS:-linux/amd64,linux/arm64}"
[[ -n "$GO_BIN" && -x "$GO_BIN" ]] || { echo "Go binary not found" >&2; exit 1; }
mkdir -p "$OUT" "${GOCACHE:-/tmp/fased-lifecycled-go-cache}"
export GOCACHE="${GOCACHE:-/tmp/fased-lifecycled-go-cache}"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"
COMMIT="${FASED_LIFECYCLE_BUILD_COMMIT:-$(git -C "$ROOT" rev-parse HEAD)}"
TREE="${FASED_LIFECYCLE_BUILD_TREE:-$(git -C "$ROOT" rev-parse 'HEAD^{tree}')}"
IDENTITY="$(FASED_LIFECYCLE_BUILD_VERSION="$VERSION" FASED_LIFECYCLE_BUILD_COMMIT="$COMMIT" FASED_LIFECYCLE_BUILD_TREE="$TREE" FASED_LIFECYCLE_BUILD_DEVELOPMENT=false node "$ROOT/scripts/fased-lifecycled-build-identity.mjs" --json)"
LDFLAGS="$(FASED_LIFECYCLE_BUILD_VERSION="$VERSION" FASED_LIFECYCLE_BUILD_COMMIT="$COMMIT" FASED_LIFECYCLE_BUILD_TREE="$TREE" FASED_LIFECYCLE_BUILD_DEVELOPMENT=false node "$ROOT/scripts/fased-lifecycled-build-identity.mjs" --ldflags)"
IFS=',' read -r -a target_list <<< "$TARGETS"
assets=()
for target in "${target_list[@]}"; do
  os="${target%/*}"; arch="${target#*/}"; asset="fased-lifecycled-${os}-${arch}"
  (cd "$ROOT/tools/fased-lifecycled"; CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" "$GO_BIN" build -buildvcs=false -trimpath -ldflags="-s -w -buildid= ${LDFLAGS}" -o "$OUT/$asset" ./cmd/fased-lifecycled)
  chmod 0755 "$OUT/$asset"; assets+=("$asset")
done
node -e 'const fs=require("node:fs"); fs.writeFileSync(process.argv[2], JSON.stringify({schemaVersion:1,...JSON.parse(process.argv[1])},null,2)+"\n",{mode:0o644})' "$IDENTITY" "$OUT/fased-lifecycled-release.json"
assets+=("fased-lifecycled-release.json")
(cd "$OUT"; sha256sum "${assets[@]}" > fased-lifecycled-checksums.txt)
