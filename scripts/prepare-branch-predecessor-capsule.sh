#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:?profile is required}"
VERSION="${2:?version is required}"
BUILDER_COMMIT="${3:?builder commit is required}"
BUILDER_TREE="${4:?builder tree is required}"
CACHE_ROOT="${5:?absolute cache root is required}"

[[ "$PROFILE" == "protected-local" || "$PROFILE" == "hosting" ]]
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]
[[ "$BUILDER_COMMIT" =~ ^[a-f0-9]{40}$ && "$BUILDER_TREE" =~ ^[a-f0-9]{40}$ ]]
[[ "$CACHE_ROOT" == /* ]]
test -z "$(git -C "$ROOT_DIR" status --porcelain=v1 --untracked-files=normal)"
FIXTURE_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
FIXTURE_TREE="$(git -C "$ROOT_DIR" rev-parse 'HEAD^{tree}')"
git -C "$ROOT_DIR" merge-base --is-ancestor "$BUILDER_COMMIT" "$FIXTURE_COMMIT"
unexpected_changes="$(
  git -C "$ROOT_DIR" diff --name-only "$BUILDER_COMMIT..$FIXTURE_COMMIT" | \
    grep -Ev '^(scripts/test-lifecycle-local-acceptance\.sh|scripts/docker/protected-local-systemd/lifecycle-acceptance\.sh|scripts/lifecycle-version-neutral\.test\.ts|scripts/build-public-predecessor-capsule\.mjs|scripts/build-public-predecessor-capsule\.test\.ts|scripts/prepare-branch-predecessor-capsule\.sh)$' || true
)"
[[ -z "$unexpected_changes" ]] || {
  echo "Predecessor capsule reuse rejected product changes:" >&2
  printf '%s\n' "$unexpected_changes" >&2
  exit 1
}

target="$CACHE_ROOT/$VERSION/$PROFILE/$BUILDER_COMMIT-$BUILDER_TREE/$FIXTURE_COMMIT-$FIXTURE_TREE"
lock="$CACHE_ROOT/$VERSION/$PROFILE/.${BUILDER_COMMIT}-${BUILDER_TREE}-${FIXTURE_COMMIT}-${FIXTURE_TREE}.lock"
mkdir -p "$(dirname "$target")"
exec {lock_fd}>"$lock"
flock "$lock_fd"
if [[ ! -f "$target/fased-predecessor-capsule.json" ]]; then
  source_dir="$(mktemp -d "${TMPDIR:-/tmp}/fased-predecessor-source.XXXXXX")"
  output_dir="$(mktemp -d "${TMPDIR:-/tmp}/fased-predecessor-output.XXXXXX")"
  cleanup() {
    [[ -z "$source_dir" ]] || rm -rf -- "$source_dir"
    [[ -z "$output_dir" ]] || rm -rf -- "$output_dir"
  }
  trap cleanup EXIT INT TERM HUP
  gh release download "v$VERSION" \
    --repo fased-ai/fased \
    --dir "$source_dir" \
    --pattern fased-hosted-release-v2.json \
    --pattern fased-hosted-release-v2.json.attestation.json
  GH_PROMPT_DISABLED=1 gh attestation verify \
    "$source_dir/fased-hosted-release-v2.json" \
    --repo fased-ai/fased \
    --bundle "$source_dir/fased-hosted-release-v2.json.attestation.json" \
    --deny-self-hosted-runners >/dev/null
  predecessor_commit="$(jq -er .release.commit "$source_dir/fased-hosted-release-v2.json")"
  test "$predecessor_commit" = "$(git -C "$ROOT_DIR" rev-parse "v$VERSION^{commit}")"
  predecessor_tree="$(git -C "$ROOT_DIR" rev-parse "${predecessor_commit}^{tree}")"
  node "$ROOT_DIR/scripts/build-public-predecessor-capsule.mjs" \
    --profile "$PROFILE" \
    --release-manifest "$source_dir/fased-hosted-release-v2.json" \
    --release-tree "$predecessor_tree" \
    --compatibility-index "$ROOT_DIR/config/lifecycle-compatibility.v1.json" \
    --acceptance-contract "$ROOT_DIR/config/lifecycle-acceptance.v2.json" \
    --output "$output_dir" \
    --builder-commit "$BUILDER_COMMIT" \
    --builder-tree "$BUILDER_TREE" \
    --branch-proof 1 >/dev/null
  mv "$output_dir" "$target"
  output_dir=""
fi

descriptor="$target/fased-predecessor-capsule.json"
proof="$target/fased-predecessor-branch-proof.json"
archive="$(jq -er .archive.name "$descriptor")"
node "$ROOT_DIR/scripts/lifecycle-installed-state-capsule.mjs" verify --descriptor "$descriptor" >/dev/null
jq -e --arg profile "$PROFILE" --arg version "$VERSION" --arg commit "$BUILDER_COMMIT" --arg tree "$BUILDER_TREE" \
  '.profile == $profile and .release.version == $version' "$descriptor" >/dev/null
jq -e --arg profile "$PROFILE" --arg commit "$BUILDER_COMMIT" --arg tree "$BUILDER_TREE" \
  '.role == "fased-predecessor-capsule-branch-proof" and .publishable == false and
   .profile == $profile and .builder.commit == $commit and .builder.tree == $tree' "$proof" >/dev/null
test "$(jq -er .descriptor.sha256 "$proof")" = "sha256:$(sha256sum "$descriptor" | awk '{print $1}')"
test "$(jq -er .archive.sha256 "$proof")" = "sha256:$(sha256sum "$target/$archive" | awk '{print $1}')"
printf '%s\n' "$target"
