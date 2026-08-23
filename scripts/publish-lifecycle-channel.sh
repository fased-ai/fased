#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/github-release-draft.sh
source "$script_dir/lib/github-release-draft.sh"

usage() {
  echo "usage: publish-lifecycle-channel.sh <candidate-directory> <source-commit> <attestation-source-ref> <attestation-source-digest>" >&2
  exit 2
}

[[ $# -eq 4 ]] || usage
candidate_dir="$(realpath -e "$1")"
source_commit="$2"
attestation_source_ref="$3"
attestation_source_digest="$4"
[[ -d "$candidate_dir" && "$source_commit" =~ ^[a-f0-9]{40}$ &&
  ( "$attestation_source_ref" == refs/heads/main ||
    "$attestation_source_ref" =~ ^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ) &&
  "$attestation_source_digest" =~ ^[a-f0-9]{40}$ ]] || usage
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

index_name=fased-release-index-v1.json
attestation_name=fased-release-index-v1.json.attestation.json
root_head_name=fased-lifecycle-root-head-v1.json
root_head_attestation_name="$root_head_name.attestation.json"
mapfile -t root_names < <(find "$candidate_dir" -maxdepth 1 -type f \
  -name 'fased-lifecycle-root-v*.json' -printf '%f\n' | sort -V)
[[ "${root_names[0]:-}" == fased-lifecycle-root-v1.json ]] || {
  echo "Candidate lifecycle root chain does not start at v1." >&2
  exit 1
}
root_name="${root_names[0]}"
root="$candidate_dir/$root_name"
index="$candidate_dir/$index_name"
attestation="$candidate_dir/$attestation_name"
root_head="$candidate_dir/$root_head_name"
root_head_attestation="$candidate_dir/$root_head_attestation_name"
roots=()
for name in "${root_names[@]}"; do
  roots+=("$candidate_dir/$name")
done
for file in "${roots[@]}" "$index" "$attestation" "$root_head" "$root_head_attestation"; do
  [[ -f "$file" && ! -L "$file" && -s "$file" ]] || {
    echo "Channel source asset is missing or unsafe: $file" >&2
    exit 1
  }
done
node scripts/verify-lifecycle-root-chain.mjs \
  --directory "$candidate_dir" \
  --pin release/lifecycle-trust/root-v1/fased-lifecycle-root-v1.sha256 >/dev/null

version="$(jq -er '.version | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$"))' "$index")"
channel="$(jq -er '.channel | select(. == "stable" or . == "beta")' "$index")"
test "$(jq -er .commit "$index")" = "$source_commit"
if [[ "$version" == *-* ]]; then
  test "$channel" = beta
else
  test "$channel" = stable
fi
node scripts/lifecycle-channel-advance.mjs \
  --candidate "$index" \
  --version "$version" \
  --commit "$source_commit" >/dev/null

expected_root_digest="$(<release/lifecycle-trust/root-v1/fased-lifecycle-root-v1.sha256)"
test "$(sha256sum "$root" | awk '{print $1}')" = "$expected_root_digest"
test "$(sha256sum release/lifecycle-trust/root-v1/fased-lifecycle-root-v1.json | awk '{print $1}')" = \
  "$expected_root_digest"
cmp -s "$root" release/lifecycle-trust/root-v1/fased-lifecycle-root-v1.json
GH_PROMPT_DISABLED=1 gh attestation verify "$index" \
  --repo "$GITHUB_REPOSITORY" \
  --bundle "$attestation" \
  --signer-workflow fased-ai/fased/.github/workflows/hosted-runtime-release.yml \
  --source-ref "$attestation_source_ref" \
  --source-digest "$attestation_source_digest" \
  --deny-self-hosted-runners >/dev/null

verify_historical_index_attestation() {
  local historical_index="$1" historical_attestation="$2" identity
  identity="$(node scripts/release-attestation-identity.mjs resolve \
    --bundle "$historical_attestation" \
    --repository "$GITHUB_REPOSITORY")"
  GH_PROMPT_DISABLED=1 gh attestation verify "$historical_index" \
    --repo "$GITHUB_REPOSITORY" \
    --bundle "$historical_attestation" \
    --signer-workflow fased-ai/fased/.github/workflows/hosted-runtime-release.yml \
    --source-ref "$(jq -er .sourceRef <<<"$identity")" \
    --source-digest "$(jq -er .sourceDigest <<<"$identity")" \
    --deny-self-hosted-runners >/dev/null
}

workspace="$(mktemp -d)"
trap 'rm -rf "$workspace"' EXIT

download_asset() {
  local release_json="$1" name="$2" output="$3" asset_id
  asset_id="$(jq -er --arg name "$name" \
    '[.assets[] | select(.name == $name)] |
     if length == 1 then .[0].id else error("required release asset is not unique") end' \
    "$release_json")"
  gh api \
    -H "Accept: application/octet-stream" \
    "repos/$GITHUB_REPOSITORY/releases/assets/$asset_id" >"$output"
  [[ -s "$output" ]]
}

optional_asset_id() {
  local release_json="$1" name="$2"
  jq -er --arg name "$name" \
    '[.assets[] | select(.name == $name)] |
     if length == 1 then .[0].id elif length == 0 then "" else error("release asset is duplicated") end' \
    "$release_json"
}

verify_release_assets() {
  local release_json="$1" directory="$2"
  mkdir -p "$directory"
  for name in "${root_names[@]}"; do
    download_asset "$release_json" "$name" "$directory/$name"
    cmp -s "$candidate_dir/$name" "$directory/$name"
  done
  download_asset "$release_json" "$index_name" "$directory/$index_name"
  download_asset "$release_json" "$attestation_name" "$directory/$attestation_name"
  cmp -s "$index" "$directory/$index_name"
  cmp -s "$attestation" "$directory/$attestation_name"
}

verify_release_head_assets() {
  local release_json="$1" directory="$2"
  download_asset "$release_json" "$root_head_name" "$directory/$root_head_name"
  download_asset \
    "$release_json" \
    "$root_head_attestation_name" \
    "$directory/$root_head_attestation_name"
  cmp -s "$root_head" "$directory/$root_head_name"
  cmp -s "$root_head_attestation" "$directory/$root_head_attestation_name"
}

# A channel is allowed to select a candidate only after the exact immutable
# release is public and exposes byte-identical, already-attested metadata.
exact_tag="v$version"
exact_release="$workspace/exact-release.json"
gh api "repos/$GITHUB_REPOSITORY/releases/tags/$exact_tag" >"$exact_release"
jq -e \
  --arg tag "$exact_tag" \
  '.tag_name == $tag and .draft == false' \
  "$exact_release" >/dev/null
verify_release_assets "$exact_release" "$workspace/exact"
verify_release_head_assets "$exact_release" "$workspace/exact"

channel_tag="fased-channel-$channel-v1"
channel_title="Fased signed $channel channel v1"
channel_release="$workspace/channel-release.json"
if ! gh api "repos/$GITHUB_REPOSITORY/releases/tags/$channel_tag" >"$channel_release" 2>/dev/null; then
  draft_id=""
  draft_created_here=false
  cleanup_draft() {
    if [[ "$draft_created_here" == true && -z "$draft_id" ]]; then
      draft_id="$(fased_discover_github_release_draft \
        "$GITHUB_REPOSITORY" "$channel_tag" "$source_commit" "$channel_title" 5 1 || true)"
    fi
    if [[ "$draft_created_here" == true && -n "$draft_id" ]]; then
      gh api --method DELETE \
        "repos/$GITHUB_REPOSITORY/releases/$draft_id" >/dev/null 2>&1 || true
    fi
  }
  trap 'cleanup_draft; rm -rf "$workspace"' EXIT
  if draft_id="$(fased_discover_github_release_draft \
    "$GITHUB_REPOSITORY" "$channel_tag" "$source_commit" "$channel_title" 10 1)"; then
    action=RECOVERED_DRAFT
  else
    discovery_status=$?
    test "$discovery_status" -eq 3
    draft_created_here=true
    gh release create "$channel_tag" "${roots[@]}" "$attestation" "$index" "$root_head_attestation" "$root_head" \
      --repo "$GITHUB_REPOSITORY" \
      --target "$source_commit" \
      --title "$channel_title" \
      --notes "Signed replay-protected selection metadata. Exact release bytes remain under $exact_tag." \
      --draft \
      --prerelease
    draft_id="$(fased_discover_github_release_draft \
      "$GITHUB_REPOSITORY" "$channel_tag" "$source_commit" "$channel_title" 30 1)"
    action=INITIALIZED
  fi
  gh api "repos/$GITHUB_REPOSITORY/releases/$draft_id" >"$channel_release"
  jq -e \
    --arg tag "$channel_tag" \
    --arg target "$source_commit" \
    --arg title "$channel_title" \
    '.tag_name == $tag and .target_commitish == $target and .name == $title and
     .draft == true and .prerelease == true' \
    "$channel_release" >/dev/null
  expected_draft_assets="$(printf '%s\n' \
    "${root_names[@]}" "$index_name" "$attestation_name" \
    "$root_head_name" "$root_head_attestation_name" | \
    jq -Rsc 'split("\n") | map(select(length > 0)) | sort')"
  test "$(jq -c '[.assets[].name] | sort' "$channel_release")" = "$expected_draft_assets"
  test "$(jq '[.assets[].name] | length' "$channel_release")" -eq \
    "$(jq 'length' <<<"$expected_draft_assets")"
  verify_release_assets "$channel_release" "$workspace/channel-draft"
  verify_release_head_assets "$channel_release" "$workspace/channel-draft"
  gh api --method PATCH \
    "repos/$GITHUB_REPOSITORY/releases/$draft_id" \
    -F draft=false \
    -F prerelease=true \
    -f make_latest=false >/dev/null
  draft_id=""
  draft_created_here=false
  trap 'rm -rf "$workspace"' EXIT
else
  jq -e \
    --arg tag "$channel_tag" \
    '.tag_name == $tag and .draft == false and .prerelease == true' \
    "$channel_release" >/dev/null
  staged_index_name="$index_name.next"
  staged_attestation_name="$attestation_name.next"
  allowed_assets="$(printf '%s\n' "${root_names[@]}" "$index_name" "$attestation_name" \
    "$staged_index_name" "$staged_attestation_name" "$root_head_name" "$root_head_attestation_name" \
    "$root_head_name.next" "$root_head_attestation_name.next" | jq -Rsc 'split("\n") | map(select(length > 0))')"
  jq -e --argjson allowed "$allowed_assets" \
    'all(.assets[].name; . as $name | $allowed | index($name)) and
     ([.assets[].name] | group_by(.) | all(length == 1))' \
    "$channel_release" >/dev/null
  mkdir -p "$workspace/channel-current"
  for name in "${root_names[@]}"; do
    root_id="$(optional_asset_id "$channel_release" "$name")"
    if [[ -z "$root_id" ]]; then
      gh release upload "$channel_tag" "$candidate_dir/$name" --repo "$GITHUB_REPOSITORY"
      gh api "repos/$GITHUB_REPOSITORY/releases/tags/$channel_tag" >"$channel_release"
    fi
    download_asset "$channel_release" "$name" "$workspace/channel-current/$name"
    cmp -s "$candidate_dir/$name" "$workspace/channel-current/$name"
  done

  current_index="$workspace/channel-current/$index_name"
  current_attestation="$workspace/channel-current/$attestation_name"
  staged_index="$workspace/channel-current/$staged_index_name"
  staged_attestation="$workspace/channel-current/$staged_attestation_name"
  current_index_id="$(optional_asset_id "$channel_release" "$index_name")"
  current_attestation_id="$(optional_asset_id "$channel_release" "$attestation_name")"
  staged_index_id="$(optional_asset_id "$channel_release" "$staged_index_name")"
  staged_attestation_id="$(optional_asset_id "$channel_release" "$staged_attestation_name")"
  if [[ -n "$current_index_id" ]]; then
    download_asset "$channel_release" "$index_name" "$current_index"
  fi
  if [[ -n "$current_attestation_id" ]]; then
    download_asset "$channel_release" "$attestation_name" "$current_attestation"
  fi
  if [[ -n "$staged_index_id" ]]; then
    download_asset "$channel_release" "$staged_index_name" "$staged_index"
    cmp -s "$index" "$staged_index"
  fi
  if [[ -n "$staged_attestation_id" ]]; then
    download_asset "$channel_release" "$staged_attestation_name" "$staged_attestation"
    cmp -s "$attestation" "$staged_attestation"
  fi

  if [[ -z "$staged_index_id" && -z "$staged_attestation_id" ]]; then
    [[ -n "$current_index_id" && -n "$current_attestation_id" ]] || {
      echo "Channel has an incomplete transaction without staged candidate assets" >&2
      exit 1
    }
    if cmp -s "$index" "$current_index"; then
      verify_historical_index_attestation "$current_index" "$current_attestation"
      action=ALREADY_CURRENT
    else
      verify_historical_index_attestation "$current_index" "$current_attestation"
      action="$(node scripts/lifecycle-channel-advance.mjs \
        --candidate "$index" \
        --current "$current_index" \
        --version "$version" \
        --commit "$source_commit")"
    fi
  else
    action=RECOVER
  fi

  if [[ "$action" != ALREADY_CURRENT ]]; then
    stage_dir="$workspace/channel-stage"
    mkdir -p "$stage_dir"
    install -m 0644 "$index" "$stage_dir/$staged_index_name"
    install -m 0644 "$attestation" "$stage_dir/$staged_attestation_name"
    if [[ -z "$staged_attestation_id" ]]; then
      gh release upload "$channel_tag" "$stage_dir/$staged_attestation_name" \
        --repo "$GITHUB_REPOSITORY"
    fi
    if [[ -z "$staged_index_id" ]]; then
      gh release upload "$channel_tag" "$stage_dir/$staged_index_name" \
        --repo "$GITHUB_REPOSITORY"
    fi
    gh api "repos/$GITHUB_REPOSITORY/releases/tags/$channel_tag" >"$channel_release"
    download_asset "$channel_release" "$staged_attestation_name" "$staged_attestation"
    download_asset "$channel_release" "$staged_index_name" "$staged_index"
    cmp -s "$attestation" "$staged_attestation"
    cmp -s "$index" "$staged_index"

    # Promote the attestation and then the index by renaming verified staged
    # assets. The staged names are a durable progress record for safe retries.
    current_attestation_id="$(optional_asset_id "$channel_release" "$attestation_name")"
    staged_attestation_id="$(optional_asset_id "$channel_release" "$staged_attestation_name")"
    if [[ -n "$current_attestation_id" ]]; then
      gh api --method DELETE \
        "repos/$GITHUB_REPOSITORY/releases/assets/$current_attestation_id" >/dev/null
    fi
    gh api --method PATCH \
      "repos/$GITHUB_REPOSITORY/releases/assets/$staged_attestation_id" \
      -f name="$attestation_name" >/dev/null

    gh api "repos/$GITHUB_REPOSITORY/releases/tags/$channel_tag" >"$channel_release"
    current_index_id="$(optional_asset_id "$channel_release" "$index_name")"
    staged_index_id="$(optional_asset_id "$channel_release" "$staged_index_name")"
    if [[ -n "$current_index_id" ]]; then
      gh api --method DELETE \
        "repos/$GITHUB_REPOSITORY/releases/assets/$current_index_id" >/dev/null
    fi
    gh api --method PATCH \
      "repos/$GITHUB_REPOSITORY/releases/assets/$staged_index_id" \
      -f name="$index_name" >/dev/null
  fi
fi

bash scripts/publish-lifecycle-root-head.sh "$candidate_dir" "$channel_tag"

gh api "repos/$GITHUB_REPOSITORY/releases/tags/$channel_tag" >"$channel_release"
final_assets="$(jq -c '[.assets[].name] | sort' "$channel_release")"
expected_assets="$(printf '%s\n' "${root_names[@]}" "$index_name" "$attestation_name" "$root_head_name" "$root_head_attestation_name" | \
  jq -Rsc 'split("\n") | map(select(length > 0)) | sort')"
test "$final_assets" = "$expected_assets"
verify_release_assets "$channel_release" "$workspace/channel-readback"
printf 'Channel %s: %s -> %s\n' "$channel" "${action:-INITIALIZED}" "$version"
