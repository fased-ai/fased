#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO_BIN="${FASED_GO_BIN:-$(command -v go || true)}"
OUT="${ROOT}/dist-native/fased-lifecycled"
[[ -n "$GO_BIN" && -x "$GO_BIN" ]] || { echo "Go binary not found" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")" "${GOCACHE:-/tmp/fased-lifecycled-go-cache}"
export GOCACHE="${GOCACHE:-/tmp/fased-lifecycled-go-cache}"
LDFLAGS="$(FASED_LIFECYCLE_BUILD_DEVELOPMENT=true node "$ROOT/scripts/fased-lifecycled-build-identity.mjs" --ldflags)"
(
  cd "$ROOT/tools/fased-lifecycled"
  CGO_ENABLED=0 "$GO_BIN" build -buildvcs=false -trimpath -ldflags="-buildid= ${LDFLAGS}" -o "$OUT" ./cmd/fased-lifecycled
)
chmod 0755 "$OUT"
"$OUT" --version
