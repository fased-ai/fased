#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lifecycle-fixture-only-paths.sh"
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
unexpected_changes="$(lifecycle_unexpected_fixture_changes \
  "$ROOT_DIR" "$BUILDER_COMMIT" "$FIXTURE_COMMIT")"
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

reuse_cached_capsule() {
  local descriptor proof archive source_root source_descriptor source_proof source_archive
  local descriptor_digest archive_digest compatibility_digest acceptance_digest
  compatibility_digest="sha256:$(sha256sum "$ROOT_DIR/config/lifecycle-compatibility.v1.json" | awk '{print $1}')"
  acceptance_digest="sha256:$(sha256sum "$ROOT_DIR/config/lifecycle-acceptance.v2.json" | awk '{print $1}')"
  while IFS= read -r -d '' source_descriptor; do
    source_root="$(dirname "$source_descriptor")"
    [[ "$source_root" != "$target" && -f "$source_descriptor" && ! -L "$source_descriptor" ]] || continue
    source_proof="$source_root/fased-predecessor-branch-proof.json"
    [[ -f "$source_proof" && ! -L "$source_proof" ]] || continue
    archive="$(jq -er .archive.name "$source_descriptor" 2>/dev/null)" || continue
    source_archive="$source_root/$archive"
    [[ -f "$source_archive" && ! -L "$source_archive" ]] || continue
    node "$ROOT_DIR/scripts/lifecycle-installed-state-capsule.mjs" verify \
      --descriptor "$source_descriptor" >/dev/null 2>&1 || continue
    descriptor_digest="sha256:$(sha256sum "$source_descriptor" | awk '{print $1}')"
    archive_digest="sha256:$(sha256sum "$source_archive" | awk '{print $1}')"
    jq -e --arg profile "$PROFILE" --arg version "$VERSION" \
      --arg installationClass "$INSTALLATION_CLASS" \
      --arg compatibility "$compatibility_digest" --arg acceptance "$acceptance_digest" \
      '.profile == $profile and .release.version == $version and
       .installationClass.kind == $installationClass and
       .compatibilityDigest == $compatibility and .expectedReceiptDigest == $acceptance' \
      "$source_descriptor" >/dev/null || continue
    if [[ "$PROFILE" == "hosting" && "$INSTALLATION_CLASS" == "public-stable" ]]; then
      jq -e '
        ([.entries[].path] | index("etc/fased/hosting-prerequisites")) != null and
        ([.entries[].path] | index("etc/fased/signerd-webauthn.env")) != null and
        ([.entries[].path] | index("etc/ssh/sshd_config.d/01-fased-hardening.conf")) != null and
        ([.entries[].path] | index("etc/fail2ban/jail.d/fased-sshd.local")) != null
      ' "$source_descriptor" >/dev/null || continue
    fi
    [[ "$(jq -er .archive.sha256 "$source_descriptor")" == "$archive_digest" ]] || continue
    jq -e --arg profile "$PROFILE" --arg descriptor "$descriptor_digest" --arg archive "$archive_digest" \
      '.role == "fased-predecessor-capsule-branch-proof" and .publishable == false and
       .profile == $profile and .descriptor.sha256 == $descriptor and .archive.sha256 == $archive' \
      "$source_proof" >/dev/null || continue

    output_dir="$(mktemp -d "${TMPDIR:-/tmp}/fased-predecessor-output.XXXXXX")"
    cp -- "$source_descriptor" "$source_archive" "$output_dir/"
    jq --arg commit "$BUILDER_COMMIT" --arg tree "$BUILDER_TREE" \
      '.builder = {commit:$commit,tree:$tree}' "$source_proof" \
      >"$output_dir/fased-predecessor-branch-proof.json"
    chmod 0600 "$output_dir/fased-predecessor-branch-proof.json"
    mv "$output_dir" "$target"
    output_dir=""
    printf 'Reused verified immutable predecessor capsule: %s\n' "$source_root" >&2
    return 0
  done < <(find "$CACHE_ROOT/$VERSION/$PROFILE/$INSTALLATION_CLASS" -mindepth 3 -maxdepth 3 \
    -type f -name fased-predecessor-capsule.json -print0 2>/dev/null | sort -z)
  return 1
}

if [[ ! -f "$target/fased-predecessor-capsule.json" ]]; then
  if reuse_cached_capsule; then
    :
  else
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
