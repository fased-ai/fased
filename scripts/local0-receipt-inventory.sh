#!/usr/bin/env bash

local0_acceptance_receipt_paths() {
  local receipt_root="$1"
  local receipt

  while IFS= read -r -d '' receipt; do
    jq -e '.role == "fased-lifecycle-acceptance-receipt"' "$receipt" >/dev/null 2>&1 || continue
    printf '%s\0' "$receipt"
  done < <(
    find "$receipt_root" -type f -name '*.json' ! -name '*.partial.json' -print0 | sort -z
  )
}
