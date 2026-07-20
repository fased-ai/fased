#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR_DEFAULT="${HOME}/.fased/bin"
INSTALL_DIR="${FASED_LOCAL_SIGNER_BIN_DIR:-$INSTALL_DIR_DEFAULT}"
VERSION="${FASED_LOCAL_SIGNER_VERSION:-}"
POLICY_TEMPLATE_DIR="${FASED_LOCAL_SIGNER_POLICY_TEMPLATE_DIR:-$(dirname "$INSTALL_DIR")/share/signer-policies}"
UPDATER="$ROOT/scripts/fased-managed-updater.mjs"
ACTION="install"
DEFER_COMMIT=0
CONFIRM_DOWNGRADE=""
EXPECTED_COMMIT="${FASED_LOCAL_SIGNER_EXPECTED_COMMIT:-}"

usage() {
  cat <<'EOF'
Usage: install-fased-signerd.sh [options]

Installs the exact version-matched native signer for Local Linux, WSL2, or
native macOS using an offline snapshot and crash-recoverable transaction.

Options:
  --version vX.Y.Z              Exact signer release (defaults to package version)
  --expected-commit SHA         Require the signer release to match this app commit
  --defer-commit                Leave the verified candidate open for paired app health
  --confirm-downgrade X.Y.Z     Explicitly confirm one exact reviewed downgrade target
  --verify                      Verify the exact running binary, release, and protocol-v2 health
  --commit                      Commit a deferred verified transaction
  --rollback                    Restore the exact verified pre-update snapshot
  --recover                     Recover an interrupted transaction deterministically
  --status                      Print the current signer transaction journal
  -h, --help                    Show this help

Native Windows is unsupported. Run this installer inside Ubuntu on WSL2.
Official installs require gh with `gh attestation verify`; Go is not required.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --expected-commit)
      EXPECTED_COMMIT="${2:-}"
      shift 2
      ;;
    --defer-commit)
      DEFER_COMMIT=1
      shift
      ;;
    --confirm-downgrade)
      CONFIRM_DOWNGRADE="${2:-}"
      shift 2
      ;;
    --commit)
      ACTION="commit"
      shift
      ;;
    --verify)
      ACTION="verify"
      shift
      ;;
    --rollback)
      ACTION="rollback"
      shift
      ;;
    --recover)
      ACTION="recover"
      shift
      ;;
    --status)
      ACTION="status"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown signer installer option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  linux|darwin) ;;
  mingw*|msys*|cygwin*)
    echo "Native Windows is unsupported. Install and run Fased inside Ubuntu on WSL2." >&2
    exit 1
    ;;
  *)
    echo "Unsupported OS for fased-signerd: $OS" >&2
    exit 1
    ;;
esac

command -v node >/dev/null 2>&1 || {
  echo "Node.js is required to run the transactional signer installer." >&2
  exit 1
}
[[ -f "$UPDATER" && ! -L "$UPDATER" ]] || {
  echo "Packaged transactional signer updater is missing: $UPDATER" >&2
  exit 1
}

if [[ "$ACTION" == "install" || "$ACTION" == "verify" ]]; then
  if [[ -z "$VERSION" || "$VERSION" == "latest" ]]; then
    VERSION="$(node -p "require(process.argv[1]).version" "$ROOT/package.json" 2>/dev/null || true)"
  fi
  VERSION="${VERSION#v}"
  if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
    echo "An exact signer release version X.Y.Z is required; latest is not accepted." >&2
    exit 1
  fi
fi

if [[ -n "$EXPECTED_COMMIT" && ! "$EXPECTED_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
  echo "--expected-commit must be one exact 40-character Git commit." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR" 2>/dev/null || true
export FASED_LOCAL_SIGNER_BIN_DIR="$INSTALL_DIR"
export FASED_WALLET_LOCAL_SIGNER_BIN="$INSTALL_DIR/fased-signerd"

args=(local-signer "$ACTION")
if [[ "$ACTION" == "install" || "$ACTION" == "verify" ]]; then
  args+=(--version "$VERSION")
  if [[ -n "$EXPECTED_COMMIT" ]]; then
    args+=(--expected-commit "$EXPECTED_COMMIT")
  fi
fi
if [[ "$ACTION" == "install" ]]; then
  # Keep the candidate read-only and the rollback journal open until all
  # packaged policy helpers/templates are installed successfully.
  args+=(--defer-commit)
  if [[ -n "$CONFIRM_DOWNGRADE" ]]; then
    args+=(--confirm-downgrade "${CONFIRM_DOWNGRADE#v}")
  fi
fi

TRANSACTION_OPEN=0
rollback_failed_install() {
  local status=$?
  if [[ "$status" -ne 0 && "$TRANSACTION_OPEN" -eq 1 ]]; then
    node "$UPDATER" local-signer rollback >/dev/null 2>&1 || true
  fi
  return "$status"
}
trap rollback_failed_install EXIT

node "$UPDATER" "${args[@]}"

if [[ "$ACTION" != "install" ]]; then
  trap - EXIT
  exit 0
fi
TRANSACTION_OPEN=1

POLICY_HELPER_PATH="${INSTALL_DIR}/fased-signer-owner-policy.mjs"
POLICY_LAUNCHER_PATH="${INSTALL_DIR}/fased-signer-policy"
POLICY_HELPER_SOURCE="${ROOT}/scripts/fased-signer-owner-policy.mjs"
POLICY_LAUNCHER_SOURCE="${ROOT}/scripts/fased-signer-policy-local.sh"
POLICY_TEMPLATE_SOURCE="${ROOT}/config/signer-policies"

required_assets=(
  "$POLICY_HELPER_SOURCE"
  "$POLICY_LAUNCHER_SOURCE"
  "$POLICY_TEMPLATE_SOURCE/README.md"
  "$POLICY_TEMPLATE_SOURCE/agent.json.template"
  "$POLICY_TEMPLATE_SOURCE/mining.json.template"
  "$POLICY_TEMPLATE_SOURCE/vault.json.template"
)
if [[ -f "$POLICY_TEMPLATE_SOURCE/network.json.template" ]]; then
  required_assets+=("$POLICY_TEMPLATE_SOURCE/network.json.template")
fi
for required_path in "${required_assets[@]}"; do
  [[ -f "$required_path" && ! -L "$required_path" ]] || {
    echo "Packaged signer policy asset is missing or unsafe: $required_path" >&2
    exit 1
  }
done

install -d -m 0700 "$INSTALL_DIR" "$POLICY_TEMPLATE_DIR"
install -m 0700 "$POLICY_HELPER_SOURCE" "$POLICY_HELPER_PATH"
install -m 0700 "$POLICY_LAUNCHER_SOURCE" "$POLICY_LAUNCHER_PATH"
for template in README.md agent.json.template mining.json.template vault.json.template network.json.template; do
  [[ -f "$POLICY_TEMPLATE_SOURCE/$template" ]] || continue
  install -m 0600 "$POLICY_TEMPLATE_SOURCE/$template" "$POLICY_TEMPLATE_DIR/$template"
done

if [[ "$DEFER_COMMIT" -eq 0 ]]; then
  node "$UPDATER" local-signer commit
  TRANSACTION_OPEN=0
fi
trap - EXIT

echo "Installed exact transactional signer: $INSTALL_DIR/fased-signerd"
echo "Installed signer enrollment launcher: $INSTALL_DIR/fased-signer-enroll"
echo "Installed signer policy launcher: $POLICY_LAUNCHER_PATH"
echo "Installed fail-closed policy templates: $POLICY_TEMPLATE_DIR"
cat <<EOF
Fresh signer-owned wallets receive their versioned Agent, Mining, or Vault
baseline during normal wallet setup after the primary RPC is verified. Optional
authenticator enrollment and $POLICY_LAUNCHER_PATH remain available for advanced
owner-reviewed customization; copying a template never applies it.
EOF
