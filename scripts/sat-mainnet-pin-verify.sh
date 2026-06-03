#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$(mktemp -d "${TMPDIR:-/tmp}/sat-mainnet-pin.XXXXXX")}"

manifest="$("$ROOT_DIR/scripts/sat-trust-manifest-rehearsal.sh" mainnet-beta "$OUT_DIR")"

if grep -Eq '"satProgramId": "EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75"|"satMintAddress": "2AhikHhzJdv6uve1yUBSUmhRKWaSfa7exrsDsfKjVFKa"' "$manifest"; then
  echo "mainnet pin verify failed: manifest still contains the current devnet SAT program or mint id" >&2
  exit 3
fi

echo "mainnet SAT runtime pins are non-devnet placeholders: $manifest"
