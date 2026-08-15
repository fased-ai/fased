#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:?profile is required}"
VERSION="${2:?version is required}"
BUILDER_COMMIT="${3:?builder commit is required}"
BUILDER_TREE="${4:?builder tree is required}"
CACHE_ROOT="${5:?absolute cache root is required}"
INSTALLATION_CLASS="${6:-public-stable}"

[[ "$PROFILE" == "protected-local" || "$PROFILE" == "hosting" ]]
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]
[[ "$BUILDER_COMMIT" =~ ^[a-f0-9]{40}$ && "$BUILDER_TREE" =~ ^[a-f0-9]{40}$ ]]
[[ "$CACHE_ROOT" == /* ]]
[[ "$INSTALLATION_CLASS" == "public-stable" || "$INSTALLATION_CLASS" == "canonical-managed" ]] || {
  echo "Unsupported predecessor installation class: $INSTALLATION_CLASS" >&2
  exit 1
}
test -z "$(git -C "$ROOT_DIR" status --porcelain=v1 --untracked-files=normal)"
FIXTURE_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
FIXTURE_TREE="$(git -C "$ROOT_DIR" rev-parse 'HEAD^{tree}')"
git -C "$ROOT_DIR" merge-base --is-ancestor "$BUILDER_COMMIT" "$FIXTURE_COMMIT"
unexpected_changes="$(
  git -C "$ROOT_DIR" diff --name-only "$BUILDER_COMMIT..$FIXTURE_COMMIT" | \
    grep -Ev '^(scripts/test-lifecycle-(local|hosting)-acceptance\.sh|scripts/docker/(protected-local|hosting)-systemd/lifecycle-acceptance\.sh|scripts/lifecycle-(d8-contract|version-neutral)\.test\.ts|scripts/lifecycle-configuration-preservation\.(mjs|test\.ts)|scripts/build-(public|canonical-managed)-predecessor-capsule\.(mjs|test\.ts)|scripts/prepare-branch-predecessor-capsule\.sh|scripts/(predecessor-capsule|lifecycle-installed-state-capsule|lifecycle-acceptance-contract|lifecycle-receipt-verifier)\.(mjs|test\.ts))$' || true
)"
[[ -z "$unexpected_changes" ]] || {
  echo "Predecessor capsule reuse rejected product changes:" >&2
  printf '%s\n' "$unexpected_changes" >&2
  exit 1
}

target="$CACHE_ROOT/$VERSION/$PROFILE/$INSTALLATION_CLASS/$BUILDER_COMMIT-$BUILDER_TREE/$FIXTURE_COMMIT-$FIXTURE_TREE"
lock="$CACHE_ROOT/$VERSION/$PROFILE/$INSTALLATION_CLASS/.${BUILDER_COMMIT}-${BUILDER_TREE}-${FIXTURE_COMMIT}-${FIXTURE_TREE}.lock"
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
  if [[ "$INSTALLATION_CLASS" == "canonical-managed" ]]; then
    [[ "$PROFILE" == "protected-local" ]] || {
      echo "No supported schema-one canonical Hosting predecessor is inventoried." >&2
      exit 1
    }
    gh release download "v$VERSION" \
      --repo fased-ai/fased \
      --dir "$source_dir" \
      --pattern fased-hosting-candidate.json \
      --pattern fased-hosting-candidate.json.attestation.json \
      --pattern fased-lifecycled-linux-amd64 \
      --pattern "fased-generation-linux-x64-v$VERSION.tar.gz" \
      --pattern 'fased-hosted-deps-linux-x64-*.tar.gz'
    GH_PROMPT_DISABLED=1 gh attestation verify \
      "$source_dir/fased-hosting-candidate.json" \
      --repo fased-ai/fased \
      --bundle "$source_dir/fased-hosting-candidate.json.attestation.json" \
      --deny-self-hosted-runners >/dev/null
    dependency_archive="$(find "$source_dir" -maxdepth 1 -type f -name 'fased-hosted-deps-linux-x64-*.tar.gz' -print -quit)"
    test -n "$dependency_archive"
    node "$ROOT_DIR/scripts/build-canonical-managed-predecessor-capsule.mjs" \
      --release-manifest "$source_dir/fased-hosted-release-v2.json" \
      --release-manifest-attestation "$source_dir/fased-hosted-release-v2.json.attestation.json" \
      --release-tree "$predecessor_tree" \
      --candidate-descriptor "$source_dir/fased-hosting-candidate.json" \
      --generation-archive "$source_dir/fased-generation-linux-x64-v$VERSION.tar.gz" \
      --dependency-archive "$dependency_archive" \
      --lifecycle-binary "$source_dir/fased-lifecycled-linux-amd64" \
      --compatibility-index "$ROOT_DIR/config/lifecycle-compatibility.v1.json" \
      --acceptance-contract "$ROOT_DIR/config/lifecycle-acceptance.v2.json" \
      --output "$output_dir" \
      --builder-commit "$BUILDER_COMMIT" \
      --builder-tree "$BUILDER_TREE" \
      --branch-proof 1 >/dev/null
  else
    node "$ROOT_DIR/scripts/build-public-predecessor-capsule.mjs" \
      --profile "$PROFILE" \
      --release-manifest "$source_dir/fased-hosted-release-v2.json" \
      --release-manifest-attestation "$source_dir/fased-hosted-release-v2.json.attestation.json" \
      --release-tree "$predecessor_tree" \
      --compatibility-index "$ROOT_DIR/config/lifecycle-compatibility.v1.json" \
      --acceptance-contract "$ROOT_DIR/config/lifecycle-acceptance.v2.json" \
      --output "$output_dir" \
      --builder-commit "$BUILDER_COMMIT" \
      --builder-tree "$BUILDER_TREE" \
      --branch-proof 1 >/dev/null
  fi
  mv "$output_dir" "$target"
  output_dir=""
fi

descriptor="$target/fased-predecessor-capsule.json"
proof="$target/fased-predecessor-branch-proof.json"
archive="$(jq -er .archive.name "$descriptor")"
node "$ROOT_DIR/scripts/lifecycle-installed-state-capsule.mjs" verify --descriptor "$descriptor" >/dev/null
jq -e --arg profile "$PROFILE" --arg version "$VERSION" --arg installationClass "$INSTALLATION_CLASS" \
  '.profile == $profile and .release.version == $version and
   .installationClass.kind == $installationClass' "$descriptor" >/dev/null
jq -e --arg profile "$PROFILE" --arg commit "$BUILDER_COMMIT" --arg tree "$BUILDER_TREE" \
  '.role == "fased-predecessor-capsule-branch-proof" and .publishable == false and
   .profile == $profile and .builder.commit == $commit and .builder.tree == $tree' "$proof" >/dev/null
test "$(jq -er .descriptor.sha256 "$proof")" = "sha256:$(sha256sum "$descriptor" | awk '{print $1}')"
test "$(jq -er .archive.sha256 "$proof")" = "sha256:$(sha256sum "$target/$archive" | awk '{print $1}')"
printf '%s\n' "$target"
