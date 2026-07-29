#!/usr/bin/env bash
set -euo pipefail

fixture=/tmp/fased-release-fixture
version=9.8.7-rc.2
commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
dependency_hash=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
app_asset="fased-hosted-app-v2-linux-x64-v${version}.tar.gz"
dependency_asset="fased-hosted-deps-linux-x64-${dependency_hash}.tar.gz"
signer_asset=fased-signerd-linux-amd64
mkdir -p \
  "$fixture/app/package/dist" \
  "$fixture/app/package/scripts" \
  "$fixture/dependencies/node_modules"

cat >"$fixture/app/package/install.sh" <<'EOF_INNER'
#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -eq 9 ]]
[[ ( "$1" == "--hosting" || "$1" == "--repair-hosting" ) && "$2" == "--release" && "$3" == "v9.8.7-rc.2" ]]
[[ "$4" == "--update-channel" && "$5" == "beta" ]]
[[ "$6" == "--release" && "$7" == "9.8.7-rc.2" && "$8" == "--verified-hosting-bundle" ]]
[[ "$9" =~ ^/var/lib/fased-installer/releases/v9\.8\.7-rc\.2/[a-f0-9]{64}/extract/package$ ]]
[[ -f "$9/.fased-hosting-bundle-verified" ]]
printf 'verified handoff\n' >/tmp/fased-bootstrap-success
printf '%s\n' "$1" >>/tmp/fased-bootstrap-modes
mkdir -p /home/app/.fased
printf '{"onboardingCompleted":true}\n' >/home/app/.fased/install-complete.json
EOF_INNER
chmod 0755 "$fixture/app/package/install.sh"
cat >"$fixture/app/package/package.json" <<'EOF_PACKAGE'
{
  "name": "@fased/fased",
  "version": "9.8.7-rc.2"
}
EOF_PACKAGE
cat >"$fixture/app/package/dist/build-info.json" <<EOF_BUILD
{
  "version": "9.8.7-rc.2",
  "commit": "$commit"
}
EOF_BUILD
cat >"$fixture/app/package/scripts/fased-lifecycle-supervisor.mjs" <<'EOF_SUPERVISOR'
#!/usr/bin/env node
process.exit(0);
EOF_SUPERVISOR
chmod 0755 "$fixture/app/package/scripts/fased-lifecycle-supervisor.mjs"
supervisor_digest="$(
  sha256sum "$fixture/app/package/scripts/fased-lifecycle-supervisor.mjs" | awk '{print $1}'
)"
tar -czf "$fixture/$app_asset" -C "$fixture/app" package
tar -czf "$fixture/$dependency_asset" -C "$fixture/dependencies" node_modules
printf 'synthetic signer\n' >"$fixture/$signer_asset"
app_digest="$(sha256sum "$fixture/$app_asset" | awk '{print $1}')"
dependency_digest="$(sha256sum "$fixture/$dependency_asset" | awk '{print $1}')"
signer_digest="$(sha256sum "$fixture/$signer_asset" | awk '{print $1}')"

cat >"$fixture/fased-hosted-release-v2.json" <<EOF_MANIFEST
{
  "schemaVersion": 2,
  "release": {"version":"$version","tag":"v$version","commit":"$commit"},
  "application": {"linux": {
    "x64": {
      "artifact":{"asset":"$app_asset","sha256":"$app_digest"},
      "dependencies":{"asset":"$dependency_asset","sha256":"$dependency_digest","dependencyHash":"$dependency_hash"}
    },
    "arm64": {
      "artifact":{"asset":"unused-arm64.tar.gz","sha256":"$app_digest"},
      "dependencies":{"asset":"unused-arm64-deps.tar.gz","sha256":"$dependency_digest","dependencyHash":"$dependency_hash"}
    }
  }},
  "signer": {
    "release":{"version":"$version","commit":"$commit","buildInputDigest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","development":false},
    "capabilities":{},
    "capabilitiesDigest":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "platforms":{
      "linux-amd64":{"asset":"$signer_asset","sha256":"$signer_digest"},
      "linux-arm64":{"asset":"fased-signerd-linux-arm64","sha256":"$signer_digest"},
      "darwin-amd64":{"asset":"fased-signerd-darwin-amd64","sha256":"$signer_digest"},
      "darwin-arm64":{"asset":"fased-signerd-darwin-arm64","sha256":"$signer_digest"}
    }
  }
}
EOF_MANIFEST
printf '{"syntheticOfflineBundle":true}\n' >"$fixture/fased-hosted-release-v2.json.attestation.json"
issued_at="$(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%S.000Z)"
expires_at="$(date -u -d '30 days' +%Y-%m-%dT%H:%M:%S.000Z)"
cat >"$fixture/fased-lifecycle-trust-v1.json" <<EOF_LIFECYCLE
{
  "schemaVersion": 1,
  "role": "fased-lifecycle-targets",
  "release": {"version":"$version","tag":"v$version","commit":"$commit"},
  "validity": {"issuedAt":"$issued_at","expiresAt":"$expires_at"},
  "policy": {
    "channels": ["beta"],
    "platforms": ["linux-arm64", "linux-x64"],
    "supervisorProtocol": 1,
    "controllerProtocol": 2
  },
  "targets": {
    "supervisor": {
      "asset": "fased-lifecycle-supervisor.mjs",
      "sha256": "$supervisor_digest"
    },
    "controllerServer": {
      "asset": "fased-host-updater.mjs",
      "sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    },
    "controllerClient": {
      "asset": "fased-host-updaterctl.mjs",
      "sha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    }
  }
}
EOF_LIFECYCLE
printf '{"syntheticOfflineBundle":true}\n' >"$fixture/fased-lifecycle-trust-v1.json.attestation.json"

cat >/usr/local/bin/curl <<'EOF_CURL'
#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ "$url" == "https://api.github.com/repos/fased-ai/fased/releases/latest" ]]; then
  printf '{"tag_name":"v9.8.7-rc.2"}\n'
  exit 0
fi
[[ -n "$output" && -f "/tmp/fased-release-fixture/${url##*/}" ]]
cp "/tmp/fased-release-fixture/${url##*/}" "$output"
EOF_CURL
chmod 0755 /usr/local/bin/curl

cat >/usr/local/bin/jq <<'EOF_JQ'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *".tag_name"* ]]; then
  input="$(cat)"
  [[ "$input" == *'"tag_name":"v9.8.7-rc.2"'* ]]
  printf 'v9.8.7-rc.2\n'
  exit 0
fi
document="${!#}"
if [[ "$*" == *"--arg channel beta"* ]]; then
  [[ "$document" == */fased-lifecycle-trust-v1.json && -f "$document" ]]
  expected="$(
    sha256sum /tmp/fased-release-fixture/app/package/scripts/fased-lifecycle-supervisor.mjs |
      awk '{print $1}'
  )"
  grep -Fq "\"version\":\"9.8.7-rc.2\"" "$document"
  grep -Fq "\"commit\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"" "$document"
  grep -Fq "\"sha256\": \"$expected\"" "$document"
  printf '%s\n' "$expected"
  exit 0
fi
if [[ "$*" == *".validity.issuedAt"* ]]; then
  [[ "$document" == */fased-lifecycle-trust-v1.json && -f "$document" ]]
  sed -n 's/.*"issuedAt":[[:space:]]*"\([^"]*\)".*/\1/p' "$document"
  exit 0
fi
if [[ "$*" == *".validity.expiresAt"* ]]; then
  [[ "$document" == */fased-lifecycle-trust-v1.json && -f "$document" ]]
  sed -n 's/.*"expiresAt":[[:space:]]*"\([^"]*\)".*/\1/p' "$document"
  exit 0
fi
[[ "$*" == *"--arg version 9.8.7-rc.2"* ]]
[[ "$*" == *"--arg architecture x64"* ]]
[[ "$*" == *"--arg signer_platform linux-amd64"* ]]
manifest="$document"
[[ "$manifest" == */fased-hosted-release-v2.json && -f "$manifest" ]]
fixture=/tmp/fased-release-fixture
version=9.8.7-rc.2
commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
dependency_hash=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
app_asset="fased-hosted-app-v2-linux-x64-v${version}.tar.gz"
dependency_asset="fased-hosted-deps-linux-x64-${dependency_hash}.tar.gz"
signer_asset=fased-signerd-linux-amd64
grep -Fq "\"version\":\"${version}\"" "$manifest"
grep -Fq "\"commit\":\"${commit}\"" "$manifest"
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$commit" \
  "$commit" \
  "$app_asset" \
  "$(sha256sum "$fixture/$app_asset" | awk '{print $1}')" \
  "$dependency_asset" \
  "$(sha256sum "$fixture/$dependency_asset" | awk '{print $1}')" \
  "$dependency_hash" \
  "$signer_asset" \
  "$(sha256sum "$fixture/$signer_asset" | awk '{print $1}')"
EOF_JQ
chmod 0755 /usr/local/bin/jq

cat >/usr/local/bin/gh <<'EOF_GH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" != *"--help"* ]] || exit 0
[[ "$*" == *"attestation verify"* && "$*" == *"--bundle"* && "$*" == *"--source-ref refs/tags/v9.8.7-rc.2"* ]]
printf '%s\n' "$*" >>/tmp/fased-gh-verification.log
EOF_GH
chmod 0755 /usr/local/bin/gh

release_installer=/tmp/fased-release-install.sh
release_marker='install_entry_release_identity="__FASED_RELEASE_IDENTITY__"'
[[ "$(grep -Fxc "$release_marker" /repo/install.sh)" -eq 1 ]]
sed \
  "s|$release_marker|install_entry_release_identity=\"$version\"|" \
  /repo/install.sh >"$release_installer"
chmod 0700 "$release_installer"
grep -Fxq "install_entry_release_identity=\"$version\"" "$release_installer"

if bash -s -- --repair-hosting <"$release_installer" 2>/tmp/repair-error; then exit 1; fi
grep -Fq 'accepts only the public one-command selector' /tmp/repair-error
[[ ! -e /var/lib/fased-installer ]]
if FASED_INSTALL_REPO=https://example.invalid bash -s -- --hosting <"$release_installer" 2>/tmp/env-error; then exit 1; fi
grep -Fq 'Refusing Fased environment overrides' /tmp/env-error
[[ ! -e /var/lib/fased-installer ]]

bash -s -- --hosting --release v9.8.7-rc.2 --update-channel beta <"$release_installer"
[[ "$(cat /tmp/fased-bootstrap-success)" == "verified handoff" ]]
[[ "$(wc -l </tmp/fased-gh-verification.log)" -eq 2 ]]
marker="$(find /var/lib/fased-installer/releases/v9.8.7-rc.2 -name .fased-hosting-bundle-verified -type f -print -quit)"
[[ -n "$marker" ]]
grep -Fq 'version=9.8.7-rc.2' "$marker"
grep -Fq "commit=$commit" "$marker"
grep -Eq '^lifecycle_metadata_sha256=[a-f0-9]{64}$' "$marker"
bash -s -- --hosting --release v9.8.7-rc.2 --update-channel beta <"$release_installer"
[[ "$(sed -n '1p' /tmp/fased-bootstrap-modes)" == "--hosting" ]]
[[ "$(sed -n '2p' /tmp/fased-bootstrap-modes)" == "--repair-hosting" ]]
printf 'streamed Hosting bootstrap container validation passed\n'
