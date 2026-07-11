#!/usr/bin/env bash
set -euo pipefail

PACKAGE_SPEC="@fased/fased@latest"
PREFIX=""
CACHE_DIR=""
BASE_URL="${FASED_HOSTED_ARTIFACT_BASE_URL:-https://github.com/fased-ai/fased/releases/download}"

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

archive_is_safe() {
  local archive="$1"
  local entry
  while IFS= read -r entry; do
    case "$entry" in
      package|package/*) ;;
      *) return 1 ;;
    esac
  done < <(tar -tzf "$archive")
}

dependency_archive_is_safe() {
  local archive="$1"
  local entry
  while IFS= read -r entry; do
    case "$entry" in
      node_modules|node_modules/*) ;;
      *) return 1 ;;
    esac
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
  printf '%s\n' "$archive"
}

for command in node npm curl tar awk; do
  command -v "$command" >/dev/null 2>&1 || exit 10
done

VERSION="$(resolve_version || true)"
ARCH="$(resolve_arch || true)"
[[ -n "$VERSION" && -n "$ARCH" ]] || exit 10

BASE_URL="${BASE_URL%/}"
RELEASE_URL="${BASE_URL}/v${VERSION}"
mkdir -p "$CACHE_DIR" "$PREFIX"
TEMP_ROOT="$(mktemp -d "$CACHE_DIR/hosted-runtime.XXXXXX")"
trap 'rm -rf "$TEMP_ROOT"' EXIT
EXTRACT_ROOT="$TEMP_ROOT/extract"
mkdir -p "$EXTRACT_ROOT"
APP_ASSET_NAME="fased-hosted-app-linux-${ARCH}-v${VERSION}.tar.gz"
set +e
APP_ARCHIVE="$(download_verified_asset "$APP_ASSET_NAME" no)"
APP_DOWNLOAD_STATUS=$?
set -e
if [[ "$APP_DOWNLOAD_STATUS" -eq 20 ]]; then
  echo "Hosted app layer failed checksum verification." >&2
  exit 20
fi
if [[ -n "$APP_ARCHIVE" ]]; then
  archive_is_safe "$APP_ARCHIVE" || exit 20
  tar -xzf "$APP_ARCHIVE" -C "$EXTRACT_ROOT"
  PACKAGE_ROOT="$EXTRACT_ROOT/package"
  METADATA_PATH="$PACKAGE_ROOT/.fased-hosted-runtime.json"
  DEPENDENCY_HASH="$(node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(value.dependencyHash || "")) process.exit(1);
    process.stdout.write(value.dependencyHash);
  ' "$METADATA_PATH" 2>/dev/null || true)"
  [[ "$DEPENDENCY_HASH" =~ ^[a-f0-9]{64}$ ]] || exit 20
  DEPENDENCY_ROOT="$CACHE_DIR/hosted-dependencies/$DEPENDENCY_HASH"
  if [[ ! -d "$DEPENDENCY_ROOT/node_modules" ]]; then
    DEPENDENCY_ASSET_NAME="fased-hosted-deps-linux-${ARCH}-${DEPENDENCY_HASH}.tar.gz"
    DEPENDENCY_ARCHIVE="$(download_verified_asset "$DEPENDENCY_ASSET_NAME" yes)" || exit $?
    dependency_archive_is_safe "$DEPENDENCY_ARCHIVE" || exit 20
    DEPENDENCY_STAGING="${DEPENDENCY_ROOT}.staging-$$"
    rm -rf "$DEPENDENCY_STAGING"
    mkdir -p "$DEPENDENCY_STAGING"
    tar -xzf "$DEPENDENCY_ARCHIVE" -C "$DEPENDENCY_STAGING"
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
  ARCHIVE="$(download_verified_asset "$ASSET_NAME" yes)" || exit $?
  archive_is_safe "$ARCHIVE" || exit 20
  tar -xzf "$ARCHIVE" -C "$EXTRACT_ROOT"
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
if ! HOME="$SMOKE_HOME" \
  FASED_STATE_DIR="$SMOKE_HOME/.fased" \
  FASED_CONFIG_PATH="$SMOKE_HOME/.fased/fased.json" \
  node "$PACKAGE_ROOT/fased.mjs" plugins doctor >/dev/null 2>&1; then
  echo "Hosted runtime failed its pre-install CLI and plugin check; the current install was not changed." >&2
  exit 20
fi

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
if ! node "$TARGET_ROOT/fased.mjs" --version >/dev/null 2>&1; then
  rm -rf "$TARGET_ROOT"
  [[ -n "$BACKUP_ROOT" && -e "$BACKUP_ROOT" ]] && mv "$BACKUP_ROOT" "$TARGET_ROOT"
  echo "Hosted runtime CLI verification failed." >&2
  exit 20
fi

mkdir -p "$PREFIX/bin"
ln -sfn "../lib/node_modules/@fased/fased/fased.mjs" "$PREFIX/bin/fased"
chmod 755 "$TARGET_ROOT/fased.mjs" 2>/dev/null || true
[[ -n "$BACKUP_ROOT" ]] && rm -rf "$BACKUP_ROOT"
printf 'Installed verified hosted runtime v%s.\n' "$VERSION"
