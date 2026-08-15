#!/usr/bin/env bash

fased_discover_github_release_draft() {
  if [[ $# -ne 6 ]]; then
    echo "usage: fased_discover_github_release_draft <repository> <tag> <target> <title> <attempts> <delay-seconds>" >&2
    return 2
  fi

  local repository="$1"
  local tag="$2"
  local target="$3"
  local title="$4"
  local attempts="$5"
  local delay_seconds="$6"
  [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ &&
    -n "$tag" &&
    "$target" =~ ^[a-f0-9]{40}$ &&
    -n "$title" &&
    "$attempts" =~ ^[1-9][0-9]*$ &&
    "$delay_seconds" =~ ^[0-9]+$ ]] || {
    echo "Invalid GitHub release draft discovery arguments." >&2
    return 2
  }

  local attempt releases selection status
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    releases="$(gh api --paginate \
      "repos/$repository/releases?per_page=100" \
      --slurp)" || return
    selection="$(jq -cer \
      --arg tag "$tag" \
      --arg target "$target" \
      --arg title "$title" \
      '
        [.[][] | select(.draft == true and .tag_name == $tag)] as $tagged |
        if ($tagged | length) == 0 then
          {status:"NOT_FOUND"}
        elif ($tagged | length) == 1 and
             $tagged[0].target_commitish == $target and
             $tagged[0].name == $title and
             $tagged[0].prerelease == true and
             ($tagged[0].id | type) == "number" then
          {status:"FOUND",id:$tagged[0].id}
        else
          {status:"CONFLICT",count:($tagged | length)}
        end
      ' <<<"$releases")" || return
    status="$(jq -er .status <<<"$selection")" || return
    case "$status" in
      FOUND)
        jq -er .id <<<"$selection"
        return 0
        ;;
      CONFLICT)
        echo "GitHub release draft for $tag conflicts with expected identity." >&2
        return 1
        ;;
      NOT_FOUND)
        ;;
      *)
        echo "Unexpected GitHub release draft discovery status: $status" >&2
        return 1
        ;;
    esac
    if ((attempt < attempts && delay_seconds > 0)); then
      sleep "$delay_seconds"
    fi
  done
  return 3
}
