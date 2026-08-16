#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lifecycle-fixture-only-paths.sh"
RUNTIME="${FASED_CONTAINER_RUNTIME:-podman}"
DISTROS="${FASED_HOSTING_SYSTEMD_FIXTURE_DISTROS:-ubuntu}"
SCENARIOS="${FASED_HOSTING_SYSTEMD_FIXTURE_SCENARIOS:-fresh-install,managed-update}"
ARTIFACT_DIR="${FASED_HOSTING_SYSTEMD_FIXTURE_ARTIFACT_DIR:-}"
RECEIPT_DIR="${FASED_HOSTING_SYSTEMD_FIXTURE_RECEIPT_DIR:-}"
IMAGE_CACHE_DIR="${FASED_HOSTING_SYSTEMD_FIXTURE_IMAGE_CACHE_DIR:-}"
PREDECESSOR_VERSION="${FASED_HOSTING_SYSTEMD_FIXTURE_PREDECESSOR_VERSION:-0.1.75}"
PREDECESSOR_CLASS="${FASED_HOSTING_SYSTEMD_FIXTURE_PREDECESSOR_CLASS:-public-stable}"
PREDECESSOR_CAPSULE_DIR="${FASED_HOSTING_SYSTEMD_FIXTURE_PREDECESSOR_CAPSULE_DIR:-}"
CACHE_HOME="${XDG_CACHE_HOME:-${HOME:-${TMPDIR:-/tmp}}/.cache}"
PREDECESSOR_CAPSULE_CACHE_DIR="${FASED_HOSTING_SYSTEMD_FIXTURE_PREDECESSOR_CAPSULE_CACHE_DIR-$CACHE_HOME/fased/predecessor-capsules}"
PARALLEL_SCENARIOS="${FASED_HOSTING_SYSTEMD_FIXTURE_PARALLEL_SCENARIOS:-1}"
PRESERVE_FAILED_CONTAINER="${FASED_HOSTING_SYSTEMD_FIXTURE_PRESERVE_FAILURE:-1}"
SYSTEMD_START_LOCK="${FASED_LIFECYCLE_FIXTURE_START_LOCK:-${TMPDIR:-/tmp}/fased-lifecycle-systemd-start.lock}"
FIXTURE_DIR="$ROOT_DIR/scripts/docker/hosting-systemd"

[[ -n "$ARTIFACT_DIR" && -d "$ARTIFACT_DIR" ]] || {
  echo "FASED_HOSTING_SYSTEMD_FIXTURE_ARTIFACT_DIR must name an existing candidate artifact directory." >&2
  exit 1
}
command -v "$RUNTIME" >/dev/null 2>&1 || {
  echo "Podman is required for the Go Hosting systemd fixture." >&2
  exit 1
}
[[ "$RUNTIME" == "podman" ]] || {
  echo "The Go Hosting systemd fixture currently requires Podman." >&2
  exit 1
}
[[ "$PARALLEL_SCENARIOS" == "0" || "$PARALLEL_SCENARIOS" == "1" ]] || {
  echo "FASED_HOSTING_SYSTEMD_FIXTURE_PARALLEL_SCENARIOS must be 0 or 1." >&2
  exit 1
}
[[ "$PRESERVE_FAILED_CONTAINER" == "0" || "$PRESERVE_FAILED_CONTAINER" == "1" ]] || {
  echo "FASED_HOSTING_SYSTEMD_FIXTURE_PRESERVE_FAILURE must be 0 or 1." >&2
  exit 1
}
[[ "$SYSTEMD_START_LOCK" == /* ]] || {
  echo "FASED_LIFECYCLE_FIXTURE_START_LOCK must be absolute." >&2
  exit 1
}
command -v flock >/dev/null 2>&1 || {
  echo "flock is required for serialized systemd fixture startup." >&2
  exit 1
}
mkdir -p "$(dirname "$SYSTEMD_START_LOCK")"

descriptor="$ARTIFACT_DIR/fased-hosting-candidate.json"
identity="$ARTIFACT_DIR/fased-lifecycled-release.json"
[[ -f "$descriptor" && -f "$identity" ]] || {
  echo "The candidate descriptor and lifecycle identity are required." >&2
  exit 1
}
version="$(jq -er .version "$identity")"
commit="$(jq -er .commit "$identity")"
tree="$(jq -er .tree "$identity")"
[[ "$version" == "$(jq -er .version "$descriptor")" &&
   "$commit" == "$(jq -er .commit "$descriptor")" &&
   "$tree" == "$(jq -er .tree "$descriptor")" ]] || {
  echo "The candidate descriptor and lifecycle identity disagree." >&2
  exit 1
}

fixture_overlay="$ARTIFACT_DIR/fased-candidate-fixture-overlay.json"
candidate_artifact_path() {
  local name="$1"
  if [[ -f "$fixture_overlay" &&
    ("$name" == "install.sh" || "$name" == "fased-bootstrap-linux-x64") ]]; then
    printf '%s\n' "$ARTIFACT_DIR/fased-candidate-original/$name"
    return
  fi
  printf '%s\n' "$ARTIFACT_DIR/$name"
}
if [[ -f "$fixture_overlay" ]]; then
  jq -e --arg digest "sha256:$(sha256sum "$descriptor" | awk '{print $1}')" \
    --arg install "sha256:$(sha256sum "$ARTIFACT_DIR/install.sh" | awk '{print $1}')" \
    --arg bootstrap "sha256:$(sha256sum "$ARTIFACT_DIR/fased-bootstrap-linux-x64" | awk '{print $1}')" \
    '.schemaVersion == 1 and .role == "fased-candidate-fixture-trust-overlay" and
     .publishable == false and .candidate.descriptorSha256 == $digest and
     .fixture.installSha256 == $install and .fixture.bootstrapSha256 == $bootstrap and
     .overriddenPaths == ["fased-bootstrap-linux-x64","install.sh"]' \
    "$fixture_overlay" >/dev/null || {
    echo "The candidate fixture trust overlay is not bound to the exact descriptor." >&2
    exit 1
  }
fi

while IFS=$'\t' read -r name expected_size expected_digest; do
  candidate="$(candidate_artifact_path "$name")"
  [[ -f "$candidate" && ! -L "$candidate" ]] || {
    echo "Candidate artifact is missing or unsafe: $name" >&2
    exit 1
  }
  [[ "$(stat -c %s "$candidate")" == "$expected_size" ]] || {
    echo "Candidate artifact size mismatch: $name" >&2
    exit 1
  }
  [[ "sha256:$(sha256sum "$candidate" | awk '{print $1}')" == "$expected_digest" ]] || {
    echo "Candidate artifact digest mismatch: $name" >&2
    exit 1
  }
done < <(jq -er '.artifacts[] | [.name, (.size|tostring), .sha256] | @tsv' "$descriptor")

if [[ ",$SCENARIOS," == *,managed-update,* ]]; then
  [[ "$PREDECESSOR_CLASS" == "public-stable" || "$PREDECESSOR_CLASS" == "canonical-managed" ]] || {
    echo "The Hosting update fixture requires an explicit supported predecessor class." >&2
    exit 1
  }
  if [[ -z "$PREDECESSOR_CAPSULE_DIR" && -f "$ARTIFACT_DIR/fased-branch-proof-x64.json" ]]; then
    PREDECESSOR_CAPSULE_DIR="$(bash "$ROOT_DIR/scripts/prepare-branch-predecessor-capsule.sh" \
      hosting "$PREDECESSOR_VERSION" "$commit" "$tree" "$PREDECESSOR_CAPSULE_CACHE_DIR" \
      "$PREDECESSOR_CLASS")"
  fi
  [[ "$PREDECESSOR_CAPSULE_DIR" == /* && -d "$PREDECESSOR_CAPSULE_DIR" ]] || {
    echo "The Hosting update fixture requires one absolute predecessor capsule directory." >&2
    exit 1
  }
  predecessor_descriptor="$PREDECESSOR_CAPSULE_DIR/fased-predecessor-capsule.json"
  predecessor_archive="$(jq -er .archive.name "$predecessor_descriptor")"
  node "$ROOT_DIR/scripts/lifecycle-installed-state-capsule.mjs" verify \
    --descriptor "$predecessor_descriptor" >/dev/null
  jq -e --arg version "$PREDECESSOR_VERSION" --arg installationClass "$PREDECESSOR_CLASS" \
    '.profile == "hosting" and .release.version == $version and
     .installationClass.kind == $installationClass' "$predecessor_descriptor" >/dev/null
  if [[ -f "$PREDECESSOR_CAPSULE_DIR/fased-predecessor-branch-proof.json" ]]; then
    test -f "$ARTIFACT_DIR/fased-branch-proof-x64.json"
    predecessor_proof="$PREDECESSOR_CAPSULE_DIR/fased-predecessor-branch-proof.json"
    jq -e --arg commit "$commit" --arg tree "$tree" \
      '.role == "fased-predecessor-capsule-branch-proof" and
       .publishable == false and .profile == "hosting" and
       .builder.commit == $commit and .builder.tree == $tree' \
      "$predecessor_proof" >/dev/null
    test "$(jq -er .descriptor.sha256 "$predecessor_proof")" = \
      "sha256:$(sha256sum "$predecessor_descriptor" | awk '{print $1}')"
    test "$(jq -er .archive.sha256 "$predecessor_proof")" = \
      "sha256:$(sha256sum "$PREDECESSOR_CAPSULE_DIR/$predecessor_archive" | awk '{print $1}')"
  else
    GH_PROMPT_DISABLED=1 gh attestation verify "$predecessor_descriptor" \
      --repo fased-ai/fased \
      --bundle "$predecessor_descriptor.attestation.json" \
      --deny-self-hosted-runners >/dev/null
    GH_PROMPT_DISABLED=1 gh attestation verify "$PREDECESSOR_CAPSULE_DIR/$predecessor_archive" \
      --repo fased-ai/fased \
      --bundle "$PREDECESSOR_CAPSULE_DIR/$predecessor_archive.attestation.json" \
      --deny-self-hosted-runners >/dev/null
  fi
fi

cleanup_names=()
image_staging=""
fixture_tools_dir="$(mktemp -d "${TMPDIR:-/tmp}/fased-hosting-fixture-tools.XXXXXX")"
failure_registry="$fixture_tools_dir/failed-containers"
mkdir -p "$failure_registry"
cleanup() {
  local status=$?
  local name
  local preserved_fixture=0
  [[ -z "$image_staging" ]] || rm -f -- "$image_staging"
  for name in "${cleanup_names[@]}"; do
    if [[ "$status" -ne 0 && "$PRESERVE_FAILED_CONTAINER" == "1" &&
      -f "$failure_registry/$name" ]] &&
      "$RUNTIME" container exists "$name" >/dev/null 2>&1; then
      printf 'Preserved failed Go Hosting fixture container: %s\n' "$name" >&2
      preserved_fixture=1
      continue
    fi
    "$RUNTIME" rm -f "$name" >/dev/null 2>&1 || true
  done
  if [[ "$preserved_fixture" -eq 0 ]]; then
    rm -rf -- "$fixture_tools_dir"
  else
    printf 'Preserved failed Hosting fixture support directory: %s\n' "$fixture_tools_dir" >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
fixture_source_commit="$commit"
if [[ -f "$ARTIFACT_DIR/fased-branch-proof-x64.json" ||
  -f "$ARTIFACT_DIR/fased-candidate-fixture-overlay.json" ]]; then
  git -C "$ROOT_DIR" merge-base --is-ancestor "$commit" HEAD || {
    echo "A branch artifact can reuse only descendant Hosting fixture corrections." >&2
    exit 1
  }
  unexpected_fixture_changes="$(lifecycle_unexpected_fixture_changes \
    "$ROOT_DIR" "$commit" HEAD)"
  [[ -z "$unexpected_fixture_changes" ]] || {
    echo "Branch artifact reuse rejected product changes:" >&2
    printf '%s\n' "$unexpected_fixture_changes" >&2
    exit 1
  }
  fixture_source_commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  echo "Hosting branch artifact reuse: product=$commit fixture=$fixture_source_commit"
fi
git -C "$ROOT_DIR" archive "$fixture_source_commit" -- \
  scripts/lifecycle-acceptance-contract.mjs \
  scripts/lifecycle-configuration-preservation.mjs \
  scripts/lifecycle-receipt-verifier.mjs \
  scripts/lifecycle-installed-state-capsule.mjs \
  scripts/predecessor-capsule.mjs \
  scripts/restore-predecessor-capsule.mjs \
  scripts/docker/hosting-systemd/lifecycle-acceptance.sh | tar -x -C "$fixture_tools_dir"
fixture_node_modules="$(readlink -f "$ROOT_DIR/node_modules")"
fixture_node="$(readlink -f "$(command -v node)")"
[[ -d "$fixture_node_modules" && -x "$fixture_node" ]]
ln -s "$ROOT_DIR/node_modules" "$fixture_tools_dir/scripts/node_modules"

IFS=',' read -r -a distro_list <<<"$DISTROS"
IFS=',' read -r -a scenario_list <<<"$SCENARIOS"
for scenario in "${scenario_list[@]}"; do
  [[ "$scenario" == "fresh-install" || "$scenario" == "managed-update" ]] || {
    echo "Unsupported Hosting fixture scenario: $scenario" >&2
    exit 1
  }
done

for distro in "${distro_list[@]}"; do
  containerfile="$FIXTURE_DIR/Containerfile.$distro"
  [[ -f "$containerfile" ]] || {
    echo "Unsupported Hosting fixture distro: $distro" >&2
    exit 1
  }
  image="fased-hosting-systemd-${distro}:local"
  image_archive=""
  image_cache_lock_fd=""
  if [[ -n "$IMAGE_CACHE_DIR" ]]; then
    [[ "$IMAGE_CACHE_DIR" == /* ]] || {
      echo "FASED_HOSTING_SYSTEMD_FIXTURE_IMAGE_CACHE_DIR must be absolute." >&2
      exit 1
    }
    mkdir -p "$IMAGE_CACHE_DIR"
    image_archive="$IMAGE_CACHE_DIR/${distro}.oci.tar"
    exec {image_cache_lock_fd}>"${image_archive}.lock"
    flock "$image_cache_lock_fd"
  fi
  if [[ -n "$image_archive" && -s "$image_archive" ]]; then
    "$RUNTIME" load --input "$image_archive" >/dev/null
    "$RUNTIME" image exists "$image"
    printf 'Hosting fixture image cache hit: distro=%s\n' "$distro"
  else
    "$RUNTIME" build -f "$containerfile" -t "$image" "$FIXTURE_DIR"
    if [[ -n "$image_archive" ]]; then
      image_staging="${image_archive}.building.$$"
      "$RUNTIME" save --format oci-archive --output "$image_staging" "$image"
      mv "$image_staging" "$image_archive"
      rm -f -- "$image_staging"
      image_staging=""
    fi
  fi
  if [[ -n "$image_cache_lock_fd" ]]; then
    flock -u "$image_cache_lock_fd"
    exec {image_cache_lock_fd}>&-
  fi
done

dump_scenario_failure() {
  local distro="$1"
  local scenario="$2"
  local name="$3"
  touch "$failure_registry/$name"
  printf 'Hosting fixture failure: distro=%s scenario=%s container=%s\n' \
    "$distro" "$scenario" "$name" >&2
  if [[ -n "$RECEIPT_DIR" ]]; then
    mkdir -p "$RECEIPT_DIR"
    "$RUNTIME" cp \
      "$name:/var/lib/fased-lifecycled/lifecycle-acceptance-${scenario}.json" \
      "$RECEIPT_DIR/${distro}-${scenario}.partial.json" >/dev/null 2>&1 || true
  fi
  "$RUNTIME" logs "$name" >&2 2>/dev/null || true
  "$RUNTIME" exec "$name" systemctl --failed --no-pager >&2 2>/dev/null || true
  "$RUNTIME" exec "$name" journalctl \
    -u fased-host-updater.service \
    -u fased-signerd.service \
    -u fased-gateway.service \
    -n 200 --no-pager >&2 2>/dev/null || true
}

run_scenario_body() {
  local distro="$1"
  local scenario="$2"
  local name="$3"
  local image="fased-hosting-systemd-${distro}:local"
  local predecessor_dir="$ARTIFACT_DIR"
  local predecessor=""
  local start_lock_fd=""
  [[ "$scenario" != "managed-update" ]] || {
    predecessor_dir="$PREDECESSOR_CAPSULE_DIR"
    predecessor="$PREDECESSOR_VERSION"
  }
  exec {start_lock_fd}>"$SYSTEMD_START_LOCK"
  flock "$start_lock_fd"
  if ! "$RUNTIME" run -d \
    --name "$name" \
    --privileged \
    --systemd=always \
    --tmpfs /run:rw,noexec \
    --tmpfs /tmp \
    -e "FASED_FIXTURE_VERSION=$version" \
    -e "FASED_FIXTURE_COMMIT=$commit" \
    -e "FASED_FIXTURE_TREE=$tree" \
    -e "FASED_FIXTURE_PREDECESSOR_VERSION=$predecessor" \
    -e "FASED_FIXTURE_PREDECESSOR_CLASS=$PREDECESSOR_CLASS" \
    -v "$fixture_tools_dir/scripts:/fixture-tools:ro,Z" \
    -v "$fixture_node_modules:$ROOT_DIR/node_modules:ro,z" \
    -v "$fixture_node:/fixture-node:ro,Z" \
    -v "$ARTIFACT_DIR:/artifacts:ro,Z" \
    -v "$predecessor_dir:/predecessor-capsule:ro,Z" \
    "$image" >/dev/null; then
    flock -u "$start_lock_fd"
    exec {start_lock_fd}>&-
    echo "$distro $scenario Go Hosting fixture container failed to start: $name" >&2
    return 1
  fi
  ready=0
  for _ in {1..200}; do
    state="$("$RUNTIME" exec "$name" systemctl is-system-running 2>/dev/null || true)"
    if [[ "$state" == "running" || "$state" == "degraded" ]]; then
      ready=1
      break
    fi
    if [[ "$("$RUNTIME" inspect "$name" --format '{{.State.Running}}' 2>/dev/null || true)" == "false" ]]; then
      break
    fi
    sleep 0.1
  done
  flock -u "$start_lock_fd"
  exec {start_lock_fd}>&-
  [[ "$ready" -eq 1 ]] || {
    echo "$distro $scenario Go Hosting fixture did not become ready: $name" >&2
    "$RUNTIME" inspect "$name" --format \
      'status={{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}' >&2 2>/dev/null || true
    "$RUNTIME" logs "$name" >&2 2>/dev/null || true
    return 1
  }
  fixture_phase="$([[ "$scenario" == "fresh-install" ]] && printf install || printf managed-update)"
  "$RUNTIME" exec "$name" bash /fixture-tools/docker/hosting-systemd/lifecycle-acceptance.sh "$fixture_phase" || return 1
  if [[ -n "$RECEIPT_DIR" ]]; then
    mkdir -p "$RECEIPT_DIR"
    receipt="$RECEIPT_DIR/${distro}-${scenario}.json"
    "$RUNTIME" cp \
      "$name:/var/lib/fased-lifecycled/lifecycle-acceptance-${scenario}.json" \
      "$receipt" || return 1
    capsule_digest=""
    installation_class_digest=""
    [[ "$scenario" != "managed-update" ]] || \
      capsule_digest="sha256:$(sha256sum "$PREDECESSOR_CAPSULE_DIR/fased-predecessor-capsule.json" | awk '{print $1}')"
    [[ "$scenario" != "managed-update" ]] || \
      installation_class_digest="$(jq -er .installationClassDigest "$PREDECESSOR_CAPSULE_DIR/fased-predecessor-capsule.json")"
    node "$ROOT_DIR/scripts/lifecycle-receipt-verifier.mjs" \
      --contract "$ARTIFACT_DIR/fased-lifecycle-acceptance-v2.json" \
      --receipt "$receipt" \
      --profile hosting \
      --scenario "$scenario" \
      --version "$version" \
      --commit "$commit" \
      --candidate-descriptor-digest "sha256:$(sha256sum "$descriptor" | awk '{print $1}')" \
      --predecessor-capsule-digest "$capsule_digest" \
      --predecessor-installation-class "$([[ "$scenario" == "managed-update" ]] && printf '%s' "$PREDECESSOR_CLASS" || true)" \
      --predecessor-installation-class-digest "$installation_class_digest" \
      --evidence-class PASS \
      --acquisition-evidence-class SUPPORTING >/dev/null || return 1
  fi
  "$RUNTIME" stop "$name" >/dev/null || return 1
  "$RUNTIME" start "$name" >/dev/null || return 1
  ready=0
  for _ in {1..200}; do
    state="$("$RUNTIME" exec "$name" systemctl is-system-running 2>/dev/null || true)"
    if [[ "$state" == "running" || "$state" == "degraded" ]]; then
      ready=1
      break
    fi
    sleep 0.1
  done
  [[ "$ready" -eq 1 ]] || {
    echo "$distro $scenario Go Hosting fixture did not recover after reboot: $name" >&2
    exit 1
  }
  "$RUNTIME" exec "$name" bash /fixture-tools/docker/hosting-systemd/lifecycle-acceptance.sh verify-reboot || return 1
  "$RUNTIME" rm -f "$name" >/dev/null || return 1
}

run_scenario() {
  local distro="$1"
  local scenario="$2"
  local name="$3"
  local status
  set +e
  (
    set -euo pipefail
    run_scenario_body "$distro" "$scenario" "$name"
  )
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    dump_scenario_failure "$distro" "$scenario" "$name"
    return "$status"
  fi
}

if [[ "$PARALLEL_SCENARIOS" == "0" ]]; then
  for distro in "${distro_list[@]}"; do
    for scenario in "${scenario_list[@]}"; do
      name="fased-go-hosting-${distro}-${scenario}-$$"
      cleanup_names+=("$name")
      if ! run_scenario "$distro" "$scenario" "$name"; then
        echo "Serial Hosting proof stopped on the first failed scenario." >&2
        exit 1
      fi
    done
  done
else
  scenario_pids=()
  declare -A scenario_labels=()
  for distro in "${distro_list[@]}"; do
    for scenario in "${scenario_list[@]}"; do
      name="fased-go-hosting-${distro}-${scenario}-$$"
      cleanup_names+=("$name")
      run_scenario "$distro" "$scenario" "$name" &
      pid="$!"
      scenario_pids+=("$pid")
      scenario_labels["$pid"]="$distro|$scenario|$name"
    done
  done
  while [[ "${#scenario_pids[@]}" -gt 0 ]]; do
    completed_pid=""
    set +e
    wait -n -p completed_pid "${scenario_pids[@]}"
    status=$?
    set -e
    if [[ -z "$completed_pid" ]]; then
      for remaining in "${scenario_pids[@]}"; do
        if ! kill -0 "$remaining" 2>/dev/null; then
          completed_pid="$remaining"
          break
        fi
      done
    fi
    [[ -n "$completed_pid" ]] || {
      echo "Parallel Hosting proof could not identify the completed scenario." >&2
      exit 1
    }
    label="${scenario_labels[$completed_pid]:-unknown|unknown|unknown}"
    IFS='|' read -r failed_distro failed_scenario failed_name <<<"$label"
    if [[ "$status" -ne 0 ]]; then
      for remaining in "${scenario_pids[@]}"; do
        [[ "$remaining" == "$completed_pid" ]] || kill "$remaining" 2>/dev/null || true
      done
      wait || true
      echo "Parallel Hosting proof stopped: distro=$failed_distro scenario=$failed_scenario container=$failed_name" >&2
      exit 1
    fi
    next_pids=()
    for remaining in "${scenario_pids[@]}"; do
      [[ "$remaining" == "$completed_pid" ]] || next_pids+=("$remaining")
    done
    scenario_pids=("${next_pids[@]}")
    unset 'scenario_labels[$completed_pid]'
  done
fi

echo "Go Hosting systemd fixtures passed: distros=$DISTROS scenarios=$SCENARIOS"
