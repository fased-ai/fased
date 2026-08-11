#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${FASED_CONTAINER_RUNTIME:-podman}"
DISTROS="${FASED_HOSTING_SYSTEMD_FIXTURE_DISTROS:-ubuntu}"
ARTIFACT_DIR="${FASED_HOSTING_SYSTEMD_FIXTURE_ARTIFACT_DIR:-}"
RECEIPT_DIR="${FASED_HOSTING_SYSTEMD_FIXTURE_RECEIPT_DIR:-}"
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

while IFS=$'\t' read -r name expected_size expected_digest; do
  candidate="$ARTIFACT_DIR/$name"
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

cleanup_names=()
fixture_tools_dir="$(mktemp -d "${TMPDIR:-/tmp}/fased-hosting-fixture-tools.XXXXXX")"
git -C "$ROOT_DIR" archive "$commit" -- \
  scripts/lifecycle-acceptance-contract.mjs \
  scripts/lifecycle-receipt-verifier.mjs \
  scripts/docker/hosting-systemd/lifecycle-acceptance.sh | tar -x -C "$fixture_tools_dir"
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
for distro in "${distro_list[@]}"; do
  containerfile="$FIXTURE_DIR/Containerfile.$distro"
  [[ -f "$containerfile" ]] || {
    echo "Unsupported Hosting fixture distro: $distro" >&2
    exit 1
  }
  image="fased-hosting-systemd-${distro}:local"
  name="fased-go-hosting-${distro}-$$"
  cleanup_names+=("$name")
  "$RUNTIME" build -f "$containerfile" -t "$image" "$FIXTURE_DIR"
  "$RUNTIME" run -d \
    --name "$name" \
    --privileged \
    --systemd=always \
    --tmpfs /run:rw,noexec \
    --tmpfs /tmp \
    -e "FASED_FIXTURE_VERSION=$version" \
    -e "FASED_FIXTURE_COMMIT=$commit" \
    -e "FASED_FIXTURE_TREE=$tree" \
    -v "$fixture_tools_dir/scripts:/fixture-tools:ro,Z" \
    -v "$ARTIFACT_DIR:/artifacts:ro,Z" \
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
  "$RUNTIME" exec "$name" bash /fixture-tools/docker/hosting-systemd/lifecycle-acceptance.sh install
  if [[ -n "$RECEIPT_DIR" ]]; then
    mkdir -p "$RECEIPT_DIR"
    receipt="$RECEIPT_DIR/${distro}-fresh-install.json"
    "$RUNTIME" cp \
      "$name:/var/lib/fased-lifecycled/lifecycle-acceptance-fresh-install.json" \
      "$receipt"
    node "$ROOT_DIR/scripts/lifecycle-receipt-verifier.mjs" \
      --contract "$ARTIFACT_DIR/fased-lifecycle-acceptance-v2.json" \
      --receipt "$receipt" \
      --profile hosting \
      --scenario fresh-install \
      --version "$version" \
      --commit "$commit" \
      --candidate-descriptor-digest "sha256:$(sha256sum "$descriptor" | awk '{print $1}')" \
      --predecessor-capsule-digest "" >/dev/null
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
  cleanup_names=("${cleanup_names[@]/$name}")
done

echo "Go Hosting systemd fixtures passed: $DISTROS"
