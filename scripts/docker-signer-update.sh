#!/usr/bin/env bash
set -euo pipefail

umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
EXTRA_COMPOSE_FILE="$ROOT_DIR/docker-compose.extra.yml"
ENV_FILE="$ROOT_DIR/.env"
LOCK_DIR="$ROOT_DIR/.docker-signer-update.lock"
ARCHIVE_NAME="signer-state.tar"
MANIFEST_NAME="snapshot.manifest"

usage() {
  cat <<'EOF'
Usage:
  scripts/docker-signer-update.sh --image <immutable-image> --snapshot-dir </absolute/new/directory> \
    [--expected-release-commit <40-hex>] \
    [--expected-signer-build-input-digest <sha256:64-hex>]
  scripts/docker-signer-update.sh --rollback </absolute/snapshot/directory>

The update transaction stops Gateway and fased-signerd, creates and verifies an
offline signer-state snapshot, preserves the exact old image ID, and only then
installs the Compose definition embedded in the exact target image and starts
the new signer. A failed signer or Gateway health check restores the snapshot,
deployment definition, and exact old image automatically.

The target must be an immutable digest or a unique version tag. `latest` and
the overwriteable `fased:local` tag are rejected. When using signed container
release metadata, pass both expected identity fields; they are checked before
the running Gateway or signer is stopped.
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required."
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required."
  fi
}

validate_absolute_path() {
  local label="$1"
  local value="$2"
  [[ "$value" == /* ]] || fail "$label must be an absolute path."
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *$'\t'* ]] || \
    fail "$label contains unsupported control characters."
}

validate_image_reference() {
  local value="$1"
  [[ -n "$value" && "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || \
    fail "image reference contains unsupported characters."
}

validate_immutable_target() {
  local value="$1"
  local final_component
  local tag
  validate_image_reference "$value"
  if [[ "$value" =~ @sha256:[a-f0-9]{64}$ || "$value" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    return 0
  fi
  final_component="${value##*/}"
  [[ "$final_component" == *:* ]] || \
    fail "target image must use an immutable digest or an explicit unique version tag."
  tag="${final_component##*:}"
  [[ "$tag" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([._-][A-Za-z0-9._-]+)?$ ]] || \
    fail "target image tag must be a unique semantic version; use a digest for other targets."
}

read_env_value() {
  local key="$1"
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "${line%%=*}" == "$key" ]]; then
      printf '%s\n' "${line#*=}"
      return 0
    fi
  done <"$ENV_FILE"
  return 1
}

write_env_image() {
  local image="$1"
  local source_file="${2:-$ENV_FILE}"
  local destination_file="${3:-$ENV_FILE}"
  local tmp
  local line
  local replaced=0
  tmp="$(mktemp "$(dirname "$destination_file")/.env.docker-signer.XXXXXX")"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "${line%%=*}" == "FASED_IMAGE" ]]; then
      printf 'FASED_IMAGE=%s\n' "$image" >>"$tmp"
      replaced=1
    else
      printf '%s\n' "$line" >>"$tmp"
    fi
  done <"$source_file"
  if [[ "$replaced" == "0" ]]; then
    printf 'FASED_IMAGE=%s\n' "$image" >>"$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$destination_file"
}

install_regular_file() {
  local source_file="$1"
  local destination_file="$2"
  local mode="$3"
  local tmp
  [[ -f "$source_file" && ! -L "$source_file" ]] || \
    fail "deployment source file is missing or unsafe: $source_file"
  tmp="$(mktemp "$(dirname "$destination_file")/.fased-docker-update.XXXXXX")"
  cp "$source_file" "$tmp"
  chmod "$mode" "$tmp"
  mv "$tmp" "$destination_file"
}

run_image_read_only() {
  local image="$1"
  shift
  docker run --rm \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --user 1000:1000 \
    --entrypoint "$1" \
    "$image" "${@:2}"
}

image_release_version() {
  local image="$1"
  local version
  version="$(run_image_read_only "$image" node /app/dist/index.js --version)"
  version="${version//$'\r'/}"
  version="${version//$'\n'/}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || \
    fail "target image did not report a valid Fased release version."
  printf '%s\n' "$version"
}

image_signer_release_identity() {
  local image="$1"
  local output
  local binary
  local version
  local commit_field
  local digest_field
  local development_field
  local trailing
  local commit
  local digest
  local development
  output="$(run_image_read_only "$image" /usr/local/bin/fased-signerd --version)"
  output="${output//$'\r'/}"
  output="${output//$'\n'/}"
  read -r binary version commit_field digest_field development_field trailing <<<"$output"
  [[ "$binary" == "fased-signerd" && -n "$version" && -z "${trailing:-}" ]] || \
    fail "image signer did not report a canonical release identity."
  [[ "$version" == "dev" || "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] || \
    fail "image signer release version is invalid."
  [[ "$commit_field" == commit=* ]] || fail "image signer commit identity is missing."
  [[ "$digest_field" == buildInputDigest=* ]] || \
    fail "image signer build-input identity is missing."
  [[ "$development_field" == development=* ]] || \
    fail "image signer development marker is missing."
  commit="${commit_field#commit=}"
  digest="${digest_field#buildInputDigest=}"
  development="${development_field#development=}"
  [[ "$commit" == "unknown" || "$commit" =~ ^[a-f0-9]{40}$ ]] || \
    fail "image signer commit identity is invalid."
  [[ "$digest" == "unknown" || "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || \
    fail "image signer build-input digest is invalid."
  [[ "$development" == "true" || "$development" == "false" ]] || \
    fail "image signer development marker is invalid."
  if [[ "$development" == "false" ]]; then
    [[ "$version" != "dev" && "$commit" != "unknown" && "$digest" != "unknown" ]] || \
      fail "production signer identity contains development placeholders."
  fi
  printf '%s\t%s\t%s\t%s\n' "$version" "$commit" "$digest" "$development"
}

extract_target_compose() {
  local image="$1"
  local destination="$2"
  run_image_read_only "$image" /bin/cat /app/docker-compose.yml >"$destination"
  chmod 600 "$destination"
  [[ -s "$destination" ]] || fail "target image does not contain its Compose definition."
}

manifest_value() {
  local manifest="$1"
  local key="$2"
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "${line%%=*}" == "$key" ]]; then
      printf '%s\n' "${line#*=}"
      return 0
    fi
  done <"$manifest"
  return 1
}

compose_file_args=()
compose_file_args+=(--project-directory "$ROOT_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
if [[ -f "$EXTRA_COMPOSE_FILE" ]]; then
  compose_file_args+=(-f "$EXTRA_COMPOSE_FILE")
fi

compose_initial() {
  docker compose "${compose_file_args[@]}" "$@"
}

compose_current() {
  docker compose --project-name "$PROJECT_NAME" "${compose_file_args[@]}" "$@"
}

compose_candidate() {
  local snapshot_dir="$1"
  shift
  local args=(
    --project-name "$PROJECT_NAME"
    --project-directory "$ROOT_DIR"
    --env-file "$snapshot_dir/.env.target"
    -f "$snapshot_dir/docker-compose.target.yml"
  )
  if [[ -f "$snapshot_dir/docker-compose.extra.before.yml" ]]; then
    args+=(-f "$snapshot_dir/docker-compose.extra.before.yml")
  fi
  docker compose "${args[@]}" "$@"
}

project_service_containers() {
  local project="$1"
  local service="$2"
  docker ps -a \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$service" \
    --format '{{.ID}}'
}

stop_project_service() {
  local project="$1"
  local service="$2"
  local container_id
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container_id")" == "true" ]]; then
      docker stop "$container_id" >/dev/null
    fi
  done < <(project_service_containers "$project" "$service")
}

assert_project_signer_stopped() {
  local project="$1"
  local require_existing="${2:-1}"
  local found=0
  local container_id
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    found=1
    [[ "$(docker inspect --format '{{.State.Running}}' "$container_id")" == "false" ]] || \
      fail "fased-signerd is still running; refusing to copy live signer state."
  done < <(project_service_containers "$project" fased-signerd)
  if [[ "$require_existing" == "1" && "$found" != "1" ]]; then
    fail "the existing fased-signerd container is unavailable."
  fi
}

stop_runtime_for_snapshot() {
  stop_project_service "$PROJECT_NAME" fased-gateway
  stop_project_service "$PROJECT_NAME" fased-signerd
  assert_project_signer_stopped "$PROJECT_NAME" 1
}

stop_runtime_for_rollback() {
  stop_project_service "$PROJECT_NAME" fased-gateway
  stop_project_service "$PROJECT_NAME" fased-signerd
  assert_project_signer_stopped "$PROJECT_NAME" 0
}

snapshot_state_archive() {
  local volume="$1"
  local image="$2"
  local archive="$3"
  assert_project_signer_stopped "$PROJECT_NAME" 0
  docker run --rm \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --user 1000:1000 \
    --mount "type=volume,src=${volume},dst=/signer-state,readonly" \
    "$image" \
    sh -ceu \
    'tar --sort=name --format=posix --pax-option=delete=atime,delete=ctime --mtime=@0 --owner=0 --group=0 --numeric-owner -C /signer-state -cf - .' \
    >"$archive"
  chmod 600 "$archive"
  [[ -s "$archive" ]] || fail "offline signer snapshot is empty."
}

verify_archive() {
  local archive="$1"
  local expected="$2"
  local actual
  actual="$(sha256_file "$archive")"
  [[ "$actual" == "$expected" ]] || fail "signer snapshot checksum verification failed."
}

restore_state_archive() {
  local volume="$1"
  local image="$2"
  local archive="$3"
  local expected="$4"
  local verification_archive="$5"
  assert_project_signer_stopped "$PROJECT_NAME" 0
  verify_archive "$archive" "$expected"
  docker run --rm -i \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --user 1000:1000 \
    --mount "type=volume,src=${volume},dst=/signer-state" \
    "$image" \
    sh -ceu \
    'find /signer-state -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xf - -C /signer-state' \
    <"$archive"
  snapshot_state_archive "$volume" "$image" "$verification_archive"
  verify_archive "$verification_archive" "$expected"
  rm -f "$verification_archive"
}

verify_snapshot_metadata() {
  local snapshot_dir="$1"
  local manifest="$snapshot_dir/$MANIFEST_NAME"
  local expected
  local required_file
  [[ -d "$snapshot_dir" && ! -L "$snapshot_dir" ]] || \
    fail "snapshot directory is missing or unsafe."
  [[ -f "$manifest" && ! -L "$manifest" ]] || fail "snapshot manifest is missing or unsafe."
  for required_file in \
    "$snapshot_dir/.env.before" \
    "$snapshot_dir/.env.target" \
    "$snapshot_dir/docker-compose.before.yml" \
    "$snapshot_dir/docker-compose.target.yml" \
    "$snapshot_dir/$ARCHIVE_NAME"; do
    [[ -f "$required_file" && ! -L "$required_file" ]] || \
      fail "snapshot file is missing or unsafe: $required_file"
  done
  [[ "$(manifest_value "$manifest" format)" == "fased-docker-signer-snapshot-v3" ]] || \
    fail "unsupported signer snapshot format."
  expected="$(manifest_value "$manifest" env_sha256)"
  verify_archive "$snapshot_dir/.env.before" "$expected"
  expected="$(manifest_value "$manifest" compose_sha256)"
  verify_archive "$snapshot_dir/docker-compose.before.yml" "$expected"
  expected="$(manifest_value "$manifest" target_env_sha256)"
  verify_archive "$snapshot_dir/.env.target" "$expected"
  expected="$(manifest_value "$manifest" target_compose_sha256)"
  verify_archive "$snapshot_dir/docker-compose.target.yml" "$expected"
  if [[ "$(manifest_value "$manifest" extra_compose_present)" == "1" ]]; then
    [[ -f "$snapshot_dir/docker-compose.extra.before.yml" && \
      ! -L "$snapshot_dir/docker-compose.extra.before.yml" ]] || \
      fail "saved extra Compose file is missing or unsafe."
    expected="$(manifest_value "$manifest" extra_compose_sha256)"
    verify_archive "$snapshot_dir/docker-compose.extra.before.yml" "$expected"
  fi
  verify_archive \
    "$snapshot_dir/$ARCHIVE_NAME" \
    "$(manifest_value "$manifest" archive_sha256)"
}

install_target_definition() {
  local snapshot_dir="$1"
  install_regular_file "$snapshot_dir/docker-compose.target.yml" "$COMPOSE_FILE" 0644
  install_regular_file "$snapshot_dir/.env.target" "$ENV_FILE" 0600
}

restore_snapshot_definition() {
  local snapshot_dir="$1"
  local image="$2"
  local manifest="$snapshot_dir/$MANIFEST_NAME"
  install_regular_file "$snapshot_dir/docker-compose.before.yml" "$COMPOSE_FILE" 0644
  if [[ "$(manifest_value "$manifest" extra_compose_present)" == "1" ]]; then
    install_regular_file \
      "$snapshot_dir/docker-compose.extra.before.yml" \
      "$EXTRA_COMPOSE_FILE" \
      0600
  elif [[ -e "$EXTRA_COMPOSE_FILE" ]]; then
    fail "an unexpected docker-compose.extra.yml exists; move it aside before rollback."
  fi
  write_env_image "$image" "$snapshot_dir/.env.before" "$ENV_FILE"
}

assert_target_container_binding() {
  local expected_image_id="$1"
  local expected_state_volume="$2"
  local container_id
  local actual_image_id
  local actual_state_volume
  compose_current create --force-recreate fased-signerd >/dev/null
  container_id="$(compose_current ps -a -q fased-signerd)"
  [[ -n "$container_id" && "$container_id" != *$'\n'* ]] || \
    fail "target Compose definition did not create exactly one signer container."
  actual_image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
  [[ "$actual_image_id" == "$expected_image_id" ]] || \
    fail "target Compose definition did not bind the exact target image ID."
  actual_state_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination \"/var/lib/fased-signerd\"}}{{.Name}}{{end}}{{end}}' "$container_id")"
  [[ "$actual_state_volume" == "$expected_state_volume" ]] || \
    fail "target Compose definition changed the signer-state volume; refusing migration."
}

activate_current_runtime() {
  local expected_version="$1"
  local signer_version="$2"
  local signer_commit="$3"
  local signer_digest="$4"
  local signer_development="$5"
  local require_production="$6"
  local actual_version
  local health_args=(
    /app/scripts/docker-signer-health.mjs
    /run/fased-signerd/app.sock
    --expected-version "$signer_version"
    --expected-commit "$signer_commit"
    --expected-build-input-digest "$signer_digest"
    --expected-development "$signer_development"
  )
  if [[ "$require_production" == "1" ]]; then
    health_args+=(--require-production)
  fi
  compose_current up -d --force-recreate --wait --wait-timeout 60 fased-signerd || return
  compose_current exec -T fased-signerd node "${health_args[@]}" || return
  compose_current up -d --force-recreate --no-deps --wait --wait-timeout 60 fased-gateway || \
    return
  compose_current exec -T fased-gateway node dist/index.js health || return
  actual_version="$(compose_current exec -T fased-gateway node dist/index.js --version)" || return
  actual_version="${actual_version//$'\r'/}"
  actual_version="${actual_version//$'\n'/}"
  [[ "$actual_version" == "$expected_version" ]] || return
}

rollback_snapshot() {
  local snapshot_dir="$1"
  local manifest="$snapshot_dir/$MANIFEST_NAME"
  local volume
  local rollback_image
  local old_image_id
  local old_version
  local old_signer_version
  local old_signer_commit
  local old_signer_digest
  local old_signer_development
  local old_require_production
  local archive_sha
  local rollback_id
  local verification_archive

  verify_snapshot_metadata "$snapshot_dir"
  PROJECT_NAME="$(manifest_value "$manifest" compose_project)"
  volume="$(manifest_value "$manifest" state_volume)"
  rollback_image="$(manifest_value "$manifest" rollback_image_ref)"
  old_image_id="$(manifest_value "$manifest" old_image_id)"
  old_version="$(manifest_value "$manifest" old_version)"
  old_signer_version="$(manifest_value "$manifest" old_signer_version)"
  old_signer_commit="$(manifest_value "$manifest" old_signer_commit)"
  old_signer_digest="$(manifest_value "$manifest" old_signer_build_input_digest)"
  old_signer_development="$(manifest_value "$manifest" old_signer_development)"
  archive_sha="$(manifest_value "$manifest" archive_sha256)"
  [[ "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "snapshot Compose project is invalid."
  [[ "$volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fail "snapshot state volume is invalid."
  validate_image_reference "$rollback_image"
  [[ "$old_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "snapshot old image ID is invalid."
  [[ "$old_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || \
    fail "snapshot old release version is invalid."
  [[ "$old_signer_version" == "dev" || "$old_signer_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] || \
    fail "snapshot old signer version is invalid."
  [[ "$old_signer_commit" == "unknown" || "$old_signer_commit" =~ ^[a-f0-9]{40}$ ]] || \
    fail "snapshot old signer commit is invalid."
  [[ "$old_signer_digest" == "unknown" || "$old_signer_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || \
    fail "snapshot old signer build-input digest is invalid."
  [[ "$old_signer_development" == "true" || "$old_signer_development" == "false" ]] || \
    fail "snapshot old signer development marker is invalid."
  old_require_production=0
  [[ "$old_signer_development" == "true" ]] || old_require_production=1
  rollback_id="$(docker image inspect --format '{{.Id}}' "$rollback_image" 2>/dev/null || true)"
  [[ "$rollback_id" == "$old_image_id" ]] || \
    fail "the exact rollback image is unavailable; signer state was not modified."
  docker volume inspect "$volume" >/dev/null

  stop_runtime_for_rollback
  verification_archive="$(mktemp "$snapshot_dir/.restore-verification.XXXXXX.tar")"
  restore_state_archive \
    "$volume" \
    "$rollback_image" \
    "$snapshot_dir/$ARCHIVE_NAME" \
    "$archive_sha" \
    "$verification_archive"
  restore_snapshot_definition "$snapshot_dir" "$rollback_image"
  activate_current_runtime \
    "$old_version" \
    "$old_signer_version" \
    "$old_signer_commit" \
    "$old_signer_digest" \
    "$old_signer_development" \
    "$old_require_production"
  echo "Rollback complete: exact image $old_image_id and verified offline signer snapshot restored."
}

target_image=""
snapshot_dir=""
rollback_dir=""
expected_release_commit=""
expected_signer_build_input_digest=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)
      [[ $# -ge 2 ]] || fail "--image requires a value."
      target_image="$2"
      shift 2
      ;;
    --snapshot-dir)
      [[ $# -ge 2 ]] || fail "--snapshot-dir requires a value."
      snapshot_dir="$2"
      shift 2
      ;;
    --rollback)
      [[ $# -ge 2 ]] || fail "--rollback requires a value."
      rollback_dir="$2"
      shift 2
      ;;
    --expected-release-commit)
      [[ $# -ge 2 ]] || fail "--expected-release-commit requires a value."
      expected_release_commit="$2"
      shift 2
      ;;
    --expected-signer-build-input-digest)
      [[ $# -ge 2 ]] || fail "--expected-signer-build-input-digest requires a value."
      expected_signer_build_input_digest="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

require_cmd docker
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail "run docker-setup.sh first; a regular .env is required."

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  fail "another Docker signer update or rollback may be active ($LOCK_DIR exists)."
fi
AUTO_ROLLBACK_SNAPSHOT=""
cleanup_and_maybe_rollback() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$status" != "0" && -n "$AUTO_ROLLBACK_SNAPSHOT" ]]; then
    echo "Update transaction failed; restoring the exact old deployment and offline snapshot." >&2
    if (rollback_snapshot "$AUTO_ROLLBACK_SNAPSHOT"); then
      echo "Automatic rollback completed." >&2
    else
      echo "CRITICAL: automatic rollback failed; keep the snapshot and inspect the host before retrying." >&2
      status=1
    fi
  fi
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup_and_maybe_rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -n "$rollback_dir" ]]; then
  [[ -z "$target_image" && -z "$snapshot_dir" && -z "$expected_release_commit" && \
    -z "$expected_signer_build_input_digest" ]] || \
    fail "--rollback cannot be combined with update options."
  validate_absolute_path "rollback snapshot directory" "$rollback_dir"
  rollback_snapshot "$rollback_dir"
  exit 0
fi

[[ -n "$target_image" && -n "$snapshot_dir" ]] || {
  usage >&2
  fail "--image and --snapshot-dir are required for an update."
}
validate_immutable_target "$target_image"
validate_absolute_path "snapshot directory" "$snapshot_dir"
[[ ! -e "$snapshot_dir" ]] || fail "snapshot directory must not already exist."
if [[ -n "$expected_release_commit" || -n "$expected_signer_build_input_digest" ]]; then
  [[ "$expected_release_commit" =~ ^[a-f0-9]{40}$ ]] || \
    fail "--expected-release-commit must be a full lowercase Git commit."
  [[ "$expected_signer_build_input_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || \
    fail "--expected-signer-build-input-digest must be a sha256 digest."
fi

signer_container="$(compose_initial ps -a -q fased-signerd)"
[[ -n "$signer_container" && "$signer_container" != *$'\n'* ]] || \
  fail "exactly one existing fased-signerd container is required."
PROJECT_NAME="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$signer_container")"
[[ "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "could not determine a safe Compose project name."

old_image_ref="$(read_env_value FASED_IMAGE || true)"
old_image_ref="${old_image_ref:-fased:local}"
validate_image_reference "$old_image_ref"
old_image_id="$(docker inspect --format '{{.Image}}' "$signer_container")"
[[ "$old_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "running signer image ID is invalid."
configured_old_id="$(docker image inspect --format '{{.Id}}' "$old_image_ref" 2>/dev/null || true)"
[[ "$configured_old_id" == "$old_image_id" ]] || \
  fail ".env FASED_IMAGE does not identify the running signer image; reconcile it before updating."
old_version="$(image_release_version "$old_image_id")"
IFS=$'\t' read -r old_signer_version old_signer_commit old_signer_digest old_signer_development \
  < <(image_signer_release_identity "$old_image_id")
state_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/fased-signerd"}}{{.Name}}{{end}}{{end}}' "$signer_container")"
[[ "$state_volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fail "could not resolve the signer-state named volume."

if [[ "$target_image" == */* ]]; then
  docker pull "$target_image"
else
  docker image inspect "$target_image" >/dev/null 2>&1 || \
    fail "local target image does not exist; build it under a unique tag first."
fi
target_image_id="$(docker image inspect --format '{{.Id}}' "$target_image")"
[[ "$target_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "target image ID is invalid."
target_version="$(image_release_version "$target_image_id")"
IFS=$'\t' read -r target_signer_version target_signer_commit target_signer_digest target_signer_development \
  < <(image_signer_release_identity "$target_image_id")
[[ "$target_signer_version" == "$target_version" ]] || \
  fail "target Gateway and signer release versions do not match."
if [[ -n "$expected_release_commit" ]]; then
  [[ "$target_signer_commit" == "$expected_release_commit" ]] || \
    fail "target signer release commit does not match verified release metadata."
  [[ "$target_signer_digest" == "$expected_signer_build_input_digest" ]] || \
    fail "target signer build-input digest does not match verified release metadata."
fi
target_require_production=0
if [[ "$target_image" == */* ]]; then
  [[ "$target_signer_development" == "false" ]] || \
    fail "registry target image contains a development signer identity."
  target_require_production=1
fi
if [[ ! "$target_image" =~ @sha256:[a-f0-9]{64}$ && ! "$target_image" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  target_tag="${target_image##*:}"
  target_tag="${target_tag#v}"
  [[ "$target_tag" == "$target_version" ]] || \
    fail "target image tag and packaged Fased version do not match."
fi
rollback_image_ref="fased-signer-rollback:${old_image_id#sha256:}"
docker image tag "$old_image_id" "$rollback_image_ref"

mkdir -m 700 "$snapshot_dir"
cp "$ENV_FILE" "$snapshot_dir/.env.before"
cp "$COMPOSE_FILE" "$snapshot_dir/docker-compose.before.yml"
chmod 600 "$snapshot_dir/.env.before" "$snapshot_dir/docker-compose.before.yml"
extract_target_compose "$target_image_id" "$snapshot_dir/docker-compose.target.yml"
write_env_image "$target_image_id" "$snapshot_dir/.env.before" "$snapshot_dir/.env.target"
extra_present=0
extra_sha="none"
if [[ -f "$EXTRA_COMPOSE_FILE" ]]; then
  cp "$EXTRA_COMPOSE_FILE" "$snapshot_dir/docker-compose.extra.before.yml"
  chmod 600 "$snapshot_dir/docker-compose.extra.before.yml"
  extra_present=1
  extra_sha="$(sha256_file "$snapshot_dir/docker-compose.extra.before.yml")"
fi

compose_candidate "$snapshot_dir" config --quiet >/dev/null || \
  fail "target image Compose definition is invalid with the current deployment configuration."

echo "Stopping Gateway, then signer, before the offline snapshot..."
stop_runtime_for_snapshot
snapshot_state_archive "$state_volume" "$rollback_image_ref" "$snapshot_dir/$ARCHIVE_NAME"
archive_sha="$(sha256_file "$snapshot_dir/$ARCHIVE_NAME")"
verify_archive "$snapshot_dir/$ARCHIVE_NAME" "$archive_sha"

manifest_tmp="$snapshot_dir/.snapshot.manifest.tmp"
{
  printf 'format=fased-docker-signer-snapshot-v3\n'
  printf 'compose_project=%s\n' "$PROJECT_NAME"
  printf 'state_volume=%s\n' "$state_volume"
  printf 'old_image_ref=%s\n' "$old_image_ref"
  printf 'old_image_id=%s\n' "$old_image_id"
  printf 'old_version=%s\n' "$old_version"
  printf 'old_signer_version=%s\n' "$old_signer_version"
  printf 'old_signer_commit=%s\n' "$old_signer_commit"
  printf 'old_signer_build_input_digest=%s\n' "$old_signer_digest"
  printf 'old_signer_development=%s\n' "$old_signer_development"
  printf 'rollback_image_ref=%s\n' "$rollback_image_ref"
  printf 'target_image_ref=%s\n' "$target_image"
  printf 'target_image_id=%s\n' "$target_image_id"
  printf 'target_version=%s\n' "$target_version"
  printf 'target_signer_version=%s\n' "$target_signer_version"
  printf 'target_signer_commit=%s\n' "$target_signer_commit"
  printf 'target_signer_build_input_digest=%s\n' "$target_signer_digest"
  printf 'target_signer_development=%s\n' "$target_signer_development"
  printf 'archive_sha256=%s\n' "$archive_sha"
  printf 'env_sha256=%s\n' "$(sha256_file "$snapshot_dir/.env.before")"
  printf 'compose_sha256=%s\n' "$(sha256_file "$snapshot_dir/docker-compose.before.yml")"
  printf 'target_env_sha256=%s\n' "$(sha256_file "$snapshot_dir/.env.target")"
  printf 'target_compose_sha256=%s\n' "$(sha256_file "$snapshot_dir/docker-compose.target.yml")"
  printf 'extra_compose_present=%s\n' "$extra_present"
  printf 'extra_compose_sha256=%s\n' "$extra_sha"
} >"$manifest_tmp"
chmod 600 "$manifest_tmp"
mv "$manifest_tmp" "$snapshot_dir/$MANIFEST_NAME"
sync
verify_snapshot_metadata "$snapshot_dir"
assert_project_signer_stopped "$PROJECT_NAME"

AUTO_ROLLBACK_SNAPSHOT="$snapshot_dir"
install_target_definition "$snapshot_dir"
assert_target_container_binding "$target_image_id" "$state_volume"
echo "Offline snapshot verified. Starting target signer $target_image_id..."
if activate_current_runtime \
  "$target_version" \
  "$target_signer_version" \
  "$target_signer_commit" \
  "$target_signer_digest" \
  "$target_signer_development" \
  "$target_require_production"; then
  AUTO_ROLLBACK_SNAPSHOT=""
  echo "Docker signer update complete."
  echo "Fased version: $target_version"
  echo "Verified snapshot retained at: $snapshot_dir"
  echo "Exact rollback image retained as: $rollback_image_ref"
  echo "Rollback command: scripts/docker-signer-update.sh --rollback $snapshot_dir"
else
  fail "target activation failed; automatic rollback is starting."
fi
