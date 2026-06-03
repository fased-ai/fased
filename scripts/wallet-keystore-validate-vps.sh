#!/usr/bin/env bash
set -euo pipefail

# Safe validation helper for embedded-keystore on a VPS.
# This script does not send transactions.
#
# Usage:
#   scripts/wallet-keystore-validate-vps.sh evm --expect-chain-id 1
#   scripts/wallet-keystore-validate-vps.sh solana

CHAIN="${1:-}"
shift || true

if [[ "$CHAIN" != "evm" && "$CHAIN" != "solana" ]]; then
  echo "usage: $0 <evm|solana> [--expect-chain-id <id>]" >&2
  exit 2
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required" >&2
  exit 2
fi

if [[ -z "${FASED_WALLET_PASSPHRASE:-}" && -z "${FASED_WALLET_PASSPHRASE_FILE:-}" ]]; then
  echo "Set FASED_WALLET_PASSPHRASE or FASED_WALLET_PASSPHRASE_FILE before running." >&2
  exit 2
fi

if [[ -z "${FASED_WALLET_EMBEDDED_KEYSTORE_RPC_URL:-}" ]]; then
  echo "Set FASED_WALLET_EMBEDDED_KEYSTORE_RPC_URL to an EVM or Solana RPC URL." >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[wallet] provider: embedded-keystore"
echo "[wallet] chain: ${CHAIN}"
echo "[wallet] rpc: configured"

pnpm fased wallet keystore status

if [[ "$CHAIN" == "evm" ]]; then
  pnpm fased wallet keystore validate --chain evm "$@"
else
  pnpm fased wallet keystore validate --chain solana "$@"
fi

echo
echo "[wallet] validation complete (no transaction sent)"
