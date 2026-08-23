#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lifecycle-fixture-only-paths.sh"
source "$ROOT_DIR/scripts/local0-receipt-inventory.sh"
MODE="all"
ONLY_LANE=""
SUPPLIED_ARTIFACT_DIR=""
SUPPLIED_RECEIPT_DIR=""
PUBLIC_STABLE_VERSION="${FASED_LOCAL0_PUBLIC_STABLE_VERSION:-0.1.75}"
CANONICAL_MANAGED_VERSION="${FASED_LOCAL0_CANONICAL_MANAGED_VERSION:-0.1.76-rc.80}"
DISTROS="${FASED_LOCAL0_DISTROS:-ubuntu}"
CACHE_HOME="${XDG_CACHE_HOME:-${HOME:-${TMPDIR:-/tmp}}/.cache}"
CACHE_ROOT="${FASED_LOCAL0_CACHE_DIR:-$CACHE_HOME/fased-dev/local0}"
FIXTURE_RELEASE_SEQUENCE="${FASED_LIFECYCLE_RELEASE_SEQUENCE:-1}"

usage() {
  cat >&2 <<'EOF_USAGE'
usage: scripts/run-lifecycle-local0.sh [--mode build|serial|concurrent|all]
       [--lane LANE] [--artifact-dir ABSOLUTE_DIR] [--receipt-dir ABSOLUTE_DIR]

Builds or reuses one exact unpublished Linux-x64 artifact, runs the Local and
Hosting lifecycle lanes, and emits one aggregate JSON receipt. No tag, GitHub
Release, npm publication, owner installation, or real Hosting mutation occurs.
EOF_USAGE
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ "$#" -ge 2 ]] || { usage; exit 2; }
      MODE="$2"
      shift 2
      ;;
    --artifact-dir)
      [[ "$#" -ge 2 ]] || { usage; exit 2; }
      SUPPLIED_ARTIFACT_DIR="$2"
      shift 2
      ;;
    --lane)
      [[ "$#" -ge 2 ]] || { usage; exit 2; }
      ONLY_LANE="$2"
      shift 2
      ;;
    --receipt-dir)
      [[ "$#" -ge 2 ]] || { usage; exit 2; }
      SUPPLIED_RECEIPT_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

case "$MODE" in
  build|serial|concurrent|all) ;;
  *) usage; exit 2 ;;
esac
if [[ -n "$ONLY_LANE" ]]; then
  [[ "$MODE" == "serial" ]] || {
    echo "--lane is valid only with --mode serial." >&2
    exit 2
  }
  case "$ONLY_LANE" in
    local-fresh|local-public-stable|local-canonical-managed|hosting-fresh|hosting-public-stable) ;;
    *) echo "Unsupported LOCAL0 diagnostic lane: $ONLY_LANE" >&2; exit 2 ;;
  esac
fi
[[ "$CACHE_ROOT" == /* ]] || {
  echo "FASED_LOCAL0_CACHE_DIR must be absolute." >&2
  exit 1
}
if [[ -n "$SUPPLIED_ARTIFACT_DIR" && "$SUPPLIED_ARTIFACT_DIR" != /* ]]; then
  echo "--artifact-dir must be absolute." >&2
  exit 1
fi
if [[ -n "$SUPPLIED_RECEIPT_DIR" && "$SUPPLIED_RECEIPT_DIR" != /* ]]; then
  echo "--receipt-dir must be absolute." >&2
  exit 1
fi
[[ "$FIXTURE_RELEASE_SEQUENCE" =~ ^[1-9][0-9]*$ ]] || {
  echo "FASED_LIFECYCLE_RELEASE_SEQUENCE must be a positive integer." >&2
  exit 1
}

command -v jq >/dev/null
command -v flock >/dev/null
commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"
tree="$(git -C "$ROOT_DIR" rev-parse 'HEAD^{tree}')"
lockfile_digest="sha256:$(sha256sum "$ROOT_DIR/pnpm-lock.yaml" | awk '{print $1}')"
identity_key="${commit}-${tree}-${lockfile_digest#sha256:}-sequence${FIXTURE_RELEASE_SEQUENCE}"
failure_marker="$CACHE_ROOT/failures/$identity_key.json"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run_id="${commit:0:12}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
if [[ -n "$SUPPLIED_RECEIPT_DIR" ]]; then
  receipt_root="$SUPPLIED_RECEIPT_DIR"
else
  receipt_root="$CACHE_ROOT/receipts/$run_id"
fi
lane_receipt_root="$receipt_root/lanes"
aggregate_receipt="$receipt_root/local0.json"
mkdir -p "$lane_receipt_root"

artifact_dir="$SUPPLIED_ARTIFACT_DIR"
artifact_product_commit=""
artifact_product_tree=""
artifact_product_lockfile_digest=""
artifact_fixture_only_descendant="false"
current_phase="initialization"
current_lane=""
active_staging=""

cleanup_interrupted_build() {
  local status=$?
  [[ -z "$active_staging" ]] || rm -rf -- "$active_staging"
  exit "$status"
}
trap cleanup_interrupted_build INT TERM HUP

collect_receipts() {
  local output="$1"
  local receipt relative digest
  local -a acceptance_receipts=()
  : >"$output"
  mapfile -d '' -t acceptance_receipts < <(local0_acceptance_receipt_paths "$lane_receipt_root")
  for receipt in "${acceptance_receipts[@]}"; do
    relative="${receipt#"$receipt_root/"}"
    digest="sha256:$(sha256sum "$receipt" | awk '{print $1}')"
    jq -c --arg path "$relative" --arg sha256 "$digest" \
      '{path:$path,sha256:$sha256,receipt:.}' "$receipt" >>"$output"
  done
}

validate_receipt_set() {
  local distro_count expected_count actual_count partial_count receipt receipt_commit
  local -a configured_distros
  local -a acceptance_receipts=()
  IFS=',' read -r -a configured_distros <<<"$DISTROS"
  distro_count="${#configured_distros[@]}"
  case "$MODE" in
    build) expected_count=0 ;;
    serial)
      if [[ -n "$ONLY_LANE" ]]; then
        expected_count="$distro_count"
      else
        expected_count="$((distro_count * 5))"
      fi
      ;;
    concurrent|all) expected_count="$((distro_count * 5))" ;;
  esac
  mapfile -d '' -t acceptance_receipts < <(local0_acceptance_receipt_paths "$lane_receipt_root")
  actual_count="${#acceptance_receipts[@]}"
  partial_count="$(find "$lane_receipt_root" -type f -name '*.partial.json' -print | wc -l)"
  [[ "$actual_count" -eq "$expected_count" && "$partial_count" -eq 0 ]] || {
    echo "LOCAL0 receipt set is incomplete: expected=$expected_count actual=$actual_count partial=$partial_count" >&2
    return 1
  }
  receipt_commit="$(jq -er .commit "$artifact_dir/fased-lifecycled-release.json")"
  for receipt in "${acceptance_receipts[@]}"; do
    jq -e --arg commit "$receipt_commit" \
      '.commit == $commit and
       ((.profile == "protected-local" and .evidenceClass == "PASS") or
        (.profile == "hosting" and .evidenceClass == "SUPPORTING")) and
       (.scenario == "fresh-install" or .scenario == "managed-update")' \
      "$receipt" >/dev/null || return 1
  done
}

write_receipt() {
  local status="$1"
  local phase="$2"
  local failed_lane="${3:-}"
  local descriptor_digest=""
  local compatibility_digest=""
  local acceptance_digest=""
  local overlay_digest=""
  local complete_local0="false"
  local local_entrypoint_digest="sha256:$(sha256sum "$ROOT_DIR/scripts/test-lifecycle-local-acceptance.sh" | awk '{print $1}')"
  local hosting_entrypoint_digest="sha256:$(sha256sum "$ROOT_DIR/scripts/test-lifecycle-hosting-acceptance.sh" | awk '{print $1}')"
  local child_jsonl
  child_jsonl="$(mktemp "${TMPDIR:-/tmp}/fased-local0-receipts.XXXXXX")"
  collect_receipts "$child_jsonl"
  if [[ -n "$artifact_dir" && -f "$artifact_dir/fased-hosting-candidate.json" ]]; then
    descriptor_digest="sha256:$(sha256sum "$artifact_dir/fased-hosting-candidate.json" | awk '{print $1}')"
    compatibility_digest="sha256:$(sha256sum "$artifact_dir/fased-lifecycle-release-compatibility-v1.json" | awk '{print $1}')"
    acceptance_digest="sha256:$(sha256sum "$artifact_dir/fased-lifecycle-acceptance-v2.json" | awk '{print $1}')"
    if [[ -f "$artifact_dir/fased-candidate-fixture-overlay.json" ]]; then
      overlay_digest="sha256:$(sha256sum "$artifact_dir/fased-candidate-fixture-overlay.json" | awk '{print $1}')"
    fi
  fi
  if [[ "$status" == "PASS" && "$MODE" == "all" && -z "$ONLY_LANE" ]]; then
    complete_local0="true"
  fi
  jq -n \
    --arg status "$status" \
    --arg mode "$MODE" \
    --arg phase "$phase" \
    --arg failedLane "$failed_lane" \
    --arg diagnosticLane "$ONLY_LANE" \
    --arg completeLocal0 "$complete_local0" \
    --arg startedAt "$started_at" \
    --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg commit "$commit" \
    --arg tree "$tree" \
    --arg lockfileDigest "$lockfile_digest" \
    --arg artifactDirectory "$artifact_dir" \
    --arg descriptorDigest "$descriptor_digest" \
    --arg compatibilityDigest "$compatibility_digest" \
    --arg acceptanceDigest "$acceptance_digest" \
    --arg overlayDigest "$overlay_digest" \
    --arg artifactProductCommit "$artifact_product_commit" \
    --arg artifactProductTree "$artifact_product_tree" \
    --arg artifactProductLockfileDigest "$artifact_product_lockfile_digest" \
    --arg artifactFixtureOnlyDescendant "$artifact_fixture_only_descendant" \
    --arg fixtureReleaseSequence "$FIXTURE_RELEASE_SEQUENCE" \
    --arg localEntrypointDigest "$local_entrypoint_digest" \
    --arg hostingEntrypointDigest "$hosting_entrypoint_digest" \
    --arg publicStableVersion "$PUBLIC_STABLE_VERSION" \
    --arg canonicalManagedVersion "$CANONICAL_MANAGED_VERSION" \
    --arg distros "$DISTROS" \
    --slurpfile receipts "$child_jsonl" \
    '{schemaVersion:1,role:"fased-local0-receipt",evidenceClass:"SUPPORTING",
      status:$status,mode:$mode,phase:$phase,completeLocal0:($completeLocal0 == "true"),
      failedLane:(if $failedLane == "" then null else $failedLane end),
      diagnosticLane:(if $diagnosticLane == "" then null else $diagnosticLane end),
      startedAt:$startedAt,completedAt:$completedAt,
      source:{commit:$commit,tree:$tree,lockfileDigest:$lockfileDigest},
      artifact:{directory:$artifactDirectory,descriptorDigest:$descriptorDigest,
        compatibilityDigest:$compatibilityDigest,acceptanceContractDigest:$acceptanceDigest,
        fixtureTrustOverlayDigest:$overlayDigest,publishable:false,platforms:["linux-x64"],
        fixtureReleaseSequence:($fixtureReleaseSequence | tonumber),
        productSource:{commit:$artifactProductCommit,tree:$artifactProductTree,
          lockfileDigest:$artifactProductLockfileDigest},
        fixtureOnlyDescendant:($artifactFixtureOnlyDescendant == "true")},
      entrypoints:{local:$localEntrypointDigest,hosting:$hostingEntrypointDigest},
      materializedInstallationClasses:{publicStableVersion:$publicStableVersion,
        canonicalManagedVersion:$canonicalManagedVersion},
      distros:($distros | split(",")),receipts:$receipts}' \
    >"$aggregate_receipt"
  rm -f -- "$child_jsonl"
}

fail_local0() {
  local message="$1"
  write_receipt FAIL "$current_phase" "$current_lane" || true
  mkdir -p "$(dirname "$failure_marker")"
  install -m 0600 "$aggregate_receipt" "$failure_marker"
  echo "$message" >&2
  echo "LOCAL0 receipt: $aggregate_receipt" >&2
  exit 1
}

verify_pre_tag_predecessor_capsule_contract() {
  local workflow="$ROOT_DIR/.github/workflows/pre-tag-p1.yml"
  local fixture="$ROOT_DIR/scripts/test-lifecycle-local-acceptance.sh"
  grep -Fq -- "bash scripts/test-lifecycle-local-acceptance.sh" "$workflow" ||
    return 1
  grep -Fq -- "prepare-branch-predecessor-capsule.sh" "$fixture" ||
    return 1
  if grep -Fq -- "owner-local-predecessor-schema1" "$workflow"; then
    return 1
  fi
  if grep -Fq -- "--previous-generation" "$workflow"; then
    return 1
  fi
}

verify_artifact() {
  local candidate="$1"
  local allow_fixture_descendant="${2:-0}"
  local descriptor="$candidate/fased-hosting-candidate.json"
  local identity="$candidate/fased-lifecycled-release.json"
  local overlay="$candidate/fased-candidate-fixture-overlay.json"
  local name expected_size expected_digest selected unexpected_fixture_changes
  [[ -d "$candidate" &&
    -f "$descriptor" && ! -L "$descriptor" &&
    -f "$identity" && ! -L "$identity" &&
    -f "$overlay" && ! -L "$overlay" &&
    -f "$candidate/fased-branch-release-index.json" && ! -L "$candidate/fased-branch-release-index.json" &&
    -f "$candidate/fased-branch-proof-x64.json" ]] || return 1
  artifact_product_commit="$(jq -er .commit "$descriptor")" || return 1
  artifact_product_tree="$(jq -er .tree "$descriptor")" || return 1
  artifact_product_lockfile_digest="$(jq -er .lockfileDigest "$descriptor")" || return 1
  git -C "$ROOT_DIR" cat-file -e "${artifact_product_commit}^{commit}" 2>/dev/null || return 1
  [[ "$(git -C "$ROOT_DIR" rev-parse "${artifact_product_commit}^{tree}")" == "$artifact_product_tree" ]] ||
    return 1
  [[ "sha256:$(git -C "$ROOT_DIR" show "${artifact_product_commit}:pnpm-lock.yaml" | sha256sum | awk '{print $1}')" == "$artifact_product_lockfile_digest" ]] ||
    return 1
  jq -e --arg commit "$artifact_product_commit" --arg tree "$artifact_product_tree" \
    '.commit == $commit and .tree == $tree' "$identity" >/dev/null || return 1
  artifact_fixture_only_descendant="false"
  if [[ "$artifact_product_commit" != "$commit" || "$artifact_product_tree" != "$tree" ]]; then
    [[ "$allow_fixture_descendant" == "1" ]] || return 1
    unexpected_fixture_changes="$(lifecycle_unexpected_fixture_changes \
      "$ROOT_DIR" "$artifact_product_commit" "$commit")"
    [[ -z "$unexpected_fixture_changes" ]] || return 1
    [[ "$artifact_product_lockfile_digest" == "$lockfile_digest" ]] || return 1
    artifact_fixture_only_descendant="true"
  else
    [[ "$artifact_product_lockfile_digest" == "$lockfile_digest" ]] || return 1
  fi
  jq -e \
    --arg descriptor "sha256:$(sha256sum "$descriptor" | awk '{print $1}')" \
    --arg install "sha256:$(sha256sum "$candidate/install.sh" | awk '{print $1}')" \
    --arg bootstrap "sha256:$(sha256sum "$candidate/fased-bootstrap-linux-x64" | awk '{print $1}')" \
    '.schemaVersion == 1 and .publishable == false and
     .candidate.descriptorSha256 == $descriptor and
     .fixture.installSha256 == $install and .fixture.bootstrapSha256 == $bootstrap and
     .overriddenPaths == ["fased-bootstrap-linux-x64","install.sh"]' \
    "$overlay" >/dev/null || return 1
  jq -e --argjson fixtureReleaseSequence "$FIXTURE_RELEASE_SEQUENCE" \
    '.signed.releaseSequence == $fixtureReleaseSequence' \
    "$candidate/fased-branch-release-index.json" >/dev/null || return 1
  while IFS=$'\t' read -r name expected_size expected_digest; do
    selected="$candidate/$name"
    if [[ "$name" == "install.sh" || "$name" == "fased-bootstrap-linux-x64" ]]; then
      selected="$candidate/fased-candidate-original/$name"
    fi
    [[ -f "$selected" && ! -L "$selected" &&
      "$(stat -c %s "$selected")" == "$expected_size" &&
      "sha256:$(sha256sum "$selected" | awk '{print $1}')" == "$expected_digest" ]] || return 1
  done < <(jq -er '.artifacts[] | [.name, (.size|tostring), .sha256] | @tsv' "$descriptor")
}

resolve_or_build_artifact() {
  local identity_dir="$CACHE_ROOT/artifacts/$identity_key"
  local lock_file="$CACHE_ROOT/artifacts/.${identity_key}.lock"
  local lock_fd=""
  local cached=()
  local staging raw prepared descriptor_digest target
  if [[ -n "$artifact_dir" ]]; then
    [[ -z "$(git -C "$ROOT_DIR" status --porcelain=v1 --untracked-files=normal)" ]] ||
      fail_local0 "Supplied LOCAL0 artifact reuse requires one exact clean committed fixture head."
    verify_artifact "$artifact_dir" 1 ||
      fail_local0 "Supplied LOCAL0 artifact is incomplete or crosses the fixture-only reuse boundary."
    printf 'LOCAL0 artifact supplied: %s\n' "$artifact_dir"
    return
  fi
  mkdir -p "$identity_dir"
  exec {lock_fd}>"$lock_file"
  flock "$lock_fd"
  while IFS= read -r -d '' staging; do
    rm -rf -- "$staging"
  done < <(find "$identity_dir" -mindepth 1 -maxdepth 1 -type d -name '.building.*' -print0)
  while IFS= read -r -d '' target; do cached+=("$target"); done < <(
    find "$identity_dir" -mindepth 1 -maxdepth 1 -type d ! -name '.building.*' -print0 | sort -z
  )
  if [[ "${#cached[@]}" -gt 1 ]]; then
    flock -u "$lock_fd"
    fail_local0 "LOCAL0 artifact cache has multiple digests for one source identity."
  fi
  if [[ "${#cached[@]}" -eq 1 ]] && verify_artifact "${cached[0]}"; then
    artifact_dir="${cached[0]}"
    flock -u "$lock_fd"
    printf 'LOCAL0 artifact cache hit: %s\n' "$artifact_dir"
    return
  fi
  if [[ "${#cached[@]}" -eq 1 ]]; then
    flock -u "$lock_fd"
    fail_local0 "LOCAL0 artifact cache contains an invalid immutable entry."
  fi
  [[ -z "$(git -C "$ROOT_DIR" status --porcelain=v1 --untracked-files=normal)" ]] || {
    flock -u "$lock_fd"
    fail_local0 "LOCAL0 artifact construction requires one exact clean committed branch head."
  }
  staging="$(mktemp -d "$identity_dir/.building.XXXXXX")"
  active_staging="$staging"
  raw="$staging/raw"
  prepared="$staging/prepared"
  mkdir -p "$raw"
  current_phase="artifact-build"
  if ! FASED_SYSTEMD_FIXTURE_BUILD_ONLY=1 \
    FASED_SYSTEMD_FIXTURE_OUTPUT_DIR="$raw" \
    FASED_SYSTEMD_FIXTURE_COMMIT="$commit" \
    bash "$ROOT_DIR/scripts/test-lifecycle-local-acceptance.sh"; then
    rm -rf -- "$staging"
    flock -u "$lock_fd"
    fail_local0 "The unpublished Linux-x64 candidate-shaped artifact build failed."
  fi
  current_phase="fixture-trust-overlay"
  if ! FASED_LIFECYCLE_RELEASE_SEQUENCE="$FIXTURE_RELEASE_SEQUENCE" \
    bash "$ROOT_DIR/scripts/prepare-candidate-fixture-trust.sh" "$raw" "$prepared" >/dev/null; then
    rm -rf -- "$staging"
    flock -u "$lock_fd"
    fail_local0 "The tag-free fixture trust overlay could not be bound to the artifact."
  fi
  descriptor_digest="$(sha256sum "$prepared/fased-hosting-candidate.json" | awk '{print $1}')"
  target="$identity_dir/$descriptor_digest"
  if [[ -e "$target" ]]; then
    verify_artifact "$target" || {
      rm -rf -- "$staging"
      flock -u "$lock_fd"
      fail_local0 "The exact LOCAL0 cache target exists but is invalid."
    }
  else
    mv "$prepared" "$target"
  fi
  rm -rf -- "$staging"
  active_staging=""
  artifact_dir="$target"
  verify_artifact "$artifact_dir" || {
    flock -u "$lock_fd"
    fail_local0 "The cached LOCAL0 artifact failed exact identity verification."
  }
  flock -u "$lock_fd"
  printf 'LOCAL0 artifact cache stored: %s\n' "$artifact_dir"
}

run_local_lane() {
  local lane="$1"
  local scenarios="$2"
  local predecessor_class="$3"
  local predecessor_version="$4"
  local parallel="$5"
  local phase="$6"
  local receipts="$lane_receipt_root/$phase/$lane"
  mkdir -p "$receipts"
  FASED_SYSTEMD_FIXTURE_ARTIFACT_DIR="$artifact_dir" \
  FASED_SYSTEMD_FIXTURE_DISTROS="$DISTROS" \
  FASED_SYSTEMD_FIXTURE_SCENARIOS="$scenarios" \
  FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_CLASS="$predecessor_class" \
  FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_VERSION="$predecessor_version" \
  FASED_SYSTEMD_FIXTURE_PARALLEL_SCENARIOS="$parallel" \
  FASED_SYSTEMD_FIXTURE_PREPARE_IMAGES=0 \
  FASED_SYSTEMD_FIXTURE_PRESERVE_FAILURE=1 \
  FASED_SYSTEMD_FIXTURE_IMAGE_CACHE_DIR="$CACHE_ROOT/images/local" \
  FASED_SYSTEMD_FIXTURE_RECEIPT_DIR="$receipts" \
    bash "$ROOT_DIR/scripts/test-lifecycle-local-acceptance.sh"
}

run_hosting_lane() {
  local lane="$1"
  local scenarios="$2"
  local predecessor_class="$3"
  local predecessor_version="$4"
  local parallel="$5"
  local phase="$6"
  local receipts="$lane_receipt_root/$phase/$lane"
  mkdir -p "$receipts"
  FASED_HOSTING_SYSTEMD_FIXTURE_ARTIFACT_DIR="$artifact_dir" \
  FASED_HOSTING_SYSTEMD_FIXTURE_DISTROS="$DISTROS" \
  FASED_HOSTING_SYSTEMD_FIXTURE_SCENARIOS="$scenarios" \
  FASED_HOSTING_SYSTEMD_FIXTURE_PREDECESSOR_CLASS="$predecessor_class" \
  FASED_HOSTING_SYSTEMD_FIXTURE_PREDECESSOR_VERSION="$predecessor_version" \
  FASED_HOSTING_SYSTEMD_FIXTURE_PARALLEL_SCENARIOS="$parallel" \
  FASED_SYSTEMD_FIXTURE_PREPARE_IMAGES=0 \
  FASED_HOSTING_SYSTEMD_FIXTURE_PRESERVE_FAILURE=1 \
  FASED_HOSTING_SYSTEMD_FIXTURE_IMAGE_CACHE_DIR="$CACHE_ROOT/images/hosting" \
  FASED_HOSTING_SYSTEMD_FIXTURE_RECEIPT_DIR="$receipts" \
    bash "$ROOT_DIR/scripts/test-lifecycle-hosting-acceptance.sh"
}

run_serial() {
  local lane
  current_phase="serial"
  for lane in local-fresh local-public-stable local-canonical-managed hosting-fresh hosting-public-stable; do
    [[ -z "$ONLY_LANE" || "$ONLY_LANE" == "$lane" ]] || continue
    current_lane="$lane"
    printf 'LOCAL0 serial lane: %s\n' "$lane"
    case "$lane" in
      local-fresh)
        run_local_lane "$lane" fresh-install public-stable "$PUBLIC_STABLE_VERSION" 0 serial || \
          fail_local0 "LOCAL0 failed in $lane. The exact failed fixture was preserved."
        ;;
      local-public-stable)
        run_local_lane "$lane" managed-update public-stable "$PUBLIC_STABLE_VERSION" 0 serial || \
          fail_local0 "LOCAL0 failed in $lane. The exact failed fixture was preserved."
        ;;
      local-canonical-managed)
        run_local_lane "$lane" managed-update canonical-managed "$CANONICAL_MANAGED_VERSION" 0 serial || \
          fail_local0 "LOCAL0 failed in $lane. The exact failed fixture was preserved."
        ;;
      hosting-fresh)
        run_hosting_lane "$lane" fresh-install public-stable "$PUBLIC_STABLE_VERSION" 0 serial || \
          fail_local0 "LOCAL0 failed in $lane. The exact failed fixture was preserved."
        ;;
      hosting-public-stable)
        run_hosting_lane "$lane" managed-update public-stable "$PUBLIC_STABLE_VERSION" 0 serial || \
          fail_local0 "LOCAL0 failed in $lane. The exact failed fixture was preserved."
        ;;
    esac
  done
  current_lane=""
}

run_concurrent() {
  local pid status completed_pid label remaining
  local pids=()
  local next_pids=()
  declare -A labels=()
  current_phase="concurrent"
  run_local_lane local-public-suite fresh-install,managed-update public-stable \
    "$PUBLIC_STABLE_VERSION" 1 concurrent &
  pid="$!"; pids+=("$pid"); labels["$pid"]="local-public-suite"
  run_local_lane local-canonical-managed managed-update canonical-managed \
    "$CANONICAL_MANAGED_VERSION" 1 concurrent &
  pid="$!"; pids+=("$pid"); labels["$pid"]="local-canonical-managed"
  run_hosting_lane hosting-public-suite fresh-install,managed-update public-stable \
    "$PUBLIC_STABLE_VERSION" 1 concurrent &
  pid="$!"; pids+=("$pid"); labels["$pid"]="hosting-public-suite"
  while [[ "${#pids[@]}" -gt 0 ]]; do
    completed_pid=""
    set +e
    wait -n -p completed_pid "${pids[@]}"
    status=$?
    set -e
    if [[ -z "$completed_pid" ]]; then
      for remaining in "${pids[@]}"; do
        if ! kill -0 "$remaining" 2>/dev/null; then
          completed_pid="$remaining"
          break
        fi
      done
    fi
    [[ -n "$completed_pid" ]] || {
      for remaining in "${pids[@]}"; do
        kill "$remaining" 2>/dev/null || true
      done
      wait || true
      fail_local0 "Concurrent LOCAL0 could not identify the completed lane."
    }
    label="${labels[$completed_pid]:-unknown}"
    if [[ "$status" -ne 0 ]]; then
      current_lane="$label"
      for remaining in "${pids[@]}"; do
        [[ "$remaining" == "$completed_pid" ]] || kill "$remaining" 2>/dev/null || true
      done
      wait || true
      fail_local0 "Concurrent LOCAL0 stopped on the first failed lane: $label."
    fi
    next_pids=()
    for remaining in "${pids[@]}"; do
      [[ "$remaining" == "$completed_pid" ]] || next_pids+=("$remaining")
    done
    pids=("${next_pids[@]}")
    unset 'labels[$completed_pid]'
  done
  current_lane=""
}

current_phase="pre-tag-predecessor-capsule-contract"
verify_pre_tag_predecessor_capsule_contract ||
  fail_local0 "The pre-tag proof no longer owns version-neutral predecessor capsule materialization."
current_phase="artifact-resolution"
resolve_or_build_artifact
case "$MODE" in
  build) ;;
  serial) run_serial ;;
  concurrent) run_concurrent ;;
  all) run_concurrent ;;
esac
current_phase="complete"
validate_receipt_set || fail_local0 "LOCAL0 refused a false PASS without every exact verified child receipt."
write_receipt PASS complete
rm -f -- "$failure_marker"
echo "LOCAL0 PASS: artifact=$artifact_dir"
echo "LOCAL0 receipt: $aggregate_receipt"
