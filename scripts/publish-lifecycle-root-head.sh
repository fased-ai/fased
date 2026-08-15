#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 2 ]] || {
  echo "usage: publish-lifecycle-root-head.sh <metadata-directory> <channel-tag>" >&2
  exit 2
}
metadata_dir="$(realpath -e "$1")"
channel_tag="$2"
[[ -d "$metadata_dir" && "$channel_tag" =~ ^fased-channel-(stable|beta)-v1$ ]] || exit 2
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

head_name=fased-lifecycle-root-head-v1.json
attestation_name="$head_name.attestation.json"
index_name=fased-release-index-v1.json
head="$metadata_dir/$head_name"
attestation="$metadata_dir/$attestation_name"
index="$metadata_dir/$index_name"

download_asset() {
  local release_json="$1" name="$2" output="$3" asset_id
  asset_id="$(jq -er --arg name "$name" \
    '[.assets[] | select(.name == $name)] | if length == 1 then .[0].id else error("asset is not unique") end' \
    "$release_json")"
  gh api -H "Accept: application/octet-stream" \
    "repos/$GITHUB_REPOSITORY/releases/assets/$asset_id" >"$output"
  [[ -s "$output" ]]
}

optional_asset_id() {
  local release_json="$1" name="$2"
  jq -er --arg name "$name" \
    '[.assets[] | select(.name == $name)] | if length == 1 then .[0].id elif length == 0 then "" else error("asset is duplicated") end' \
    "$release_json"
}

verify_head_pair() {
  local candidate_head="$1" candidate_attestation="$2" candidate_index="$3" roots="$4"
  for file in "$candidate_head" "$candidate_attestation" "$candidate_index"; do
    [[ -f "$file" && ! -L "$file" && -s "$file" ]]
  done
  local root_version root_file channel release_version witness_ref witness_commit index_commit
  root_version="$(jq -er '.rootVersion | select(type == "number" and . >= 1 and floor == .)' "$candidate_head")"
  root_file="$roots/fased-lifecycle-root-v${root_version}.json"
  [[ -f "$root_file" && ! -L "$root_file" && -s "$root_file" ]]
  root_info="$(node scripts/verify-lifecycle-root-chain.mjs \
    --directory "$roots" \
    --pin release/lifecycle-trust/root-v1/fased-lifecycle-root-v1.sha256)"
  test "$(jq -er .version <<<"$root_info")" = "$root_version"
  test "$(jq -er .digest <<<"$root_info")" = "$(jq -er .rootSHA256 "$candidate_head")"
  test "$(sha256sum "$candidate_index" | awk '{print $1}')" = "$(jq -er .releaseIndexSHA256 "$candidate_head")"
  channel="$(jq -er '.channel | select(. == "stable" or . == "beta")' "$candidate_head")"
  release_version="$(jq -er .releaseVersion "$candidate_head")"
  index_commit="$(jq -er .indexCommit "$candidate_head")"
  test "$channel_tag" = "fased-channel-$channel-v1"
  test "$release_version" = "$(jq -er .version "$candidate_index")"
  test "$channel" = "$(jq -er .channel "$candidate_index")"
  test "$(jq -er .releaseSequence "$candidate_head")" = "$(jq -er .releaseSequence "$candidate_index")"
  test "$(jq -er .securityEpoch "$candidate_head")" = "$(jq -er .securityEpoch "$candidate_index")"
  test "$index_commit" = "$(jq -er .commit "$candidate_index")"
  witness_ref="$(jq -er .witnessRef "$candidate_head")"
  witness_commit="$(jq -er .witnessCommit "$candidate_head")"
  if [[ "$witness_ref" == "refs/tags/v$release_version" ]]; then
    test "$witness_commit" = "$index_commit"
  else
    test "$witness_ref" = refs/heads/main
  fi
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const issued = Date.parse(value.issuedAt);
    const expires = Date.parse(value.expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued ||
        expires - issued > 48 * 60 * 60 * 1000 || Date.now() < issued || Date.now() >= expires) process.exit(1);
  ' "$candidate_head"
  GH_PROMPT_DISABLED=1 gh attestation verify "$candidate_head" \
    --repo "$GITHUB_REPOSITORY" \
    --bundle "$candidate_attestation" \
    --signer-workflow fased-ai/fased/.github/workflows/hosted-runtime-release.yml \
    --source-ref "$witness_ref" \
    --deny-self-hosted-runners >/dev/null
}

verify_head_pair "$head" "$attestation" "$index" "$metadata_dir"
workspace="$(mktemp -d)"
trap 'rm -rf "$workspace"' EXIT
release_json="$workspace/channel.json"
gh api "repos/$GITHUB_REPOSITORY/releases/tags/$channel_tag" >"$release_json"

staged_head_name="$head_name.next"
staged_attestation_name="$attestation_name.next"
current_head_id="$(optional_asset_id "$release_json" "$head_name")"
current_attestation_id="$(optional_asset_id "$release_json" "$attestation_name")"
staged_head_id="$(optional_asset_id "$release_json" "$staged_head_name")"
staged_attestation_id="$(optional_asset_id "$release_json" "$staged_attestation_name")"
if [[ -n "$staged_head_id" || -n "$staged_attestation_id" ]]; then
  if [[ -n "$staged_head_id" ]]; then
    download_asset "$release_json" "$staged_head_name" "$workspace/staged-head"
    cmp -s "$head" "$workspace/staged-head"
  fi
  if [[ -n "$staged_attestation_id" ]]; then
    download_asset "$release_json" "$staged_attestation_name" "$workspace/staged-attestation"
    cmp -s "$attestation" "$workspace/staged-attestation"
  fi
  action=RECOVER
else
  action=UPDATE
  if [[ -n "$current_head_id" || -n "$current_attestation_id" ]]; then
    if [[ -n "$current_head_id" && -n "$current_attestation_id" ]]; then
      download_asset "$release_json" "$head_name" "$workspace/current-head"
      download_asset "$release_json" "$attestation_name" "$workspace/current-attestation"
      download_asset "$release_json" "$index_name" "$workspace/current-index"
      if test "$(jq -er .releaseIndexSHA256 "$workspace/current-head")" = \
        "$(sha256sum "$workspace/current-index" | awk '{print $1}')"; then
        mkdir -p "$workspace/current-roots"
        for root_file in "$metadata_dir"/fased-lifecycle-root-v*.json; do
          cp "$root_file" "$workspace/current-roots/$(basename "$root_file")"
        done
        verify_head_pair "$workspace/current-head" "$workspace/current-attestation" \
          "$workspace/current-index" "$workspace/current-roots"
        current_expires="$(jq -er .expiresAt "$workspace/current-head")"
        candidate_expires="$(jq -er .expiresAt "$head")"
        if [[ "$current_expires" > "$candidate_expires" || "$current_expires" == "$candidate_expires" ]]; then
          action=ALREADY_CURRENT
        fi
      fi
    else
      action=RECOVER
    fi
  fi
fi

if [[ "$action" != ALREADY_CURRENT ]]; then
  stage="$workspace/stage"
  mkdir -p "$stage"
  install -m 0644 "$attestation" "$stage/$staged_attestation_name"
  install -m 0644 "$head" "$stage/$staged_head_name"
  if [[ -z "$staged_attestation_id" ]]; then
    gh release upload "$channel_tag" "$stage/$staged_attestation_name" --repo "$GITHUB_REPOSITORY"
  fi
  if [[ -z "$staged_head_id" ]]; then
    gh release upload "$channel_tag" "$stage/$staged_head_name" --repo "$GITHUB_REPOSITORY"
  fi
  gh api "repos/$GITHUB_REPOSITORY/releases/tags/$channel_tag" >"$release_json"
  download_asset "$release_json" "$staged_attestation_name" "$workspace/readback-attestation"
  download_asset "$release_json" "$staged_head_name" "$workspace/readback-head"
  cmp -s "$attestation" "$workspace/readback-attestation"
  cmp -s "$head" "$workspace/readback-head"

  current_attestation_id="$(optional_asset_id "$release_json" "$attestation_name")"
  staged_attestation_id="$(optional_asset_id "$release_json" "$staged_attestation_name")"
  if [[ -n "$current_attestation_id" ]]; then
    gh api --method DELETE "repos/$GITHUB_REPOSITORY/releases/assets/$current_attestation_id" >/dev/null
  fi
  gh api --method PATCH "repos/$GITHUB_REPOSITORY/releases/assets/$staged_attestation_id" \
    -f name="$attestation_name" >/dev/null

  gh api "repos/$GITHUB_REPOSITORY/releases/tags/$channel_tag" >"$release_json"
  current_head_id="$(optional_asset_id "$release_json" "$head_name")"
  staged_head_id="$(optional_asset_id "$release_json" "$staged_head_name")"
  if [[ -n "$current_head_id" ]]; then
    gh api --method DELETE "repos/$GITHUB_REPOSITORY/releases/assets/$current_head_id" >/dev/null
  fi
  gh api --method PATCH "repos/$GITHUB_REPOSITORY/releases/assets/$staged_head_id" \
    -f name="$head_name" >/dev/null
fi

gh api "repos/$GITHUB_REPOSITORY/releases/tags/$channel_tag" >"$release_json"
download_asset "$release_json" "$head_name" "$workspace/final-head"
download_asset "$release_json" "$attestation_name" "$workspace/final-attestation"
download_asset "$release_json" "$index_name" "$workspace/final-index"
verify_head_pair "$workspace/final-head" "$workspace/final-attestation" "$workspace/final-index" "$metadata_dir"
printf 'Root head %s: %s\n' "$channel_tag" "$action"
