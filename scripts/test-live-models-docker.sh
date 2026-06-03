#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${FASED_IMAGE:-fased:local}"
CONFIG_DIR="${FASED_CONFIG_DIR:-$HOME/.fased}"
WORKSPACE_DIR="${FASED_WORKSPACE_DIR:-$HOME/.fased/workspace}"
PROFILE_FILE="${FASED_PROFILE_FILE:-$HOME/.profile}"

PROFILE_MOUNT=()
if [[ -f "$PROFILE_FILE" ]]; then
  PROFILE_MOUNT=(-v "$PROFILE_FILE":/home/node/.profile:ro)
fi

echo "==> Build image: $IMAGE_NAME"
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"

echo "==> Run live model tests (profile keys)"
docker run --rm -t \
  --entrypoint bash \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e HOME=/home/node \
  -e NODE_OPTIONS=--disable-warning=ExperimentalWarning \
  -e FASED_LIVE_TEST=1 \
  -e FASED_LIVE_MODELS="${FASED_LIVE_MODELS:-modern}" \
  -e FASED_LIVE_PROVIDERS="${FASED_LIVE_PROVIDERS:-}" \
  -e FASED_LIVE_MAX_MODELS="${FASED_LIVE_MAX_MODELS:-48}" \
  -e FASED_LIVE_MODEL_TIMEOUT_MS="${FASED_LIVE_MODEL_TIMEOUT_MS:-}" \
  -e FASED_LIVE_REQUIRE_PROFILE_KEYS="${FASED_LIVE_REQUIRE_PROFILE_KEYS:-}" \
  -v "$CONFIG_DIR":/home/node/.fased \
  -v "$WORKSPACE_DIR":/home/node/.fased/workspace \
  "${PROFILE_MOUNT[@]}" \
  "$IMAGE_NAME" \
  -lc "set -euo pipefail; [ -f \"$HOME/.profile\" ] && source \"$HOME/.profile\" || true; cd /app && pnpm test:live"
