#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK="${1:-devnet}"
OUT_DIR="${2:-}"
ENV_FILE="${FASED_SAT_RUNTIME_ENV_FILE:-$ROOT_DIR/config/sat-runtime.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing SAT runtime env file: $ENV_FILE" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

require_value() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    echo "missing required SAT runtime value: $name" >&2
    exit 2
  fi
}

require_value FASED_SAT_PROGRAM_ID
require_value FASED_SAT_BOND_PROGRAM_ID
require_value FASED_SAT_MINT_ADDRESS
require_value FASED_SAT_MINT_PROGRAM_ID

IDL_PATH="$ROOT_DIR/../../token/sat/api/idl.json"
IDL_SHA256=""
if [[ -f "$IDL_PATH" ]]; then
  IDL_SHA256="$(sha256sum "$IDL_PATH" | awk '{print $1}')"
fi

GIT_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || true)"
GENERATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

manifest_json() {
  cat <<JSON
{
  "schema": "ai.fased.sat.trust-manifest.v1",
  "network": "$NETWORK",
  "generatedAt": "$GENERATED_AT",
  "gitCommit": "$GIT_COMMIT",
  "addresses": {
    "satProgramId": "$FASED_SAT_PROGRAM_ID",
    "satBondProgramId": "$FASED_SAT_BOND_PROGRAM_ID",
    "satMintAddress": "$FASED_SAT_MINT_ADDRESS",
    "satMintProgramId": "$FASED_SAT_MINT_PROGRAM_ID"
  },
  "hashes": {
    "idlSha256": "$IDL_SHA256"
  },
  "notes": [
    "Rehearsal manifest only. Mainnet launch still requires deployed-program hash proof, signed address manifest, release SHA256SUMS, metadata proof, and fake-mint sentinel evidence."
  ]
}
JSON
}

if [[ -z "$OUT_DIR" ]]; then
  manifest_json
  exit 0
fi

mkdir -p "$OUT_DIR"
MANIFEST_PATH="$OUT_DIR/sat-$NETWORK-addresses.json"
manifest_json >"$MANIFEST_PATH"
sha256sum "$MANIFEST_PATH" >"$MANIFEST_PATH.sha256"

if command -v minisign >/dev/null 2>&1 && [[ -n "${SAT_MINISIGN_SECRET_KEY:-}" ]]; then
  minisign -Sm "$MANIFEST_PATH" -s "$SAT_MINISIGN_SECRET_KEY"
else
  echo "minisign skipped; set SAT_MINISIGN_SECRET_KEY to write $MANIFEST_PATH.minisig" >&2
fi

echo "$MANIFEST_PATH"
