#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${1:-}"
OUTPUT_DIR="${2:-}"
VERSION="${3:-}"
COMMIT="${4:-}"
TREE="${5:-}"
RELEASE_SEQUENCE="${6:-}"
SECURITY_EPOCH="${7:-}"

[[ "$SOURCE_DIR" == /* && -d "$SOURCE_DIR" && "$OUTPUT_DIR" == /* && ! -e "$OUTPUT_DIR" ]] || {
  echo "usage: finalize-pretag-candidate.sh SOURCE_DIR NEW_OUTPUT_DIR VERSION COMMIT TREE RELEASE_SEQUENCE SECURITY_EPOCH" >&2
  exit 2
}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]
[[ "$COMMIT" =~ ^[a-f0-9]{40}$ && "$TREE" =~ ^[a-f0-9]{40}$ ]]
[[ "$RELEASE_SEQUENCE" =~ ^[1-9][0-9]*$ && "$SECURITY_EPOCH" =~ ^[1-9][0-9]*$ ]]

descriptor="$SOURCE_DIR/fased-hosting-candidate.json"
overlay="$SOURCE_DIR/fased-candidate-fixture-overlay.json"
originals="$SOURCE_DIR/fased-candidate-original"
test -f "$descriptor"
test -f "$overlay"
test -d "$originals"
jq -e \
  --arg version "$VERSION" --arg commit "$COMMIT" --arg tree "$TREE" \
  '.version == $version and .commit == $commit and .tree == $tree and
   .sourceRef == ("refs/tags/v" + $version)' "$descriptor" >/dev/null
jq -e \
  --arg digest "sha256:$(sha256sum "$descriptor" | awk '{print $1}')" \
  '.schemaVersion == 1 and .role == "fased-candidate-fixture-trust-overlay" and
   .publishable == false and .candidate.descriptorSha256 == $digest and
   .overriddenPaths == ["fased-bootstrap-linux-x64","install.sh"]' \
  "$overlay" >/dev/null

mkdir -m 0700 "$OUTPUT_DIR"
while IFS=$'\t' read -r name expected_size expected_digest; do
  source="$SOURCE_DIR/$name"
  case "$name" in
    install.sh|fased-bootstrap-linux-x64)
      source="$originals/$name"
      ;;
  esac
  test -f "$source"
  test ! -L "$source"
  test "$(stat -c %s "$source")" = "$expected_size"
  test "sha256:$(sha256sum "$source" | awk '{print $1}')" = "$expected_digest"
  case "$name" in
    fased-branch-*|fased-hosting-candidate.json|fased-hosting-candidate.json.attestation.json)
      continue
      ;;
    *.attestation.json)
      continue
      ;;
  esac
  install -m "$(stat -c %a "$source")" "$source" "$OUTPUT_DIR/$name"
done < <(jq -er '.artifacts[] | [.name, (.size|tostring), .sha256] | @tsv' "$descriptor")

for required in \
  install.sh \
  fased-bootstrap-linux-x64 \
  fased-lifecycled-linux-amd64 \
  fased-signerd-linux-amd64 \
  fased-hosted-release-v2.json \
  "fased-generation-linux-x64-v${VERSION}.tar.gz"; do
  test -s "$OUTPUT_DIR/$required"
done
install -m 0755 "$ROOT_DIR/scripts/privileged-release-evidence.mjs" \
  "$OUTPUT_DIR/fased-privileged-release-evidence.mjs"
install -m 0644 "$ROOT_DIR/config/lifecycle-acceptance.v2.json" \
  "$OUTPUT_DIR/fased-lifecycle-acceptance-v2.json"
node "$ROOT_DIR/scripts/lifecycle-release-compatibility.mjs" verify \
  --manifest "$OUTPUT_DIR/fased-lifecycle-release-compatibility-v1.json" \
  --version "$VERSION" --commit "$COMMIT" --tree "$TREE" >/dev/null

readarray -t lifecycle_times < <(node -e '
  const issued = new Date(process.argv[1]);
  const expires = new Date(issued.getTime() + 365 * 24 * 60 * 60 * 1000);
  process.stdout.write(`${issued.toISOString()}\n${expires.toISOString()}\n`);
' "$(git -C "$ROOT_DIR" show -s --format=%cI "$COMMIT")")
node "$ROOT_DIR/scripts/privileged-release-evidence.mjs" build \
  --assets "$OUTPUT_DIR" \
  --version "$VERSION" \
  --commit "$COMMIT" \
  --issued-at "${lifecycle_times[0]}" \
  --vex-decisions "$ROOT_DIR/release/vulnerability-decisions-v1.json" \
  --output-dir "$OUTPUT_DIR"

root_pin="$ROOT_DIR/release/lifecycle-trust/root-v1/fased-lifecycle-root-v1.sha256"
root_stage="$(mktemp -d "${TMPDIR:-/tmp}/fased-final-roots.XXXXXX")"
cleanup() { rm -rf -- "$root_stage"; }
trap cleanup EXIT INT TERM HUP
mapfile -t root_policies < <(find "$ROOT_DIR/release/lifecycle-trust" -mindepth 2 -maxdepth 2 \
  -type f -name 'fased-lifecycle-root-v*.json' | sort -V)
test "${#root_policies[@]}" -gt 0
for source_root in "${root_policies[@]}"; do
  root_name="$(basename "$source_root")"
  install -m 0644 "$source_root" "$root_stage/$root_name"
  install -m 0644 "$source_root" "$OUTPUT_DIR/$root_name"
done
node "$ROOT_DIR/scripts/verify-lifecycle-root-chain.mjs" --directory "$root_stage" --pin "$root_pin"
root_policy="${root_policies[${#root_policies[@]}-1]}"
node "$ROOT_DIR/scripts/build-lifecycle-trust-metadata.mjs" \
  --assets "$OUTPUT_DIR" \
  --root-policy "$root_policy" \
  --version "$VERSION" \
  --commit "$COMMIT" \
  --issued-at "${lifecycle_times[0]}" \
  --expires-at "${lifecycle_times[1]}" \
  --output "$OUTPUT_DIR/fased-lifecycle-trust-v1.json"

channel=stable
[[ "$VERSION" != *-* ]] || channel=beta
release_index_raw="$(mktemp "${TMPDIR:-/tmp}/fased-release-index.XXXXXX")"
node "$ROOT_DIR/scripts/build-lifecycle-release-index.mjs" \
  --assets "$OUTPUT_DIR" \
  --channel "$channel" \
  --version "$VERSION" \
  --commit "$COMMIT" \
  --tree "$TREE" \
  --release-sequence "$RELEASE_SEQUENCE" \
  --security-epoch "$SECURITY_EPOCH" \
  --issued-at "${lifecycle_times[0]}" \
  --expires-at "$(jq -er .signed.expiresAt "$root_policy")" \
  --output "$release_index_raw"
go -C "$ROOT_DIR/tools/fased-lifecycled" run ./cmd/fased-release-index \
  --input "$release_index_raw" \
  --output "$OUTPUT_DIR/fased-release-index-v1.json"
rm -f -- "$release_index_raw"

readarray -t root_head_times < <(node -e '
  const issued = new Date();
  const expires = new Date(issued.getTime() + 36 * 60 * 60 * 1000);
  process.stdout.write(`${issued.toISOString()}\n${expires.toISOString()}\n`);
')
node "$ROOT_DIR/scripts/build-lifecycle-root-head.mjs" \
  --root "$root_policy" \
  --index "$OUTPUT_DIR/fased-release-index-v1.json" \
  --witness-ref "refs/tags/v$VERSION" \
  --witness-commit "$COMMIT" \
  --issued-at "${root_head_times[0]}" \
  --expires-at "${root_head_times[1]}" \
  --output "$OUTPUT_DIR/fased-lifecycle-root-head-v1.json"

echo "$OUTPUT_DIR"
