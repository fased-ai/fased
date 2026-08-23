#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${1:-}"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT_DIR/package.json")"
COMMIT="${FASED_RELEASE_SOURCE_COMMIT:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
TREE="$(git -C "$ROOT_DIR" rev-parse "${COMMIT}^{tree}")"
LOCKFILE_DIGEST="sha256:$(git -C "$ROOT_DIR" show "${COMMIT}:pnpm-lock.yaml" | sha256sum | awk '{print $1}')"
GO_BIN="${FASED_GO_BIN:-$(command -v go || true)}"
RELEASE_SEQUENCE="${FASED_LIFECYCLE_RELEASE_SEQUENCE:-1}"
SECURITY_EPOCH="${FASED_LIFECYCLE_SECURITY_EPOCH:-1}"
readonly MAX_CORE_ARTIFACT_FILES=96
readonly MAX_CORE_ARTIFACT_BYTES=805306368

usage() {
  echo "usage: build-linux-x64-release-artifact.sh EMPTY_ABSOLUTE_OUTPUT_DIR" >&2
  exit 2
}

[[ "$OUTPUT_DIR" == /* ]] || usage
[[ "$COMMIT" =~ ^[a-f0-9]{40}$ ]] || usage
[[ "$RELEASE_SEQUENCE" =~ ^[1-9][0-9]*$ ]] || usage
[[ "$SECURITY_EPOCH" =~ ^[1-9][0-9]*$ ]] || usage
[[ -n "$GO_BIN" && -x "$GO_BIN" ]] || {
  echo "Go is required to build the Linux-x64 release artifact." >&2
  exit 1
}
[[ -z "$(git -C "$ROOT_DIR" status --porcelain=v1 --untracked-files=normal)" ]] || {
  echo "The release artifact builder requires one exact clean committed source tree." >&2
  exit 1
}
[[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" == "$COMMIT" ]] || {
  echo "The release artifact builder requires the selected source commit at HEAD." >&2
  exit 1
}
[[ -x "$ROOT_DIR/node_modules/.bin/tsdown" && -x "$ROOT_DIR/ui/node_modules/.bin/vite" ]] || {
  echo "The release artifact builder requires one complete frozen dependency install." >&2
  exit 1
}

mkdir -p "$OUTPUT_DIR"
[[ -d "$OUTPUT_DIR" && -z "$(find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
  echo "The release artifact output directory must be empty." >&2
  exit 1
}

if [[ ! -f "$ROOT_DIR/dist/build-info.json" ]] ||
  [[ "$(jq -r .version "$ROOT_DIR/dist/build-info.json")" != "$VERSION" ]] ||
  [[ "$(jq -r .commit "$ROOT_DIR/dist/build-info.json")" != "$COMMIT" ]]; then
  pnpm --dir "$ROOT_DIR" build
fi
[[ "$(jq -r .version "$ROOT_DIR/dist/build-info.json")" == "$VERSION" &&
  "$(jq -r .commit "$ROOT_DIR/dist/build-info.json")" == "$COMMIT" ]] || {
  echo "The release artifact builder refuses stale dist identity." >&2
  exit 1
}

release_dir="$ROOT_DIR/dist-native/release"
mkdir -p "$release_dir"
find "$release_dir" -maxdepth 1 \( -type f -o -type l \) \
  \( -name 'fased-signerd-*' -o -name 'fased-lifecycled-*' -o -name 'fased-bootstrap-*' \) \
  -delete

go_tmp="${GOTMPDIR:-${TMPDIR:-/tmp}/fased-release-go-tmp}"
go_cache="${GOCACHE:-${TMPDIR:-/tmp}/fased-release-go-cache}"
mkdir -p "$go_tmp" "$go_cache"
GOTMPDIR="$go_tmp" \
GOCACHE="$go_cache" \
FASED_SIGNER_BUILD_COMMIT="$COMMIT" \
FASED_SIGNER_TARGETS="linux/amd64" \
FASED_LIFECYCLE_BUILD_COMMIT="$COMMIT" \
FASED_LIFECYCLE_BUILD_TREE="$TREE" \
FASED_LIFECYCLE_TARGETS="linux/amd64" \
  bash "$ROOT_DIR/scripts/build-native-release-assets.sh"

# Core is the only eagerly installed package. Optional component packs are
# independent P6 transactions and are intentionally absent from this artifact.
pnpm --dir "$ROOT_DIR" hosted:artifact:from-dist --output "$OUTPUT_DIR"
cp -a "$release_dir/." "$OUTPUT_DIR/"

node "$ROOT_DIR/scripts/stamp-release-installer.mjs" \
  --source "$ROOT_DIR/install.sh" \
  --output "$OUTPUT_DIR/install.sh" \
  --version "$VERSION" \
  --bootstrap-x64 "$OUTPUT_DIR/fased-bootstrap-linux-x64" \
  --architecture x64

x64_identity="$OUTPUT_DIR/fased-hosted-app-v2-linux-x64-v${VERSION}.tar.gz.release.json"
x64_app="$(jq -er .app.asset "$x64_identity")"
x64_dependency="$(jq -er .dependencies.asset "$x64_identity")"
node "$ROOT_DIR/scripts/build-hosted-release-manifest.mjs" \
  --assets "$OUTPUT_DIR" \
  --version "$VERSION" \
  --commit "$COMMIT" \
  --output "$OUTPUT_DIR/fased-hosted-release-v2.json"
node "$ROOT_DIR/scripts/assemble-lifecycle-generation.mjs" \
  --runtime-archive "$OUTPUT_DIR/$x64_app" \
  --dependency-archive "$OUTPUT_DIR/$x64_dependency" \
  --release-manifest "$OUTPUT_DIR/fased-hosted-release-v2.json" \
  --signer "$OUTPUT_DIR/fased-signerd-linux-amd64" \
  --inventory-tool "$OUTPUT_DIR/fased-lifecycled-linux-amd64" \
  --node "$(readlink -f "$(command -v node)")" \
  --node-license "$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")/LICENSE" \
  --output-dir "$OUTPUT_DIR" \
  --version "$VERSION" \
  --commit "$COMMIT" \
  --tree "$TREE" \
  --architecture x64

printf '{"schemaVersion":1,"profile":"linux-x64","publishable":false,"platforms":["linux-x64"]}\n' \
  >"$OUTPUT_DIR/fased-branch-proof-x64.json"
install -m 0644 \
  "$ROOT_DIR/config/lifecycle-acceptance.v2.json" \
  "$OUTPUT_DIR/fased-lifecycle-acceptance-v2.json"
node "$ROOT_DIR/scripts/lifecycle-release-compatibility.mjs" build \
  --version "$VERSION" \
  --commit "$COMMIT" \
  --tree "$TREE" \
  --output "$OUTPUT_DIR/fased-lifecycle-release-compatibility-v1.json"
node "$ROOT_DIR/scripts/release-artifact-set.mjs" build \
  --directory "$OUTPUT_DIR" \
  --version "$VERSION" \
  --commit "$COMMIT" \
  --tree "$TREE" \
  --lockfile-digest "$LOCKFILE_DIGEST" \
  --source-ref "refs/tags/v${VERSION}" \
  --workflow-run-id "${GITHUB_RUN_ID:-1}" \
  --workflow-run-attempt "${GITHUB_RUN_ATTEMPT:-1}"
printf '{"preTagUnpublished":true}\n' \
  >"$OUTPUT_DIR/fased-hosting-candidate.json.attestation.json"

for required_asset in \
  install.sh \
  fased-bootstrap-linux-x64 \
  fased-hosted-release-v2.json \
  fased-lifecycle-acceptance-v2.json \
  fased-lifecycle-release-compatibility-v1.json \
  fased-hosting-candidate.json \
  fased-hosting-candidate.json.attestation.json \
  "fased-generation-linux-x64-v${VERSION}.tar.gz"; do
  [[ -s "$OUTPUT_DIR/$required_asset" ]] || {
    echo "The Linux-x64 release artifact is missing $required_asset." >&2
    exit 1
  }
done

unsupported_entries="$(find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 ! -type f -print)"
[[ -z "$unsupported_entries" ]] || {
  echo "The Linux-x64 core artifact contains a non-regular entry." >&2
  exit 1
}
artifact_file_count="$(find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -type f -printf '.' | wc -c)"
artifact_total_bytes="$(find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -type f -printf '%s\n' | awk '{sum += $1} END {print sum + 0}')"
((artifact_file_count <= MAX_CORE_ARTIFACT_FILES)) || {
  echo "The Linux-x64 core artifact exceeds its ${MAX_CORE_ARTIFACT_FILES}-file budget." >&2
  exit 1
}
((artifact_total_bytes <= MAX_CORE_ARTIFACT_BYTES)) || {
  echo "The Linux-x64 core artifact exceeds its ${MAX_CORE_ARTIFACT_BYTES}-byte budget." >&2
  exit 1
}

echo "Linux-x64 release artifact: commit=$COMMIT tree=$TREE lock=$LOCKFILE_DIGEST"
echo "Linux-x64 core budget: files=$artifact_file_count bytes=$artifact_total_bytes"
printf '%s\n' "$OUTPUT_DIR"
