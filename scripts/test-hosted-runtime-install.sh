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
APP_ASSET="fased-hosted-app-linux-${ARCH}-v${VERSION}.tar.gz"
DEPENDENCY_HASH="$(printf 'test-lockfile' | sha256sum | awk '{print $1}')"
DEPENDENCY_ASSET="fased-hosted-deps-linux-${ARCH}-${DEPENDENCY_HASH}.tar.gz"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

PACKAGE_ROOT="$TEMP_ROOT/source/package"
RELEASE_ROOT="$TEMP_ROOT/releases/v${VERSION}"
PREFIX="$TEMP_ROOT/prefix"
CACHE="$TEMP_ROOT/cache"
mkdir -p "$PACKAGE_ROOT/node_modules" "$PACKAGE_ROOT/scripts" "$PACKAGE_ROOT/dist/control-ui" "$RELEASE_ROOT"

cat >"$PACKAGE_ROOT/package.json" <<EOF
{"name":"@fased/fased","version":"${VERSION}","type":"module"}
EOF
cat >"$PACKAGE_ROOT/fased.mjs" <<EOF
#!/usr/bin/env node
console.log("${VERSION}");
EOF
chmod 755 "$PACKAGE_ROOT/fased.mjs"
cat >"$PACKAGE_ROOT/dist/control-ui/version.json" <<EOF
{"version":"${VERSION}"}
EOF
for managed_script in \
  fased-managed-launcher.sh \
  fased-managed-service.sh \
  fased-managed-updater.mjs \
  fased-managed-updater-core.mjs \
  generation-updater.mjs \
  fased-host-updaterctl.mjs \
  hosted-release-manifest.mjs \
  install-managed-runtime.mjs \
  lifecycle-trust-crypto.mjs \
  lifecycle-trust-policy.mjs \
  lifecycle-trust-root.mjs \
  lifecycle-trust-runtime.mjs \
  managed-updater-bundle.mjs \
  managed-updater-bundle.v1.json \
  managed-runtime-layout.mjs \
  managed-update-contract.mjs; do
  cp "$ROOT_DIR/scripts/$managed_script" "$PACKAGE_ROOT/scripts/$managed_script"
  chmod 755 "$PACKAGE_ROOT/scripts/$managed_script"
done
cat >"$PACKAGE_ROOT/scripts/start-managed.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod 755 "$PACKAGE_ROOT/scripts/start-managed.sh"
tar -czf "$RELEASE_ROOT/$ASSET" -C "$TEMP_ROOT/source" package
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$RELEASE_ROOT" && sha256sum "$ASSET" >"${ASSET}.sha256")
else
  digest="$(shasum -a 256 "$RELEASE_ROOT/$ASSET" | awk '{print $1}')"
  printf '%s  %s\n' "$digest" "$ASSET" >"$RELEASE_ROOT/${ASSET}.sha256"
fi

cat >"$PACKAGE_ROOT/.fased-hosted-runtime.json" <<EOF
{"schemaVersion":1,"dependencyHash":"${DEPENDENCY_HASH}"}
EOF
mv "$PACKAGE_ROOT/node_modules" "$TEMP_ROOT/dependency-node_modules"
tar -czf "$RELEASE_ROOT/$APP_ASSET" -C "$TEMP_ROOT/source" package
mkdir -p "$TEMP_ROOT/dependency-source"
mv "$TEMP_ROOT/dependency-node_modules" "$TEMP_ROOT/dependency-source/node_modules"
tar -czf "$RELEASE_ROOT/$DEPENDENCY_ASSET" -C "$TEMP_ROOT/dependency-source" node_modules
mkdir -p "$PACKAGE_ROOT/node_modules"
for layered_asset in "$APP_ASSET" "$DEPENDENCY_ASSET"; do
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$RELEASE_ROOT" && sha256sum "$layered_asset" >"${layered_asset}.sha256")
  else
    digest="$(shasum -a 256 "$RELEASE_ROOT/$layered_asset" | awk '{print $1}')"
    printf '%s  %s\n' "$digest" "$layered_asset" >"$RELEASE_ROOT/${layered_asset}.sha256"
  fi
done

layered_output="$(bash "$INSTALLER" \
  --package "@fased/fased@${VERSION}" \
  --prefix "$TEMP_ROOT/layered-prefix" \
  --cache "$TEMP_ROOT/layered-cache" \
  --base-url "file://$TEMP_ROOT/releases")"
printf '%s\n' "$layered_output"
grep -Fq "Fresh runtime timing:" <<<"$layered_output"
grep -Fq "dependency archive safety scan:" <<<"$layered_output"
grep -Fq "dependency extraction:" <<<"$layered_output"
grep -Fq "runtime smoke verification:" <<<"$layered_output"
grep -Fq "runtime activation:" <<<"$layered_output"
grep -Fq "total:" <<<"$layered_output"

[[ "$("$TEMP_ROOT/layered-prefix/bin/fased" --version)" == "$VERSION" ]]
[[ -L "$TEMP_ROOT/layered-prefix/lib/node_modules/@fased/fased/node_modules" ]]

LEGACY_STATE="$TEMP_ROOT/legacy-state"
LEGACY_PREFIX="$LEGACY_STATE/install-cache/npm-global"
LEGACY_ROOT="$LEGACY_PREFIX/lib/node_modules/@fased/fased"
mkdir -p "$(dirname "$LEGACY_ROOT")" "$LEGACY_STATE"
cp -a "$PACKAGE_ROOT" "$LEGACY_ROOT"
cat >"$LEGACY_ROOT/package.json" <<'EOF'
{"name":"@fased/fased","version":"0.1.23","type":"module"}
EOF
cat >"$LEGACY_ROOT/dist/control-ui/version.json" <<'EOF'
{"version":"0.1.23"}
EOF
cat >"$LEGACY_ROOT/fased.mjs" <<'EOF'
#!/usr/bin/env node
console.log("0.1.23");
EOF
chmod 755 "$LEGACY_ROOT/fased.mjs"
printf 'preserve-wallet-and-session-state\n' >"$LEGACY_STATE/persistent-state"
bash "$INSTALLER" \
  --package "@fased/fased@${VERSION}" \
  --prefix "$LEGACY_PREFIX" \
  --cache "$LEGACY_STATE/install-cache" \
  --state-dir "$LEGACY_STATE" \
  --profile local \
  --base-url "file://$TEMP_ROOT/releases" >/dev/null
[[ "$(cd "$TEMP_ROOT" && "$LEGACY_PREFIX/bin/fased" --version)" == "$VERSION" ]]
[[ "$(cat "$LEGACY_STATE/persistent-state")" == "preserve-wallet-and-session-state" ]]
[[ "$(readlink -f "$LEGACY_STATE/runtime/previous")" == "$LEGACY_STATE/runtime/releases/0.1.23" ]]
grep -Fq '"profile": "local"' "$LEGACY_STATE/install.json"

cp "$RELEASE_ROOT/${APP_ASSET}.sha256" "$TEMP_ROOT/app-asset.sha256"
printf '%064d  %s\n' 0 "$APP_ASSET" >"$RELEASE_ROOT/${APP_ASSET}.sha256"
set +e
bash "$INSTALLER" \
  --package "@fased/fased@${VERSION}" \
  --prefix "$TEMP_ROOT/layered-tampered-prefix" \
  --cache "$TEMP_ROOT/layered-tampered-cache" \
  --base-url "file://$TEMP_ROOT/releases" >/dev/null 2>&1
layered_tampered_status=$?
set -e
[[ "$layered_tampered_status" -eq 20 ]]
mv "$TEMP_ROOT/app-asset.sha256" "$RELEASE_ROOT/${APP_ASSET}.sha256"

rm -f "$RELEASE_ROOT/$APP_ASSET" "$RELEASE_ROOT/${APP_ASSET}.sha256"
rm -f "$RELEASE_ROOT/$DEPENDENCY_ASSET" "$RELEASE_ROOT/${DEPENDENCY_ASSET}.sha256"
rm -f "$PACKAGE_ROOT/.fased-hosted-runtime.json"

bash "$INSTALLER" \
  --package "@fased/fased@${VERSION}" \
  --prefix "$PREFIX" \
  --cache "$CACHE" \
  --base-url "file://$TEMP_ROOT/releases"

[[ "$($PREFIX/bin/fased --version)" == "$VERSION" ]]
[[ -d "$PREFIX/lib/node_modules/@fased/fased/node_modules" ]]

cat >"$PACKAGE_ROOT/fased.mjs" <<EOF
#!/usr/bin/env node
if (process.argv[2] === "--version") {
  console.log("${VERSION}");
  process.exit(0);
}
process.exit(42);
EOF
chmod 755 "$PACKAGE_ROOT/fased.mjs"
tar -czf "$RELEASE_ROOT/$ASSET" -C "$TEMP_ROOT/source" package
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$RELEASE_ROOT" && sha256sum "$ASSET" >"${ASSET}.sha256")
else
  digest="$(shasum -a 256 "$RELEASE_ROOT/$ASSET" | awk '{print $1}')"
  printf '%s  %s\n' "$digest" "$ASSET" >"$RELEASE_ROOT/${ASSET}.sha256"
fi
set +e
bash "$INSTALLER" \
  --package "@fased/fased@${VERSION}" \
  --prefix "$PREFIX" \
  --cache "$TEMP_ROOT/incomplete-cache" \
  --base-url "file://$TEMP_ROOT/releases" >/dev/null 2>&1
incomplete_status=$?
set -e
[[ "$incomplete_status" -eq 20 ]]
[[ "$($PREFIX/bin/fased --version)" == "$VERSION" ]]

printf '%064d  %s\n' 0 "$ASSET" >"$RELEASE_ROOT/${ASSET}.sha256"
set +e
bash "$INSTALLER" \
  --package "@fased/fased@${VERSION}" \
  --prefix "$TEMP_ROOT/tampered-prefix" \
  --cache "$TEMP_ROOT/tampered-cache" \
  --base-url "file://$TEMP_ROOT/releases" >/dev/null 2>&1
tampered_status=$?
set -e
[[ "$tampered_status" -eq 20 ]]

set +e
bash "$INSTALLER" \
  --package "@fased/fased@${VERSION}" \
  --prefix "$TEMP_ROOT/missing-prefix" \
  --cache "$TEMP_ROOT/missing-cache" \
  --base-url "file://$TEMP_ROOT/missing" >/dev/null 2>&1
missing_status=$?
set -e
[[ "$missing_status" -eq 10 ]]

echo "hosted runtime installer smoke passed"
