#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="fased-sandbox-browser:bookworm-slim"

docker build -t "${IMAGE_NAME}" -f deploy/containers/Dockerfile.sandbox-browser .
echo "Built ${IMAGE_NAME}"
