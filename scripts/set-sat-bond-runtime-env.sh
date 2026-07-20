#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SAT_RUNTIME_ENV_FILE="${FASED_SAT_RUNTIME_ENV_FILE:-$ROOT_DIR/config/sat-runtime.env}"
STATE_DIR="${FASED_STATE_DIR:-$HOME/.fased}"
ENV_FILE="${FASED_AGENT_ENV_FILE:-$STATE_DIR/.env}"
SYSTEMD_UNIT="${FASED_AGENT_SYSTEMD_UNIT:-fased-gateway.service}"
PROGRAM_ID=""
RESTART=1

if [[ -f "$SAT_RUNTIME_ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$SAT_RUNTIME_ENV_FILE"
  set +a
fi
PROGRAM_ID="${FASED_SAT_BOND_PROGRAM_ID:-}"

usage() {
  cat <<'EOF'
Usage: bash scripts/set-sat-bond-runtime-env.sh [program-id] [options]

Writes the SAT mining/mint/bond ids from config/sat-runtime.env into the managed agent runtime env file.

Options:
  --program-id <id>   Override the bond program id to persist.
  --env-file <path>   Override the target env file (default: ~/.fased/.env).
  --unit <name>       Override the systemd user unit (default: fased-gateway.service).
  --no-restart        Do not restart the user service after updating env.
  -h, --help          Show this help.

Examples:
  bash scripts/set-sat-bond-runtime-env.sh
  bash scripts/set-sat-bond-runtime-env.sh D1ySMMiJmvJRhJJKwYnc171w3g2JDPQnkgD8kGhaG4Vq
  FASED_AGENT_ENV_FILE=/tmp/fased.env bash scripts/set-sat-bond-runtime-env.sh --no-restart
EOF
}

upsert_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp
  tmp="$(mktemp)"
  if [[ -f "$file" ]]; then
    awk -v k="$key" -v v="$value" '
      BEGIN { found = 0 }
      $0 ~ ("^" k "=") { print k "=" v; found = 1; next }
      { print }
      END { if (!found) print k "=" v }
    ' "$file" >"$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >"$tmp"
  fi
  mv "$tmp" "$file"
  chmod 600 "$file" 2>/dev/null || true
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --program-id)
      shift
      PROGRAM_ID="${1:-}"
      ;;
    --env-file)
      shift
      ENV_FILE="${1:-}"
      ;;
    --unit)
      shift
      SYSTEMD_UNIT="${1:-}"
      ;;
    --no-restart)
      RESTART=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "${PROGRAM_ID:-}" || "$PROGRAM_ID" == "${FASED_SAT_BOND_PROGRAM_ID:-}" ]]; then
        PROGRAM_ID="$1"
      else
        echo "Unknown argument: $1" >&2
        usage >&2
        exit 1
      fi
      ;;
  esac
  shift
done

if [[ -z "$PROGRAM_ID" ]]; then
  echo "Missing bond program id." >&2
  exit 1
fi
if [[ -z "${FASED_SAT_PROGRAM_ID:-}" || -z "${FASED_SAT_MINT_ADDRESS:-}" || -z "${FASED_SAT_MINT_PROGRAM_ID:-}" ]]; then
  echo "Missing SAT runtime ids in $SAT_RUNTIME_ENV_FILE." >&2
  exit 1
fi
if [[ -z "${FASED_SAT_RUNTIME_MANIFEST_PATH:-}" || -z "${FASED_SAT_RUNTIME_MANIFEST_SHA256:-}" || -z "${FASED_SAT_RUNTIME_MANIFEST_SIGNATURE_PATH:-}" ]]; then
  echo "Missing signed SAT runtime manifest proof in $SAT_RUNTIME_ENV_FILE." >&2
  exit 1
fi

mkdir -p "$(dirname "$ENV_FILE")"
upsert_env_var "$ENV_FILE" "FASED_SAT_PROGRAM_ID" "$FASED_SAT_PROGRAM_ID"
upsert_env_var "$ENV_FILE" "FASED_SAT_BOND_PROGRAM_ID" "$PROGRAM_ID"
upsert_env_var "$ENV_FILE" "FASED_SAT_MINT_ADDRESS" "$FASED_SAT_MINT_ADDRESS"
upsert_env_var "$ENV_FILE" "FASED_SAT_MINT_PROGRAM_ID" "$FASED_SAT_MINT_PROGRAM_ID"
upsert_env_var "$ENV_FILE" "FASED_SAT_RUNTIME_MANIFEST_PATH" "$FASED_SAT_RUNTIME_MANIFEST_PATH"
upsert_env_var "$ENV_FILE" "FASED_SAT_RUNTIME_MANIFEST_SHA256" "$FASED_SAT_RUNTIME_MANIFEST_SHA256"
upsert_env_var "$ENV_FILE" "FASED_SAT_RUNTIME_MANIFEST_SIGNATURE_PATH" "$FASED_SAT_RUNTIME_MANIFEST_SIGNATURE_PATH"
printf 'Updated %s\n' "$ENV_FILE"
printf 'FASED_SAT_PROGRAM_ID=%s\n' "$FASED_SAT_PROGRAM_ID"
printf 'FASED_SAT_BOND_PROGRAM_ID=%s\n' "$PROGRAM_ID"
printf 'FASED_SAT_MINT_ADDRESS=%s\n' "$FASED_SAT_MINT_ADDRESS"
printf 'FASED_SAT_MINT_PROGRAM_ID=%s\n' "$FASED_SAT_MINT_PROGRAM_ID"
printf 'FASED_SAT_RUNTIME_MANIFEST_SHA256=%s\n' "$FASED_SAT_RUNTIME_MANIFEST_SHA256"

if [[ "$RESTART" -eq 1 ]]; then
  if command -v systemctl >/dev/null 2>&1 && systemctl --user cat "$SYSTEMD_UNIT" >/dev/null 2>&1; then
    systemctl --user restart "$SYSTEMD_UNIT"
    printf 'Restarted %s\n' "$SYSTEMD_UNIT"
  else
    printf 'Skipped restart: systemd user unit %s was not found.\n' "$SYSTEMD_UNIT"
  fi
fi
