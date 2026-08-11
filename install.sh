#!/usr/bin/env bash
set -euo pipefail

install_entry_release_identity="__FASED_RELEASE_IDENTITY__"
bootstrap_sha256_x64="__FASED_BOOTSTRAP_SHA256_X64__"
bootstrap_sha256_arm64="__FASED_BOOTSTRAP_SHA256_ARM64__"
version_pattern='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$'
digest_pattern='^[0-9a-f]{64}$'

main() {
source_path="${BASH_SOURCE[0]:-}"
streamed=0
case "$source_path" in
  ""|bash|-|/dev/stdin) streamed=1 ;;
esac

if [[ "$install_entry_release_identity" == "__FASED_RELEASE_IDENTITY__" ]]; then
  install_entry_release_identity=""
elif [[ ! "$install_entry_release_identity" =~ $version_pattern ]]; then
  echo "Fased installer: invalid stamped release identity." >&2
  exit 1
fi

if [[ "$streamed" -eq 0 && -z "$install_entry_release_identity" ]]; then
  repo_root="$(cd "$(dirname "$source_path")" && pwd -P)"
  exec "$repo_root/scripts/install-development.sh" "$@"
fi
if [[ "$streamed" -eq 1 && -z "$install_entry_release_identity" ]]; then
  echo "Fased installer: refusing an unstamped streamed installer." >&2
  exit 1
fi

profile="protected-local"
channel=""
release="$install_entry_release_identity"
operator_user=""
gateway_port="18789"
verbose=0
onboard=1
onboard_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local|--protected-local) profile="protected-local"; shift ;;
    --hosting) profile="hosting"; shift ;;
    --release)
      [[ $# -ge 2 ]] || { echo "Fased installer: --release needs a value." >&2; exit 1; }
      release="${2#v}"; shift 2 ;;
    --update-channel|--channel)
      [[ $# -ge 2 ]] || { echo "Fased installer: --update-channel needs a value." >&2; exit 1; }
      channel="$2"; shift 2 ;;
    --gateway-port)
      [[ $# -ge 2 ]] || { echo "Fased installer: --gateway-port needs a value." >&2; exit 1; }
      gateway_port="$2"; shift 2 ;;
    --operator-user)
      [[ $# -ge 2 ]] || { echo "Fased installer: --operator-user needs a value." >&2; exit 1; }
      operator_user="$2"; shift 2 ;;
    --no-onboard) onboard=0; shift ;;
    --verbose) verbose=1; shift ;;
    --)
      shift
      onboard_args=("$@")
      break
      ;;
    -h|--help)
      printf '%s\n' \
        'Usage: install.sh [--local|--hosting] [--release vX.Y.Z] [--update-channel stable|beta] [--verbose] [-- <onboard args>]' \
        'Contributor checkouts use scripts/install-development.sh.'
      exit 0
      ;;
    *) echo "Fased installer: unsupported option: $1" >&2; exit 1 ;;
  esac
done

[[ "$release" =~ $version_pattern ]] || { echo "Fased installer: release must be vX.Y.Z[-prerelease]." >&2; exit 1; }
if [[ -z "$channel" ]]; then
  channel="stable"
  [[ "$release" == *-* ]] && channel="beta"
fi
[[ "$channel" == "stable" || "$channel" == "beta" ]] || { echo "Fased installer: channel must be stable or beta." >&2; exit 1; }
[[ "$release" != *-* || "$channel" == "beta" ]] || { echo "Fased installer: prereleases require beta." >&2; exit 1; }
[[ "$release" == "$install_entry_release_identity" ]] || { echo "Fased installer: requested release differs from this immutable installer." >&2; exit 1; }
[[ "$gateway_port" =~ ^[0-9]+$ && "$gateway_port" -ge 1 && "$gateway_port" -le 65535 ]] || { echo "Fased installer: invalid Gateway port." >&2; exit 1; }

case "$(uname -s)" in
  Linux) ;;
  *) echo "Fased installer: public lifecycle installation supports Linux only." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch="x64"; bootstrap_sha256="$bootstrap_sha256_x64" ;;
  aarch64|arm64) arch="arm64"; bootstrap_sha256="$bootstrap_sha256_arm64" ;;
  *) echo "Fased installer: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
[[ "$bootstrap_sha256" =~ $digest_pattern ]] || { echo "Fased installer: bootstrap digest was not stamped." >&2; exit 1; }

if [[ -z "$operator_user" ]]; then
  if [[ "$profile" == "hosting" ]]; then
    operator_user="app"
  else
    operator_user="${SUDO_USER:-${USER:-}}"
  fi
fi
[[ "$operator_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$operator_user" != root ]] || { echo "Fased installer: invalid unprivileged operator." >&2; exit 1; }

for tool in curl sha256sum install mktemp uname; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Fased installer: missing required system tool: $tool" >&2; exit 1; }
done
if [[ "$(id -u)" -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
  echo "Fased installer: sudo is required for Local lifecycle installation." >&2
  exit 1
fi

cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/fased/bootstrap"
mkdir -p "$cache_root"
chmod 0700 "$cache_root"
download="$(mktemp "$cache_root/.fased-bootstrap.XXXXXX")"
trap 'rm -f -- "$download"' EXIT
bootstrap_asset="fased-bootstrap-linux-${arch}"
release_base="https://github.com/fased-ai/fased/releases/download/v${release}"
curl_args=(-fsS --proto '=https' --tlsv1.2 --retry 2 --retry-delay 1)
if [[ "$verbose" -eq 1 ]]; then
  curl_args=(-fL --proto '=https' --tlsv1.2 --retry 2 --retry-delay 1)
fi

if [[ "$streamed" -eq 1 ]]; then cat >/dev/null || true; fi
echo "Fased: acquiring verified lifecycle bootstrap..."
curl "${curl_args[@]}" "${release_base}/${bootstrap_asset}" -o "$download"
actual_sha256="$(sha256sum "$download")"
actual_sha256="${actual_sha256%% *}"
[[ "$actual_sha256" == "$bootstrap_sha256" ]] || { echo "Fased installer: bootstrap digest mismatch." >&2; exit 1; }
chmod 0500 "$download"

bootstrap_dir="/opt/fased/lifecycle/bootstrap-v1"
bootstrap="${bootstrap_dir}/fased-bootstrap"
root_command=()
if [[ "$(id -u)" -ne 0 ]]; then root_command=(sudo); fi
"${root_command[@]}" install -d -m 0755 "$bootstrap_dir"
"${root_command[@]}" install -m 0555 "$download" "$bootstrap"
installed_sha256="$(sha256sum "$bootstrap")"
installed_sha256="${installed_sha256%% *}"
[[ "$installed_sha256" == "$bootstrap_sha256" ]] || { echo "Fased installer: installed bootstrap identity mismatch." >&2; exit 1; }

bootstrap_args=(
  install
  --profile "$profile"
  --channel "$channel"
  --version "$release"
  --operator-user "$operator_user"
  --gateway-port "$gateway_port"
)
[[ "$verbose" -eq 1 ]] && bootstrap_args+=(--verbose)
[[ "$onboard" -eq 0 ]] && bootstrap_args+=(--no-onboard)
if [[ ${#onboard_args[@]} -gt 0 ]]; then bootstrap_args+=(-- "${onboard_args[@]}"); fi

echo "Fased: applying ${profile} release ${release}..."
"${root_command[@]}" "$bootstrap" "${bootstrap_args[@]}"
echo "Fased: installation complete."
}

main "$@"
