#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${FASED_CONTAINER_RUNTIME:-podman}"
DISTROS="${FASED_SYSTEMD_FIXTURE_DISTROS:-ubuntu,rocky}"
SCENARIOS="${FASED_SYSTEMD_FIXTURE_SCENARIOS:-fresh-install,install}"
FIXTURE_DIR="$ROOT_DIR/scripts/docker/protected-local-systemd"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT_DIR/package.json")"
COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
ARTIFACT_DIR="${FASED_SYSTEMD_FIXTURE_ARTIFACT_DIR:-}"
OWN_ARTIFACT_DIR=0
LEGACY_VERSION="${FASED_SYSTEMD_FIXTURE_LEGACY_VERSION:-0.1.76-rc.7}"
LEGACY_ARTIFACT_DIR="${FASED_SYSTEMD_FIXTURE_LEGACY_ARTIFACT_DIR:-}"
OWN_LEGACY_ARTIFACT_DIR=0

command -v "$RUNTIME" >/dev/null 2>&1 || {
  echo "Podman is required for the protected Local systemd fixtures." >&2
  exit 1
}
command -v gh >/dev/null 2>&1 || {
  echo "GitHub CLI is required for the literal Protected Local update fixture." >&2
  exit 1
}
[[ "$RUNTIME" == "podman" ]] || {
  echo "The protected Local systemd fixtures currently require Podman." >&2
  exit 1
}

GOTMPDIR="${GOTMPDIR:-${TMPDIR:-/tmp}/fased-go-tmp}" \
GOCACHE="${GOCACHE:-${TMPDIR:-/tmp}/fased-go-cache}" \
FASED_SIGNER_TARGETS=linux/amd64 \
  bash "$ROOT_DIR/scripts/release-fased-signerd.sh"

if [[ -z "$ARTIFACT_DIR" ]]; then
  ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fased-protected-local-artifact.XXXXXX")"
  OWN_ARTIFACT_DIR=1
  pnpm --dir "$ROOT_DIR" hosted:artifact:from-dist --output "$ARTIFACT_DIR"
fi
[[ -f "$ARTIFACT_DIR/fased-hosted-linux-x64-v${VERSION}.tar.gz" ]] || {
  echo "The protected Local fixture requires the exact x64 packaged runtime artifact." >&2
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
      --pattern "fased-hosted-linux-x64-v${LEGACY_VERSION}.tar.gz" \
      --pattern "fased-hosted-linux-x64-v${LEGACY_VERSION}.tar.gz.sha256"
  fi
  legacy_asset="$LEGACY_ARTIFACT_DIR/fased-hosted-linux-x64-v${LEGACY_VERSION}.tar.gz"
  legacy_checksum="$legacy_asset.sha256"
  [[ -f "$legacy_asset" && -f "$legacy_checksum" ]] || {
    echo "The protected Local update fixture requires the exact published legacy runtime." >&2
    exit 1
  }
  (
    cd "$LEGACY_ARTIFACT_DIR"
    sha256sum -c "$(basename "$legacy_checksum")"
  )
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
  "$RUNTIME" exec "$name" /bin/bash -lc '
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
    "$RUNTIME" rm -f "$name" >/dev/null 2>&1 || true
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
  "$RUNTIME" run -d \
    --name "$name" \
    --privileged \
    --systemd=always \
    --tmpfs /run \
    --tmpfs /tmp \
    -e "FASED_FIXTURE_VERSION=$VERSION" \
    -e "FASED_FIXTURE_COMMIT=$COMMIT" \
    -e "FASED_FIXTURE_LEGACY_VERSION=$LEGACY_VERSION" \
    -v "$ROOT_DIR:/repo:ro,Z" \
    -v "$ARTIFACT_DIR:/artifacts:ro,Z" \
    -v "$LEGACY_ARTIFACT_DIR:/legacy-artifacts:ro,Z" \
    "$image" >/dev/null
  if [[ "$distro" == "ubuntu" ]]; then
    "$RUNTIME" cp "$(command -v gh)" "$name:/usr/bin/gh"
  fi
  for _ in {1..200}; do
    state="$("$RUNTIME" exec "$name" systemctl is-system-running 2>/dev/null || true)"
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
  if ! "$RUNTIME" exec "$name" \
    /usr/local/bin/fased-protected-local-systemd-fixture "$scenario"; then
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
    echo "$distro systemd fixture did not recover after container reboot." >&2
    exit 1
  }
  if ! "$RUNTIME" exec "$name" /usr/local/bin/fased-protected-local-systemd-fixture verify-reboot; then
    dump_fixture_failure "$name"
    exit 1
  fi
  "$RUNTIME" rm -f "$name" >/dev/null
}

for distro in "${distro_list[@]}"; do
  containerfile="$FIXTURE_DIR/Containerfile.$distro"
  [[ -f "$containerfile" ]] || {
    echo "Unsupported protected Local fixture distro: $distro" >&2
    exit 1
  }
  image="fased-protected-local-systemd-${distro}:local"
  "$RUNTIME" build -f "$containerfile" -t "$image" "$FIXTURE_DIR"
  for scenario in "${scenario_list[@]}"; do
    case "$scenario" in
      fresh-install|install) ;;
      *)
        echo "Unsupported protected Local fixture scenario: $scenario" >&2
        exit 1
        ;;
    esac
    run_fixture_scenario "$distro" "$image" "$scenario"
  done
done

echo "Protected Local systemd fixtures passed: distros=$DISTROS scenarios=$SCENARIOS"
