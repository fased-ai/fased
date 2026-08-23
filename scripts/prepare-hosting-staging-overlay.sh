#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${1:-}"
OUTPUT_DIR="${2:-}"
LOOPBACK_PORT="${3:-}"
[[ "$SOURCE_DIR" == /* && -d "$SOURCE_DIR" && "$OUTPUT_DIR" == /* && ! -e "$OUTPUT_DIR" &&
  "$LOOPBACK_PORT" =~ ^[0-9]+$ && "$LOOPBACK_PORT" -ge 1024 && "$LOOPBACK_PORT" -le 65535 ]] || {
  echo "usage: prepare-hosting-staging-overlay ABSOLUTE_ARTIFACT_DIR ABSOLUTE_NEW_OUTPUT_DIR LOOPBACK_PORT" >&2
  exit 1
}

descriptor="$SOURCE_DIR/fased-hosting-candidate.json"
identity="$SOURCE_DIR/fased-lifecycled-release.json"
[[ -f "$descriptor" && ! -L "$descriptor" && -f "$identity" && ! -L "$identity" ]] || {
  echo "The exact artifact descriptor and lifecycle identity are required." >&2
  exit 1
}
version="$(jq -er .version "$descriptor")"
commit="$(jq -er .commit "$descriptor")"
tree="$(jq -er .tree "$descriptor")"
[[ "$version" == "$(jq -er .version "$identity")" &&
  "$commit" == "$(jq -er .commit "$identity")" &&
  "$tree" == "$(jq -er .tree "$identity")" ]] || {
  echo "The artifact descriptor and lifecycle identity disagree." >&2
  exit 1
}

while IFS=$'\t' read -r name expected_size expected_digest; do
  candidate="$SOURCE_DIR/$name"
  [[ -f "$candidate" && ! -L "$candidate" && "$(stat -c %s "$candidate")" == "$expected_size" &&
    "sha256:$(sha256sum "$candidate" | awk '{print $1}')" == "$expected_digest" ]] || {
    echo "Artifact identity mismatch: $name" >&2
    exit 1
  }
done < <(jq -er '.artifacts[] | [.name, (.size|tostring), .sha256] | @tsv' "$descriptor")

mkdir -m 0700 "$OUTPUT_DIR"
cleanup_output=1
inventory="$(mktemp "${TMPDIR:-/tmp}/fased-staging-inventory.XXXXXX")"
source_installer=""
cleanup() {
  rm -f -- "$inventory" ${source_installer:+"$source_installer"}
  if [[ "$cleanup_output" -eq 1 ]]; then rm -rf -- "$OUTPUT_DIR"; fi
}
trap cleanup EXIT INT TERM HUP
cp -a --reflink=auto "$SOURCE_DIR/." "$OUTPUT_DIR/"
mkdir -m 0700 "$OUTPUT_DIR/fased-publishable-original"
for overridden in install.sh fased-bootstrap-linux-x64; do
  mv "$OUTPUT_DIR/$overridden" "$OUTPUT_DIR/fased-publishable-original/$overridden"
done

generation="$OUTPUT_DIR/fased-generation-linux-x64-v${version}.tar.gz"
tar -xOf "$generation" generation/inventory.json >"$inventory"
generation_digest="$(tar -xOf "$generation" generation/generation.json | jq -er .generation.artifactSetDigest)"
plugin_lock_digest="sha256:$(
  tar -xOf "$generation" generation/payload/runtime/plugin.lock.json |
    jq -cj '{schemaVersion,type,entries:[.entries[]|{id,origin,digest,apiCapability,required}]}' |
    sha256sum | awk '{print $1}'
)"
issued_at="$(node -e 'process.stdout.write(new Date(process.argv[1]).toISOString())' \
  "$(git -C "$ROOT_DIR" show -s --format=%cI "$commit")")"
go_tmp="${FASED_STAGING_GOTMPDIR:-${TMPDIR:-/tmp}/fased-staging-go-tmp}"
go_cache="${FASED_STAGING_GOCACHE:-${TMPDIR:-/tmp}/fased-staging-go-cache}"
mkdir -p "$go_tmp" "$go_cache"
GOTMPDIR="$go_tmp" GOCACHE="$go_cache" \
  go -C "$ROOT_DIR/tools/fased-lifecycled" run ./cmd/fased-branch-trust \
    --artifact-dir "$OUTPUT_DIR" --inventory "$inventory" --version "$version" \
    --commit "$commit" --tree "$tree" --artifact-set-digest "$generation_digest" \
    --plugin-lock-digest "$plugin_lock_digest" \
    --release-sequence "${FASED_LIFECYCLE_RELEASE_SEQUENCE:-1}" \
    --security-epoch "${FASED_LIFECYCLE_SECURITY_EPOCH:-1}" --issued-at "$issued_at"

cp "$OUTPUT_DIR/fased-branch-root.json" "$OUTPUT_DIR/fased-lifecycle-root-v1.json"
cp "$OUTPUT_DIR/fased-branch-release-index.json" "$OUTPUT_DIR/fased-release-index-v1.json"
cp "$OUTPUT_DIR/fased-branch-delegation.json" "$OUTPUT_DIR/fased-release-index-v1.json.attestation.json"
root_pin="$(tr -d '\n' <"$OUTPUT_DIR/fased-branch-root.sha256")"
metadata_base="http://127.0.0.1:${LOOPBACK_PORT}/v${version}"
(
  cd "$ROOT_DIR/tools/fased-lifecycled"
  GOTMPDIR="$go_tmp" GOCACHE="$go_cache" CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -buildvcs=false -trimpath \
    -ldflags="-s -w -buildid= -X main.branchFixtureMetadataBase=${metadata_base} -X main.branchFixturePinnedRootSHA256=${root_pin}" \
    -o "$OUTPUT_DIR/fased-bootstrap-linux-x64" ./cmd/fased-bootstrap
)
chmod 0755 "$OUTPUT_DIR/fased-bootstrap-linux-x64"
source_installer="$(mktemp "${TMPDIR:-/tmp}/fased-staging-install.XXXXXX")"
git -C "$ROOT_DIR" show "$commit:install.sh" >"$source_installer"
node -e '
  const fs = require("node:fs");
  const [file, replacement] = process.argv.slice(1);
  const expected = `release_base="https://github.com/fased-ai/fased/releases/download/v\${release}"`;
  const source = fs.readFileSync(file, "utf8");
  if (source.split(expected).length !== 2) throw new Error("staging installer release base is not unique");
  fs.writeFileSync(file, source.replace(expected, `release_base="${replacement}"`));
' "$source_installer" "$metadata_base"
node "$ROOT_DIR/scripts/stamp-release-installer.mjs" \
  --source "$source_installer" --output "$OUTPUT_DIR/install.sh" --version "$version" \
  --bootstrap-x64 "$OUTPUT_DIR/fased-bootstrap-linux-x64" --architecture x64
rm -f -- "$source_installer"
source_installer=""

jq -n --arg version "$version" --arg commit "$commit" --arg tree "$tree" \
  --arg metadataBase "$metadata_base" \
  --arg descriptorDigest "sha256:$(sha256sum "$descriptor" | awk '{print $1}')" \
  --arg installDigest "sha256:$(sha256sum "$OUTPUT_DIR/install.sh" | awk '{print $1}')" \
  --arg bootstrapDigest "sha256:$(sha256sum "$OUTPUT_DIR/fased-bootstrap-linux-x64" | awk '{print $1}')" \
  '{schemaVersion:1,role:"fased-hosting-staging-overlay",publishable:false,
    version:$version,commit:$commit,tree:$tree,metadataBase:$metadataBase,
    descriptorDigest:$descriptorDigest,installDigest:$installDigest,bootstrapDigest:$bootstrapDigest}' \
  >"$OUTPUT_DIR/fased-hosting-staging-overlay.json"
chmod 0444 "$OUTPUT_DIR/fased-hosting-staging-overlay.json"
cleanup_output=0
printf '%s\n' "$OUTPUT_DIR"
