#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${FASED_LOCAL_SIGNER_BIN_DIR:-${HOME}/.fased/bin}"
VERSION="${FASED_LOCAL_SIGNER_VERSION:-}"
EXPECTED_COMMIT="${FASED_LOCAL_SIGNER_EXPECTED_COMMIT:-}"
POLICY_TEMPLATE_DIR="${FASED_LOCAL_SIGNER_POLICY_TEMPLATE_DIR:-$(dirname "$INSTALL_DIR")/share/signer-policies}"
DEFAULT_RELEASE_BASE_URL="https://github.com/fased-ai/fased/releases/download"

usage() {
  cat <<'EOF'
Usage: install-fased-signerd.sh [options]

Installs the exact version-matched native signer for an unprivileged Local or
developer installation. Protected Local and Hosting signer mutation belongs
exclusively to fased-lifecycled.

Options:
  --version vX.Y.Z          Exact signer release (defaults to package version)
  --expected-commit SHA     Require the signer release to match this app commit
  -h, --help                Show this help

Native Windows is unsupported. Run Fased inside Ubuntu on WSL2. Official
installs require gh attestation verify; Go is not required.
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
    --defer-commit|--commit|--verify|--rollback|--recover|--status|--confirm-downgrade)
      echo "Standalone signer lifecycle transactions were retired; use fased update for managed installations." >&2
      exit 2
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
  linux) platform="linux" ;;
  darwin) platform="darwin" ;;
  mingw*|msys*|cygwin*)
    echo "Native Windows is unsupported. Install and run Fased inside Ubuntu on WSL2." >&2
    exit 1
    ;;
  *)
    echo "Unsupported OS for fased-signerd: $OS" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="amd64" ;;
  aarch64|arm64) arch="arm64" ;;
  *)
    echo "Unsupported architecture for fased-signerd: $(uname -m)" >&2
    exit 1
    ;;
esac

if [[ -z "$VERSION" || "$VERSION" == "latest" ]]; then
  VERSION="$(node -p "require(process.argv[1]).version" "$ROOT/package.json" 2>/dev/null || true)"
fi
VERSION="${VERSION#v}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
  echo "An exact signer release version X.Y.Z is required; latest is not accepted." >&2
  exit 1
fi
if [[ -n "$EXPECTED_COMMIT" && ! "$EXPECTED_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
  echo "--expected-commit must be one exact 40-character Git commit." >&2
  exit 1
fi

base_url="${FASED_LOCAL_SIGNER_BASE_URL:-$DEFAULT_RELEASE_BASE_URL}"
base_url="${base_url%/}"
official=0
if [[ "$base_url" == "$DEFAULT_RELEASE_BASE_URL" ]]; then
  official=1
elif [[ "${FASED_LOCAL_SIGNER_ALLOW_UNATTESTED:-0}" != "1" ]]; then
  echo "A custom signer release source requires FASED_LOCAL_SIGNER_ALLOW_UNATTESTED=1." >&2
  exit 1
fi
if [[ "$official" -eq 0 && "${FASED_LOCAL_SIGNER_FLAT_RELEASE:-0}" == "1" ]]; then
  release_url="$base_url"
else
  release_url="$base_url/v$VERSION"
fi

asset_name="fased-signerd-${platform}-${arch}"
manifest_name="fased-signerd-release.json"
checksums_name="fased-signerd-checksums.txt"
mkdir -p "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR"
stage="$(mktemp -d "$INSTALL_DIR/.fased-signerd-install.XXXXXX")"
cleanup() {
  rm -rf -- "$stage"
}
trap cleanup EXIT

copy_release_file() {
  local name="$1"
  local source="$release_url/$name"
  local destination="$stage/$name"
  if [[ "$source" == file://* ]]; then
    local source_path="${source#file://}"
    [[ -f "$source_path" && ! -L "$source_path" ]] || {
      echo "Local signer release asset is missing or unsafe: $source_path" >&2
      return 1
    }
    cp -- "$source_path" "$destination"
  else
    curl -q -fL --proto '=https' --tlsv1.2 "$source" -o "$destination"
  fi
  [[ -f "$destination" && ! -L "$destination" ]]
  chmod 600 "$destination"
}

copy_release_file "$asset_name"
copy_release_file "$manifest_name"
copy_release_file "$checksums_name"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

verify_checksum() {
  local name="$1"
  local expected=""
  local actual=""
  expected="$(awk -v target="$name" '$1 ~ /^[a-fA-F0-9]{64}$/ { file=$2; sub(/^\*/, "", file); if (file == target) { print tolower($1); exit } }' "$stage/$checksums_name")"
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || {
    echo "$checksums_name has no exact entry for $name" >&2
    return 1
  }
  actual="$(sha256_file "$stage/$name")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Checksum mismatch for $name" >&2
    return 1
  fi
}

verify_checksum "$asset_name"
verify_checksum "$manifest_name"

if [[ "$official" -eq 1 ]]; then
  command -v gh >/dev/null 2>&1 || {
    echo "GitHub CLI is required to verify the official signer attestation." >&2
    exit 1
  }
  bundle_name="fased-signerd-release.attestation.json"
  copy_release_file "$bundle_name"
  for verified_file in "$asset_name" "$manifest_name"; do
    GH_PROMPT_DISABLED=1 gh attestation verify "$stage/$verified_file" \
      --repo fased-ai/fased \
      --bundle "$stage/$bundle_name" \
      --signer-workflow fased-ai/fased/.github/workflows/hosted-runtime-release.yml \
      --source-ref "refs/tags/v$VERSION" \
      --deny-self-hosted-runners >/dev/null
  done
fi

chmod 700 "$stage/$asset_name"
identity="$("$stage/$asset_name" --version 2>/dev/null || true)"
node - "$stage/$manifest_name" "$VERSION" "$EXPECTED_COMMIT" "$identity" <<'NODE'
const fs = require("node:fs");
const [manifestPath, version, expectedCommit, output] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const match = /^fased-signerd\s+(\S+)\s+commit=([a-f0-9]{40})\s+buildInputDigest=(sha256:[a-f0-9]{64})\s+development=(true|false)$/u.exec(output.trim());
if (!match || match[1] !== version || match[4] !== "false") {
  throw new Error("candidate signer binary identity is invalid");
}
if (manifest.schemaVersion !== 1 || manifest.version !== match[1] || manifest.commit !== match[2] || manifest.buildInputDigest !== match[3] || manifest.development !== false) {
  throw new Error("candidate signer binary and release manifest identities do not match");
}
if (expectedCommit && match[2] !== expectedCommit) {
  throw new Error("candidate signer commit does not match --expected-commit");
}
NODE

target="$INSTALL_DIR/fased-signerd"
temporary="$INSTALL_DIR/.fased-signerd.$$.new"
install -m 0700 "$stage/$asset_name" "$temporary"
mv -f -- "$temporary" "$target"

enrollment_target="$INSTALL_DIR/fased-signer-enroll"
enrollment_temporary="$INSTALL_DIR/.fased-signer-enroll.$$.new"
install -m 0700 "$stage/$asset_name" "$enrollment_temporary"
mv -f -- "$enrollment_temporary" "$enrollment_target"

policy_helper_source="$ROOT/scripts/fased-signer-owner-policy.mjs"
policy_launcher_source="$ROOT/scripts/fased-signer-policy-local.sh"
policy_template_source="$ROOT/config/signer-policies"
install -d -m 0700 "$POLICY_TEMPLATE_DIR"
install -m 0700 "$policy_helper_source" "$INSTALL_DIR/fased-signer-owner-policy.mjs"
install -m 0700 "$policy_launcher_source" "$INSTALL_DIR/fased-signer-policy"
for template in README.md agent.json.template mining.json.template vault.json.template network.json.template; do
  [[ -f "$policy_template_source/$template" ]] || continue
  install -m 0600 "$policy_template_source/$template" "$POLICY_TEMPLATE_DIR/$template"
done

echo "Installed exact verified signer: $target"
echo "Installed signer enrollment launcher: $enrollment_target"
