#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${FASED_CONTAINER_RUNTIME:-podman}"
DISTROS="${FASED_HOSTING_SYSTEMD_FIXTURE_DISTROS:-ubuntu}"
SCENARIOS="${FASED_HOSTING_SYSTEMD_FIXTURE_SCENARIOS:-fresh-install,managed-update}"
ARTIFACT_DIR="${FASED_HOSTING_SYSTEMD_FIXTURE_ARTIFACT_DIR:-}"
RECEIPT_DIR="${FASED_HOSTING_SYSTEMD_FIXTURE_RECEIPT_DIR:-}"
PREDECESSOR_VERSION="${FASED_HOSTING_SYSTEMD_FIXTURE_PREDECESSOR_VERSION:-0.1.75}"
PREDECESSOR_CAPSULE_DIR="${FASED_HOSTING_SYSTEMD_FIXTURE_PREDECESSOR_CAPSULE_DIR:-}"
CACHE_HOME="${XDG_CACHE_HOME:-${HOME:-${TMPDIR:-/tmp}}/.cache}"
PREDECESSOR_CAPSULE_CACHE_DIR="${FASED_HOSTING_SYSTEMD_FIXTURE_PREDECESSOR_CAPSULE_CACHE_DIR-$CACHE_HOME/fased/predecessor-capsules}"
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
  if [[ -z "$PREDECESSOR_CAPSULE_DIR" && -f "$ARTIFACT_DIR/fased-branch-proof-x64.json" ]]; then
    PREDECESSOR_CAPSULE_DIR="$(bash "$ROOT_DIR/scripts/prepare-branch-predecessor-capsule.sh" \
      hosting "$PREDECESSOR_VERSION" "$commit" "$tree" "$PREDECESSOR_CAPSULE_CACHE_DIR")"
  fi
  [[ "$PREDECESSOR_CAPSULE_DIR" == /* && -d "$PREDECESSOR_CAPSULE_DIR" ]] || {
    echo "The Hosting update fixture requires one absolute predecessor capsule directory." >&2
    exit 1
  }
  predecessor_descriptor="$PREDECESSOR_CAPSULE_DIR/fased-predecessor-capsule.json"
  predecessor_archive="$(jq -er .archive.name "$predecessor_descriptor")"
  node "$ROOT_DIR/scripts/lifecycle-installed-state-capsule.mjs" verify \
    --descriptor "$predecessor_descriptor" >/dev/null
  jq -e --arg version "$PREDECESSOR_VERSION" \
    '.profile == "hosting" and .release.version == $version' "$predecessor_descriptor" >/dev/null
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
fixture_tools_dir="$(mktemp -d "${TMPDIR:-/tmp}/fased-hosting-fixture-tools.XXXXXX")"
fixture_source_commit="$commit"
if [[ -f "$ARTIFACT_DIR/fased-branch-proof-x64.json" ||
  -f "$ARTIFACT_DIR/fased-candidate-fixture-overlay.json" ]]; then
  git -C "$ROOT_DIR" merge-base --is-ancestor "$commit" HEAD || {
    echo "A branch artifact can reuse only descendant Hosting fixture corrections." >&2
    exit 1
  }
  unexpected_fixture_changes="$(
    git -C "$ROOT_DIR" diff --name-only "$commit..HEAD" | \
      grep -Ev '^(\.github/workflows/candidate-p1-replay\.yml|docs/maintainers/codex-skills/fased-release-manager/(SKILL\.md|references/release\.md)|scripts/test-lifecycle-(local|hosting)-acceptance\.sh|scripts/docker/(protected-local|hosting)-systemd/lifecycle-acceptance\.sh|scripts/(hosted-installer-artifact-layout|ci-workflow-contract|lifecycle-d8-contract)\.test\.ts|scripts/prepare-candidate-fixture-trust\.sh|scripts/build-public-predecessor-capsule\.(mjs|test\.ts)|scripts/prepare-branch-predecessor-capsule\.sh)$' || true
  )"
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
  scripts/lifecycle-receipt-verifier.mjs \
  scripts/lifecycle-installed-state-capsule.mjs \
  scripts/predecessor-capsule.mjs \
  scripts/restore-predecessor-capsule.mjs \
  scripts/docker/hosting-systemd/lifecycle-acceptance.sh | tar -x -C "$fixture_tools_dir"
fixture_node_modules="$(readlink -f "$ROOT_DIR/node_modules")"
fixture_node="$(readlink -f "$(command -v node)")"
[[ -d "$fixture_node_modules" && -x "$fixture_node" ]]
ln -s /fixture-node-modules "$fixture_tools_dir/scripts/node_modules"
cleanup() {
  local status=$?
  local name
  if [[ "$status" -ne 0 && "${FASED_KEEP_FAILED_CONTAINER:-0}" == "1" ]]; then
    printf 'Preserving failed Go Hosting fixture container(s): %s\n' "${cleanup_names[*]}" >&2
    return
  fi
  for name in "${cleanup_names[@]}"; do
    "$RUNTIME" rm -f "$name" >/dev/null 2>&1 || true
  done
  rm -rf -- "$fixture_tools_dir"
}
trap cleanup EXIT INT TERM HUP

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
  "$RUNTIME" build -f "$containerfile" -t "$image" "$FIXTURE_DIR"
done

run_scenario() {
  local distro="$1"
  local scenario="$2"
  local image="fased-hosting-systemd-${distro}:local"
  local name="fased-go-hosting-${distro}-${scenario}-$$"
  local predecessor_dir="$ARTIFACT_DIR"
  local predecessor=""
  [[ "$scenario" != "managed-update" ]] || {
    predecessor_dir="$PREDECESSOR_CAPSULE_DIR"
    predecessor="$PREDECESSOR_VERSION"
  }
  "$RUNTIME" run -d \
    --name "$name" \
    --privileged \
    --systemd=always \
    --tmpfs /run:rw,noexec \
    --tmpfs /tmp \
    -e "FASED_FIXTURE_VERSION=$version" \
    -e "FASED_FIXTURE_COMMIT=$commit" \
    -e "FASED_FIXTURE_TREE=$tree" \
    -e "FASED_FIXTURE_PREDECESSOR_VERSION=$predecessor" \
    -v "$fixture_tools_dir/scripts:/fixture-tools:ro,Z" \
    -v "$fixture_node_modules:/fixture-node-modules:ro,Z" \
    -v "$fixture_node:/fixture-node:ro,Z" \
    -v "$ARTIFACT_DIR:/artifacts:ro,Z" \
    -v "$predecessor_dir:/predecessor-capsule:ro,Z" \
    "$image" >/dev/null
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
    echo "$distro Go Hosting fixture did not become ready." >&2
    exit 1
  }
  fixture_phase="$([[ "$scenario" == "fresh-install" ]] && printf install || printf managed-update)"
  "$RUNTIME" exec "$name" bash /fixture-tools/docker/hosting-systemd/lifecycle-acceptance.sh "$fixture_phase"
  if [[ -n "$RECEIPT_DIR" ]]; then
    mkdir -p "$RECEIPT_DIR"
    receipt="$RECEIPT_DIR/${distro}-${scenario}.json"
    "$RUNTIME" cp \
      "$name:/var/lib/fased-lifecycled/lifecycle-acceptance-${scenario}.json" \
      "$receipt"
    capsule_digest=""
    [[ "$scenario" != "managed-update" ]] || \
      capsule_digest="sha256:$(sha256sum "$PREDECESSOR_CAPSULE_DIR/fased-predecessor-capsule.json" | awk '{print $1}')"
    node "$ROOT_DIR/scripts/lifecycle-receipt-verifier.mjs" \
      --contract "$ARTIFACT_DIR/fased-lifecycle-acceptance-v2.json" \
      --receipt "$receipt" \
      --profile hosting \
      --scenario "$scenario" \
      --version "$version" \
      --commit "$commit" \
      --candidate-descriptor-digest "sha256:$(sha256sum "$descriptor" | awk '{print $1}')" \
      --predecessor-capsule-digest "$capsule_digest" >/dev/null
  fi
  "$RUNTIME" stop "$name" >/dev/null
  "$RUNTIME" start "$name" >/dev/null
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
    echo "$distro Go Hosting fixture did not recover after reboot." >&2
    exit 1
  }
  "$RUNTIME" exec "$name" bash /fixture-tools/docker/hosting-systemd/lifecycle-acceptance.sh verify-reboot
  "$RUNTIME" rm -f "$name" >/dev/null
}

scenario_pids=()
for distro in "${distro_list[@]}"; do
  for scenario in "${scenario_list[@]}"; do
    name="fased-go-hosting-${distro}-${scenario}-$$"
    cleanup_names+=("$name")
    run_scenario "$distro" "$scenario" &
    scenario_pids+=("$!")
  done
done
for pid in "${scenario_pids[@]}"; do
  if ! wait "$pid"; then
    for remaining in "${scenario_pids[@]}"; do kill "$remaining" 2>/dev/null || true; done
    wait || true
    echo "Parallel Hosting proof stopped on the first failed scenario." >&2
    exit 1
  fi
done

echo "Go Hosting systemd fixtures passed: distros=$DISTROS scenarios=$SCENARIOS"
