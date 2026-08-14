#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${1:-}"
OUTPUT_DIR="${2:-}"
[[ "$SOURCE_DIR" == /* && -d "$SOURCE_DIR" && "$OUTPUT_DIR" == /* && ! -e "$OUTPUT_DIR" ]] || {
  echo "usage: prepare-candidate-fixture-trust ABSOLUTE_CANDIDATE_DIR ABSOLUTE_NEW_OUTPUT_DIR" >&2
  exit 1
}

descriptor="$SOURCE_DIR/fased-hosting-candidate.json"
identity="$SOURCE_DIR/fased-lifecycled-release.json"
[[ -f "$descriptor" && ! -L "$descriptor" && -f "$identity" && ! -L "$identity" ]] || {
  echo "The exact candidate descriptor and lifecycle identity are required." >&2
  exit 1
}
version="$(jq -er .version "$descriptor")"
commit="$(jq -er .commit "$descriptor")"
tree="$(jq -er .tree "$descriptor")"
[[ "$version" == "$(jq -er .version "$identity")" &&
  "$commit" == "$(jq -er .commit "$identity")" &&
  "$tree" == "$(jq -er .tree "$identity")" ]] || {
  echo "The candidate descriptor and lifecycle identity disagree." >&2
  exit 1
}

while IFS=$'\t' read -r name expected_size expected_digest; do
  candidate="$SOURCE_DIR/$name"
  [[ -f "$candidate" && ! -L "$candidate" && "$(stat -c %s "$candidate")" == "$expected_size" &&
    "sha256:$(sha256sum "$candidate" | awk '{print $1}')" == "$expected_digest" ]] || {
    echo "Candidate artifact identity mismatch: $name" >&2
    exit 1
  }
done < <(jq -er '.artifacts[] | [.name, (.size|tostring), .sha256] | @tsv' "$descriptor")
unsafe_entry="$(find "$SOURCE_DIR" -mindepth 1 -maxdepth 1 ! -type f -print -quit)"
[[ -z "$unsafe_entry" ]] || {
  echo "Candidate artifact directory contains a non-regular entry: $unsafe_entry" >&2
  exit 1
}
unexpected_inventory="$({
  comm -3 \
    <({ jq -r '.artifacts[].name' "$descriptor"; printf '%s\n' \
      fased-hosting-candidate.json fased-hosting-candidate.json.attestation.json; } | sort) \
    <(find "$SOURCE_DIR" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | sort)
})"
[[ -z "$unexpected_inventory" ]] || {
  echo "Candidate artifact directory does not match its exact closed inventory:" >&2
  printf '%s\n' "$unexpected_inventory" >&2
  exit 1
}

mkdir -m 0700 "$OUTPUT_DIR"
cp -a --reflink=auto "$SOURCE_DIR/." "$OUTPUT_DIR/"
mkdir -m 0700 "$OUTPUT_DIR/fased-candidate-original"
for overridden in install.sh fased-bootstrap-linux-x64; do
  mv "$OUTPUT_DIR/$overridden" "$OUTPUT_DIR/fased-candidate-original/$overridden"
done

inventory="$(mktemp "${TMPDIR:-/tmp}/fased-candidate-inventory.XXXXXX")"
source_installer=""
cleanup() { rm -f -- "$inventory" ${source_installer:+"$source_installer"}; }
trap cleanup EXIT INT TERM HUP
generation="$OUTPUT_DIR/fased-generation-linux-x64-v${version}.tar.gz"
tar -xOf "$generation" generation/inventory.json >"$inventory"
generation_digest="$(
  tar -xOf "$generation" generation/generation.json | jq -er .generation.artifactSetDigest
)"
plugin_lock_digest="sha256:$(
  tar -xOf "$generation" generation/payload/runtime/plugin.lock.json |
    jq -c '{schemaVersion,type,entries:[.entries[]|{id,origin,digest,apiCapability,required}]}' |
    sha256sum | awk '{print $1}'
)"
issued_at="$(node -e '
  process.stdout.write(new Date(process.argv[1]).toISOString());
' "$(git -C "$ROOT_DIR" show -s --format=%cI "$commit")")"
go_tmp="${FASED_FIXTURE_GOTMPDIR:-${TMPDIR:-/tmp}/fased-fixture-go-tmp}"
go_cache="${FASED_FIXTURE_GOCACHE:-${TMPDIR:-/tmp}/fased-fixture-go-cache}"
mkdir -p "$go_tmp" "$go_cache"
GOTMPDIR="$go_tmp" GOCACHE="$go_cache" \
  go -C "$ROOT_DIR/tools/fased-lifecycled" run ./cmd/fased-branch-trust \
    --artifact-dir "$OUTPUT_DIR" \
    --inventory "$inventory" \
    --version "$version" \
    --commit "$commit" \
    --tree "$tree" \
    --artifact-set-digest "$generation_digest" \
    --plugin-lock-digest "$plugin_lock_digest" \
    --release-sequence "${FASED_LIFECYCLE_RELEASE_SEQUENCE:-1}" \
    --security-epoch "${FASED_LIFECYCLE_SECURITY_EPOCH:-1}" \
    --issued-at "$issued_at"

root_pin="$(tr -d '\n' <"$OUTPUT_DIR/fased-branch-root.sha256")"
metadata_base="https://github.com/fased-ai/fased/releases/download/v${version}"
(
  cd "$ROOT_DIR/tools/fased-lifecycled"
  GOTMPDIR="$go_tmp" GOCACHE="$go_cache" CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -buildvcs=false -trimpath \
    -ldflags="-s -w -buildid= -X main.branchFixtureMetadataBase=${metadata_base} -X main.branchFixturePinnedRootSHA256=${root_pin}" \
    -o "$OUTPUT_DIR/fased-bootstrap-linux-x64" ./cmd/fased-bootstrap
)
chmod 0755 "$OUTPUT_DIR/fased-bootstrap-linux-x64"
source_installer="$(mktemp "${TMPDIR:-/tmp}/fased-candidate-install.XXXXXX")"
git -C "$ROOT_DIR" show "$commit:install.sh" >"$source_installer"
node "$ROOT_DIR/scripts/stamp-release-installer.mjs" \
  --source "$source_installer" \
  --output "$OUTPUT_DIR/install.sh" \
  --version "$version" \
  --bootstrap-x64 "$OUTPUT_DIR/fased-bootstrap-linux-x64" \
  --architecture x64
rm -f -- "$source_installer"
source_installer=""

jq -n \
  --arg candidateDescriptorSha256 "sha256:$(sha256sum "$descriptor" | awk '{print $1}')" \
  --arg candidateInstallSha256 "sha256:$(sha256sum "$OUTPUT_DIR/fased-candidate-original/install.sh" | awk '{print $1}')" \
  --arg candidateBootstrapSha256 "sha256:$(sha256sum "$OUTPUT_DIR/fased-candidate-original/fased-bootstrap-linux-x64" | awk '{print $1}')" \
  --arg fixtureInstallSha256 "sha256:$(sha256sum "$OUTPUT_DIR/install.sh" | awk '{print $1}')" \
  --arg fixtureBootstrapSha256 "sha256:$(sha256sum "$OUTPUT_DIR/fased-bootstrap-linux-x64" | awk '{print $1}')" \
  --arg version "$version" --arg commit "$commit" --arg tree "$tree" \
  '{schemaVersion:1,role:"fased-candidate-fixture-trust-overlay",publishable:false,
    candidate:{version:$version,commit:$commit,tree:$tree,descriptorSha256:$candidateDescriptorSha256,
      installSha256:$candidateInstallSha256,bootstrapSha256:$candidateBootstrapSha256},
    fixture:{installSha256:$fixtureInstallSha256,bootstrapSha256:$fixtureBootstrapSha256},
    overriddenPaths:["fased-bootstrap-linux-x64","install.sh"]}' \
  >"$OUTPUT_DIR/fased-candidate-fixture-overlay.json"
chmod 0444 "$OUTPUT_DIR/fased-candidate-fixture-overlay.json"
echo "$OUTPUT_DIR"
