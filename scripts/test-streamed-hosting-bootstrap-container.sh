#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${FASED_CONTAINER_RUNTIME:-}"
if [[ -z "$RUNTIME" ]]; then
  if command -v docker >/dev/null 2>&1; then
    RUNTIME=docker
  elif command -v podman >/dev/null 2>&1; then
    RUNTIME=podman
  else
    echo "Docker or Podman is required for the disposable streamed Hosting bootstrap test." >&2
    exit 1
  fi
fi
IMAGE="fased-streamed-hosting-bootstrap-test:local"
"$RUNTIME" build -t "$IMAGE" "$ROOT_DIR/scripts/docker/streamed-hosting-bootstrap"
mount="${ROOT_DIR}:/repo:ro"
[[ "$RUNTIME" != "podman" ]] || mount="${mount},z"
"$RUNTIME" run --rm -v "$mount" "$IMAGE"
