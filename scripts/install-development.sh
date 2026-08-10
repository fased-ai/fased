#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
run_onboard=1
verbose=0
onboard_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-install)
      shift
      ;;
    --no-onboard)
      run_onboard=0
      shift
      ;;
    --verbose)
      verbose=1
      shift
      ;;
    --)
      shift
      onboard_args=("$@")
      break
      ;;
    -h|--help)
      printf '%s\n' \
        'Usage: scripts/install-development.sh [--no-onboard] [--verbose] [-- <onboard args>]' \
        'Builds the current contributor checkout. Public Local/Hosting installs use install.sh.'
      exit 0
      ;;
    *)
      onboard_args+=("$1")
      shift
      ;;
  esac
done

for tool in node pnpm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Developer installation requires $tool; install contributor prerequisites first." >&2
    exit 1
  fi
done

run_step() {
  local label="$1"
  shift
  printf '== %s ==\n' "$label"
  if [[ "$verbose" == "1" ]]; then
    "$@"
  else
    "$@" >/dev/null
  fi
}

run_step "Install frozen dependencies" pnpm --dir "$repo_root" install --frozen-lockfile
run_step "Build runtime" pnpm --dir "$repo_root" run build:fast
run_step "Build runtime assets" pnpm --dir "$repo_root" run build:runtime-assets
run_step "Build Control UI" pnpm --dir "$repo_root" run ui:build

mkdir -p "$HOME/.local/bin"
ln -sfn "$repo_root/fased.mjs" "$HOME/.local/bin/fased"
chmod 755 "$repo_root/fased.mjs"

if [[ "$run_onboard" == "0" ]]; then
  echo "Developer runtime ready: $HOME/.local/bin/fased"
  exit 0
fi

exec "$HOME/.local/bin/fased" onboard --install-daemon "${onboard_args[@]}"
