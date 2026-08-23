#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

fail() {
  printf 'lifecycle reconciliation contract failed: %s\n' "$1" >&2
  exit 1
}

require_text() {
  local path="$1"
  local text="$2"
  grep -Fq -- "$text" "$repo_root/$path" || fail "$path is missing: $text"
}

reject_text() {
  local path="$1"
  local text="$2"
  if grep -Fq -- "$text" "$repo_root/$path"; then
    fail "$path retains forbidden text: $text"
  fi
}

# DEV-003: an explicit release is fully rooted in that immutable GitHub Release.
require_text install.sh 'release_base="https://github.com/fased-ai/fased/releases/download/v${release}"'
require_text tools/fased-lifecycled/cmd/fased-bootstrap/main_test.go \
  'TestPublicTrustRouteRequiresExactVersionAndHasNoDelegationOrUpdatesDomain'
reject_text install.sh 'updates.fased.ai'
reject_text tools/fased-lifecycled/cmd/fased-bootstrap/main.go 'updates.fased.ai'

# DEV-005: quiet and verbose share one redirect-following download definition;
# verbosity only adds quiet-output flags or the bootstrap logging selector.
require_text install.sh "curl_args=(-fL --proto '=https' --tlsv1.2 --retry 2 --retry-delay 1)"
require_text install.sh 'if [[ "$verbose" -eq 0 ]]; then curl_args+=(-sS); fi'
require_text install.sh "curl \"\${curl_args[@]}\" --write-out '%{size_download} %{time_total}\\n'"
require_text install.sh '"${release_base}/${bootstrap_asset}" -o "$download"'
require_text install.sh '[[ "$verbose" -eq 1 ]] && bootstrap_args+=(--verbose)'

# DEV-004 and DEV-006: substituted Hosting transport can only be SUPPORTING;
# real Local and Hosting acceptance remain external evidence.
require_text scripts/lifecycle-acceptance-contract.mjs \
  'acquisitionMode: "substituted-fixture"'
require_text scripts/lifecycle-acceptance-contract.mjs \
  'acquisitionMode: "immutable-github-release"'
require_text scripts/docker/hosting-systemd/lifecycle-acceptance.sh \
  'acceptance_acquisition_evidence_class=SUPPORTING'
require_text .github/workflows/pre-tag-p1.yml 'build-linux-x64-release-artifact.sh'
reject_text .github/workflows/pre-tag-p1.yml 'test-lifecycle-hosting-acceptance.sh'
reject_text .github/workflows/pre-tag-p1.yml 'test-lifecycle-local-acceptance.sh'
require_text .github/workflows/hosted-runtime-release.yml \
  'Verify immutable protected pre-tag P1 pass'
require_text docs/maintainers/codex-skills/fased-release-manager/SKILL.md \
  'Before candidate allocation, require one owner-authorized real-init'
require_text docs/maintainers/codex-skills/fased-release-manager/SKILL.md \
  'Never use a release to discover whether a correction works.'
require_text docs/maintainers/codex-skills/fased-release-manager/references/release.md \
  'build one production Linux-x64 artifact on exact versioned main'
require_text docs/maintainers/codex-skills/fased-release-manager/references/release.md \
  'allocate an RC to discover whether a correction works.'

# DEV-007: PUBLIC0 is a readback boundary and cannot be lifecycle acceptance.
require_text docs/maintainers/codex-skills/fased-release-manager/references/release.md \
  'PUBLIC0 is readback-only.'
if grep -R -n --exclude='test-lifecycle-plan-reconciliation.sh' \
  -E 'PUBLIC0.*(Local|Hosting).*(PASS|acceptance)|(Local|Hosting).*(PASS|acceptance).*PUBLIC0' \
  "$repo_root/.github/workflows" "$repo_root/scripts" >/dev/null 2>&1; then
  fail 'production workflow or script lets PUBLIC0 supply Local/Hosting acceptance'
fi

# Demolition boundary: removed mutation owners cannot return as production files.
for removed in \
  scripts/fased-generation-updater-core.mjs \
  scripts/generation-updater.mjs \
  tools/fased-lifecycled/controller/controller.go \
  tools/fased-lifecycled/platform/controller_adapter.go \
  tools/fased-lifecycled/candidate/verify.go \
  tools/fased-lifecycled/platform/shared_state_store.go; do
  [[ ! -e "$repo_root/$removed" ]] || fail "removed lifecycle owner returned: $removed"
done

printf 'lifecycle reconciliation contract: PASS\n'
