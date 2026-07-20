#!/usr/bin/env bash
set -euo pipefail

fixture=/tmp/fased-release-fixture
version=9.8.7
commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
dependency_hash=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
app_asset="fased-hosted-app-v2-linux-x64-v${version}.tar.gz"
dependency_asset="fased-hosted-deps-linux-x64-${dependency_hash}.tar.gz"
signer_asset=fased-signerd-linux-amd64
mkdir -p "$fixture/app/package/dist" "$fixture/dependencies/node_modules"

cat >"$fixture/app/package/install.sh" <<'EOF_INNER'
#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -eq 5 && "$1" == "--hosting" && "$2" == "--release" && "$3" == "9.8.7" && "$4" == "--verified-hosting-bundle" ]]
[[ "$5" =~ ^/var/lib/fased-installer/releases/v9\.8\.7/[a-f0-9]{64}/extract/package$ ]]
[[ -f "$5/.fased-hosting-bundle-verified" ]]
printf 'verified handoff\n' >/tmp/fased-bootstrap-success
EOF_INNER
chmod 0755 "$fixture/app/package/install.sh"
cat >"$fixture/app/package/package.json" <<'EOF_PACKAGE'
{
  "name": "@fased/fased",
  "version": "9.8.7"
}
EOF_PACKAGE
cat >"$fixture/app/package/dist/build-info.json" <<EOF_BUILD
{
  "version": "9.8.7",
  "commit": "$commit"
}
EOF_BUILD
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
  printf '{"tag_name":"v9.8.7"}\n'
  exit 0
fi
[[ -n "$output" && -f "/tmp/fased-release-fixture/${url##*/}" ]]
cp "/tmp/fased-release-fixture/${url##*/}" "$output"
EOF_CURL
chmod 0755 /usr/local/bin/curl

cat >/usr/local/bin/gh <<'EOF_GH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" != *"--help"* ]] || exit 0
[[ "$*" == *"attestation verify"* && "$*" == *"--bundle"* && "$*" == *"--source-ref refs/tags/v9.8.7"* ]]
printf '%s\n' "$*" >>/tmp/fased-gh-verification.log
EOF_GH
chmod 0755 /usr/local/bin/gh

if bash -s -- --repair-hosting </repo/install.sh 2>/tmp/repair-error; then exit 1; fi
grep -Fq 'accepts only the exact fresh-install selector' /tmp/repair-error
[[ ! -e /var/lib/fased-installer ]]
if FASED_INSTALL_REPO=https://example.invalid bash -s -- --hosting </repo/install.sh 2>/tmp/env-error; then exit 1; fi
grep -Fq 'Refusing Fased environment overrides' /tmp/env-error
[[ ! -e /var/lib/fased-installer ]]

bash -s -- --hosting </repo/install.sh
[[ "$(cat /tmp/fased-bootstrap-success)" == "verified handoff" ]]
[[ "$(wc -l </tmp/fased-gh-verification.log)" -eq 1 ]]
marker="$(find /var/lib/fased-installer/releases/v9.8.7 -name .fased-hosting-bundle-verified -type f -print -quit)"
[[ -n "$marker" ]]
grep -Fq 'version=9.8.7' "$marker"
grep -Fq "commit=$commit" "$marker"
if bash -s -- --hosting </repo/install.sh 2>/tmp/repeat-error; then exit 1; fi
grep -Fq 'only for a fresh host' /tmp/repeat-error
printf 'streamed Hosting bootstrap container validation passed\n'
