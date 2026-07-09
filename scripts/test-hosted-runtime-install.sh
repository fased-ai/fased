#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$ROOT_DIR/scripts/install-hosted-runtime.sh"
VERSION="9.8.7"
ARCH="x64"
if [[ "$(uname -m)" == "aarch64" || "$(uname -m)" == "arm64" ]]; then
  ARCH="arm64"
fi
ASSET="fased-hosted-linux-${ARCH}-v${VERSION}.tar.gz"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

PACKAGE_ROOT="$TEMP_ROOT/source/package"
RELEASE_ROOT="$TEMP_ROOT/releases/v${VERSION}"
PREFIX="$TEMP_ROOT/prefix"
CACHE="$TEMP_ROOT/cache"
mkdir -p "$PACKAGE_ROOT/node_modules" "$RELEASE_ROOT"

cat >"$PACKAGE_ROOT/package.json" <<EOF
{"name":"@fased/fased","version":"${VERSION}","type":"module"}
EOF
cat >"$PACKAGE_ROOT/fased.mjs" <<EOF
#!/usr/bin/env node
console.log("${VERSION}");
EOF
chmod 755 "$PACKAGE_ROOT/fased.mjs"
tar -czf "$RELEASE_ROOT/$ASSET" -C "$TEMP_ROOT/source" package
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$RELEASE_ROOT" && sha256sum "$ASSET" >"${ASSET}.sha256")
else
  digest="$(shasum -a 256 "$RELEASE_ROOT/$ASSET" | awk '{print $1}')"
  printf '%s  %s\n' "$digest" "$ASSET" >"$RELEASE_ROOT/${ASSET}.sha256"
fi

"$INSTALLER" \
  --package "@fased/fased@${VERSION}" \
  --prefix "$PREFIX" \
  --cache "$CACHE" \
  --base-url "file://$TEMP_ROOT/releases"

[[ "$($PREFIX/bin/fased --version)" == "$VERSION" ]]
[[ -d "$PREFIX/lib/node_modules/@fased/fased/node_modules" ]]

printf '%064d  %s\n' 0 "$ASSET" >"$RELEASE_ROOT/${ASSET}.sha256"
set +e
"$INSTALLER" \
  --package "@fased/fased@${VERSION}" \
  --prefix "$TEMP_ROOT/tampered-prefix" \
  --cache "$TEMP_ROOT/tampered-cache" \
  --base-url "file://$TEMP_ROOT/releases" >/dev/null 2>&1
tampered_status=$?
set -e
[[ "$tampered_status" -eq 20 ]]

set +e
"$INSTALLER" \
  --package "@fased/fased@${VERSION}" \
  --prefix "$TEMP_ROOT/missing-prefix" \
  --cache "$TEMP_ROOT/missing-cache" \
  --base-url "file://$TEMP_ROOT/missing" >/dev/null 2>&1
missing_status=$?
set -e
[[ "$missing_status" -eq 10 ]]

echo "hosted runtime installer smoke passed"
