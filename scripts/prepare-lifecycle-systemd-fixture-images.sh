#!/usr/bin/env bash
set -euo pipefail

FASED_FIXTURE_IMAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FASED_FIXTURE_IMAGE_STAGING=""
FASED_FIXTURE_IMAGE_LOCK_FD=""

fased_fixture_image_dir() {
  case "${1:?fixture profile is required}" in
    local) printf '%s\n' "$FASED_FIXTURE_IMAGE_ROOT/scripts/docker/protected-local-systemd" ;;
    hosting) printf '%s\n' "$FASED_FIXTURE_IMAGE_ROOT/scripts/docker/hosting-systemd" ;;
    *) echo "Unsupported fixture image profile: $1" >&2; return 1 ;;
  esac
}

fased_fixture_image_digest() {
  local profile="${1:?fixture profile is required}"
  local distro="${2:?fixture distro is required}"
  local image_dir=""
  local path=""
  local relative=""
  local -a inputs=()
  image_dir="$(fased_fixture_image_dir "$profile")"
  inputs+=("$image_dir/Containerfile.$distro")
  if [[ "$profile" == "local" && "$distro" == "rocky" ]]; then
    inputs+=(
      "$image_dir/user-at-no-pam.conf"
      "$image_dir/sudo-no-pam.conf"
    )
  elif [[ "$profile" == "hosting" ]]; then
    inputs+=("$image_dir/updater-request.mjs")
  fi
  for path in "${inputs[@]}"; do
    [[ -f "$path" && ! -L "$path" ]] || {
      echo "Fixture image input is missing or unsafe: $path" >&2
      return 1
    }
    relative="${path#"$FASED_FIXTURE_IMAGE_ROOT/"}"
    printf '%s\t%s\n' "$relative" "$(sha256sum "$path" | awk '{print $1}')"
  done | sha256sum | awk '{print $1}'
}

fased_fixture_image_ref() {
  local profile="${1:?fixture profile is required}"
  local distro="${2:?fixture distro is required}"
  local digest="${3:?fixture digest is required}"
  local prefix="fased-protected-local-systemd"
  [[ "$profile" == "local" ]] || prefix="fased-hosting-systemd"
  printf '%s-%s:fixture-%s\n' "$prefix" "$distro" "${digest:0:24}"
}

fased_fixture_image_archive() {
  local cache_dir="${1:?fixture image cache directory is required}"
  local profile="${2:?fixture profile is required}"
  local distro="${3:?fixture distro is required}"
  local digest="${4:?fixture digest is required}"
  printf '%s/%s-%s-%s.oci.tar\n' "$cache_dir" "$profile" "$distro" "$digest"
}

fased_fixture_verify_image() {
  local image="${1:?fixture image is required}"
  local digest="${2:?fixture digest is required}"
  local actual=""
  actual="$(run_container image inspect --format '{{ index .Labels "io.fased.fixture.input-digest" }}' "$image")"
  [[ "$actual" == "sha256:$digest" ]] || {
    echo "Fixture image input digest mismatch: $image" >&2
    return 1
  }
}

fased_fixture_prepare_main() {
  local profile="${FASED_SYSTEMD_FIXTURE_PROFILE:-local}"
  local runtime="${FASED_CONTAINER_RUNTIME:-podman}"
  local oci_runtime="${FASED_CONTAINER_OCI_RUNTIME:-}"
  local cache_home="${XDG_CACHE_HOME:-${HOME:-${TMPDIR:-/tmp}}/.cache}"
  local distros=""
  local cache_dir=""
  local image_dir=""
  local distro=""
  local digest=""
  local image=""
  local archive=""
  cleanup_prepare() {
    local status=$?
    [[ -z "$FASED_FIXTURE_IMAGE_STAGING" ]] || rm -f -- "$FASED_FIXTURE_IMAGE_STAGING"
    if [[ -n "$FASED_FIXTURE_IMAGE_LOCK_FD" ]]; then
      flock -u "$FASED_FIXTURE_IMAGE_LOCK_FD" >/dev/null 2>&1 || true
      exec {FASED_FIXTURE_IMAGE_LOCK_FD}>&-
    fi
    return "$status"
  }
  trap cleanup_prepare EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP

  case "$profile" in
    local)
      distros="${FASED_SYSTEMD_FIXTURE_DISTROS:-ubuntu,rocky}"
      cache_dir="${FASED_SYSTEMD_FIXTURE_IMAGE_CACHE_DIR:-$cache_home/fased-dev/lifecycle-fixture-images/local}"
      ;;
    hosting)
      distros="${FASED_HOSTING_SYSTEMD_FIXTURE_DISTROS:-ubuntu}"
      cache_dir="${FASED_HOSTING_SYSTEMD_FIXTURE_IMAGE_CACHE_DIR:-$cache_home/fased-dev/lifecycle-fixture-images/hosting}"
      ;;
    *) echo "Unsupported fixture image profile: $profile" >&2; return 1 ;;
  esac
  image_dir="$(fased_fixture_image_dir "$profile")"

  [[ "$cache_dir" == /* ]] || {
    echo "FASED_SYSTEMD_FIXTURE_IMAGE_CACHE_DIR must be absolute." >&2
    return 1
  }
  command -v "$runtime" >/dev/null 2>&1 || {
    echo "Podman is required to prepare lifecycle fixture images." >&2
    return 1
  }
  [[ "$runtime" == "podman" ]] || {
    echo "Lifecycle fixture images currently require Podman." >&2
    return 1
  }
  command -v flock >/dev/null 2>&1 || {
    echo "flock is required to prepare lifecycle fixture images." >&2
    return 1
  }
  if [[ -z "$oci_runtime" ]] && command -v runc >/dev/null 2>&1; then
    oci_runtime="$(command -v runc)"
  fi
  run_container() {
    if [[ -n "$oci_runtime" ]]; then
      "$runtime" --runtime "$oci_runtime" "$@"
      return
    fi
    "$runtime" "$@"
  }

  mkdir -p "$cache_dir"
  IFS=',' read -r -a distro_list <<<"$distros"
  for distro in "${distro_list[@]}"; do
    digest="$(fased_fixture_image_digest "$profile" "$distro")"
    image="$(fased_fixture_image_ref "$profile" "$distro" "$digest")"
    archive="$(fased_fixture_image_archive "$cache_dir" "$profile" "$distro" "$digest")"
    exec {FASED_FIXTURE_IMAGE_LOCK_FD}>"${archive}.lock"
    flock "$FASED_FIXTURE_IMAGE_LOCK_FD"
    if run_container image exists "$image"; then
      fased_fixture_verify_image "$image" "$digest"
    elif [[ -s "$archive" ]]; then
      run_container load --input "$archive" >/dev/null
      run_container image exists "$image"
      fased_fixture_verify_image "$image" "$digest"
    else
      run_container build \
        --label "io.fased.fixture.input-digest=sha256:$digest" \
        -f "$image_dir/Containerfile.$distro" \
        -t "$image" \
        "$image_dir"
      fased_fixture_verify_image "$image" "$digest"
    fi
    if [[ ! -s "$archive" ]]; then
      FASED_FIXTURE_IMAGE_STAGING="${archive}.building.$$"
      run_container save --format oci-archive \
        --output "$FASED_FIXTURE_IMAGE_STAGING" "$image"
      mv "$FASED_FIXTURE_IMAGE_STAGING" "$archive"
      FASED_FIXTURE_IMAGE_STAGING=""
    fi
    flock -u "$FASED_FIXTURE_IMAGE_LOCK_FD"
    exec {FASED_FIXTURE_IMAGE_LOCK_FD}>&-
    FASED_FIXTURE_IMAGE_LOCK_FD=""
    printf 'fixture image prepared: profile=%s distro=%s image=%s digest=sha256:%s\n' \
      "$profile" "$distro" "$image" "$digest"
  done
  trap - EXIT INT TERM HUP
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  fased_fixture_prepare_main "$@"
fi
