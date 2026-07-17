#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_SPEC="@fased/fased@latest"
PREFIX=""
CACHE_DIR=""
STATE_DIR=""
PROFILE="local"
DEFAULT_BASE_URL="https://github.com/fased-ai/fased/releases/download"
BASE_URL="${FASED_HOSTED_ARTIFACT_BASE_URL:-$DEFAULT_BASE_URL}"
INSTALL_STARTED_MS=""
TIMING_LABELS=()
TIMING_VALUES=()

now_ms() {
  date +%s%3N
}

record_timing() {
  local label="$1"
  local started_ms="$2"
  local finished_ms
  finished_ms="$(now_ms)"
  TIMING_LABELS+=("$label")
  TIMING_VALUES+=("$((finished_ms - started_ms))")
}

format_duration() {
  local duration_ms="$1"
  if (( duration_ms < 1000 )); then
    printf '%sms' "$duration_ms"
    return
  fi
  printf '%d.%02ds' "$((duration_ms / 1000))" "$(((duration_ms % 1000) / 10))"
}

print_timing_summary() {
  local finished_ms
  local index
  finished_ms="$(now_ms)"
  printf 'Fresh runtime timing:\n'
  for ((index = 0; index < ${#TIMING_LABELS[@]}; index++)); do
    printf '  %s: %s\n' "${TIMING_LABELS[$index]}" "$(format_duration "${TIMING_VALUES[$index]}")"
  done
  printf '  total: %s\n' "$(format_duration "$((finished_ms - INSTALL_STARTED_MS))")"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --package)
      PACKAGE_SPEC="${2:-}"
      shift 2
      ;;
    --prefix)
      PREFIX="${2:-}"
      shift 2
      ;;
    --cache)
      CACHE_DIR="${2:-}"
      shift 2
      ;;
    --state-dir)
      STATE_DIR="${2:-}"
      shift 2
      ;;
    --profile)
      PROFILE="${2:-}"
      shift 2
      ;;
    --base-url)
      BASE_URL="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown hosted runtime installer option: $1" >&2
      exit 20
      ;;
  esac
done

if [[ -z "$PREFIX" || -z "$CACHE_DIR" ]]; then
  echo "Hosted runtime installer requires --prefix and --cache." >&2
  exit 20
fi
if [[ -z "$STATE_DIR" ]]; then
  STATE_DIR="$(cd "$(dirname "$CACHE_DIR")" && pwd)"
fi
case "$PROFILE" in
  local|hosting|source) ;;
  *) echo "Invalid managed runtime profile: $PROFILE" >&2; exit 20 ;;
esac
HOST_TRANSACTION_ID="${FASED_HOST_UPDATE_TRANSACTION_ID:-}"
HOST_TRANSACTION_VERSION="${FASED_HOST_UPDATE_TRANSACTION_VERSION:-}"
if [[ -n "$HOST_TRANSACTION_ID" || -n "$HOST_TRANSACTION_VERSION" ]]; then
  if [[ -z "$HOST_TRANSACTION_ID" || -z "$HOST_TRANSACTION_VERSION" ]]; then
    echo "FASED_HOST_UPDATE_TRANSACTION_ID and FASED_HOST_UPDATE_TRANSACTION_VERSION must be provided together." >&2
    exit 20
  fi
  if [[ "$PROFILE" != "hosting" ]]; then
    echo "A host update transaction can only install the hosting profile." >&2
    exit 20
  fi
fi

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return
  fi
  return 1
}

resolve_arch() {
  [[ "$(uname -s)" == "Linux" ]] || return 1
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64\n' ;;
    aarch64|arm64) printf 'arm64\n' ;;
    *) return 1 ;;
  esac
}

resolve_version() {
  local requested="${PACKAGE_SPEC##*@}"
  if [[ "$requested" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
    printf '%s\n' "${requested#v}"
    return
  fi
  npm view "$PACKAGE_SPEC" version --loglevel=error 2>/dev/null | tail -n 1 | tr -d '[:space:]'
}

download_manifest_bound_asset() {
  local asset_name="$1"
  local expected="$2"
  local archive="$TEMP_ROOT/$asset_name"
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || return 20
  curl -fsSL "$RELEASE_URL/$asset_name" -o "$archive" 2>/dev/null || return 10
  local actual
  actual="$(sha256_file "$archive" || true)"
  [[ "$actual" == "$expected" ]] || return 20
  if [[ "$BASE_URL" == "$DEFAULT_BASE_URL" ]]; then
    GH_PROMPT_DISABLED=1 gh attestation verify "$archive" \
      --repo fased-ai/fased \
      --signer-workflow fased-ai/fased/.github/workflows/hosted-runtime-release.yml \
      --source-ref "refs/tags/v${VERSION}" \
      --deny-self-hosted-runners >/dev/null || return 20
  fi
  printf '%s\n' "$archive"
}

archive_entry_is_safe() {
  local entry="${1%/}"
  local allowed_root="$2"
  local part
  local -a parts=()
  [[ -n "$entry" && "$entry" != /* && "$entry" != *\\* ]] || return 1
  [[ "$entry" == "$allowed_root" || "$entry" == "$allowed_root/"* ]] || return 1
  IFS='/' read -r -a parts <<<"$entry"
  for part in "${parts[@]}"; do
    [[ -n "$part" && "$part" != "." && "$part" != ".." ]] || return 1
  done
}

archive_is_safe() {
  local archive="$1"
  local entry
  while IFS= read -r entry; do
    archive_entry_is_safe "$entry" package || return 1
  done < <(tar -tzf "$archive")
}

dependency_archive_is_safe() {
  local archive="$1"
  local entry
  while IFS= read -r entry; do
    archive_entry_is_safe "$entry" node_modules || return 1
  done < <(tar -tzf "$archive")
}

download_verified_asset() {
  local asset_name="$1"
  local required="${2:-yes}"
  local checksum_file="$TEMP_ROOT/${asset_name}.sha256"
  local archive="$TEMP_ROOT/$asset_name"
  if ! curl -fsSL "$RELEASE_URL/${asset_name}.sha256" -o "$checksum_file" 2>/dev/null; then
    [[ "$required" == "yes" ]] && return 10
    return 1
  fi
  local expected
  expected="$(awk -v asset="$asset_name" '$2 == asset || $2 == "*" asset { print tolower($1); exit }' "$checksum_file")"
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || return 20
  curl -fsSL "$RELEASE_URL/$asset_name" -o "$archive" 2>/dev/null || return 10
  local actual
  actual="$(sha256_file "$archive" || true)"
  [[ "$actual" == "$expected" ]] || return 20
  if [[ "$BASE_URL" == "$DEFAULT_BASE_URL" ]]; then
    command -v gh >/dev/null 2>&1 || {
      echo "GitHub CLI with attestation verification is required for official runtime installs." >&2
      return 20
    }
    GH_PROMPT_DISABLED=1 gh attestation verify "$archive" \
      --repo fased-ai/fased \
      --signer-workflow fased-ai/fased/.github/workflows/hosted-runtime-release.yml \
      --source-ref "refs/tags/v${VERSION}" \
      --deny-self-hosted-runners >/dev/null || return 20
  fi
  printf '%s\n' "$archive"
}

for command in node npm curl tar awk; do
  command -v "$command" >/dev/null 2>&1 || exit 10
done

INSTALL_STARTED_MS="$(now_ms)"
phase_started_ms="$(now_ms)"
VERSION="$(resolve_version || true)"
ARCH="$(resolve_arch || true)"
[[ -n "$VERSION" && -n "$ARCH" ]] || exit 10
if [[ "$PROFILE" == "hosting" && ! "${PACKAGE_SPEC##*@}" =~ ^v?${VERSION//./\.}$ ]]; then
  echo "Maintained Hosting requires an exact @fased/fased@X.Y.Z release selection." >&2
  exit 20
fi
if [[ -n "$HOST_TRANSACTION_VERSION" && "$HOST_TRANSACTION_VERSION" != "$VERSION" ]]; then
  echo "Host transaction version ${HOST_TRANSACTION_VERSION} does not match runtime ${VERSION}." >&2
  exit 20
fi
record_timing "release resolution" "$phase_started_ms"

BASE_URL="${BASE_URL%/}"
RELEASE_URL="${BASE_URL}/v${VERSION}"
mkdir -p "$CACHE_DIR" "$PREFIX"
TEMP_ROOT="$(mktemp -d "$CACHE_DIR/hosted-runtime.XXXXXX")"
trap 'rm -rf "$TEMP_ROOT"' EXIT
EXTRACT_ROOT="$TEMP_ROOT/extract"
mkdir -p "$EXTRACT_ROOT"
APP_ASSET_NAME="fased-hosted-app-linux-${ARCH}-v${VERSION}.tar.gz"
APP_ARCHIVE=""
APP_DOWNLOAD_STATUS=1
RELEASE_MANIFEST_PATH=""
RELEASE_COMMIT=""
EXPECTED_APP_DIGEST=""
EXPECTED_DEPENDENCY_DIGEST=""
DEPENDENCY_ASSET_NAME=""
DEPENDENCY_HASH=""
if [[ "$PROFILE" == "hosting" ]]; then
  RELEASE_MANIFEST_NAME="fased-hosted-release-v2.json"
  RELEASE_MANIFEST_PATH="$TEMP_ROOT/$RELEASE_MANIFEST_NAME"
  phase_started_ms="$(now_ms)"
  curl -fsSL "$RELEASE_URL/$RELEASE_MANIFEST_NAME" -o "$RELEASE_MANIFEST_PATH" 2>/dev/null || {
    echo "The exact attested Hosting release manifest is unavailable; the installed runtime was not changed." >&2
    exit 20
  }
  if [[ "$BASE_URL" == "$DEFAULT_BASE_URL" ]]; then
    GH_PROMPT_DISABLED=1 gh attestation verify "$RELEASE_MANIFEST_PATH" \
      --repo fased-ai/fased \
      --signer-workflow fased-ai/fased/.github/workflows/hosted-runtime-release.yml \
      --source-ref "refs/tags/v${VERSION}" \
      --deny-self-hosted-runners >/dev/null || {
        echo "Hosted release manifest attestation verification failed." >&2
        exit 20
      }
  fi
  mapfile -t RELEASE_SELECTION < <(
    node --input-type=module - "$SCRIPT_DIR/hosted-release-manifest.mjs" "$RELEASE_MANIFEST_PATH" "$VERSION" "$ARCH" <<'EOF_RELEASE_SELECTION'
import { pathToFileURL } from "node:url";
const [modulePath, manifestPath, version, arch] = process.argv.slice(2);
const { readHostedReleaseManifestV2 } = await import(pathToFileURL(modulePath));
const { manifest } = await readHostedReleaseManifestV2(manifestPath, { version });
const selected = manifest.application.linux[arch];
for (const value of [
  manifest.release.commit,
  selected.artifact.asset,
  selected.artifact.sha256,
  selected.dependencies.asset,
  selected.dependencies.sha256,
  selected.dependencies.dependencyHash,
  manifest.signer.release.commit,
  manifest.signer.capabilitiesDigest,
]) console.log(value);
EOF_RELEASE_SELECTION
  )
  [[ "${#RELEASE_SELECTION[@]}" -eq 8 ]] || {
    echo "Hosted release manifest is malformed or missing this architecture." >&2
    exit 20
  }
  RELEASE_COMMIT="${RELEASE_SELECTION[0]}"
  APP_ASSET_NAME="${RELEASE_SELECTION[1]}"
  EXPECTED_APP_DIGEST="${RELEASE_SELECTION[2]}"
  DEPENDENCY_ASSET_NAME="${RELEASE_SELECTION[3]}"
  EXPECTED_DEPENDENCY_DIGEST="${RELEASE_SELECTION[4]}"
  DEPENDENCY_HASH="${RELEASE_SELECTION[5]}"
  [[ "${RELEASE_SELECTION[6]}" == "$RELEASE_COMMIT" ]] || {
    echo "Hosted app and signer commits are mixed; activation was refused." >&2
    exit 20
  }
  APP_ARCHIVE="$(download_manifest_bound_asset "$APP_ASSET_NAME" "$EXPECTED_APP_DIGEST")" || {
    echo "Hosted app layer is unavailable or does not match the attested release manifest." >&2
    exit 20
  }
  APP_DOWNLOAD_STATUS=0
  record_timing "release manifest, app attestation, and digest verification" "$phase_started_ms"
else
  set +e
  phase_started_ms="$(now_ms)"
  APP_ARCHIVE="$(download_verified_asset "$APP_ASSET_NAME" no)"
  APP_DOWNLOAD_STATUS=$?
  set -e
  record_timing "app download and checksum" "$phase_started_ms"
  if [[ "$APP_DOWNLOAD_STATUS" -eq 20 ]]; then
    echo "Hosted app layer failed checksum verification." >&2
    exit 20
  fi
fi
if [[ -n "$APP_ARCHIVE" ]]; then
  phase_started_ms="$(now_ms)"
  archive_is_safe "$APP_ARCHIVE" || exit 20
  record_timing "app archive safety scan" "$phase_started_ms"
  phase_started_ms="$(now_ms)"
  tar -xzf "$APP_ARCHIVE" -C "$EXTRACT_ROOT"
  record_timing "app extraction" "$phase_started_ms"
  PACKAGE_ROOT="$EXTRACT_ROOT/package"
  METADATA_PATH="$PACKAGE_ROOT/.fased-hosted-runtime.json"
  EMBEDDED_RELEASE="$(node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (value.schemaVersion === 2) {
      process.stdout.write([value.version, value.commit, value.dependencyHash].join("\n"));
    } else if (value.schemaVersion === 1) {
      process.stdout.write(["", "", value.dependencyHash].join("\n"));
    } else process.exit(1);
  ' "$METADATA_PATH" 2>/dev/null || true)"
  mapfile -t EMBEDDED_RELEASE_FIELDS <<<"$EMBEDDED_RELEASE"
  EMBEDDED_VERSION="${EMBEDDED_RELEASE_FIELDS[0]:-}"
  EMBEDDED_COMMIT="${EMBEDDED_RELEASE_FIELDS[1]:-}"
  EMBEDDED_DEPENDENCY_HASH="${EMBEDDED_RELEASE_FIELDS[2]:-}"
  if [[ "$PROFILE" == "hosting" ]]; then
    [[ "$EMBEDDED_VERSION" == "$VERSION" && "$EMBEDDED_COMMIT" == "$RELEASE_COMMIT" && "$EMBEDDED_DEPENDENCY_HASH" == "$DEPENDENCY_HASH" ]] || {
      echo "Hosted application build identity does not match the attested release manifest." >&2
      exit 20
    }
    cp "$RELEASE_MANIFEST_PATH" "$PACKAGE_ROOT/.fased-hosted-release-v2.json"
  else
    DEPENDENCY_HASH="$EMBEDDED_DEPENDENCY_HASH"
  fi
  [[ "$DEPENDENCY_HASH" =~ ^[a-f0-9]{64}$ ]] || exit 20
  DEPENDENCY_ROOT="$CACHE_DIR/hosted-dependencies/$DEPENDENCY_HASH"
  if [[ ! -d "$DEPENDENCY_ROOT/node_modules" ]]; then
    if [[ "$PROFILE" != "hosting" ]]; then
      DEPENDENCY_ASSET_NAME="fased-hosted-deps-linux-${ARCH}-${DEPENDENCY_HASH}.tar.gz"
    fi
    phase_started_ms="$(now_ms)"
    if [[ "$PROFILE" == "hosting" ]]; then
      DEPENDENCY_ARCHIVE="$(download_manifest_bound_asset "$DEPENDENCY_ASSET_NAME" "$EXPECTED_DEPENDENCY_DIGEST")" || exit $?
    else
      DEPENDENCY_ARCHIVE="$(download_verified_asset "$DEPENDENCY_ASSET_NAME" yes)" || exit $?
    fi
    record_timing "dependency download and checksum" "$phase_started_ms"
    phase_started_ms="$(now_ms)"
    dependency_archive_is_safe "$DEPENDENCY_ARCHIVE" || exit 20
    record_timing "dependency archive safety scan" "$phase_started_ms"
    DEPENDENCY_STAGING="${DEPENDENCY_ROOT}.staging-$$"
    rm -rf "$DEPENDENCY_STAGING"
    mkdir -p "$DEPENDENCY_STAGING"
    phase_started_ms="$(now_ms)"
    tar -xzf "$DEPENDENCY_ARCHIVE" -C "$DEPENDENCY_STAGING"
    record_timing "dependency extraction" "$phase_started_ms"
    [[ -d "$DEPENDENCY_STAGING/node_modules" ]] || exit 20
    mkdir -p "$(dirname "$DEPENDENCY_ROOT")"
    if ! mv "$DEPENDENCY_STAGING" "$DEPENDENCY_ROOT" 2>/dev/null; then
      [[ -d "$DEPENDENCY_ROOT/node_modules" ]] || exit 20
      rm -rf "$DEPENDENCY_STAGING"
    fi
  fi
  ln -s "$DEPENDENCY_ROOT/node_modules" "$PACKAGE_ROOT/node_modules"
else
  ASSET_NAME="fased-hosted-linux-${ARCH}-v${VERSION}.tar.gz"
  phase_started_ms="$(now_ms)"
  ARCHIVE="$(download_verified_asset "$ASSET_NAME" yes)" || exit $?
  record_timing "runtime download and checksum" "$phase_started_ms"
  phase_started_ms="$(now_ms)"
  archive_is_safe "$ARCHIVE" || exit 20
  record_timing "runtime archive safety scan" "$phase_started_ms"
  phase_started_ms="$(now_ms)"
  tar -xzf "$ARCHIVE" -C "$EXTRACT_ROOT"
  record_timing "runtime extraction" "$phase_started_ms"
fi
PACKAGE_ROOT="$EXTRACT_ROOT/package"
if [[ ! -f "$PACKAGE_ROOT/fased.mjs" || ! -d "$PACKAGE_ROOT/node_modules" ]]; then
  echo "Hosted runtime archive is incomplete." >&2
  exit 20
fi
if [[ "$(node -p "require(process.argv[1]).version" "$PACKAGE_ROOT/package.json" 2>/dev/null || true)" != "$VERSION" ]]; then
  echo "Hosted runtime version does not match v${VERSION}." >&2
  exit 20
fi
SMOKE_HOME="$TEMP_ROOT/smoke-home"
mkdir -p "$SMOKE_HOME"
phase_started_ms="$(now_ms)"
if ! HOME="$SMOKE_HOME" \
  FASED_STATE_DIR="$SMOKE_HOME/.fased" \
  FASED_CONFIG_PATH="$SMOKE_HOME/.fased/fased.json" \
  node "$PACKAGE_ROOT/fased.mjs" plugins doctor >/dev/null 2>&1; then
  echo "Hosted runtime failed its pre-install CLI and plugin check; the current install was not changed." >&2
  exit 20
fi
record_timing "runtime smoke verification" "$phase_started_ms"

phase_started_ms="$(now_ms)"
TARGET_ROOT="$PREFIX/lib/node_modules/@fased/fased"
TARGET_PARENT="$(dirname "$TARGET_ROOT")"
BACKUP_ROOT="${TARGET_PARENT}/.fased-backup-$(date +%s)-$$"
mkdir -p "$TARGET_PARENT"
if [[ -e "$TARGET_ROOT" ]]; then
  mv "$TARGET_ROOT" "$BACKUP_ROOT"
else
  BACKUP_ROOT=""
fi
if ! mv "$PACKAGE_ROOT" "$TARGET_ROOT"; then
  [[ -n "$BACKUP_ROOT" && -e "$BACKUP_ROOT" ]] && mv "$BACKUP_ROOT" "$TARGET_ROOT"
  exit 20
fi
if [[ ! -x "$TARGET_ROOT/fased.mjs" || ! -d "$TARGET_ROOT/node_modules" ]]; then
  rm -rf "$TARGET_ROOT"
  [[ -n "$BACKUP_ROOT" && -e "$BACKUP_ROOT" ]] && mv "$BACKUP_ROOT" "$TARGET_ROOT"
  echo "Hosted runtime activation verification failed." >&2
  exit 20
fi

mkdir -p "$PREFIX/bin"
ln -sfn "../lib/node_modules/@fased/fased/fased.mjs" "$PREFIX/bin/fased"
chmod 755 "$TARGET_ROOT/fased.mjs" 2>/dev/null || true
MANAGED_INSTALL_ARGS=(
  --package-root "$TARGET_ROOT"
  --state-dir "$STATE_DIR"
  --prefix "$PREFIX"
  --profile "$PROFILE"
)
if [[ -n "$BACKUP_ROOT" ]]; then
  MANAGED_INSTALL_ARGS+=(--previous-package-root "$BACKUP_ROOT")
fi
if [[ -n "$HOST_TRANSACTION_ID" ]]; then
  MANAGED_INSTALL_ARGS+=(
    --host-transaction-id "$HOST_TRANSACTION_ID"
    --host-transaction-version "$HOST_TRANSACTION_VERSION"
  )
fi
node "$TARGET_ROOT/scripts/install-managed-runtime.mjs" "${MANAGED_INSTALL_ARGS[@]}"
[[ -n "$BACKUP_ROOT" && -e "$BACKUP_ROOT" ]] && rm -rf "$BACKUP_ROOT"
record_timing "runtime activation" "$phase_started_ms"
printf 'Installed verified hosted runtime v%s.\n' "$VERSION"
print_timing_summary
