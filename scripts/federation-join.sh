#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/federation-join.sh [--handle @fased-agent@ff1.fased.app] [--node-endpoint https://ff1.fased.app] [--agent-name fased-agent]

Environment:
  FASED_GATEWAY_ORIGIN     Local gateway URL (default: http://127.0.0.1:18789)
  FASED_GATEWAY_TOKEN      Optional gateway bearer token for secured gateway HTTP
  FASED_A2A_ORIGIN         Default node endpoint fallback
  FASED_A2A_HANDLE         Default handle fallback
  FASED_A2A_NAME           Agent name used when handle is auto-derived (default: fased-agent)

Flow:
  1) register handle
  2) attest (gateway builds and signs attestation payload)
  3) fetch directory entry for the handle
EOF
}

HANDLE="${FASED_A2A_HANDLE:-}"
AGENT_NAME="${FASED_A2A_NAME:-fased-agent}"
NODE_ENDPOINT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --handle)
      HANDLE="${2:-}"
      shift 2
      ;;
    --node-endpoint)
      NODE_ENDPOINT="${2:-}"
      shift 2
      ;;
    --agent-name)
      AGENT_NAME="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

GATEWAY_ORIGIN="${FASED_GATEWAY_ORIGIN:-http://127.0.0.1:18789}"
if [[ -z "${NODE_ENDPOINT}" ]]; then
  NODE_ENDPOINT="${FASED_A2A_ORIGIN:-$GATEWAY_ORIGIN}"
fi

if [[ -z "${HANDLE}" ]]; then
  HOST="$(node -e "process.stdout.write(new URL(process.argv[1]).hostname)" "${NODE_ENDPOINT}")"
  if [[ -z "${AGENT_NAME}" ]]; then
    AGENT_NAME="fased-agent"
  fi
  HANDLE="@${AGENT_NAME}@${HOST}"
  echo "Auto-derived handle: ${HANDLE}"
fi

AUTH_ARGS=()
if [[ -n "${FASED_GATEWAY_TOKEN:-}" ]]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${FASED_GATEWAY_TOKEN}")
fi

echo "[1/3] Registering handle ${HANDLE} -> ${NODE_ENDPOINT}"
curl -sS "${AUTH_ARGS[@]}" \
  -H "Content-Type: application/json" \
  -X POST "${GATEWAY_ORIGIN}/api/federation/registry/handles" \
  -d "{\"requestedHandle\":\"${HANDLE}\",\"nodeEndpoint\":\"${NODE_ENDPOINT}\"}"
echo

echo "[2/3] Attesting handle ${HANDLE}"
curl -sS "${AUTH_ARGS[@]}" \
  -H "Content-Type: application/json" \
  -X POST "${GATEWAY_ORIGIN}/api/federation/admission/attest" \
  -d "{\"handle\":\"${HANDLE}\"}"
echo

ENC_HANDLE="$(node -e "process.stdout.write(encodeURIComponent(process.argv[1] ?? ''))" "${HANDLE}")"

echo "[3/3] Fetching directory entry for ${HANDLE}"
curl -sS "${AUTH_ARGS[@]}" \
  -H "Accept: application/json" \
  "${GATEWAY_ORIGIN}/api/federation/directory/${ENC_HANDLE}"
echo
