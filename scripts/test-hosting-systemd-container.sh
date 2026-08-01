#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${FASED_CONTAINER_RUNTIME:-podman}"
DISTROS="${FASED_HOSTING_SYSTEMD_FIXTURE_DISTROS:-ubuntu,rocky}"
FIXTURE_DIR="$ROOT_DIR/scripts/docker/hosting-systemd"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT_DIR/package.json")"
COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
ARTIFACT_DIR="${FASED_HOSTING_SYSTEMD_FIXTURE_ARTIFACT_DIR:-}"
OWN_ARTIFACT_DIR=0
FIXTURE_ASSETS="$(mktemp -d "${TMPDIR:-/tmp}/fased-hosting-systemd-assets.XXXXXX")"

command -v "$RUNTIME" >/dev/null 2>&1 || {
  echo "Podman is required for the Hosting systemd fixtures." >&2
  exit 1
}
[[ "$RUNTIME" == "podman" ]] || {
  echo "The Hosting systemd fixtures currently require Podman." >&2
  exit 1
}

GOTMPDIR="${GOTMPDIR:-${TMPDIR:-/tmp}/fased-go-tmp}" \
GOCACHE="${GOCACHE:-${TMPDIR:-/tmp}/fased-go-cache}" \
FASED_SIGNER_TARGETS=linux/amd64 \
  bash "$ROOT_DIR/scripts/release-fased-signerd.sh"

if [[ -z "$ARTIFACT_DIR" ]]; then
  ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fased-hosting-systemd-artifact.XXXXXX")"
  OWN_ARTIFACT_DIR=1
  pnpm --dir "$ROOT_DIR" hosted:artifact:from-dist --output "$ARTIFACT_DIR"
fi

cleanup_names=()
cleanup() {
  local status=$?
  local name
  if [[ "$status" -ne 0 && "${FASED_KEEP_FAILED_CONTAINER:-0}" == "1" ]]; then
    printf 'Preserving failed Hosting fixture container(s): %s\n' "${cleanup_names[*]}" >&2
    return
  fi
  for name in "${cleanup_names[@]}"; do
    "$RUNTIME" rm -f "$name" >/dev/null 2>&1 || true
  done
  rm -rf -- "$FIXTURE_ASSETS"
  if [[ "$OWN_ARTIFACT_DIR" -eq 1 ]]; then
    rm -rf -- "$ARTIFACT_DIR"
  fi
}
trap cleanup EXIT INT TERM HUP

app_asset="fased-hosted-app-v2-linux-x64-v${VERSION}.tar.gz"
app_identity="fased-hosted-app-linux-x64-v${VERSION}.tar.gz.release.json"
[[ -f "$ARTIFACT_DIR/$app_asset" && -f "$ARTIFACT_DIR/$app_identity" ]] || {
  echo "The Hosting fixture requires the exact x64 application artifact and identity." >&2
  exit 1
}
cp "$ARTIFACT_DIR/$app_asset" "$FIXTURE_ASSETS/$app_asset"
cp "$ARTIFACT_DIR/$app_identity" "$FIXTURE_ASSETS/$app_identity"
dependency_hash="$(jq -er .dependencyHash "$FIXTURE_ASSETS/$app_identity")"
dependency_asset="fased-hosted-deps-linux-x64-${dependency_hash}.tar.gz"
cp "$ARTIFACT_DIR/$dependency_asset" "$FIXTURE_ASSETS/$dependency_asset"
cp "$ARTIFACT_DIR/fased-hosted-components-linux-x64-v${VERSION}.spdx.json" \
  "$FIXTURE_ASSETS/fased-hosted-components-linux-x64-v${VERSION}.spdx.json"

arm_app_asset="fased-hosted-app-v2-linux-arm64-v${VERSION}.tar.gz"
arm_dependency_asset="fased-hosted-deps-linux-arm64-${dependency_hash}.tar.gz"
arm_identity="fased-hosted-app-linux-arm64-v${VERSION}.tar.gz.release.json"
cp "$FIXTURE_ASSETS/$app_asset" "$FIXTURE_ASSETS/$arm_app_asset"
cp "$FIXTURE_ASSETS/$dependency_asset" "$FIXTURE_ASSETS/$arm_dependency_asset"
jq \
  --arg app "$arm_app_asset" \
  --arg dependencies "$arm_dependency_asset" \
  '.architecture = "arm64" | .app.asset = $app | .dependencies.asset = $dependencies' \
  "$FIXTURE_ASSETS/$app_identity" >"$FIXTURE_ASSETS/$arm_identity"

for platform in linux-amd64 linux-arm64 darwin-amd64 darwin-arm64; do
  cp "$ROOT_DIR/dist-native/release/fased-signerd-linux-amd64" \
    "$FIXTURE_ASSETS/fased-signerd-${platform}"
done
cp "$ROOT_DIR/dist-native/release/fased-signerd-release.json" \
  "$FIXTURE_ASSETS/fased-signerd-release.json"
cp "$ROOT_DIR/dist-native/release/fased-signerd-components-v${VERSION}.spdx.json" \
  "$FIXTURE_ASSETS/fased-signerd-components-v${VERSION}.spdx.json"
cp "$ROOT_DIR/install.sh" "$FIXTURE_ASSETS/install.sh"
cp "$ROOT_DIR/scripts/fased-lifecycle-supervisor.mjs" \
  "$FIXTURE_ASSETS/fased-lifecycle-supervisor.mjs"
cp "$ROOT_DIR/scripts/fased-host-updater.mjs" "$FIXTURE_ASSETS/fased-host-updater.mjs"
cp "$ROOT_DIR/scripts/fased-host-updaterctl.mjs" "$FIXTURE_ASSETS/fased-host-updaterctl.mjs"
cp "$ROOT_DIR/scripts/privileged-release-evidence.mjs" \
  "$FIXTURE_ASSETS/fased-privileged-release-evidence.mjs"
for bundle in \
  fased-hosted-release-v2.json.attestation.json \
  fased-signerd-release.attestation.json \
  fased-host-updater.mjs.attestation.json \
  fased-host-updaterctl.mjs.attestation.json; do
  printf '{"fixture":true}\n' >"$FIXTURE_ASSETS/$bundle"
done
printf '%s\n' "$VERSION" >"$FIXTURE_ASSETS/fixture-version"
printf '%s\n' "$COMMIT" >"$FIXTURE_ASSETS/fixture-commit"
node "$ROOT_DIR/scripts/build-hosted-release-manifest.mjs" \
  --assets "$FIXTURE_ASSETS" \
  --version "$VERSION" \
  --commit "$COMMIT" \
  --output "$FIXTURE_ASSETS/fased-hosted-release-v2.json"
chmod 0755 "$FIXTURE_ASSETS"
chmod 0644 "$FIXTURE_ASSETS"/*

dump_fixture_failure() {
  local name="$1"
  echo "Hosting fixture diagnostics: $name" >&2
  "$RUNTIME" exec "$name" /bin/bash -lc '
    for focused in /tmp/failure-activate.err /tmp/failure-activate.out /tmp/fased-fixture-stage.out; do
      [[ -f "$focused" ]] || continue
      echo "==> $focused" >&2
      cat "$focused" >&2 || true
    done
    systemctl --failed --no-pager >&2 || true
    journalctl \
      -u fased-host-controller.service \
      -u fased-host-updater.service \
      -u fased-signerd.service \
      -u fased-gateway.service \
      -n 180 --no-pager >&2 || true
    for log in /var/lib/fased-signerd/audit.jsonl /home/app/.fased/logs/*.log /tmp/*.err /tmp/*.out /tmp/*.json; do
      [[ -f "$log" ]] || continue
      echo "==> $log" >&2
      tail -n 120 "$log" >&2 || true
    done
    echo "==> controller generation diagnostics" >&2
    find /opt/fased/host-controller/releases -maxdepth 2 -printf "%m %u:%g %p\n" >&2 2>/dev/null || true
    sha256sum \
      /opt/fased/host-controller/releases/v*/fased-host-updater.mjs \
      /opt/fased/host-controller/releases/v*/fased-host-updaterctl.mjs \
      /artifacts/fased-host-updater.mjs \
      /artifacts/fased-host-updaterctl.mjs \
      /var/lib/fased-installer/releases/*/*/extract/package/scripts/fased-host-updater.mjs \
      /var/lib/fased-installer/releases/*/*/extract/package/scripts/fased-host-updaterctl.mjs \
      >&2 2>/dev/null || true
    cat /var/lib/fased-host-updater/controller-version.json >&2 2>/dev/null || true
    /usr/local/bin/fased-hosting-systemd-fixture controller-status >&2 2>/dev/null || true
    echo "==> lifecycle transaction diagnostics" >&2
    find /var/lib/fased-host-updater -maxdepth 5 -printf "%m %u:%g %p\n" >&2 2>/dev/null || true
    for record in \
      /var/lib/fased-host-updater/ctl-transaction.json \
      /var/lib/fased-host-updater/active-signer-transaction.json \
      /var/lib/fased-host-updater/supervisor/product-transaction.json \
      /var/lib/fased-host-updater/supervisor/controller-transaction.json \
      /var/lib/fased-host-updater/supervisor/controller-selections/*/*.json \
      /var/lib/fased-host-updater/supervisor/controller-selections/*/current \
      /var/lib/fased-host-updater/supervisor/receipts/*.json; do
      [[ -f "$record" ]] || continue
      echo "==> $record" >&2
      cat "$record" >&2 || true
    done
    sha256sum \
      /opt/fased/host-controller/supervisor/fased-lifecycle-supervisor.mjs \
      /artifacts/fased-lifecycle-supervisor.mjs \
      /repo/scripts/fased-lifecycle-supervisor.mjs \
      >&2 2>/dev/null || true
    grep -n "sameProductTransaction" \
      /opt/fased/host-controller/supervisor/fased-lifecycle-supervisor.mjs \
      >&2 2>/dev/null || true
  ' || true
}

IFS=',' read -r -a distro_list <<<"$DISTROS"
for distro in "${distro_list[@]}"; do
  containerfile="$FIXTURE_DIR/Containerfile.$distro"
  [[ -f "$containerfile" ]] || {
    echo "Unsupported Hosting fixture distro: $distro" >&2
    exit 1
  }
  image="fased-hosting-systemd-${distro}:local"
  name="fased-hosting-${distro}-$$"
  cleanup_names+=("$name")
  "$RUNTIME" build -f "$containerfile" -t "$image" "$FIXTURE_DIR"
  "$RUNTIME" run -d \
    --name "$name" \
    --privileged \
    --systemd=always \
    --tmpfs /run \
    --tmpfs /tmp \
    -e "FASED_FIXTURE_VERSION=$VERSION" \
    -e "FASED_FIXTURE_COMMIT=$COMMIT" \
    -v "$ROOT_DIR:/repo:ro,Z" \
    -v "$FIXTURE_ASSETS:/artifacts:ro,Z" \
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
    echo "$distro Hosting fixture did not become ready." >&2
    exit 1
  }
  if ! "$RUNTIME" exec "$name" /usr/local/bin/fased-hosting-systemd-fixture install; then
    dump_fixture_failure "$name"
    exit 1
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
    echo "$distro Hosting fixture did not recover after container reboot." >&2
    exit 1
  }
  if ! "$RUNTIME" exec "$name" /usr/local/bin/fased-hosting-systemd-fixture verify-reboot; then
    dump_fixture_failure "$name"
    exit 1
  fi
  "$RUNTIME" rm -f "$name" >/dev/null
  cleanup_names=("${cleanup_names[@]/$name}")
done

echo "Hosting systemd fixtures passed: $DISTROS"
