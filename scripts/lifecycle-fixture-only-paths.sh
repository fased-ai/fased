#!/usr/bin/env bash

readonly FASED_LIFECYCLE_FIXTURE_ONLY_PATH_RE='^(\.github/workflows/(candidate-p1-replay|hosted-runtime-release)\.yml|docs/maintainers/codex-skills/fased-release-manager/(SKILL\.md|references/(lifecycle|release)\.md)|scripts/lifecycle-fixture-only-paths\.sh|scripts/local0-receipt-inventory\.sh|scripts/run-lifecycle-local0\.sh|scripts/test-lifecycle-(local|hosting)-acceptance\.sh|scripts/docker/(protected-local|hosting)-systemd/(lifecycle-acceptance\.sh|Containerfile\.(ubuntu|rocky))|scripts/(hosted-installer-artifact-layout|ci-workflow-contract|lifecycle-d8-contract|lifecycle-version-neutral|npm-free-managed-lifecycle-contract)\.test\.ts|scripts/lifecycle-configuration-preservation\.(mjs|test\.ts)|scripts/prepare-candidate-fixture-trust\.sh|scripts/build-(public|canonical-managed)-predecessor-capsule\.(mjs|test\.ts)|scripts/prepare-branch-predecessor-capsule\.sh|scripts/(predecessor-capsule|lifecycle-installed-state-capsule|lifecycle-acceptance-contract|lifecycle-receipt-verifier)\.(mjs|test\.ts))$'

lifecycle_unexpected_fixture_changes() {
  local root_dir="${1:?repository root is required}"
  local product_commit="${2:?product commit is required}"
  local fixture_commit="${3:?fixture commit is required}"
  local changed_paths

  changed_paths="$(git -C "$root_dir" diff --name-only "$product_commit..$fixture_commit")" ||
    return 1
  if [[ -n "$changed_paths" ]]; then
    printf '%s\n' "$changed_paths" | grep -Ev "$FASED_LIFECYCLE_FIXTURE_ONLY_PATH_RE" || true
  fi
}
