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
PUBLIC_ACQUISITION="${FASED_SYSTEMD_FIXTURE_PUBLIC_ACQUISITION:-0}"
PREDECESSOR_VERSION="${FASED_SYSTEMD_FIXTURE_PREDECESSOR_VERSION:-}"
PREDECESSOR_ARTIFACT_DIR="${FASED_SYSTEMD_FIXTURE_PREDECESSOR_ARTIFACT_DIR:-}"
OWN_PREDECESSOR_ARTIFACT_DIR=0
MANAGED_PREDECESSOR_VERSION="${FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_VERSION:-}"
MANAGED_PREDECESSOR_ARTIFACT_DIR="${FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_ARTIFACT_DIR:-}"
OWN_MANAGED_PREDECESSOR_ARTIFACT_DIR=0
SOURCE_REPO_DIR=""
OWN_SOURCE_REPO_DIR=0

command -v "$RUNTIME" >/dev/null 2>&1 || {
  echo "Podman is required for the protected Local systemd fixtures." >&2
  exit 1
}
if [[ ",$SCENARIOS," == *,install,* || ",$SCENARIOS," == *,managed-update,* ]]; then
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
[[ "$PUBLIC_ACQUISITION" == "0" || "$PUBLIC_ACQUISITION" == "1" ]] || {
  echo "FASED_SYSTEMD_FIXTURE_PUBLIC_ACQUISITION must be 0 or 1." >&2
  exit 1
}

if [[ -z "$ARTIFACT_DIR" ]]; then
  [[ -x "$ROOT_DIR/node_modules/.bin/tsdown" &&
    -x "$ROOT_DIR/ui/node_modules/.bin/vite" ]] || {
    echo "The protected Local fixture requires a complete frozen development install." >&2
    echo "Run pnpm install --frozen-lockfile from the repository root, then retry." >&2
    exit 1
  }
  if [[ ! -f "$ROOT_DIR/dist/build-info.json" ]] ||
    [[ "$(jq -r .version "$ROOT_DIR/dist/build-info.json")" != "$VERSION" ]] ||
    [[ "$(jq -r .commit "$ROOT_DIR/dist/build-info.json")" != "$COMMIT" ]]; then
    pnpm --dir "$ROOT_DIR" build
  fi
  [[ "$(jq -r .version "$ROOT_DIR/dist/build-info.json")" == "$VERSION" &&
    "$(jq -r .commit "$ROOT_DIR/dist/build-info.json")" == "$COMMIT" ]] || {
    echo "The protected Local fixture refuses stale dist identity." >&2
    exit 1
  }
  fixture_go_tmp="${GOTMPDIR:-${TMPDIR:-/tmp}/fased-go-tmp}"
  fixture_go_cache="${GOCACHE:-${TMPDIR:-/tmp}/fased-go-cache}"
  mkdir -p "$fixture_go_tmp" "$fixture_go_cache"
  GOTMPDIR="$fixture_go_tmp" \
  GOCACHE="$fixture_go_cache" \
  FASED_SIGNER_BUILD_COMMIT="$COMMIT" \
  FASED_SIGNER_TARGETS=linux/amd64 \
    bash "$ROOT_DIR/scripts/release-fased-signerd.sh"
  GOTMPDIR="$fixture_go_tmp" \
  GOCACHE="$fixture_go_cache" \
  FASED_LIFECYCLE_BUILD_COMMIT="$COMMIT" \
  FASED_LIFECYCLE_BUILD_TREE="$(git -C "$ROOT_DIR" rev-parse 'HEAD^{tree}')" \
  FASED_LIFECYCLE_TARGETS=linux/amd64 \
    bash "$ROOT_DIR/scripts/release-fased-lifecycled.sh"
  ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fased-protected-local-artifact.XXXXXX")"
  OWN_ARTIFACT_DIR=1
  pnpm --dir "$ROOT_DIR" hosted:artifact:from-dist --output "$ARTIFACT_DIR"
  cp -a "$ROOT_DIR/dist-native/release/." "$ARTIFACT_DIR/"
  node "$ROOT_DIR/scripts/assemble-lifecycle-generation.mjs" \
    --runtime-archive "$ARTIFACT_DIR/fased-hosted-linux-x64-v${VERSION}.tar.gz" \
    --signer "$ARTIFACT_DIR/fased-signerd-linux-amd64" \
    --lifecycled "$ARTIFACT_DIR/fased-lifecycled-linux-amd64" \
    --output-dir "$ARTIFACT_DIR" \
    --version "$VERSION" \
    --commit "$COMMIT" \
    --tree "$(git -C "$ROOT_DIR" rev-parse 'HEAD^{tree}')" \
    --architecture x64
  node "$ROOT_DIR/scripts/release-artifact-set.mjs" build \
    --directory "$ARTIFACT_DIR" \
    --version "$VERSION" \
    --commit "$COMMIT" \
    --tree "$(git -C "$ROOT_DIR" rev-parse 'HEAD^{tree}')" \
    --lockfile-digest "sha256:$(sha256sum "$ROOT_DIR/pnpm-lock.yaml" | awk '{print $1}')" \
    --source-ref "refs/tags/v${VERSION}" \
    --workflow-run-id 1 \
    --workflow-run-attempt 1
  printf '{"fixtureOfflineAttestation":true}\n' \
    >"$ARTIFACT_DIR/fased-hosting-candidate.json.attestation.json"
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
if [[ "$PUBLIC_ACQUISITION" == "1" ]]; then
  for required_asset in \
    install.sh \
    fased-hosted-release-v2.json \
    fased-hosted-release-v2.json.attestation.json \
    fased-lifecycle-trust-v1.json \
    fased-lifecycle-trust-v1.json.attestation.json \
    fased-privileged-provenance-v1.intoto.json \
    fased-privileged-provenance-v1.intoto.json.attestation.json \
    fased-lifecycle-supervisor.mjs \
    fased-lifecycle-supervisor.mjs.attestation.json \
    fased-host-updater.mjs \
    fased-host-updater.mjs.attestation.json \
    fased-host-updaterctl.mjs \
    fased-host-updaterctl.mjs.attestation.json \
    fased-signerd-release.attestation.json \
    fased-hosting-candidate.json \
    fased-hosting-candidate.json.attestation.json \
    "fased-generation-linux-x64-v${VERSION}.tar.gz"; do
    [[ -f "$ARTIFACT_DIR/$required_asset" ]] || {
      echo "The public-acquisition fixture is missing $required_asset." >&2
      exit 1
    }
  done
  grep -Fqx \
    "install_entry_release_identity=\"${VERSION}\"" \
    "$ARTIFACT_DIR/install.sh" || {
    echo "The public-acquisition fixture requires the exact stamped installer identity." >&2
    exit 1
  }
  jq -e --arg version "$VERSION" --arg commit "$COMMIT" \
    '.release.version == $version and
      .release.tag == ("v" + $version) and
      .release.commit == $commit' \
    "$ARTIFACT_DIR/fased-hosted-release-v2.json" >/dev/null || {
    echo "The public-acquisition fixture requires the exact candidate manifest identity." >&2
    exit 1
  }
fi
if [[ ",$SCENARIOS," == *,install,* ]]; then
  [[ "$PREDECESSOR_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || {
    echo "The install fixture requires FASED_SYSTEMD_FIXTURE_PREDECESSOR_VERSION." >&2
    exit 1
  }
  if [[ -z "$PREDECESSOR_ARTIFACT_DIR" ]]; then
    PREDECESSOR_ARTIFACT_DIR="$(
      mktemp -d "${TMPDIR:-/tmp}/fased-protected-local-predecessor-artifact.XXXXXX"
    )"
    OWN_PREDECESSOR_ARTIFACT_DIR=1
    gh release download "v$PREDECESSOR_VERSION" \
      --repo fased-ai/fased \
      --dir "$PREDECESSOR_ARTIFACT_DIR" \
      --pattern "install.sh" \
      --pattern "fased-hosted-release-v2.json" \
      --pattern "fased-hosted-release-v2.json.attestation.json" \
      --pattern "fased-hosted-app-v2-linux-x64-v${PREDECESSOR_VERSION}.tar.gz" \
      --pattern "fased-hosted-deps-linux-x64-*.tar.gz" \
      --pattern "fased-signerd-linux-amd64" \
      --pattern "fased-signerd-release.json" \
      --pattern "fased-signerd-checksums.txt"
    chmod 0755 "$PREDECESSOR_ARTIFACT_DIR"
  fi
  predecessor_manifest="$PREDECESSOR_ARTIFACT_DIR/fased-hosted-release-v2.json"
  predecessor_app="$PREDECESSOR_ARTIFACT_DIR/fased-hosted-app-v2-linux-x64-v${PREDECESSOR_VERSION}.tar.gz"
  predecessor_dependency="$(
    find "$PREDECESSOR_ARTIFACT_DIR" -maxdepth 1 -type f \
      -name 'fased-hosted-deps-linux-x64-*.tar.gz' -print -quit
  )"
  [[ -f "$PREDECESSOR_ARTIFACT_DIR/install.sh" &&
    -f "$predecessor_manifest" &&
    -f "$PREDECESSOR_ARTIFACT_DIR/fased-hosted-release-v2.json.attestation.json" &&
    -f "$predecessor_app" &&
    -n "$predecessor_dependency" &&
    -f "$predecessor_dependency" &&
    -f "$PREDECESSOR_ARTIFACT_DIR/fased-signerd-linux-amd64" &&
    -f "$PREDECESSOR_ARTIFACT_DIR/fased-signerd-release.json" &&
    -f "$PREDECESSOR_ARTIFACT_DIR/fased-signerd-checksums.txt" ]] || {
    echo "The protected Local update fixture requires the complete immutable predecessor release." >&2
    exit 1
  }
  jq -e --arg version "$PREDECESSOR_VERSION" \
    '.release.version == $version and
      .release.tag == ("v" + $version) and
      .signer.release.version == $version and
      .signer.release.commit == .release.commit' \
    "$predecessor_manifest" >/dev/null
  predecessor_signer_sha="$(
    sha256sum "$PREDECESSOR_ARTIFACT_DIR/fased-signerd-linux-amd64" | awk '{print $1}'
  )"
  jq -e --arg sha "$predecessor_signer_sha" \
    '.signer.platforms["linux-amd64"].asset == "fased-signerd-linux-amd64" and
      .signer.platforms["linux-amd64"].sha256 == $sha' \
    "$predecessor_manifest" >/dev/null
  jq -e --slurpfile signer "$PREDECESSOR_ARTIFACT_DIR/fased-signerd-release.json" \
    '.signer.release == ($signer[0] | del(.schemaVersion))' \
    "$predecessor_manifest" >/dev/null
fi
if [[ ",$SCENARIOS," == *,managed-update,* ]]; then
  [[ "$MANAGED_PREDECESSOR_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || {
    echo "The managed-update fixture requires FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_VERSION." >&2
    exit 1
  }
  if [[ -z "$MANAGED_PREDECESSOR_ARTIFACT_DIR" ]]; then
    MANAGED_PREDECESSOR_ARTIFACT_DIR="$(
      mktemp -d "${TMPDIR:-/tmp}/fased-protected-local-managed-predecessor-artifact.XXXXXX"
    )"
    OWN_MANAGED_PREDECESSOR_ARTIFACT_DIR=1
    gh release download "v$MANAGED_PREDECESSOR_VERSION" \
      --repo fased-ai/fased \
      --dir "$MANAGED_PREDECESSOR_ARTIFACT_DIR"
    chmod 0755 "$MANAGED_PREDECESSOR_ARTIFACT_DIR"
  fi
  managed_predecessor_manifest="$MANAGED_PREDECESSOR_ARTIFACT_DIR/fased-hosted-release-v2.json"
  [[ -f "$MANAGED_PREDECESSOR_ARTIFACT_DIR/install.sh" && -f "$managed_predecessor_manifest" ]] || {
    echo "The managed Protected Local update fixture requires a complete predecessor release." >&2
    exit 1
  }
  jq -e --arg version "$MANAGED_PREDECESSOR_VERSION" \
    '.release.version == $version and .release.tag == ("v" + $version)' \
    "$managed_predecessor_manifest" >/dev/null
fi
if [[ -z "$PREDECESSOR_ARTIFACT_DIR" ]]; then
  PREDECESSOR_ARTIFACT_DIR="$(
    mktemp -d "${TMPDIR:-/tmp}/fased-protected-local-predecessor-artifact.XXXXXX"
  )"
  OWN_PREDECESSOR_ARTIFACT_DIR=1
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
  if [[ "$OWN_PREDECESSOR_ARTIFACT_DIR" -eq 1 ]]; then
    rm -rf -- "$PREDECESSOR_ARTIFACT_DIR"
  fi
  if [[ "$OWN_MANAGED_PREDECESSOR_ARTIFACT_DIR" -eq 1 ]]; then
    rm -rf -- "$MANAGED_PREDECESSOR_ARTIFACT_DIR"
  fi
  if [[ "$OWN_SOURCE_REPO_DIR" -eq 1 ]]; then
    rm -rf -- "$SOURCE_REPO_DIR"
  fi
}
trap cleanup EXIT INT TERM HUP

SOURCE_REPO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fased-protected-local-source.XXXXXX")"
OWN_SOURCE_REPO_DIR=1
git clone --quiet --no-hardlinks "$ROOT_DIR" "$SOURCE_REPO_DIR"
git -C "$SOURCE_REPO_DIR" checkout --quiet --detach "$COMMIT"
[[ "$(git -C "$SOURCE_REPO_DIR" rev-parse HEAD)" == "$COMMIT" ]] || {
  echo "The protected Local fixture failed to materialize the exact source commit." >&2
  exit 1
}

IFS=',' read -r -a distro_list <<<"$DISTROS"
IFS=',' read -r -a scenario_list <<<"$SCENARIOS"
run_fixture_scenario() {
  local distro="$1"
  local image="$2"
  local scenario="$3"
  local name="fased-protected-local-${distro}-${scenario}-$$"
  local fixture_command_pid=""
  local fixture_command_started=""
  local fixture_command_status=0
  local fixture_memory=""
  local ready=0
  local state=""
  local predecessor_artifact_dir="$PREDECESSOR_ARTIFACT_DIR"
  local predecessor_version="$PREDECESSOR_VERSION"
  if [[ "$scenario" == "managed-update" ]]; then
    predecessor_artifact_dir="$MANAGED_PREDECESSOR_ARTIFACT_DIR"
    predecessor_version="$MANAGED_PREDECESSOR_VERSION"
  fi

  cleanup_names+=("$name")
  run_container run -d \
    --name "$name" \
    --privileged \
    --systemd=always \
    --tmpfs /run \
    --tmpfs /tmp \
    -e "FASED_FIXTURE_VERSION=$VERSION" \
    -e "FASED_FIXTURE_COMMIT=$COMMIT" \
    -e "FASED_FIXTURE_PREDECESSOR_VERSION=$predecessor_version" \
    -e "FASED_FIXTURE_PREINSTALLED_TOOLS=$PREINSTALLED_TOOLS" \
    -e "FASED_FIXTURE_PUBLIC_ACQUISITION=$PUBLIC_ACQUISITION" \
    -v "$SOURCE_REPO_DIR:/repo:ro,Z" \
    -v "$FIXTURE_DIR/run.sh:/usr/local/bin/fased-protected-local-systemd-fixture:ro,Z" \
    -v "$ARTIFACT_DIR:/artifacts:ro,Z" \
    -v "$predecessor_artifact_dir:/predecessor-artifacts:ro,Z" \
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
  fixture_command_started="$SECONDS"
  run_container exec "$name" /bin/bash \
    /usr/local/bin/fased-protected-local-systemd-fixture "$scenario" &
  fixture_command_pid="$!"
  while kill -0 "$fixture_command_pid" 2>/dev/null; do
    sleep 15
    if kill -0 "$fixture_command_pid" 2>/dev/null; then
      fixture_memory="$(
        run_container stats --no-stream --format '{{.MemUsage}}' "$name" 2>/dev/null || true
      )"
      printf \
        'fixture heartbeat: distro=%s scenario=%s stage=product-lifecycle elapsed=%ss memory=%s\n' \
        "$distro" \
        "$scenario" \
        "$((SECONDS - fixture_command_started))" \
        "${fixture_memory:-unavailable}"
    fi
  done
  wait "$fixture_command_pid" || fixture_command_status="$?"
  if [[ "$fixture_command_status" -ne 0 ]]; then
    dump_fixture_failure "$name"
    return "$fixture_command_status"
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
    fresh-install|install|managed-update) ;;
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
