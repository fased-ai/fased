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

for command in node npm curl tar awk; do
  command -v "$command" >/dev/null 2>&1 || exit 10
done

VERSION="$(resolve_version || true)"
ARCH="$(resolve_arch || true)"
[[ -n "$VERSION" && -n "$ARCH" ]] || exit 10

ASSET_NAME="fased-hosted-linux-${ARCH}-v${VERSION}.tar.gz"
BASE_URL="${BASE_URL%/}"
RELEASE_URL="${BASE_URL}/v${VERSION}"
mkdir -p "$CACHE_DIR" "$PREFIX"
TEMP_ROOT="$(mktemp -d "$CACHE_DIR/hosted-runtime.XXXXXX")"
trap 'rm -rf "$TEMP_ROOT"' EXIT

CHECKSUM_FILE="$TEMP_ROOT/${ASSET_NAME}.sha256"
ARCHIVE="$TEMP_ROOT/$ASSET_NAME"
EXTRACT_ROOT="$TEMP_ROOT/extract"

curl -fsSL "$RELEASE_URL/${ASSET_NAME}.sha256" -o "$CHECKSUM_FILE" 2>/dev/null || exit 10
EXPECTED="$(awk -v asset="$ASSET_NAME" '$2 == asset || $2 == "*" asset { print tolower($1); exit }' "$CHECKSUM_FILE")"
if [[ ! "$EXPECTED" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Hosted runtime checksum is invalid for $ASSET_NAME." >&2
  exit 20
fi
curl -fsSL "$RELEASE_URL/$ASSET_NAME" -o "$ARCHIVE" 2>/dev/null || exit 10
ACTUAL="$(sha256_file "$ARCHIVE" || true)"
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
  echo "Hosted runtime checksum mismatch for $ASSET_NAME." >&2
  exit 20
fi
if ! archive_is_safe "$ARCHIVE"; then
  echo "Hosted runtime archive layout is invalid." >&2
  exit 20
fi

mkdir -p "$EXTRACT_ROOT"
tar -xzf "$ARCHIVE" -C "$EXTRACT_ROOT"
PACKAGE_ROOT="$EXTRACT_ROOT/package"
if [[ ! -f "$PACKAGE_ROOT/fased.mjs" || ! -d "$PACKAGE_ROOT/node_modules" ]]; then
  echo "Hosted runtime archive is incomplete." >&2
  exit 20
fi
if [[ "$(node -p "require(process.argv[1]).version" "$PACKAGE_ROOT/package.json" 2>/dev/null || true)" != "$VERSION" ]]; then
  echo "Hosted runtime version does not match v${VERSION}." >&2
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
