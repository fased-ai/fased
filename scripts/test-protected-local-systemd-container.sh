#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${FASED_CONTAINER_RUNTIME:-podman}"
OCI_RUNTIME="${FASED_CONTAINER_OCI_RUNTIME:-}"
DISTROS="${FASED_SYSTEMD_FIXTURE_DISTROS:-ubuntu,rocky}"
SCENARIOS="${FASED_SYSTEMD_FIXTURE_SCENARIOS:-fresh-install,install}"
FIXTURE_DIR="$ROOT_DIR/scripts/docker/protected-local-systemd"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT_DIR/package.json")"
COMMIT="${FASED_SYSTEMD_FIXTURE_COMMIT:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "The protected Local fixture requires an exact 40-character commit." >&2
  exit 1
}
ARTIFACT_DIR="${FASED_SYSTEMD_FIXTURE_ARTIFACT_DIR:-}"
OWN_ARTIFACT_DIR=0
IMAGE_CACHE_DIR="${FASED_SYSTEMD_FIXTURE_IMAGE_CACHE_DIR:-}"
PREINSTALLED_TOOLS="${FASED_SYSTEMD_FIXTURE_PREINSTALLED_TOOLS:-0}"
LEGACY_VERSION="${FASED_SYSTEMD_FIXTURE_LEGACY_VERSION:-0.1.75}"
LEGACY_ARTIFACT_DIR="${FASED_SYSTEMD_FIXTURE_LEGACY_ARTIFACT_DIR:-}"
OWN_LEGACY_ARTIFACT_DIR=0

command -v "$RUNTIME" >/dev/null 2>&1 || {
  echo "Podman is required for the protected Local systemd fixtures." >&2
  exit 1
}
if [[ ",$SCENARIOS," == *,install,* ]]; then
  command -v gh >/dev/null 2>&1 || {
    echo "GitHub CLI is required for the literal Protected Local update fixture." >&2
    exit 1
  }
fi
[[ "$RUNTIME" == "podman" ]] || {
  echo "The protected Local systemd fixtures currently require Podman." >&2
  exit 1
}
if [[ -z "$OCI_RUNTIME" ]] && command -v runc >/dev/null 2>&1; then
  OCI_RUNTIME="$(command -v runc)"
fi
run_container() {
  if [[ -n "$OCI_RUNTIME" ]]; then
    "$RUNTIME" --runtime "$OCI_RUNTIME" "$@"
    return
  fi
  "$RUNTIME" "$@"
}
[[ "$PREINSTALLED_TOOLS" == "0" || "$PREINSTALLED_TOOLS" == "1" ]] || {
  echo "FASED_SYSTEMD_FIXTURE_PREINSTALLED_TOOLS must be 0 or 1." >&2
  exit 1
}

if [[ -z "$ARTIFACT_DIR" ]]; then
  GOTMPDIR="${GOTMPDIR:-${TMPDIR:-/tmp}/fased-go-tmp}" \
  GOCACHE="${GOCACHE:-${TMPDIR:-/tmp}/fased-go-cache}" \
  FASED_SIGNER_BUILD_COMMIT="$COMMIT" \
  FASED_SIGNER_TARGETS=linux/amd64 \
    bash "$ROOT_DIR/scripts/release-fased-signerd.sh"
  ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fased-protected-local-artifact.XXXXXX")"
  OWN_ARTIFACT_DIR=1
  pnpm --dir "$ROOT_DIR" hosted:artifact:from-dist --output "$ARTIFACT_DIR"
  cp -a "$ROOT_DIR/dist-native/release/." "$ARTIFACT_DIR/"
fi
[[ -f "$ARTIFACT_DIR/fased-hosted-linux-x64-v${VERSION}.tar.gz" ]] || {
  echo "The protected Local fixture requires the exact x64 packaged runtime artifact." >&2
  exit 1
}
[[ -f "$ARTIFACT_DIR/fased-signerd-linux-amd64" &&
  -f "$ARTIFACT_DIR/fased-signerd-release.json" ]] || {
  echo "The protected Local fixture requires the exact signer artifact and identity." >&2
  exit 1
}
if [[ ",$SCENARIOS," == *,install,* ]]; then
  if [[ -z "$LEGACY_ARTIFACT_DIR" ]]; then
    LEGACY_ARTIFACT_DIR="$(
      mktemp -d "${TMPDIR:-/tmp}/fased-protected-local-legacy-artifact.XXXXXX"
    )"
    OWN_LEGACY_ARTIFACT_DIR=1
    gh release download "v$LEGACY_VERSION" \
      --repo fased-ai/fased \
      --dir "$LEGACY_ARTIFACT_DIR" \
      --pattern "install.sh" \
      --pattern "fased-hosted-release-v2.json" \
      --pattern "fased-hosted-release-v2.json.attestation.json" \
      --pattern "fased-hosted-app-v2-linux-x64-v${LEGACY_VERSION}.tar.gz" \
      --pattern "fased-hosted-deps-linux-x64-*.tar.gz" \
      --pattern "fased-signerd-linux-amd64" \
      --pattern "fased-signerd-release.json" \
      --pattern "fased-signerd-checksums.txt"
    chmod 0755 "$LEGACY_ARTIFACT_DIR"
  fi
  legacy_manifest="$LEGACY_ARTIFACT_DIR/fased-hosted-release-v2.json"
  legacy_app="$LEGACY_ARTIFACT_DIR/fased-hosted-app-v2-linux-x64-v${LEGACY_VERSION}.tar.gz"
  legacy_dependency="$(
    find "$LEGACY_ARTIFACT_DIR" -maxdepth 1 -type f \
      -name 'fased-hosted-deps-linux-x64-*.tar.gz' -print -quit
  )"
  [[ -f "$LEGACY_ARTIFACT_DIR/install.sh" &&
    -f "$legacy_manifest" &&
    -f "$LEGACY_ARTIFACT_DIR/fased-hosted-release-v2.json.attestation.json" &&
    -f "$legacy_app" &&
    -n "$legacy_dependency" &&
    -f "$legacy_dependency" &&
    -f "$LEGACY_ARTIFACT_DIR/fased-signerd-linux-amd64" &&
    -f "$LEGACY_ARTIFACT_DIR/fased-signerd-release.json" &&
    -f "$LEGACY_ARTIFACT_DIR/fased-signerd-checksums.txt" ]] || {
    echo "The protected Local update fixture requires the complete immutable predecessor release." >&2
    exit 1
  }
  jq -e --arg version "$LEGACY_VERSION" \
    '.release.version == $version and
      .release.tag == ("v" + $version) and
      .signer.release.version == $version and
      .signer.release.commit == .release.commit' \
    "$legacy_manifest" >/dev/null
  legacy_signer_sha="$(
    sha256sum "$LEGACY_ARTIFACT_DIR/fased-signerd-linux-amd64" | awk '{print $1}'
  )"
  jq -e --arg sha "$legacy_signer_sha" \
    '.signer.platforms["linux-amd64"].asset == "fased-signerd-linux-amd64" and
      .signer.platforms["linux-amd64"].sha256 == $sha' \
    "$legacy_manifest" >/dev/null
  jq -e --slurpfile signer "$LEGACY_ARTIFACT_DIR/fased-signerd-release.json" \
    '.signer.release == ($signer[0] | del(.schemaVersion))' \
    "$legacy_manifest" >/dev/null
fi
if [[ -z "$LEGACY_ARTIFACT_DIR" ]]; then
  LEGACY_ARTIFACT_DIR="$(
    mktemp -d "${TMPDIR:-/tmp}/fased-protected-local-legacy-artifact.XXXXXX"
  )"
  OWN_LEGACY_ARTIFACT_DIR=1
fi
cleanup_names=()
dump_fixture_failure() {
  local name="$1"
  echo "Protected Local fixture diagnostics: $name" >&2
  run_container exec "$name" /bin/bash -lc '
    systemctl --failed --no-pager >&2 || true
    systemctl cat "fased-gateway-*" >&2 || true
    find /var/lib/fased-local -maxdepth 4 -printf "%M %u:%g %p\n" >&2 2>/dev/null || true
    find /home/testop/.fased/wallet /home/testop/.fased/identity /home/testop/.fased \
      -maxdepth 1 -printf "%M %u:%g %p\n" >&2 2>/dev/null || true
    journalctl -u "fased-gateway-*" -u "fased-signerd-*" -u "fased-local-controller-*" -n 160 --no-pager >&2 || true
    for log in /var/lib/fased-local/*/signer/audit.jsonl /home/testop/.fased/logs/*.log /tmp/*.err /tmp/*.out /tmp/*.json; do
      [[ -f "$log" ]] || continue
      echo "==> $log" >&2
      tail -n 100 "$log" >&2 || true
    done
  ' || true
}

cleanup() {
  local name
  for name in "${cleanup_names[@]}"; do
    run_container rm -f "$name" >/dev/null 2>&1 || true
  done
  if [[ "$OWN_ARTIFACT_DIR" -eq 1 ]]; then
    rm -rf -- "$ARTIFACT_DIR"
  fi
  if [[ "$OWN_LEGACY_ARTIFACT_DIR" -eq 1 ]]; then
    rm -rf -- "$LEGACY_ARTIFACT_DIR"
  fi
}
trap cleanup EXIT INT TERM HUP

IFS=',' read -r -a distro_list <<<"$DISTROS"
IFS=',' read -r -a scenario_list <<<"$SCENARIOS"
run_fixture_scenario() {
  local distro="$1"
  local image="$2"
  local scenario="$3"
  local name="fased-protected-local-${distro}-${scenario}-$$"
  local ready=0
  local state=""

  cleanup_names+=("$name")
  run_container run -d \
    --name "$name" \
    --privileged \
    --systemd=always \
    --tmpfs /run \
    --tmpfs /tmp \
    -e "FASED_FIXTURE_VERSION=$VERSION" \
    -e "FASED_FIXTURE_COMMIT=$COMMIT" \
    -e "FASED_FIXTURE_LEGACY_VERSION=$LEGACY_VERSION" \
    -e "FASED_FIXTURE_PREINSTALLED_TOOLS=$PREINSTALLED_TOOLS" \
    -v "$ROOT_DIR:/repo:ro,Z" \
    -v "$FIXTURE_DIR/run.sh:/usr/local/bin/fased-protected-local-systemd-fixture:ro,Z" \
    -v "$ARTIFACT_DIR:/artifacts:ro,Z" \
    -v "$LEGACY_ARTIFACT_DIR:/legacy-artifacts:ro,Z" \
    "$image" >/dev/null
  for _ in {1..200}; do
    state="$(run_container exec "$name" systemctl is-system-running 2>/dev/null || true)"
    if [[ "$state" == "running" || "$state" == "degraded" ]]; then
      ready=1
      break
    fi
    sleep 0.1
  done
  [[ "$ready" -eq 1 ]] || {
    echo "$distro systemd fixture did not become ready." >&2
    exit 1
  }
  if ! run_container exec "$name" /bin/bash \
    /usr/local/bin/fased-protected-local-systemd-fixture "$scenario"; then
    dump_fixture_failure "$name"
    exit 1
  fi
  run_container stop "$name" >/dev/null
  run_container start "$name" >/dev/null
  ready=0
  for _ in {1..200}; do
    state="$(run_container exec "$name" systemctl is-system-running 2>/dev/null || true)"
    if [[ "$state" == "running" || "$state" == "degraded" ]]; then
      ready=1
      break
    fi
    sleep 0.1
  done
  [[ "$ready" -eq 1 ]] || {
    echo "$distro systemd fixture did not recover after container reboot." >&2
    exit 1
  }
  if ! run_container exec "$name" /bin/bash \
    /usr/local/bin/fased-protected-local-systemd-fixture verify-reboot; then
    dump_fixture_failure "$name"
    exit 1
  fi
  run_container rm -f "$name" >/dev/null
}

for distro in "${distro_list[@]}"; do
  containerfile="$FIXTURE_DIR/Containerfile.$distro"
  [[ -f "$containerfile" ]] || {
    echo "Unsupported protected Local fixture distro: $distro" >&2
    exit 1
  }
  image="fased-protected-local-systemd-${distro}:local"
  image_started="$SECONDS"
  archive=""
  if [[ -n "$IMAGE_CACHE_DIR" ]]; then
    mkdir -p "$IMAGE_CACHE_DIR"
    archive="$IMAGE_CACHE_DIR/${distro}.oci.tar"
  fi
  if [[ -n "$archive" && -s "$archive" ]]; then
    run_container load --input "$archive" >/dev/null
    run_container image exists "$image"
    printf 'fixture timing: distro=%s stage=image-cache-load elapsed=%ss\n' \
      "$distro" "$((SECONDS - image_started))"
  else
    run_container build -f "$containerfile" -t "$image" "$FIXTURE_DIR"
    if [[ -n "$archive" ]]; then
      run_container save --format oci-archive --output "$archive" "$image"
    fi
    printf 'fixture timing: distro=%s stage=image-build elapsed=%ss\n' \
      "$distro" "$((SECONDS - image_started))"
  fi
done

for scenario in "${scenario_list[@]}"; do
  case "$scenario" in
    fresh-install|install) ;;
    *)
      echo "Unsupported protected Local fixture scenario: $scenario" >&2
      exit 1
      ;;
  esac
  for distro in "${distro_list[@]}"; do
    image="fased-protected-local-systemd-${distro}:local"
    fixture_started="$SECONDS"
    run_fixture_scenario "$distro" "$image" "$scenario"
    printf 'fixture timing: distro=%s scenario=%s stage=complete elapsed=%ss\n' \
      "$distro" "$scenario" "$((SECONDS - fixture_started))"
  done
done

echo "Protected Local systemd fixtures passed: distros=$DISTROS scenarios=$SCENARIOS"
