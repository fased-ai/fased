#!/usr/bin/env bash
set -euo pipefail

install_entry_release_identity="__FASED_RELEASE_IDENTITY__"
if [[ "$install_entry_release_identity" == "__FASED_RELEASE_IDENTITY__" ]]; then
  install_entry_release_identity=""
elif [[ ! "$install_entry_release_identity" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
  echo "This installer has an invalid immutable release identity." >&2
  exit 1
fi

install_entry_source="${BASH_SOURCE[0]:-}"
install_entry_is_stream=0
case "$install_entry_source" in
  ""|bash|-|/dev/stdin) install_entry_is_stream=1 ;;
esac
if [[ "$install_entry_is_stream" -eq 1 && -z "$install_entry_release_identity" ]]; then
  echo "Refusing an unstamped streamed installer." >&2
  echo "Use the immutable GitHub Release install.sh asset documented at https://docs.fased.ai/install." >&2
  exit 1
fi
install_entry_hosting=0
install_entry_protected_local_root=0
install_entry_local_repair=0
install_entry_verified_bundle=""
install_entry_app_handoff=""
install_entry_legacy_ts_authkey=0
install_entry_local_file_bootstrap=0
install_entry_args=("$@")
for ((install_entry_index = 0; install_entry_index < ${#install_entry_args[@]}; install_entry_index++)); do
  case "${install_entry_args[$install_entry_index]}" in
    --hosting|--repair-hosting)
      install_entry_hosting=1
      ;;
    --protected-local-root-bootstrap)
      install_entry_protected_local_root=1
      ;;
    --repair-local)
      install_entry_local_repair=1
      ;;
    --host-profile)
      if [[ "${install_entry_args[$((install_entry_index + 1))]:-}" == "hosting" ]]; then
        install_entry_hosting=1
      fi
      ;;
    --verified-hosting-bundle)
      install_entry_verified_bundle="${install_entry_args[$((install_entry_index + 1))]:-}"
      ;;
    --verified-hosting-app-handoff)
      install_entry_app_handoff="${install_entry_args[$((install_entry_index + 1))]:-}"
      ;;
    --ts-authkey)
      install_entry_legacy_ts_authkey=1
      ;;
  esac
done

if [[ "$install_entry_is_stream" -eq 0 && "$install_entry_hosting" -eq 0 && \
  "$install_entry_protected_local_root" -eq 0 ]]; then
  install_entry_source_dir="$(cd "$(dirname "$install_entry_source")" && pwd -P)"
  if [[ ! -f "$install_entry_source_dir/scripts/install-runtime-profile.sh" ]]; then
    install_entry_local_file_bootstrap=1
  fi
fi

if [[ "$install_entry_legacy_ts_authkey" -eq 1 ]]; then
  echo "Refusing --ts-authkey because command arguments can expose the Tailscale secret." >&2
  echo "Place it in a root-only 0600 file and pass --ts-authkey-file /root/path instead." >&2
  exit 1
fi

if [[ "$install_entry_is_stream" -eq 1 && "$install_entry_hosting" -eq 1 ]]; then
  install_entry_completed_hosting_repair=0
  install_entry_streamed_hosting_selector=""
  if [[ "${#install_entry_args[@]}" -eq 1 && "${install_entry_args[0]:-}" == "--hosting" ]]; then
    install_entry_streamed_hosting_selector="stable"
  elif [[ "${#install_entry_args[@]}" -eq 5 && \
    "${install_entry_args[0]:-}" == "--hosting" && \
    "${install_entry_args[1]:-}" == "--release" && \
    "${install_entry_args[3]:-}" == "--update-channel" ]]; then
    install_entry_streamed_release="${install_entry_args[2]#v}"
    install_entry_streamed_channel="${install_entry_args[4]}"
    if [[ "$install_entry_streamed_release" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ && \
      "$install_entry_streamed_channel" =~ ^(stable|beta)$ && \
      ( "$install_entry_streamed_release" != *-* || "$install_entry_streamed_channel" == "beta" ) ]]; then
      install_entry_streamed_hosting_selector="exact-release"
    fi
  fi
  if [[ -z "$install_entry_streamed_hosting_selector" ]]; then
    echo "Streamed VPS Hosting accepts only the public one-command selector:" >&2
    echo "  --hosting" >&2
    echo "  --hosting --release vX.Y.Z[-prerelease] --update-channel stable|beta" >&2
    echo "The same selector installs fresh or repairs an interrupted/completed installation; other advanced selectors require an exact tagged, attested installer file." >&2
    exit 1
  fi
  install_entry_exported_env=()
  mapfile -t install_entry_exported_env < <(compgen -e)
  for install_entry_env_name in "${install_entry_exported_env[@]}"; do
    if [[ "$install_entry_env_name" == FASED_* ]]; then
      echo "Refusing Fased environment overrides during streamed VPS Hosting: ${install_entry_env_name}" >&2
      exit 1
    fi
  done
  install_entry_unsafe_env=(
    HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy
    CURL_HOME CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR GIT_SSL_NO_VERIFY
    GH_HOST GH_REPO GH_CONFIG_DIR TMPDIR LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV CDPATH
  )
  for install_entry_env_name in "${install_entry_unsafe_env[@]}"; do
    if [[ -n "${!install_entry_env_name+x}" ]]; then
      echo "Refusing unsafe environment override during streamed VPS Hosting: ${install_entry_env_name}" >&2
      exit 1
    fi
  done
  install_entry_existing_hosting_paths=(
    /etc/fased
    /opt/fased
    /var/lib/fased-installer
    /var/lib/fased-gateway
    /var/lib/fased-signerd
    /etc/systemd/system/fased-gateway.service
    /etc/systemd/system/fased-signerd.service
    /usr/local/libexec/fased-gateway-launch
    /usr/local/libexec/fased-host-updater
  )
  install_entry_existing_hosting_state=0
  for install_entry_existing_path in "${install_entry_existing_hosting_paths[@]}"; do
    if [[ -e "$install_entry_existing_path" || -L "$install_entry_existing_path" ]]; then
      install_entry_existing_hosting_state=1
      break
    fi
  done
  if [[ "$install_entry_existing_hosting_state" -eq 1 ]]; then
    install_entry_completion_marker="/home/${FASED_INSTALL_USER:-app}/.fased/install-complete.json"
    install_entry_config="/home/${FASED_INSTALL_USER:-app}/.fased/fased.json"
    if { [[ -f "$install_entry_completion_marker" ]] && \
      grep -Eq '"onboardingCompleted"[[:space:]]*:[[:space:]]*true' "$install_entry_completion_marker"; } || \
      { [[ -s "$install_entry_config" ]] && command -v systemctl >/dev/null 2>&1 && \
        systemctl is-active --quiet fased-gateway.service; }; then
      install_entry_completed_hosting_repair=1
      echo "Existing VPS Hosting installation detected; the verified one-command bootstrap will repair/update it without rerunning onboarding." >&2
    else
      echo "Interrupted VPS Hosting setup detected; resuming through a newly verified release bundle." >&2
    fi
  fi
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  LANG="C.UTF-8"
  LC_ALL="C.UTF-8"
  export PATH LANG LC_ALL
  unset -f curl gh jq tar sha256sum awk stat find grep flock install mv cp chown chmod sync 2>/dev/null || true
  hash -r 2>/dev/null || true
fi

# A Hosting file request enters the attest-and-extract bootstrap unless it is
# the exact inner invocation carrying the root-owned verified bundle marker.
# Streamed Hosting reaches this block only for the fresh stable selector or
# the exact release/channel selector validated above. Repair and other advanced
# Hosting selectors remain exact-tag-only.
if [[ "$install_entry_is_stream" -eq 1 || "$install_entry_local_file_bootstrap" -eq 1 || \
  "$install_entry_protected_local_root" -eq 1 || \
  ( "$install_entry_hosting" -eq 1 && -z "$install_entry_verified_bundle" && -z "$install_entry_app_handoff" ) ]]; then
  install_repo_url="${FASED_INSTALL_REPO:-https://github.com/fased-ai/fased.git}"
  install_base_dir="${FASED_INSTALL_DIR:-$HOME/fased}"
  install_dir_explicit=0
  if [[ -n "${FASED_INSTALL_DIR:-}" ]]; then
    install_dir_explicit=1
  fi
  auto_install=1
  hosting_bootstrap=0
  hosting_repair_bootstrap=0
  hosting_release=""
  hosting_update_channel="stable"
  verified_hosting_bundle=""
  protected_local_bootstrap="$install_entry_protected_local_root"
  protected_local_operator_user=""
  protected_local_state_dir=""
  protected_local_gateway_port=""
  lifecycle_skip_onboard=0
  lifecycle_onboard_args=()
  args=("$@")

  for ((i = 0; i < ${#args[@]}; i++)); do
    if [[ "${args[$i]}" == "--" ]]; then
      lifecycle_onboard_args=("${args[@]:$((i + 1))}")
      break
    fi
    case "${args[$i]}" in
      --install-dir)
        if (( i + 1 >= ${#args[@]} )); then
          echo "Missing value for --install-dir" >&2
          exit 1
        fi
        install_base_dir="${args[$((i + 1))]}"
        install_dir_explicit=1
        ;;
      --no-auto-install)
        auto_install=0
        ;;
      --no-onboard)
        lifecycle_skip_onboard=1
        ;;
      --hosting)
        hosting_bootstrap=1
        ;;
      --repair-hosting)
        hosting_bootstrap=1
        hosting_repair_bootstrap=1
        ;;
      --host-profile)
        if (( i + 1 < ${#args[@]} )) && [[ "${args[$((i + 1))]}" == "hosting" ]]; then
          hosting_bootstrap=1
        fi
        ;;
      --release)
        if (( i + 1 >= ${#args[@]} )); then
          echo "Missing value for --release" >&2
          exit 1
        fi
        hosting_release="${args[$((i + 1))]}"
        ;;
      --update-channel)
        if (( i + 1 >= ${#args[@]} )); then
          echo "Missing value for --update-channel" >&2
          exit 1
        fi
        hosting_update_channel="${args[$((i + 1))]}"
        ;;
      --verified-hosting-bundle)
        if (( i + 1 >= ${#args[@]} )); then
          echo "Missing value for --verified-hosting-bundle" >&2
          exit 1
        fi
        verified_hosting_bundle="${args[$((i + 1))]}"
        ;;
      --protected-local-operator-user) protected_local_operator_user="${args[$((i + 1))]:-}" ;;
      --protected-local-state-dir) protected_local_state_dir="${args[$((i + 1))]:-}" ;;
      --protected-local-gateway-port) protected_local_gateway_port="${args[$((i + 1))]:-}" ;;
    esac
  done
  if [[ -n "$install_entry_release_identity" ]]; then
    if [[ -n "$hosting_release" && "${hosting_release#v}" != "$install_entry_release_identity" ]]; then
      echo "The immutable installer identity does not match the requested release." >&2
      exit 1
    fi
    hosting_release="v${install_entry_release_identity}"
  fi

  drain_streamed_install_input() {
    if [[ "$install_entry_is_stream" -eq 1 ]]; then
      cat >/dev/null || true
    fi
  }

  if [[ "$hosting_bootstrap" -eq 0 && "$protected_local_bootstrap" -eq 0 && \
    "$(id -u)" -eq 0 ]]; then
    echo "Local installation must run from the intended non-root operator account." >&2
    echo "Log in as that user and rerun the same Local command; the installer will request bounded sudo authorization when required." >&2
    drain_streamed_install_input
    exit 1
  fi

  if [[ "$hosting_bootstrap" -eq 0 && "$protected_local_bootstrap" -eq 0 && \
    "$install_dir_explicit" -eq 1 && -e "$install_base_dir" && ! -d "$install_base_dir/.git" ]]; then
    echo "Refusing to overwrite existing path: $install_base_dir" >&2
    echo "Set --install-dir to a new directory or clean the existing one, then rerun." >&2
    drain_streamed_install_input
    exit 1
  fi

  if [[ "$protected_local_bootstrap" -eq 1 ]]; then
    if [[ "$(id -u)" -ne 0 || "$install_entry_is_stream" -eq 1 || "$hosting_bootstrap" -eq 1 ]]; then
      echo "Protected Local root bootstrap requires the exact local installer file through normal OS administrator authorization." >&2
      exit 1
    fi
    protected_local_required=(
      "$protected_local_operator_user"
      "$protected_local_state_dir"
      "$protected_local_gateway_port"
      "$hosting_release"
    )
    for protected_local_value in "${protected_local_required[@]}"; do
      if [[ -z "$protected_local_value" ]]; then
        echo "Protected Local root bootstrap is missing a fixed installer input." >&2
        exit 1
      fi
    done
  fi

  if [[ "$hosting_bootstrap" -eq 1 && "$hosting_repair_bootstrap" -eq 0 && -z "$hosting_release" ]]; then
    hosting_release="latest"
  fi

  bootstrap_as_root() {
    if [[ "$(id -u)" -eq 0 ]]; then
      "$@"
      return
    fi
    if command -v sudo >/dev/null 2>&1; then
      sudo "$@"
      return
    fi
    echo "Administrator access is required to install bootstrap dependencies." >&2
    return 1
  }

  install_current_github_cli_bootstrap() {
    if command -v gh >/dev/null 2>&1 && gh attestation verify --help >/dev/null 2>&1; then
      return 0
    fi
    [[ "$auto_install" -eq 1 ]] || return 1
    if command -v apt-get >/dev/null 2>&1; then
      bootstrap_as_root apt-get update
      bootstrap_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates
      local keyring_tmp=""
      local source_tmp=""
      keyring_tmp="$(mktemp)"
      source_tmp="$(mktemp)"
      curl -q -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o "$keyring_tmp"
      printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' "$(dpkg --print-architecture)" >"$source_tmp"
      bootstrap_as_root install -d -m 0755 /etc/apt/keyrings
      bootstrap_as_root install -m 0644 "$keyring_tmp" /etc/apt/keyrings/githubcli-archive-keyring.gpg
      bootstrap_as_root install -m 0644 "$source_tmp" /etc/apt/sources.list.d/github-cli.list
      rm -f -- "$keyring_tmp" "$source_tmp"
      bootstrap_as_root apt-get update
      bootstrap_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y gh
    elif command -v dnf5 >/dev/null 2>&1; then
      bootstrap_as_root dnf5 install -y dnf5-plugins
      bootstrap_as_root dnf5 config-manager addrepo \
        --from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo
      bootstrap_as_root dnf5 install -y gh
    elif command -v dnf >/dev/null 2>&1; then
      bootstrap_as_root dnf install -y 'dnf-command(config-manager)'
      bootstrap_as_root dnf config-manager --add-repo \
        https://cli.github.com/packages/rpm/gh-cli.repo
      bootstrap_as_root dnf install -y gh
    elif command -v yum >/dev/null 2>&1; then
      bootstrap_as_root yum install -y yum-utils >/dev/null 2>&1 || true
      bootstrap_as_root yum-config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo >/dev/null 2>&1 || true
      bootstrap_as_root yum install -y gh
    elif command -v zypper >/dev/null 2>&1; then
      bootstrap_as_root zypper --non-interactive install gh
    elif command -v apk >/dev/null 2>&1; then
      bootstrap_as_root apk add --no-cache github-cli
    elif command -v pacman >/dev/null 2>&1; then
      bootstrap_as_root pacman -Sy --needed --noconfirm github-cli
    elif command -v brew >/dev/null 2>&1; then
      brew install gh || brew upgrade gh
    else
      return 1
    fi
    hash -r 2>/dev/null || true
    command -v gh >/dev/null 2>&1 && gh attestation verify --help >/dev/null 2>&1
  }

  resolve_public_latest_release_tag() {
    curl -q -fsSL --proto '=https' --tlsv1.2 \
      -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' \
      -H 'User-Agent: fased-installer' \
      https://api.github.com/repos/fased-ai/fased/releases/latest \
      | jq -er '.tag_name | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))'
  }

  verify_release_attestation_source() {
    local subject="$1"
    local bundle="$2"
    local release_version="$3"
    GH_PROMPT_DISABLED=1 gh attestation verify "$subject" \
      --repo fased-ai/fased \
      --bundle "$bundle" \
      --signer-workflow fased-ai/fased/.github/workflows/hosted-runtime-release.yml \
      --source-ref "refs/tags/v${release_version}" \
      --deny-self-hosted-runners >/dev/null 2>&1
  }

  root_owned_bundle_tree_is_secure() {
    local tree="$1"
    local canonical_tree=""
    local link=""
    local target=""
    local resolved=""
    local invalid_link=0

    canonical_tree="$(readlink -f -- "$tree" 2>/dev/null || true)"
    [[ -n "$canonical_tree" && -d "$canonical_tree" ]] || return 1
    if find "$canonical_tree" -xdev ! -user root -print -quit | grep -q . || \
      find "$canonical_tree" -xdev \( -type f -o -type d \) -perm /022 -print -quit | grep -q . || \
      find "$canonical_tree" -xdev ! -type f ! -type d ! -type l -print -quit | grep -q .; then
      return 1
    fi
    while IFS= read -r -d '' link; do
      target="$(readlink -- "$link" 2>/dev/null || true)"
      if [[ -z "$target" || "$target" == /* || "$target" == *\\* ]]; then
        invalid_link=1
        break
      fi
      resolved="$(readlink -f -- "$link" 2>/dev/null || true)"
      if [[ -z "$resolved" || \
        ( "$resolved" != "$canonical_tree" && "$resolved" != "$canonical_tree/"* ) ]]; then
        invalid_link=1
        break
      fi
    done < <(find "$canonical_tree" -xdev -type l -print0)
    [[ "$invalid_link" -eq 0 ]]
  }

  bootstrap_hosting_attested_bundle() {
    if [[ "$(id -u)" -ne 0 ]]; then
      echo "VPS Hosting bootstrap must start in the provider's root console." >&2
      echo "Do not grant the Fased app account sudo access." >&2
      exit 1
    fi
    if [[ -n "$verified_hosting_bundle" ]]; then
      echo "Refusing a caller-supplied verified bundle marker." >&2
      exit 1
    fi
    [[ -n "$hosting_release" ]] || {
      echo "VPS Hosting release resolution failed before verification." >&2
      exit 1
    }
    local -a verified_inner_args=("$@")
    if [[ "${install_entry_completed_hosting_repair:-0}" -eq 1 ]]; then
      local inner_arg_index=0
      for ((inner_arg_index = 0; inner_arg_index < ${#verified_inner_args[@]}; inner_arg_index++)); do
        if [[ "${verified_inner_args[$inner_arg_index]}" == "--hosting" ]]; then
          verified_inner_args[$inner_arg_index]="--repair-hosting"
          break
        fi
      done
    fi

    install_hosting_bootstrap_tools() {
      [[ "$auto_install" -eq 1 ]] || return 0
      local -a packages=(ca-certificates)
      command -v curl >/dev/null 2>&1 || packages+=(curl)
      command -v tar >/dev/null 2>&1 || packages+=(tar)
      if ! command -v sha256sum >/dev/null 2>&1 || ! command -v stat >/dev/null 2>&1; then
        packages+=(coreutils)
      fi
      command -v find >/dev/null 2>&1 || packages+=(findutils)
      command -v awk >/dev/null 2>&1 || packages+=(gawk)
      command -v jq >/dev/null 2>&1 || packages+=(jq)
      command -v grep >/dev/null 2>&1 || packages+=(grep)
      if ! command -v flock >/dev/null 2>&1 || ! command -v setpriv >/dev/null 2>&1; then
        packages+=(util-linux)
      fi
      if command -v apt-get >/dev/null 2>&1; then
        apt-get update
        env DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}"
      elif command -v dnf >/dev/null 2>&1; then
        dnf install -y "${packages[@]}"
      elif command -v dnf5 >/dev/null 2>&1; then
        dnf5 install -y "${packages[@]}"
      elif command -v yum >/dev/null 2>&1; then
        yum install -y "${packages[@]}"
      elif command -v zypper >/dev/null 2>&1; then
        zypper --non-interactive install "${packages[@]}"
      fi
    }
    if ! command -v gh >/dev/null 2>&1 || ! gh attestation verify --help >/dev/null 2>&1; then
      install_hosting_bootstrap_tools
      install_current_github_cli_bootstrap
    fi
    for command in curl tar sha256sum awk jq stat find grep flock setpriv; do
      if ! command -v "$command" >/dev/null 2>&1; then
        echo "Missing required Hosting bootstrap command: $command" >&2
        echo "Install curl, jq, tar, coreutils, and findutils from the provider console, then retry." >&2
        exit 1
      fi
    done
    if ! command -v gh >/dev/null 2>&1 || ! gh attestation verify --help >/dev/null 2>&1; then
      echo "GitHub CLI with 'gh attestation verify' is required before privileged Hosting setup." >&2
      echo "Install GitHub CLI from the provider console, then retry the exact release command." >&2
      exit 1
    fi

    local release_version="${hosting_release#v}"
    if [[ "$hosting_release" == "latest" ]]; then
      local latest_tag=""
      latest_tag="$(resolve_public_latest_release_tag 2>/dev/null || true)"
      release_version="${latest_tag#v}"
    fi
    if [[ ! "$hosting_update_channel" =~ ^(stable|beta)$ ]]; then
      echo "Hosting update channel must be stable or beta." >&2
      exit 1
    fi
    if [[ ! "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
      echo "Hosting release must resolve to an exact vX.Y.Z or vX.Y.Z-prerelease GitHub release." >&2
      exit 1
    fi
    if [[ "$release_version" == *-* && "$hosting_update_channel" != "beta" ]]; then
      echo "Hosting prerelease installation requires --update-channel beta." >&2
      exit 1
    fi

    local architecture=""
    local signer_platform=""
    case "$(uname -m)" in
      x86_64|amd64)
        architecture="x64"
        signer_platform="linux-amd64"
        ;;
      aarch64|arm64)
        architecture="arm64"
        signer_platform="linux-arm64"
        ;;
      *)
        echo "Unsupported Hosting architecture: $(uname -m)" >&2
        exit 1
        ;;
    esac
    local asset="fased-hosted-app-v2-linux-${architecture}-v${release_version}.tar.gz"
    local release_url="https://github.com/fased-ai/fased/releases/download/v${release_version}"
    local release_parent="/var/lib/fased-installer/releases/v${release_version}"
    local staging="${release_parent}/.staging.$$"
    local preflight=""
    preflight="$(mktemp -d "${TMPDIR:-/tmp}/fased-hosting-bootstrap.XXXXXX")"
    local archive="${preflight}/${asset}"
    local dependency_archive=""
    local dependency_asset=""
    local dependency_expected=""
    local dependency_hash=""
    local signer_binary=""
    local signer_asset=""
    local signer_expected=""
    local release_manifest="${preflight}/fased-hosted-release-v2.json"
    local release_manifest_bundle="${preflight}/fased-hosted-release-v2.json.attestation.json"
    local lifecycle_metadata="${preflight}/fased-lifecycle-trust-v1.json"
    local lifecycle_metadata_bundle="${preflight}/fased-lifecycle-trust-v1.json.attestation.json"
    local evidence_verifier="${preflight}/fased-privileged-release-evidence.mjs"
    local provenance="${preflight}/fased-privileged-provenance-v1.intoto.json"
    local provenance_bundle="${preflight}/fased-privileged-provenance-v1.intoto.json.attestation.json"
    local sbom="${preflight}/fased-privileged-sbom-v1.spdx.json"
    local vex="${preflight}/fased-privileged-vex-v1.openvex.json"
    local expected=""
    local actual=""
    local manifest_digest=""
    local manifest_commit=""
    local manifest_signer_commit=""
    local lifecycle_metadata_digest=""
    local provenance_digest=""
    local sbom_digest=""
    local vex_digest=""
    local evidence_verifier_digest=""
    local evidence_verifier_expected=""
    local lifecycle_issued_at=""
    local lifecycle_expires_at=""
    local lifecycle_issued_epoch=""
    local lifecycle_expires_epoch=""
    local lifecycle_now_epoch=""

    enter_go_lifecycle_bundle() {
      local selected_root_store="$1"
      local selected_package_root="$2"
      local _selected_commit="$3"
      local lifecycle_profile="hosting"
      local lifecycle_instance="hosting"
      local lifecycle_operator="${FASED_INSTALL_USER:-app}"
      local lifecycle_owner_state="/home/${lifecycle_operator}/.fased"
      local lifecycle_port="${FASED_GATEWAY_PORT:-18789}"
      local lifecycle_node=""
      local lifecycle_node_candidate=""
      for lifecycle_node_candidate in /usr/bin/node-24 /usr/bin/node-22 /usr/local/bin/node /usr/bin/node; do
        if [[ -x "$lifecycle_node_candidate" ]] && \
          "$lifecycle_node_candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<14))process.exit(1);require("node:sqlite")' >/dev/null 2>&1; then
          lifecycle_node="$lifecycle_node_candidate"
          break
        fi
      done
      if [[ "$protected_local_bootstrap" -eq 1 ]]; then
        lifecycle_profile="protected-local"
        lifecycle_instance=""
        lifecycle_operator="$protected_local_operator_user"
        lifecycle_owner_state="$protected_local_state_dir"
        lifecycle_port="$protected_local_gateway_port"
      fi
      [[ -n "$lifecycle_node" && -x "$lifecycle_node" ]] || {
        echo "A compatible root-controlled Node.js runtime is required to enter the verified lifecycle bundle." >&2
        return 1
      }
      local lifecycle_result=""
      if ! lifecycle_result="$(NODE_PATH="$selected_root_store/verified-dependencies/node_modules" \
        "$lifecycle_node" \
        "$selected_package_root/scripts/generation-updater.mjs" initialize \
        --version "$release_version" \
        --profile "$lifecycle_profile" \
        --instance "$lifecycle_instance" \
        --owner-state "$lifecycle_owner_state" \
        --operator-user "$lifecycle_operator" \
        --gateway-port "$lifecycle_port")"; then
        return 1
      fi
      printf '%s\n' "$lifecycle_result"

      # Protected Local keeps onboarding in the original unprivileged
      # installer process. That process owns the caller's exact arguments and
      # sends COMPLETE_ONBOARDING after the wizard writes fased.json. The root
      # bundle handoff must only commit the lifecycle transaction and return;
      # attempting onboarding here loses the outer argument boundary and runs
      # the wizard twice.
      if [[ "$lifecycle_profile" == "protected-local" ]]; then
        return 0
      fi

      local lifecycle_config="${lifecycle_owner_state}/fased.json"
      if [[ ! -s "$lifecycle_config" ]]; then
        if [[ "$lifecycle_skip_onboard" -eq 1 ]]; then
          echo "Lifecycle services are committed; onboarding was skipped and Gateway remains stopped."
          echo "Rerun the same verified installer command to complete onboarding."
          return 0
        fi
        local lifecycle_home=""
        lifecycle_home="$(getent passwd "$lifecycle_operator" | awk -F: '{print $6; exit}')"
        if [[ -z "$lifecycle_home" || "$lifecycle_owner_state" != "$lifecycle_home/.fased" ]]; then
          echo "Lifecycle operator home does not match the committed owner state." >&2
          return 1
        fi
        local lifecycle_launcher="${lifecycle_owner_state}/bin/fased"
        [[ -x "$lifecycle_launcher" && ! -L "$lifecycle_launcher" ]] || {
          echo "Committed lifecycle CLI launcher is unavailable for onboarding." >&2
          return 1
        }
        local -a lifecycle_environment=(
          HOME="$lifecycle_home"
          FASED_STATE_DIR="$lifecycle_owner_state"
          FASED_CONFIG_PATH="$lifecycle_config"
          FASED_INSTALLER_ONBOARD=1
          FASED_INSTALL_LIFECYCLE_COMMITTED=1
          FASED_WALLET_LOCAL_SIGNER_LIFECYCLE=external
        )
        if [[ "$lifecycle_profile" == "hosting" ]]; then
          lifecycle_environment+=(
            FASED_HOST_PROFILE=hosting
            FASED_HOST_ROOT_PREPARED=1
            FASED_UPDATE_CHANNEL="$hosting_update_channel"
            FASED_WALLET_LOCAL_SIGNER_SOCKET=/run/fased-signerd/app.sock
            FASED_HOST_UPDATER_SOCKET=/run/fased-host-updater/request.sock
          )
        fi
        local lifecycle_noninteractive=0
        local lifecycle_onboard_arg=""
        for lifecycle_onboard_arg in "${lifecycle_onboard_args[@]}"; do
          [[ "$lifecycle_onboard_arg" == "--non-interactive" ]] && lifecycle_noninteractive=1
        done
        if [[ "$lifecycle_noninteractive" -eq 1 ]]; then
          runuser -u "$lifecycle_operator" -- env "${lifecycle_environment[@]}" \
            "$lifecycle_launcher" onboard --install-daemon "${lifecycle_onboard_args[@]}" </dev/null
        else
          if ! ( : </dev/tty ) 2>/dev/null; then
            echo "Onboarding requires an interactive terminal or -- --non-interactive options." >&2
            return 1
          fi
          runuser -u "$lifecycle_operator" -- env "${lifecycle_environment[@]}" \
            "$lifecycle_launcher" onboard --install-daemon "${lifecycle_onboard_args[@]}" </dev/tty
        fi
      fi

      [[ -s "$lifecycle_config" ]] || {
        echo "Onboarding did not create ${lifecycle_config}." >&2
        return 1
      }
      local lifecycle_socket="/run/fased-host-updater/request.sock"
      if [[ "$lifecycle_profile" == "protected-local" ]]; then
        lifecycle_socket="/run/fased-local-controller/${lifecycle_instance}/request.sock"
      fi
      local lifecycle_request_id=""
      lifecycle_request_id="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || true)"
      [[ "$lifecycle_request_id" =~ ^[0-9a-f-]{36}$ ]] || {
        echo "Could not allocate the onboarding completion request identity." >&2
        return 1
      }
      /opt/fased/lifecycle/supervisor-v1/fased-lifecycled request \
        --socket "$lifecycle_socket" \
        --operation COMPLETE_ONBOARDING \
        --request-id "$lifecycle_request_id"
    }

    umask 077
    hosting_bootstrap_cleanup() {
      local status="$?"
      rm -rf -- "${preflight:-}" "${staging:-}"
      if [[ "$status" -ne 0 ]]; then
        if [[ -e /var/lib/fased-installer || -L /var/lib/fased-installer ]]; then
          echo "Hosting bootstrap stopped without activating Fased services." >&2
          echo "Persistent installer state exists; fix the reported problem and rerun the same public --hosting command from the provider root console." >&2
        else
          echo "Hosting bootstrap stopped before persistent Fased state was created; fix the reported problem and rerun the exact --hosting command." >&2
        fi
      fi
      return "$status"
    }
    trap hosting_bootstrap_cleanup EXIT

    if [[ "$protected_local_bootstrap" -eq 1 && -d "$release_parent" ]]; then
      local cached_root_store=""
      local cached_package_root=""
      local cached_commit=""
      local cached_digest=""
      local cached_manifest_digest=""
      local cached_signer_digest=""
      local cached_lifecycle_digest=""
      local cached_provenance_digest=""
      local cached_sbom_digest=""
      local cached_vex_digest=""
      local cached_evidence_verifier_digest=""
      local cached_candidate=""
      for cached_candidate in "$release_parent"/*; do
        [[ -d "$cached_candidate" && "$(basename "$cached_candidate")" =~ ^[a-f0-9]{64}$ ]] || continue
        if [[ -n "$cached_root_store" ]]; then
          cached_root_store=""
          break
        fi
        cached_root_store="$cached_candidate"
      done
      if [[ -n "$cached_root_store" ]]; then
        cached_package_root="$cached_root_store/extract/package"
        cached_digest="$(basename "$cached_root_store")"
        if [[ -f "$cached_package_root/.fased-hosting-bundle-verified" && \
          ! -L "$cached_package_root/.fased-hosting-bundle-verified" ]]; then
          cached_commit="$(awk -F= '$1 == "commit" { print $2; exit }' "$cached_package_root/.fased-hosting-bundle-verified")"
          cached_manifest_digest="$(awk -F= '$1 == "release_manifest_sha256" { print $2; exit }' "$cached_package_root/.fased-hosting-bundle-verified")"
          cached_signer_digest="$(awk -F= '$1 == "signer_sha256" { print $2; exit }' "$cached_package_root/.fased-hosting-bundle-verified")"
          cached_lifecycle_digest="$(awk -F= '$1 == "lifecycle_metadata_sha256" { print $2; exit }' "$cached_package_root/.fased-hosting-bundle-verified")"
          cached_provenance_digest="$(awk -F= '$1 == "provenance_sha256" { print $2; exit }' "$cached_package_root/.fased-hosting-bundle-verified")"
          cached_sbom_digest="$(awk -F= '$1 == "sbom_sha256" { print $2; exit }' "$cached_package_root/.fased-hosting-bundle-verified")"
          cached_vex_digest="$(awk -F= '$1 == "vex_sha256" { print $2; exit }' "$cached_package_root/.fased-hosting-bundle-verified")"
          cached_evidence_verifier_digest="$(awk -F= '$1 == "evidence_verifier_sha256" { print $2; exit }' "$cached_package_root/.fased-hosting-bundle-verified")"
        fi
        if [[ "$cached_commit" =~ ^[a-f0-9]{40}$ && \
          "$cached_manifest_digest" =~ ^[a-f0-9]{64}$ && \
          "$cached_signer_digest" =~ ^[a-f0-9]{64}$ && \
          "$cached_lifecycle_digest" =~ ^[a-f0-9]{64}$ && \
          "$cached_provenance_digest" =~ ^[a-f0-9]{64}$ && \
          "$cached_sbom_digest" =~ ^[a-f0-9]{64}$ && \
          "$cached_vex_digest" =~ ^[a-f0-9]{64}$ && \
          "$cached_evidence_verifier_digest" =~ ^[a-f0-9]{64}$ && \
          "$(awk -F= '$1 == "version" { print $2; exit }' "$cached_package_root/.fased-hosting-bundle-verified" 2>/dev/null || true)" == "$release_version" && \
          "$(awk -F= '$1 == "sha256" { print $2; exit }' "$cached_package_root/.fased-hosting-bundle-verified" 2>/dev/null || true)" == "$cached_digest" && \
          -d "$cached_root_store/verified-dependencies/node_modules" && \
          -f "$cached_root_store/verified-assets/fased-signerd" && \
          -f "$cached_root_store/verified-assets/fased-lifecycle-trust-v1.json" && \
          -f "$cached_root_store/verified-assets/fased-privileged-provenance-v1.intoto.json" && \
          -f "$cached_root_store/verified-assets/fased-privileged-sbom-v1.spdx.json" && \
          -f "$cached_root_store/verified-assets/fased-privileged-vex-v1.openvex.json" && \
          -f "$cached_root_store/verified-assets/fased-privileged-release-evidence.mjs" && \
          -f "$cached_package_root/.fased-hosted-release-v2.json" && \
          ! -L "$cached_package_root/.fased-hosted-release-v2.json" && \
          "$(sha256sum "$cached_package_root/.fased-hosted-release-v2.json" | awk '{print tolower($1)}')" == "$cached_manifest_digest" && \
          "$(sha256sum "$cached_root_store/verified-assets/fased-lifecycle-trust-v1.json" | awk '{print tolower($1)}')" == "$cached_lifecycle_digest" && \
          "$(sha256sum "$cached_root_store/verified-assets/fased-privileged-provenance-v1.intoto.json" | awk '{print tolower($1)}')" == "$cached_provenance_digest" && \
          "$(sha256sum "$cached_root_store/verified-assets/fased-privileged-sbom-v1.spdx.json" | awk '{print tolower($1)}')" == "$cached_sbom_digest" && \
          "$(sha256sum "$cached_root_store/verified-assets/fased-privileged-vex-v1.openvex.json" | awk '{print tolower($1)}')" == "$cached_vex_digest" && \
          "$(sha256sum "$cached_root_store/verified-assets/fased-privileged-release-evidence.mjs" | awk '{print tolower($1)}')" == "$cached_evidence_verifier_digest" && \
          "$(sha256sum "$cached_root_store/verified-assets/fased-signerd" | awk '{print tolower($1)}')" == "$cached_signer_digest" ]] && \
          root_owned_bundle_tree_is_secure "$cached_root_store"; then
          rm -rf -- "$preflight"
          trap - EXIT
          echo "Reusing verified tagged Hosting bundle v${release_version} (${cached_digest})."
          drain_streamed_install_input
          enter_go_lifecycle_bundle "$cached_root_store" "$cached_package_root" "$cached_commit"
        fi
      fi
    fi

    curl -q -fL --proto '=https' --tlsv1.2 "$release_url/fased-hosted-release-v2.json" -o "$release_manifest"
    curl -q -fL --proto '=https' --tlsv1.2 "$release_url/fased-hosted-release-v2.json.attestation.json" -o "$release_manifest_bundle"
    curl -q -fL --proto '=https' --tlsv1.2 "$release_url/fased-lifecycle-trust-v1.json" -o "$lifecycle_metadata"
    curl -q -fL --proto '=https' --tlsv1.2 "$release_url/fased-lifecycle-trust-v1.json.attestation.json" -o "$lifecycle_metadata_bundle"
    curl -q -fL --proto '=https' --tlsv1.2 "$release_url/fased-privileged-release-evidence.mjs" -o "$evidence_verifier"
    curl -q -fL --proto '=https' --tlsv1.2 "$release_url/fased-privileged-provenance-v1.intoto.json" -o "$provenance"
    curl -q -fL --proto '=https' --tlsv1.2 "$release_url/fased-privileged-provenance-v1.intoto.json.attestation.json" -o "$provenance_bundle"
    curl -q -fL --proto '=https' --tlsv1.2 "$release_url/fased-privileged-sbom-v1.spdx.json" -o "$sbom"
    curl -q -fL --proto '=https' --tlsv1.2 "$release_url/fased-privileged-vex-v1.openvex.json" -o "$vex"
    verify_release_attestation_source \
      "$release_manifest" "$release_manifest_bundle" "$release_version" || {
      echo "Release manifest attestation verification failed." >&2
      return 1
    }
    verify_release_attestation_source \
      "$lifecycle_metadata" "$lifecycle_metadata_bundle" "$release_version" || {
      echo "Lifecycle trust attestation verification failed." >&2
      return 1
    }
    verify_release_attestation_source \
      "$provenance" "$provenance_bundle" "$release_version" || {
      echo "Privileged provenance attestation verification failed." >&2
      return 1
    }
    local manifest_selection=""
    manifest_selection="$(jq -er --arg version "$release_version" --arg architecture "$architecture" --arg signer_platform "$signer_platform" '
      if (keys == ["application", "release", "schemaVersion", "signer"]) and
        .schemaVersion == 2 and
        (.release | keys == ["commit", "tag", "version"]) and
        (.application | keys == ["linux"]) and
        (.application.linux | keys == ["arm64", "x64"]) and
        (.application.linux[$architecture] | keys == ["artifact", "dependencies"]) and
        (.application.linux[$architecture].artifact | keys == ["asset", "sha256"]) and
        (.application.linux[$architecture].dependencies | keys == ["asset", "dependencyHash", "sha256"]) and
        (.signer | keys == ["capabilities", "capabilitiesDigest", "platforms", "release"]) and
        (.signer.release | keys == ["buildInputDigest", "commit", "development", "version"]) and
        (.signer.platforms | keys == ["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64"]) and
        (.signer.platforms[$signer_platform] | keys == ["asset", "sha256"]) and
        (.signer.capabilitiesDigest | test("^sha256:[a-f0-9]{64}$")) and
        (.release.version == $version) and (.release.tag == ("v" + $version)) and
        (.release.commit | test("^[a-f0-9]{40}$")) and
        (.signer.release.version == $version) and
        (.signer.release.commit == .release.commit) and
        (.signer.release.development == false) and
        (.signer.release.buildInputDigest | test("^sha256:[a-f0-9]{64}$")) and
        (.application.linux[$architecture].artifact.asset | test("^[A-Za-z0-9][A-Za-z0-9._-]+$")) and
        (.application.linux[$architecture].artifact.sha256 | test("^[a-f0-9]{64}$")) and
        (.application.linux[$architecture].dependencies.asset | test("^[A-Za-z0-9][A-Za-z0-9._-]+$")) and
        (.application.linux[$architecture].dependencies.sha256 | test("^[a-f0-9]{64}$")) and
        (.application.linux[$architecture].dependencies.dependencyHash | test("^[a-f0-9]{64}$")) and
        (.signer.platforms[$signer_platform].asset | test("^[A-Za-z0-9][A-Za-z0-9._-]+$")) and
        (.signer.platforms[$signer_platform].sha256 | test("^[a-f0-9]{64}$"))
      then [
        .release.commit,
        .signer.release.commit,
        .application.linux[$architecture].artifact.asset,
        .application.linux[$architecture].artifact.sha256,
        .application.linux[$architecture].dependencies.asset,
        .application.linux[$architecture].dependencies.sha256,
        .application.linux[$architecture].dependencies.dependencyHash,
        .signer.platforms[$signer_platform].asset,
        .signer.platforms[$signer_platform].sha256
      ] | @tsv
      else error("invalid hosted release manifest") end
    ' "$release_manifest")" || {
      echo "Hosted release manifest does not bind this exact app and signer release." >&2
      exit 1
    }
    IFS=$'\t' read -r manifest_commit manifest_signer_commit asset expected dependency_asset dependency_expected dependency_hash signer_asset signer_expected <<<"$manifest_selection"
    [[ "$manifest_commit" == "$manifest_signer_commit" && \
      "$asset" == "fased-hosted-app-v2-linux-${architecture}-v${release_version}.tar.gz" && \
      "$dependency_asset" == "fased-hosted-deps-linux-${architecture}-${dependency_hash}.tar.gz" && \
      "$signer_asset" == "fased-signerd-${signer_platform}" ]] || {
      echo "Hosted release manifest selects a mixed commit or unexpected app artifact." >&2
      exit 1
    }
    local lifecycle_selection=""
    lifecycle_selection="$(jq -er \
      --arg version "$release_version" \
      --arg commit "$manifest_commit" \
      --arg channel "$hosting_update_channel" \
      --arg platform "linux-${architecture}" \
      --arg current_time "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" '
      if (keys == ["evidence", "policy", "release", "role", "rootPolicy", "schemaVersion", "targets", "validity"]) and
        .schemaVersion == 1 and
        .role == "fased-lifecycle-targets" and
        (.rootPolicy | keys == ["schemaVersion", "signatures", "signed"]) and
        .rootPolicy.schemaVersion == 1 and
        (.rootPolicy.signed | type == "object") and
        (.rootPolicy.signatures | type == "array" and length >= 2) and
        (.release | keys == ["commit", "tag", "version"]) and
        .release.version == $version and
        .release.tag == ("v" + $version) and
        .release.commit == $commit and
        (.validity | keys == ["expiresAt", "issuedAt"]) and
        (.validity.issuedAt <= $current_time) and
        (.validity.expiresAt > $current_time) and
        (.policy | keys == ["channels", "lifecycleProtocol", "platforms"]) and
        .policy.channels == (if ($version | contains("-")) then ["beta"] else ["beta", "stable"] end) and
        (.policy.channels | index($channel)) != null and
        .policy.platforms == ["linux-arm64", "linux-x64"] and
        (.policy.platforms | index($platform)) != null and
        .policy.lifecycleProtocol == 1 and
        (.targets | keys == ["bootstrap", "evidenceVerifier", "lifecycleLinuxArm64", "lifecycleLinuxX64"]) and
        .targets.bootstrap.asset == "install.sh" and
        (.targets.bootstrap.sha256 | test("^[a-f0-9]{64}$")) and
        .targets.lifecycleLinuxX64.asset == "fased-lifecycled-linux-amd64" and
        (.targets.lifecycleLinuxX64.sha256 | test("^[a-f0-9]{64}$")) and
        .targets.lifecycleLinuxArm64.asset == "fased-lifecycled-linux-arm64" and
        (.targets.lifecycleLinuxArm64.sha256 | test("^[a-f0-9]{64}$")) and
        .targets.evidenceVerifier.asset == "fased-privileged-release-evidence.mjs" and
        (.targets.evidenceVerifier.sha256 | test("^[a-f0-9]{64}$")) and
        (.evidence | keys == ["provenance", "sbom", "vex"]) and
        .evidence.provenance.asset == "fased-privileged-provenance-v1.intoto.json" and
        (.evidence.provenance.sha256 | test("^[a-f0-9]{64}$")) and
        .evidence.sbom.asset == "fased-privileged-sbom-v1.spdx.json" and
        (.evidence.sbom.sha256 | test("^[a-f0-9]{64}$")) and
        .evidence.vex.asset == "fased-privileged-vex-v1.openvex.json" and
        (.evidence.vex.sha256 | test("^[a-f0-9]{64}$"))
      then .targets.evidenceVerifier.sha256
      else error("invalid lifecycle trust metadata") end
    ' "$lifecycle_metadata")" || {
      echo "Lifecycle trust metadata does not authorize this exact release and platform." >&2
      exit 1
    }
    evidence_verifier_expected="$lifecycle_selection"
    lifecycle_issued_at="$(jq -er '.validity.issuedAt | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.000Z$"))' "$lifecycle_metadata")"
    lifecycle_expires_at="$(jq -er '.validity.expiresAt | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.000Z$"))' "$lifecycle_metadata")"
    lifecycle_issued_epoch="$(date -u -d "$lifecycle_issued_at" +%s 2>/dev/null || true)"
    lifecycle_expires_epoch="$(date -u -d "$lifecycle_expires_at" +%s 2>/dev/null || true)"
    lifecycle_now_epoch="$(date -u +%s)"
    if [[ ! "$lifecycle_issued_epoch" =~ ^[0-9]+$ || \
      ! "$lifecycle_expires_epoch" =~ ^[0-9]+$ || \
      ! "$lifecycle_now_epoch" =~ ^[0-9]+$ ]] || \
      (( lifecycle_issued_epoch >= lifecycle_expires_epoch ||
        lifecycle_now_epoch < lifecycle_issued_epoch ||
        lifecycle_now_epoch >= lifecycle_expires_epoch ||
        lifecycle_expires_epoch - lifecycle_issued_epoch > 34560000 )); then
      echo "Lifecycle trust metadata validity is non-canonical, expired, or too broad." >&2
      exit 1
    fi
    [[ "$(sha256sum "$evidence_verifier" | awk '{print tolower($1)}')" == "$evidence_verifier_expected" ]] || {
      echo "Privileged release evidence verifier does not match lifecycle trust metadata." >&2
      exit 1
    }
    local evidence_node=""
    evidence_node="${protected_local_node_binary:-$(command -v node || true)}"
    [[ -n "$evidence_node" && -x "$evidence_node" ]] || {
      echo "A root-controlled Node.js runtime is required to verify release evidence." >&2
      exit 1
    }
    "$evidence_node" "$evidence_verifier" verify \
      --release-manifest "$release_manifest" \
      --lifecycle-metadata "$lifecycle_metadata" \
      --provenance "$provenance" \
      --sbom "$sbom" \
      --vex "$vex" \
      --version "$release_version" \
      --commit "$manifest_commit" >/dev/null || {
      echo "Privileged release provenance, SBOM, or VEX verification failed." >&2
      exit 1
    }
    lifecycle_metadata_digest="$(sha256sum "$lifecycle_metadata" | awk '{print tolower($1)}')"
    provenance_digest="$(sha256sum "$provenance" | awk '{print tolower($1)}')"
    sbom_digest="$(sha256sum "$sbom" | awk '{print tolower($1)}')"
    vex_digest="$(sha256sum "$vex" | awk '{print tolower($1)}')"
    evidence_verifier_digest="$(sha256sum "$evidence_verifier" | awk '{print tolower($1)}')"
    archive="${preflight}/${asset}"
    dependency_archive="${preflight}/${dependency_asset}"
    signer_binary="${preflight}/${signer_asset}"
    curl -q -fL --proto '=https' --tlsv1.2 "$release_url/$asset" -o "$archive"
    curl -q -fL --proto '=https' --tlsv1.2 "$release_url/$dependency_asset" -o "$dependency_archive"
    curl -q -fL --proto '=https' --tlsv1.2 "$release_url/$signer_asset" -o "$signer_binary"
    actual="$(sha256sum "$archive" | awk '{print tolower($1)}')"
    local dependency_actual=""
    local signer_actual=""
    dependency_actual="$(sha256sum "$dependency_archive" | awk '{print tolower($1)}')"
    signer_actual="$(sha256sum "$signer_binary" | awk '{print tolower($1)}')"
    manifest_digest="$(sha256sum "$release_manifest" | awk '{print tolower($1)}')"
    if [[ ! "$expected" =~ ^[a-f0-9]{64}$ || "$actual" != "$expected" || \
      ! "$dependency_expected" =~ ^[a-f0-9]{64}$ || "$dependency_actual" != "$dependency_expected" || \
      ! "$signer_expected" =~ ^[a-f0-9]{64}$ || "$signer_actual" != "$signer_expected" ]]; then
      echo "Hosted app, dependency, or signer release checksum verification failed." >&2
      exit 1
    fi
    local entry=""
    while IFS= read -r entry; do
      entry="${entry%/}"
      if [[ -z "$entry" || "$entry" == /* || "$entry" == *\\* || \
        ( "$entry" != "package" && "$entry" != package/* ) || \
        "$entry" == *"/../"* || "$entry" == ../* || "$entry" == */.. || \
        "$entry" == *"/./"* || "$entry" == ./* || "$entry" == */. ]]; then
        echo "Hosted app archive contains an unsafe path: $entry" >&2
        exit 1
      fi
    done < <(tar -tzf "$archive")
    while IFS= read -r entry; do
      entry="${entry%/}"
      if [[ -z "$entry" || "$entry" == /* || "$entry" == *\\* || \
        ( "$entry" != "node_modules" && "$entry" != node_modules/* ) || \
        "$entry" == *"/../"* || "$entry" == ../* || "$entry" == */.. || \
        "$entry" == *"/./"* || "$entry" == ./* || "$entry" == */. ]]; then
        echo "Hosted dependency archive contains an unsafe path: $entry" >&2
        exit 1
      fi
    done < <(tar -tzf "$dependency_archive")

    local verified_extract="$preflight/verified-app"
    install -d -m 0700 "$verified_extract"
    tar -xzf "$archive" -C "$verified_extract" --no-same-owner --no-same-permissions
    local verified_package_root="$verified_extract/package"
    [[ -f "$verified_package_root/install.sh" && -f "$verified_package_root/package.json" && \
      ! -L "$verified_package_root/install.sh" && -f "$verified_package_root/dist/build-info.json" && \
      ! -L "$verified_package_root/dist/build-info.json" && \
      -f "$verified_package_root/scripts/privileged-release-evidence.mjs" && \
      ! -L "$verified_package_root/scripts/privileged-release-evidence.mjs" ]] || {
      echo "Attested Hosting bundle is incomplete or has an invalid entrypoint." >&2
      exit 1
    }
    [[ "$(sha256sum "$verified_package_root/scripts/privileged-release-evidence.mjs" | awk '{print tolower($1)}')" == "$evidence_verifier_expected" ]] || {
      echo "Packaged release evidence verifier does not match lifecycle trust metadata." >&2
      exit 1
    }
    local packaged_version=""
    local packaged_commit=""
    local build_info_version=""
    packaged_version="$(awk -F'"' '/^[[:space:]]*"version"[[:space:]]*:/ { print $4; exit }' "$verified_package_root/package.json")"
    packaged_commit="$(awk -F'"' '/^[[:space:]]*"commit"[[:space:]]*:/ { print $4; exit }' "$verified_package_root/dist/build-info.json")"
    build_info_version="$(awk -F'"' '/^[[:space:]]*"version"[[:space:]]*:/ { print $4; exit }' "$verified_package_root/dist/build-info.json")"
    [[ "$packaged_version" == "$release_version" && "$build_info_version" == "$release_version" && \
      "$packaged_commit" =~ ^[a-f0-9]{40}$ && "$packaged_commit" == "$manifest_commit" ]] || {
      echo "Attested Hosting application identity does not match the unified release manifest." >&2
      exit 1
    }
    if find "$verified_package_root" -xdev ! -type f ! -type d -print -quit | grep -q . || \
      find "$verified_package_root" -xdev -type f -links +1 -print -quit | grep -q . || \
      find "$verified_package_root" -xdev \( ! -user root -o -perm /022 \) -print -quit | grep -q .; then
      echo "Attested Hosting bundle violates the file, link, ownership, or writable-mode policy." >&2
      exit 1
    fi

    # Only after the exact unified manifest, app/dependency layers, signer
    # binary, archive layout, and build identity are verified may the
    # bootstrap create persistent Fased root state.
    install -d -m 0700 -o root -g root /var/lib/fased-installer /var/lib/fased-installer/releases "$release_parent"
    exec 9>/var/lib/fased-installer/install.lock
    chmod 0600 /var/lib/fased-installer/install.lock
    flock -x 9
    rm -rf -- "$staging"
    install -d -m 0700 -o root -g root "$staging"
    local root_store="${release_parent}/${actual}"
    local existing_root="${root_store}/extract/package"
    local existing_commit=""
    if [[ -f "$existing_root/dist/build-info.json" && ! -L "$existing_root/dist/build-info.json" ]]; then
      existing_commit="$(awk -F'"' '/^[[:space:]]*"commit"[[:space:]]*:/ { print $4; exit }' "$existing_root/dist/build-info.json")"
    fi
    if [[ -f "$existing_root/.fased-hosting-bundle-verified" && \
      ! -L "$existing_root/.fased-hosting-bundle-verified" ]] && \
      grep -Fxq "version=${release_version}" "$existing_root/.fased-hosting-bundle-verified" && \
      grep -Fxq "sha256=${actual}" "$existing_root/.fased-hosting-bundle-verified" && \
      grep -Fxq "signer_sha256=${signer_actual}" "$existing_root/.fased-hosting-bundle-verified" && \
      grep -Fxq "dependency_sha256=${dependency_actual}" "$existing_root/.fased-hosting-bundle-verified" && \
      grep -Fxq "dependency_hash=${dependency_hash}" "$existing_root/.fased-hosting-bundle-verified" && \
      grep -Fxq "release_manifest_sha256=${manifest_digest}" "$existing_root/.fased-hosting-bundle-verified" && \
      [[ -f "$existing_root/.fased-hosted-release-v2.json" && \
        ! -L "$existing_root/.fased-hosted-release-v2.json" && \
        "$(sha256sum "$existing_root/.fased-hosted-release-v2.json" | awk '{print tolower($1)}')" == "$manifest_digest" ]] && \
      grep -Fxq "lifecycle_metadata_sha256=${lifecycle_metadata_digest}" "$existing_root/.fased-hosting-bundle-verified" && \
      grep -Fxq "provenance_sha256=${provenance_digest}" "$existing_root/.fased-hosting-bundle-verified" && \
      grep -Fxq "sbom_sha256=${sbom_digest}" "$existing_root/.fased-hosting-bundle-verified" && \
      grep -Fxq "vex_sha256=${vex_digest}" "$existing_root/.fased-hosting-bundle-verified" && \
      grep -Fxq "evidence_verifier_sha256=${evidence_verifier_digest}" "$existing_root/.fased-hosting-bundle-verified" && \
      [[ -d "$root_store/verified-dependencies/node_modules" && \
        ! -L "$root_store/verified-dependencies/node_modules" ]] && \
      [[ -f "$root_store/verified-assets/fased-signerd" && \
        ! -L "$root_store/verified-assets/fased-signerd" && \
        "$(sha256sum "$root_store/verified-assets/fased-signerd" | awk '{print tolower($1)}')" == "$signer_actual" ]] && \
      [[ -f "$root_store/verified-assets/fased-privileged-provenance-v1.intoto.json" && \
        "$(sha256sum "$root_store/verified-assets/fased-privileged-provenance-v1.intoto.json" | awk '{print tolower($1)}')" == "$provenance_digest" ]] && \
      [[ -f "$root_store/verified-assets/fased-privileged-sbom-v1.spdx.json" && \
        "$(sha256sum "$root_store/verified-assets/fased-privileged-sbom-v1.spdx.json" | awk '{print tolower($1)}')" == "$sbom_digest" ]] && \
      [[ -f "$root_store/verified-assets/fased-privileged-vex-v1.openvex.json" && \
        "$(sha256sum "$root_store/verified-assets/fased-privileged-vex-v1.openvex.json" | awk '{print tolower($1)}')" == "$vex_digest" ]] && \
      [[ -f "$root_store/verified-assets/fased-privileged-release-evidence.mjs" && \
        "$(sha256sum "$root_store/verified-assets/fased-privileged-release-evidence.mjs" | awk '{print tolower($1)}')" == "$evidence_verifier_digest" ]] && \
      [[ "$existing_commit" =~ ^[a-f0-9]{40}$ ]] && \
      grep -Fxq "commit=${existing_commit}" "$existing_root/.fased-hosting-bundle-verified" && \
      root_owned_bundle_tree_is_secure "$root_store" && \
      ! find "$existing_root" -xdev ! -type f ! -type d -print -quit | grep -q . && \
      ! find "$existing_root" -xdev -type f -links +1 -print -quit | grep -q .; then
      rm -rf -- "$staging"
      rm -rf -- "$preflight"
      trap - EXIT
      flock -u 9
      exec 9>&-
      echo "Reusing verified tagged Hosting bundle v${release_version} (${actual})."
      drain_streamed_install_input
      enter_go_lifecycle_bundle "$root_store" "$existing_root" "$existing_commit"
      exit 0
    fi
    if [[ -e "$root_store" ]]; then
      echo "An existing Hosting bundle at ${root_store} failed immutable verification; refusing to replace it." >&2
      echo "Inspect or quarantine it from the provider root console, then retry." >&2
      exit 1
    fi

    install -d -m 0700 -o root -g root "$staging/extract"
    cp -a "$verified_package_root" "$staging/extract/package"
    install -m 0644 -o root -g root \
      "$release_manifest" \
      "$staging/extract/package/.fased-hosted-release-v2.json"
    install -d -m 0755 -o root -g root "$staging/verified-dependencies"
    tar -xzf "$dependency_archive" -C "$staging/verified-dependencies" \
      --no-same-owner --no-same-permissions
    install -d -m 0755 -o root -g root "$staging/verified-assets"
    install -m 0755 -o root -g root "$signer_binary" "$staging/verified-assets/fased-signerd"
    install -m 0644 -o root -g root \
      "$lifecycle_metadata" \
      "$staging/verified-assets/fased-lifecycle-trust-v1.json"
    install -m 0644 -o root -g root \
      "$lifecycle_metadata_bundle" \
      "$staging/verified-assets/fased-lifecycle-trust-v1.json.attestation.json"
    install -m 0755 -o root -g root \
      "$evidence_verifier" \
      "$staging/verified-assets/fased-privileged-release-evidence.mjs"
    install -m 0644 -o root -g root \
      "$provenance" \
      "$staging/verified-assets/fased-privileged-provenance-v1.intoto.json"
    install -m 0644 -o root -g root \
      "$provenance_bundle" \
      "$staging/verified-assets/fased-privileged-provenance-v1.intoto.json.attestation.json"
    install -m 0644 -o root -g root \
      "$sbom" \
      "$staging/verified-assets/fased-privileged-sbom-v1.spdx.json"
    install -m 0644 -o root -g root \
      "$vex" \
      "$staging/verified-assets/fased-privileged-vex-v1.openvex.json"
    local package_root="$staging/extract/package"
    chown -R root:root "$staging"
    chmod -R a+rX "$staging"
    chmod -R go-w "$staging"
    if ! root_owned_bundle_tree_is_secure "$staging"; then
      echo "Could not secure the verified Hosting bundle as root-owned and non-writable." >&2
      exit 1
    fi
    printf 'version=%s\nsha256=%s\nsigner_sha256=%s\ndependency_sha256=%s\ndependency_hash=%s\nrelease_manifest_sha256=%s\nlifecycle_metadata_sha256=%s\nprovenance_sha256=%s\nsbom_sha256=%s\nvex_sha256=%s\nevidence_verifier_sha256=%s\ncommit=%s\n' \
      "$release_version" "$actual" "$signer_actual" "$dependency_actual" "$dependency_hash" "$manifest_digest" "$lifecycle_metadata_digest" "$provenance_digest" "$sbom_digest" "$vex_digest" "$evidence_verifier_digest" "$packaged_commit" >"$package_root/.fased-hosting-bundle-verified"
    chmod 0600 "$package_root/.fased-hosting-bundle-verified"
    sync -f "$package_root/.fased-hosting-bundle-verified" "$package_root" "$staging/extract" 2>/dev/null || true
    mv "$staging" "$root_store"
    rm -rf -- "$preflight"
    trap - EXIT
    flock -u 9
    exec 9>&-

    local final_root="$root_store/extract/package"
    echo "Verified tagged Hosting bundle v${release_version}; entering the root-owned installer."
    drain_streamed_install_input
    enter_go_lifecycle_bundle "$root_store" "$final_root" "$packaged_commit"
    exit 0
  }

  if [[ "$hosting_bootstrap" -eq 1 || "$protected_local_bootstrap" -eq 1 ]]; then
    bootstrap_hosting_attested_bundle "$@"
  fi

  run_as_root() {
    if [[ "$(id -u)" -eq 0 ]]; then
      "$@"
    elif command -v sudo >/dev/null 2>&1; then
      sudo "$@"
    else
      echo "Missing required command: git" >&2
      echo "Install git, or rerun on a host where sudo is available." >&2
      exit 1
    fi
  }

  install_bootstrap_git() {
    if [[ "$auto_install" -ne 1 ]]; then
      return 1
    fi
    local -a packages=(ca-certificates)
    command -v git >/dev/null 2>&1 || packages+=(git)
    command -v curl >/dev/null 2>&1 || packages+=(curl)
    if command -v apt-get >/dev/null 2>&1; then
      run_as_root apt-get update
      run_as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
        apt-get install -y "${packages[@]}"
    elif command -v dnf >/dev/null 2>&1; then
      run_as_root dnf install -y "${packages[@]}"
    elif command -v yum >/dev/null 2>&1; then
      run_as_root yum install -y "${packages[@]}"
    elif command -v zypper >/dev/null 2>&1; then
      run_as_root zypper --non-interactive install "${packages[@]}"
    elif command -v apk >/dev/null 2>&1; then
      run_as_root apk add --no-cache bash git curl ca-certificates
    elif command -v pacman >/dev/null 2>&1; then
      run_as_root pacman -Sy --noconfirm git curl ca-certificates
    elif command -v pkg >/dev/null 2>&1; then
      run_as_root pkg install -y bash git curl ca_root_nss
    elif command -v brew >/dev/null 2>&1; then
      brew install git
    else
      return 1
    fi
  }

  install_local_release_verification_tools() {
    if command -v gh >/dev/null 2>&1 && gh attestation verify --help >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
      return 0
    fi
    if [[ "$auto_install" -ne 1 ]]; then
      return 1
    fi
    local -a packages=(ca-certificates)
    command -v jq >/dev/null 2>&1 || packages+=(jq)
    command -v curl >/dev/null 2>&1 || packages+=(curl)
    if command -v apt-get >/dev/null 2>&1; then
      bootstrap_as_root apt-get update
      bootstrap_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}"
    elif command -v dnf >/dev/null 2>&1; then
      bootstrap_as_root dnf install -y "${packages[@]}"
    elif command -v dnf5 >/dev/null 2>&1; then
      bootstrap_as_root dnf5 install -y "${packages[@]}"
    elif command -v yum >/dev/null 2>&1; then
      bootstrap_as_root yum install -y "${packages[@]}"
    elif command -v zypper >/dev/null 2>&1; then
      bootstrap_as_root zypper --non-interactive install "${packages[@]}"
    elif command -v apk >/dev/null 2>&1; then
      bootstrap_as_root apk add --no-cache jq curl ca-certificates
    elif command -v pacman >/dev/null 2>&1; then
      bootstrap_as_root pacman -Sy --needed --noconfirm jq curl ca-certificates
    elif command -v brew >/dev/null 2>&1; then
      brew install jq || brew upgrade jq
    else
      return 1
    fi
    install_current_github_cli_bootstrap || return 1
    hash -r 2>/dev/null || true
    command -v gh >/dev/null 2>&1 && gh attestation verify --help >/dev/null 2>&1 && command -v jq >/dev/null 2>&1
  }

  resolve_attested_local_release_commit() {
    local release_version="$1"
    if ! command -v gh >/dev/null 2>&1 || \
      ! gh attestation verify --help >/dev/null 2>&1 || \
      ! command -v jq >/dev/null 2>&1; then
      echo "Exact Local repair requires GitHub CLI with attestation support and jq." >&2
      echo "Install current gh and jq, then rerun the exact release command." >&2
      return 1
    fi
    local release_url="https://github.com/fased-ai/fased/releases/download/v${release_version}"
    local verification_dir=""
    verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/fased-local-release.XXXXXX")" || {
      echo "Could not create a private Local release verification directory." >&2
      return 1
    }
    chmod 0700 "$verification_dir" || {
      rm -rf -- "$verification_dir"
      echo "Could not secure the Local release verification directory." >&2
      return 1
    }
    local manifest="$verification_dir/fased-hosted-release-v2.json"
    local bundle="$verification_dir/fased-hosted-release-v2.json.attestation.json"
    if ! curl -fsSL --proto '=https' --tlsv1.2 \
      "$release_url/fased-hosted-release-v2.json" -o "$manifest"; then
      rm -rf -- "$verification_dir"
      echo "Could not download the Local release manifest." >&2
      return 1
    fi
    if ! curl -fsSL --proto '=https' --tlsv1.2 \
      "$release_url/fased-hosted-release-v2.json.attestation.json" -o "$bundle"; then
      rm -rf -- "$verification_dir"
      echo "Could not download the Local release attestation bundle." >&2
      return 1
    fi
    if ! verify_release_attestation_source "$manifest" "$bundle" "$release_version"; then
      rm -rf -- "$verification_dir"
      echo "Local release attestation verification failed." >&2
      return 1
    fi
    local release_commit=""
    release_commit="$(jq -er --arg version "$release_version" '
      if .schemaVersion == 2 and
        .release.version == $version and
        .release.tag == ("v" + $version) and
        (.release.commit | test("^[a-f0-9]{40}$")) and
        .signer.release.version == $version and
        .signer.release.commit == .release.commit and
        .signer.release.development == false
      then .release.commit
      else error("invalid unified release manifest") end
    ' "$manifest")" || {
      rm -rf -- "$verification_dir"
      echo "Attested release manifest does not bind one exact Local source commit." >&2
      return 1
    }
    rm -rf -- "$verification_dir"
    printf '%s\n' "$release_commit"
  }

  materialize_attested_local_installer() {
    local release_version="$1"
    local verification_dir=""
    verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/fased-local-installer.XXXXXX")" || return 1
    chmod 0700 "$verification_dir" || {
      rm -rf -- "$verification_dir"
      return 1
    }
    local installer="$verification_dir/install.sh"
    local bundle="$verification_dir/install.sh.attestation.json"
    local release_url="https://github.com/fased-ai/fased/releases/download/v${release_version}"
    if ! curl -fsSL --proto '=https' --tlsv1.2 "$release_url/install.sh" -o "$installer" ||
      ! curl -fsSL --proto '=https' --tlsv1.2 \
        "$release_url/install.sh.attestation.json" -o "$bundle" ||
      ! verify_release_attestation_source "$installer" "$bundle" "$release_version" ||
      ! grep -Fqx "install_entry_release_identity=\"${release_version}\"" "$installer"; then
      rm -rf -- "$verification_dir"
      return 1
    fi
    chmod 0700 "$installer"
    printf '%s\n' "$installer"
  }

  run_attested_local_lifecycle() {
    local release_version="$1"
    local verified_installer="$2"
    local operator_user=""
    local state_dir="$local_state_dir"
    local gateway_port="${FASED_GATEWAY_PORT:-18789}"
    local skip_onboard=0
    local argument=""
    local index=0
    operator_user="$(id -un)"
    for ((index = 0; index < ${#args[@]}; index++)); do
      argument="${args[$index]}"
      if [[ "$argument" == "--gateway-port" && $((index + 1)) -lt ${#args[@]} ]]; then
        gateway_port="${args[$((index + 1))]}"
      elif [[ "$argument" == "--no-onboard" ]]; then
        skip_onboard=1
      fi
    done
    [[ "$gateway_port" =~ ^[0-9]+$ && "$gateway_port" -ge 1 && "$gateway_port" -le 65535 ]] || {
      echo "Local Gateway port must be an integer from 1 to 65535." >&2
      return 1
    }

    local lifecycle_output=""
    if ! lifecycle_output="$(sudo -- /bin/bash "$verified_installer" \
      --protected-local-root-bootstrap \
      --release "$release_version" \
      --update-channel "$hosting_update_channel" \
      --protected-local-operator-user "$operator_user" \
      --protected-local-state-dir "$state_dir" \
      --protected-local-gateway-port "$gateway_port")"; then
      return 1
    fi
    printf '%s\n' "$lifecycle_output"
    local lifecycle_outcome=""
    lifecycle_outcome="$(printf '%s\n' "$lifecycle_output" | tail -n 1 | jq -er '.outcome')" || {
      echo "Verified Local lifecycle returned an invalid outcome." >&2
      return 1
    }

    local projection="$state_dir/lifecycle.json"
    [[ -f "$projection" && ! -L "$projection" ]] || {
      echo "Verified Local lifecycle returned without its canonical projection." >&2
      return 1
    }
    local instance=""
    local signer_binary=""
    local signer_socket=""
    local lifecycle_socket=""
    instance="$(jq -er '.environment.FASED_PROTECTED_LOCAL_INSTANCE' "$projection")"
    signer_binary="$(jq -er '.environment.FASED_WALLET_LOCAL_SIGNER_BIN' "$projection")"
    signer_socket="$(jq -er '.environment.FASED_WALLET_LOCAL_SIGNER_SOCKET' "$projection")"
    lifecycle_socket="$(jq -er '.environment.FASED_HOST_UPDATER_SOCKET' "$projection")"
	[[ "$instance" =~ ^[a-f0-9]{16}$ && -x "$signer_binary" &&
	  "$signer_socket" == "/run/fased-local/$instance/application/app.sock" &&
	  "$lifecycle_socket" == "/run/fased-local-controller/$instance/request.sock" ]] || {
      echo "Verified Local lifecycle projection is inconsistent." >&2
      return 1
    }

    local config="$state_dir/fased.json"
    if [[ ! -s "$config" ]]; then
      if [[ "$skip_onboard" -eq 1 ]]; then
        echo "Lifecycle services are committed; onboarding was skipped and Gateway remains stopped."
        echo "Rerun the same verified installer command to complete onboarding."
        return 0
      fi
      local launcher="$state_dir/bin/fased"
      [[ -x "$launcher" && ! -L "$launcher" ]] || {
        echo "Committed Local lifecycle CLI is unavailable for onboarding." >&2
        return 1
      }
      env \
        HOME="$HOME" \
        FASED_STATE_DIR="$state_dir" \
        FASED_CONFIG_PATH="$config" \
        FASED_INSTALLER_ONBOARD=1 \
        FASED_INSTALL_LIFECYCLE_COMMITTED=1 \
        FASED_WALLET_LOCAL_SIGNER_LIFECYCLE=external \
        FASED_WALLET_LOCAL_SIGNER_BIN="$signer_binary" \
        FASED_WALLET_LOCAL_SIGNER_SOCKET="$signer_socket" \
        FASED_HOST_UPDATER_SOCKET="$lifecycle_socket" \
        "$launcher" onboard --install-daemon "${lifecycle_onboard_args[@]}"
    fi
    [[ -s "$config" && ! -L "$config" ]] || {
      echo "Onboarding did not create the canonical Local configuration." >&2
      return 1
    }
    if [[ "$lifecycle_outcome" == "ALREADY_CURRENT" ]]; then
      echo "Already current: $release_version"
      return 0
    fi

    local lifecycle_binary="${signer_binary%/fased-signerd}/fased-lifecycled"
    local request_id=""
    request_id="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || true)"
    [[ -x "$lifecycle_binary" && "$request_id" =~ ^[0-9a-f-]{36}$ ]] || {
      echo "Committed Local lifecycle client is unavailable." >&2
      return 1
    }
    if ! "$lifecycle_binary" request \
      --socket "$lifecycle_socket" \
      --operation COMPLETE_ONBOARDING \
      --request-id "$request_id" >/dev/null; then
      echo "Committed Local lifecycle could not complete onboarding." >&2
      return 1
    fi
    cat >"$state_dir/install-complete.json" <<EOF_LOCAL_COMPLETE
{
  "repoPath": "$(readlink -f "$state_dir/runtime/current")",
  "fasedDir": "$(readlink -f "$state_dir/runtime/current")",
  "onboardingCompleted": true,
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF_LOCAL_COMPLETE
    chmod 0600 "$state_dir/install-complete.json"
    echo "Verified Local lifecycle handoff complete. Future releases use fased update."
  }

  local_path_uid() {
    local target_path="$1"
    if stat -c '%u' "$target_path" >/dev/null 2>&1; then
      stat -c '%u' "$target_path"
      return
    fi
    stat -f '%u' "$target_path" 2>/dev/null
  }

  local_path_links() {
    local target_path="$1"
    if stat -c '%h' "$target_path" >/dev/null 2>&1; then
      stat -c '%h' "$target_path"
      return
    fi
    stat -f '%l' "$target_path" 2>/dev/null
  }

  local_path_size() {
    local target_path="$1"
    if stat -c '%s' "$target_path" >/dev/null 2>&1; then
      stat -c '%s' "$target_path"
      return
    fi
    stat -f '%z' "$target_path" 2>/dev/null
  }

  protected_local_forward_authority_ready() {
    local state_dir="$1"
    local current_link="$state_dir/updater/current"
    local generation_target=""
    local generation_dir=""
    local required_name=""
    local required_files=(
      fased-managed-updater.mjs
      fased-generation-updater-core.mjs
      generation-updater.mjs
      hosted-release-manifest.mjs
      lifecycle-trust-crypto.mjs
      lifecycle-trust-policy.mjs
      lifecycle-trust-root.mjs
      lifecycle-trust-runtime.mjs
      managed-runtime-layout.mjs
      managed-updater-bundle.mjs
      managed-updater-bundle.v1.json
      managed-updater-generation.v1.json
    )

    [[ -L "$current_link" ]] || return 1
    generation_target="$(readlink "$current_link" 2>/dev/null || true)"
    [[ "$generation_target" =~ ^generations/[a-f0-9]{64}$ ]] || return 1
    generation_dir="$state_dir/updater/$generation_target"
    [[ -d "$generation_dir" && ! -L "$generation_dir" ]] || return 1
    for required_name in "${required_files[@]}"; do
      [[ -f "$generation_dir/$required_name" && \
        ! -L "$generation_dir/$required_name" ]] || return 1
    done
    [[ -f "$state_dir/bin/fased" && ! -L "$state_dir/bin/fased" ]] || return 1
    grep -Fq 'UPDATER_GENERATION=' "$state_dir/bin/fased" || return 1
    return 0
  }

  existing_local_state=0
  existing_local_topology=""
  existing_local_resume=0
  local_state_dir="${FASED_STATE_DIR:-$HOME/.fased}"
  if [[ "$hosting_bootstrap" -eq 0 && "$protected_local_bootstrap" -eq 0 && \
    ( -e "$local_state_dir" || -L "$local_state_dir" ) ]]; then
    if [[ ! -d "$local_state_dir" || -L "$local_state_dir" || \
      "$(local_path_uid "$local_state_dir" || true)" != "$(id -u)" ]]; then
      echo "Existing Local state directory is not a safe operator-owned directory: $local_state_dir" >&2
      echo "No files were changed." >&2
      drain_streamed_install_input
      exit 1
    fi
    if [[ -n "$(find "$local_state_dir" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)" ]]; then
      local_state_recognized=0
      for local_state_marker in "$local_state_dir/fased.json" "$local_state_dir/install.json"; do
        local_state_marker_size="$(local_path_size "$local_state_marker" || true)"
        if [[ -f "$local_state_marker" && ! -L "$local_state_marker" && \
          "$(local_path_uid "$local_state_marker" || true)" == "$(id -u)" && \
          "$(local_path_links "$local_state_marker" || true)" == "1" && \
          "$local_state_marker_size" =~ ^[0-9]+$ && \
          "$local_state_marker_size" -le 16777216 ]]; then
          local_state_recognized=1
          break
        fi
      done
      if [[ "$local_state_recognized" -ne 1 ]]; then
        echo "Existing Local state is not a recognized recoverable Fased installation: $local_state_dir" >&2
        echo "No files were changed. Move unrelated or incomplete remnants aside, or use an explicit isolated FASED_STATE_DIR." >&2
        drain_streamed_install_input
        exit 1
      fi
      existing_local_state=1
      if [[ -f "$local_state_dir/install.json" ]] && \
        grep -Eq '"profile"[[:space:]]*:[[:space:]]*"protected-local"' \
          "$local_state_dir/install.json"; then
        existing_local_topology="protected-local"
      elif [[ -f "$local_state_dir/install.json" ]] && \
        grep -Eq '"profile"[[:space:]]*:[[:space:]]*"hosting"' \
          "$local_state_dir/install.json"; then
        existing_local_topology="hosting"
      else
        existing_local_topology="pre-handoff-local"
      fi
    fi
  fi

  if [[ "$existing_local_topology" == "hosting" ]]; then
    echo "This state belongs to a VPS Hosting installation, not Local." >&2
    echo "Use fased update as the Hosting app user, or the documented one-command Hosting bootstrap when its privileged boundary is missing." >&2
    drain_streamed_install_input
    exit 1
  fi
  if [[ "$existing_local_topology" == "protected-local" && \
    "$install_entry_local_repair" -ne 1 ]]; then
    if [[ -f "$local_state_dir/install-complete.json" ]] && \
      grep -Eq '"onboardingCompleted"[[:space:]]*:[[:space:]]*true' \
        "$local_state_dir/install-complete.json"; then
      if protected_local_forward_authority_ready "$local_state_dir"; then
        echo "Existing Protected Local installation detected; use fased update." >&2
        drain_streamed_install_input
        exit 0
      fi
      echo "Protected Local installation needs one verified lifecycle handoff; continuing without rerunning onboarding." >&2
    else
      existing_local_resume=1
      echo "Committed Protected Local services detected; resuming onboarding." >&2
    fi
  fi
  if [[ "$existing_local_topology" == "pre-handoff-local" && \
    "$install_entry_local_repair" -ne 1 ]]; then
    echo "Pre-handoff Local installation detected; entering one verified protected bootstrap without rerunning onboarding." >&2
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo "git is missing; installing bootstrap dependencies first."
    install_bootstrap_git || {
      echo "git is required to bootstrap the repository checkout." >&2
      exit 1
    }
    hash -r 2>/dev/null || true
  fi

  local_bootstrap_release=""
  local_bootstrap_commit=""
  if [[ "$hosting_bootstrap" -eq 0 ]]; then
    install_local_release_verification_tools || {
      echo "Local install requires GitHub CLI with attestation support and jq." >&2
      echo "Install current gh and jq, then rerun the installer." >&2
      drain_streamed_install_input
      exit 1
    }
  fi
  if [[ "$hosting_bootstrap" -eq 0 && -z "$hosting_release" ]]; then
    latest_local_tag="$(resolve_public_latest_release_tag 2>/dev/null || true)"
    if [[ ! "$latest_local_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "Could not resolve one stable tagged Local release." >&2
      drain_streamed_install_input
      exit 1
    fi
    hosting_release="$latest_local_tag"
  fi
  if [[ "$hosting_bootstrap" -eq 0 && -n "$hosting_release" ]]; then
    local_bootstrap_release="${hosting_release#v}"
    if [[ ! "$local_bootstrap_release" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
      echo "Local --release requires one exact vX.Y.Z or vX.Y.Z-prerelease version." >&2
      drain_streamed_install_input
      exit 1
    fi
    if [[ "$local_bootstrap_release" == *-* && "$hosting_update_channel" != "beta" ]]; then
      echo "Local prerelease installation requires --update-channel beta." >&2
      drain_streamed_install_input
      exit 1
    fi
    if ! local_bootstrap_commit="$(resolve_attested_local_release_commit "$local_bootstrap_release")"; then
      echo "Could not verify the attested Local release commit." >&2
      drain_streamed_install_input
      exit 1
    fi
    if [[ ! "$local_bootstrap_commit" =~ ^[a-f0-9]{40}$ ]]; then
      echo "Could not resolve the attested Local release commit." >&2
      drain_streamed_install_input
      exit 1
    fi
  fi

  if [[ "$hosting_bootstrap" -eq 0 && -n "$local_bootstrap_release" &&
    "$install_entry_release_identity" == "$local_bootstrap_release" &&
    ( "$install_entry_is_stream" -eq 1 || "$install_entry_local_file_bootstrap" -eq 1 ) ]]; then
    verified_local_installer="$(materialize_attested_local_installer "$local_bootstrap_release")" || {
      echo "Could not verify the exact Local installer asset." >&2
      drain_streamed_install_input
      exit 1
    }
    if ! run_attested_local_lifecycle "$local_bootstrap_release" "$verified_local_installer"; then
      rm -rf -- "$(dirname "$verified_local_installer")"
      drain_streamed_install_input
      exit 1
    fi
    rm -rf -- "$(dirname "$verified_local_installer")"
    drain_streamed_install_input
    exit 0
  fi

  if [[ "$hosting_bootstrap" -eq 0 && -n "$local_bootstrap_release" && \
    "$install_dir_explicit" -eq 0 ]]; then
    install_base_dir="${XDG_CACHE_HOME:-$HOME/.cache}/fased/installers/v${local_bootstrap_release}-${local_bootstrap_commit:0:12}"
  fi

  if [[ ! -e "$install_base_dir" ]]; then
    mkdir -p "$(dirname "$install_base_dir")"
    if [[ -n "$local_bootstrap_release" ]]; then
      git clone --filter=blob:none --no-checkout "$install_repo_url" "$install_base_dir"
    else
      git clone "$install_repo_url" "$install_base_dir"
    fi
  elif [[ -d "$install_base_dir/.git" ]]; then
    if [[ -z "$local_bootstrap_release" ]]; then
      git -C "$install_base_dir" pull --ff-only origin main
    fi
  else
    echo "Refusing to overwrite existing path: $install_base_dir" >&2
    echo "Set --install-dir to a new directory or clean the existing one, then rerun." >&2
    drain_streamed_install_input
    exit 1
  fi

  if [[ -n "$local_bootstrap_release" ]]; then
    git -C "$install_base_dir" fetch --force --depth=1 origin \
      "refs/tags/v${local_bootstrap_release}:refs/fased-installer/v${local_bootstrap_release}"
    fetched_release_commit=""
    fetched_release_commit="$(git -C "$install_base_dir" rev-parse "refs/fased-installer/v${local_bootstrap_release}^{commit}")"
    if [[ "$fetched_release_commit" != "$local_bootstrap_commit" ]]; then
      echo "Release tag commit does not match the attested unified release manifest." >&2
      drain_streamed_install_input
      exit 1
    fi
    git -C "$install_base_dir" checkout --detach "$local_bootstrap_commit"
    if [[ "$(git -C "$install_base_dir" rev-parse HEAD)" != "$local_bootstrap_commit" ]]; then
      echo "Local release checkout did not land on the attested commit." >&2
      drain_streamed_install_input
      exit 1
    fi
  fi

  exec_bootstrapped_installer() {
    local installer_path="$1"
    shift

    # A streamed shell may start executing before curl has written the entire
    # installer. Consume the remaining bytes before replacing this reader so
    # the public curl | bash command finishes without a misleading EPIPE.
    if [[ "$install_entry_is_stream" -eq 1 ]]; then
      cat >/dev/null
    fi
    if ( : < /dev/tty ) 2>/dev/null; then
      exec bash "$installer_path" "$@" < /dev/tty
    fi
    if [[ "$install_entry_is_stream" -eq 1 ]]; then
      exec bash "$installer_path" "$@" < /dev/null
    fi
    exec bash "$installer_path" "$@"
  }

  exec_bootstrapped_installer_with_internal_flag() {
    local installer_path="$1"
    local internal_flag="$2"
    local inserted=0
    local -a forwarded_args=()
    shift 2
    while [[ $# -gt 0 ]]; do
      if [[ "$inserted" -eq 0 && "$1" == "--" ]]; then
        forwarded_args+=("$internal_flag")
        inserted=1
      fi
      forwarded_args+=("$1")
      shift
    done
    if [[ "$inserted" -eq 0 ]]; then
      forwarded_args+=("$internal_flag")
    fi
    exec_bootstrapped_installer "$installer_path" "${forwarded_args[@]}"
  }

  if [[ "$existing_local_state" -eq 1 ]]; then
    if [[ "$install_entry_local_repair" -eq 1 ]]; then
      exec_bootstrapped_installer "$install_base_dir/install.sh" "$@"
    fi
    if [[ "$existing_local_resume" -eq 1 ]]; then
      exec_bootstrapped_installer_with_internal_flag \
        "$install_base_dir/install.sh" --resume-local-onboarding "$@"
    fi
    exec_bootstrapped_installer_with_internal_flag \
      "$install_base_dir/install.sh" --existing-local-bootstrap "$@"
  fi
  exec_bootstrapped_installer "$install_base_dir/install.sh" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FASED_DIR="$SCRIPT_DIR"
EARLY_HOSTING_REQUESTED=0
EARLY_HOSTING_RELEASE=""
EARLY_UPDATE_CHANNEL="stable"
EARLY_VERIFIED_HOSTING_BUNDLE=""
EARLY_ARGS=("$@")
for ((early_index = 0; early_index < ${#EARLY_ARGS[@]}; early_index++)); do
  case "${EARLY_ARGS[$early_index]}" in
    --hosting|--repair-hosting) EARLY_HOSTING_REQUESTED=1 ;;
    --host-profile)
      [[ "${EARLY_ARGS[$((early_index + 1))]:-}" == "hosting" ]] && EARLY_HOSTING_REQUESTED=1
      ;;
    --release) EARLY_HOSTING_RELEASE="${EARLY_ARGS[$((early_index + 1))]:-}" ;;
    --update-channel) EARLY_UPDATE_CHANNEL="${EARLY_ARGS[$((early_index + 1))]:-}" ;;
    --verified-hosting-bundle)
      EARLY_VERIFIED_HOSTING_BUNDLE="${EARLY_ARGS[$((early_index + 1))]:-}"
      ;;
  esac
done
if [[ "$(id -u)" -eq 0 && "$EARLY_HOSTING_REQUESTED" -eq 1 ]]; then
  EARLY_HOSTING_RELEASE="${EARLY_HOSTING_RELEASE#v}"
  early_source="$(readlink -f "$FASED_DIR" 2>/dev/null || true)"
  early_bundle="$(readlink -f "$EARLY_VERIFIED_HOSTING_BUNDLE" 2>/dev/null || true)"
  if [[ ! "$EARLY_UPDATE_CHANNEL" =~ ^(stable|beta)$ || \
    ! "$EARLY_HOSTING_RELEASE" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ || \
    ( "$EARLY_HOSTING_RELEASE" == *-* && "$EARLY_UPDATE_CHANNEL" != "beta" ) || \
    -z "$early_source" || "$early_source" != "$early_bundle" || \
    ! "$early_source" =~ ^/var/lib/fased-installer/releases/v${EARLY_HOSTING_RELEASE}/[a-f0-9]{64}/extract/package$ || \
    -e "$early_source/.git" || ! -f "$early_source/.fased-hosting-bundle-verified" || \
    -L "$early_source/.fased-hosting-bundle-verified" || \
    "$(stat -c '%u:%a:%h' "$early_source/.fased-hosting-bundle-verified" 2>/dev/null || true)" != "0:600:1" ]] || \
    find "$early_source" -xdev \( ! -user root -o -perm /022 \) -print -quit | grep -q . || \
    find "$early_source" -xdev ! -type f ! -type d -print -quit | grep -q . || \
    find "$early_source" -xdev -type f -links +1 -print -quit | grep -q .; then
    echo "Refusing to load privileged Hosting assets from an app-owned, Git, dirty, writable, or unverified source tree." >&2
    echo "Start from the provider root console with the public one-command --hosting bootstrap." >&2
    exit 1
  fi
fi
# shellcheck source=scripts/install-runtime-profile.sh
. "$FASED_DIR/scripts/install-runtime-profile.sh"
SAT_RUNTIME_ENV_FILE="${FASED_SAT_RUNTIME_ENV_FILE:-$FASED_DIR/config/sat-runtime.env}"
INSTALL_REPO_URL="${FASED_INSTALL_REPO:-https://github.com/fased-ai/fased.git}"
INSTALL_BASE_DIR="${FASED_INSTALL_DIR:-$HOME/fased}"
FASED_STATE_DIR_EXPLICIT="${FASED_STATE_DIR+x}"
FASED_CONFIG_DIR_EXPLICIT="${FASED_CONFIG_DIR+x}"
FASED_CONFIG_PATH_EXPLICIT="${FASED_CONFIG_PATH+x}"
FASED_CONFIG_DIR="${FASED_CONFIG_DIR:-${FASED_STATE_DIR:-$HOME/.fased}}"
INSTALL_MARKER_PATH="$FASED_CONFIG_DIR/install-complete.json"
INSTALL_CACHE_DIR="$FASED_CONFIG_DIR/install-cache"
INSTALL_LOG_DIR="$FASED_CONFIG_DIR/logs"
INSTALL_VERBOSE="${FASED_INSTALL_VERBOSE:-0}"
INSTALL_GIT_UPDATE="${FASED_INSTALL_GIT_UPDATE:-1}"
RELEASE_NPM_PACKAGE="${FASED_RUNTIME_NPM_PACKAGE:-${FASED_HOSTING_NPM_PACKAGE:-@fased/fased@latest}}"
AUTO_INSTALL=1
RUN_ONBOARD=1
HOSTING_REQUESTED=0
HOSTING_REPAIR_REQUESTED=0
LOCAL_REPAIR_REQUESTED=0
LOCAL_EXISTING_BOOTSTRAP_REQUESTED=0
LOCAL_ONBOARDING_RESUME_REQUESTED=0
SOURCE_INSTALL_REQUESTED=0
DIRTY_CHECKOUT_SOURCE_AUTO_SELECTED=0
HOSTING_RELEASE=""
UPDATE_CHANNEL="stable"
UPDATE_CHANNEL_EXPLICIT=0
VERIFIED_HOSTING_BUNDLE=""
VERIFIED_HOSTING_APP_HANDOFF=""
HOSTING_APP_HANDOFF_VERIFIED=0
TAILSCALE_AUTHKEY_FILE=""
REQUESTED_SWAP_GB=""
FASED_CLI_PATH=""
PREBUILT_RUNTIME_INSTALLED=0
FRESH_PROTECTED_LOCAL_REQUESTED=0
GATEWAY_SERVICE_REFRESHED=0
GATEWAY_RUNTIME_HEALTH_VERIFIED=0
LOCAL_SIGNER_INSTALL_TRANSACTION_OPEN=0
PROTECTED_LOCAL_BOOTSTRAPPED=0
PROTECTED_LOCAL_LIFECYCLE_COMMITTED=0
PROTECTED_LOCAL_INSTANCE=""
LOCAL_EXISTING_BOOTSTRAP_MANIFEST_SNAPSHOT=""
RUNTIME_UPDATE_CHANNEL_CHANGED=0
HOST_SIGNER_TRANSACTION_ACTIVE=0
HOST_SIGNER_DURABLE_COMMIT_DECISION=0
HOST_SIGNER_TRANSACTION_ID=""
HOST_SIGNER_TRANSACTION_VERSION=""
HOSTING_APPLICATION_BOUNDARY_PREPARED=0
LOW_MEMORY_SWAP_THRESHOLD_MB=2304
LOW_MEMORY_SWAP_GB=4
HOSTING_SWAP_GB=2

ORIGINAL_INSTALL_ARGS=("$@")
pass_args=()

supports_color() {
  if [[ "${FORCE_COLOR:-}" == "0" ]]; then
    return 1
  fi
  if [[ -n "${NO_COLOR:-}" && "${FORCE_COLOR:-}" != "1" ]]; then
    return 1
  fi
  [[ -t 1 || -n "${FORCE_COLOR:-}" ]]
}

if supports_color; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_GRAY=$'\033[90m'
  C_CYAN=$'\033[36m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
else
  C_RESET=""
  C_BOLD=""
  C_DIM=""
  C_GRAY=""
  C_CYAN=""
  C_GREEN=""
  C_YELLOW=""
  C_RED=""
fi

color_cyan() { printf '%s%s%s' "$C_CYAN" "$1" "$C_RESET"; }
color_green() { printf '%s%s%s' "$C_GREEN" "$1" "$C_RESET"; }
color_yellow() { printf '%s%s%s' "$C_YELLOW" "$1" "$C_RESET"; }
color_red() { printf '%s%s%s' "$C_RED" "$1" "$C_RESET"; }
color_dim() { printf '%s%s%s' "$C_DIM" "$1" "$C_RESET"; }
color_gray() { printf '%s%s%s' "$C_GRAY" "$1" "$C_RESET"; }

INSTALL_BLOCK_CONTENT_WIDTH=72
INSTALL_STATUS_FRAME_OPEN=0
INSTALL_STATUS_SECTION_COUNT=0

repeat_char() {
  local char="$1"
  local count="$2"
  local out=""
  local i
  for ((i = 0; i < count; i++)); do
    out+="$char"
  done
  printf '%s' "$out"
}

visible_length() {
  printf '%s' "$1" | sed -E $'s/\x1B\\[[0-9;]*[A-Za-z]//g' | wc -m | tr -d ' '
}

block_top() {
  local title="$1"
  local title_width
  local rule_width
  title_width="$(visible_length "$title")"
  rule_width=$((INSTALL_BLOCK_CONTENT_WIDTH + 2 - title_width - 3))
  if (( rule_width < 0 )); then
    rule_width=0
  fi
  printf '\n  %s%s%s%s%s\n' \
    "$(color_gray "╭─ ")" \
    "$(color_gray "${C_BOLD}${title}${C_RESET}")" \
    "$(color_gray " ")" \
    "$(color_gray "$(repeat_char "─" "$rule_width")")" \
    "$(color_gray "╮")"
}

block_line() {
  local text="${1:-}"
  local width
  local padding
  width="$(visible_length "$text")"
  padding=$((INSTALL_BLOCK_CONTENT_WIDTH - width))
  if (( padding < 0 )); then
    padding=0
  fi
  printf '  %s %s%s %s\n' \
    "$(color_gray "│")" \
    "$text" \
    "$(repeat_char " " "$padding")" \
    "$(color_gray "│")"
}

block_bottom() {
  printf '  %s\n' "$(color_gray "╰$(repeat_char "─" $((INSTALL_BLOCK_CONTENT_WIDTH + 2)))╯")"
}

status_frame_start() {
  block_top "INSTALLER STATUS"
  INSTALL_STATUS_FRAME_OPEN=1
  INSTALL_STATUS_SECTION_COUNT=0
}

status_frame_end() {
  if [[ "$INSTALL_STATUS_FRAME_OPEN" -eq 1 ]]; then
    block_bottom
    INSTALL_STATUS_FRAME_OPEN=0
    printf '\n'
  fi
}

print_installer_banner() {
  local version="$1"
  local profile="Local"
  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    profile="VPS Hosting"
  fi
  block_top "FASED AGENT"
  block_line
  block_line "$(color_gray "  _____   _     ____   _____  ____")"
  block_line "$(color_gray " |  ___| / \\   / ___| | ____||  _ \\")"
  block_line "$(color_gray " | |_   / _ \\  \\___ \\ |  _|  | | | |")"
  block_line "$(color_gray " |  _| / ___ \\  ___) || |___ | |_| |")"
  block_line "$(color_gray " |_|  /_/   \\_\\|____/ |_____||____/")"
  block_line
  block_line "Fased Agent v${version}"
  block_line "$(color_yellow "Mode")  ${profile}"
  block_line "$(color_yellow "Logs")  ${INSTALL_LOG_DIR}"
  block_line
  block_bottom
}

section() {
  local label="$1"
  local display="${label^^}"
  if [[ "$INSTALL_STATUS_FRAME_OPEN" -eq 1 ]]; then
    if [[ "$INSTALL_STATUS_SECTION_COUNT" -gt 0 ]]; then
      block_line
    fi
    block_line "$(color_yellow "${C_BOLD}${display}${C_RESET}")"
    INSTALL_STATUS_SECTION_COUNT=$((INSTALL_STATUS_SECTION_COUNT + 1))
  else
    printf '\n%s\n' "$(color_gray "${C_BOLD}${display}${C_RESET}")"
  fi
}

if [[ -f "$SAT_RUNTIME_ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$SAT_RUNTIME_ENV_FILE"
  set +a
fi

usage() {
  cat <<'USAGE'
Fased installer (single path): install.sh -> fased onboard --install-daemon

Usage: ./install.sh [options] [-- <extra onboard args>]

Options:
  --auto-install   install missing deps with apt/dnf/yum/zypper/apk/pacman/pkg or Homebrew (default)
  --no-auto-install  Disable automatic dependency installation
  --install-dir <path>  Contributor checkout directory. Tagged Local installs use
                  a release-scoped bootstrap cache and do not overwrite ~/fased.
  --hosting       VPS/always-on server profile. Requires Tailscale; applies hosted
                  onboarding defaults and may change SSH/firewall behavior.
  --repair-hosting  Repair an existing VPS runtime and root-managed gateway service
                  without rerunning onboarding or changing persistent user state.
  --release <vX.Y.Z|vX.Y.Z-prerelease|latest>  Pin a Local repair to an exact
                  release. Required for VPS Hosting; its root phase runs only
                  from the exact attested tagged bundle.
  --update-channel <stable|beta>  Persist the runtime update channel. A Hosting
                  prerelease is accepted only with the explicit beta channel.
  --ts-authkey-file <path>  Read a Tailscale auth key from a root-owned mode-0600
                  file. The secret is copied to a one-use /run file, never argv.
  --repair-local  Repair an existing Linux Local or WSL runtime and user Gateway
                  service without rerunning onboarding or changing user state.
  --local         Laptop/desktop profile. Tailscale is optional; on a VPS this does
                  not apply hosting SSH/firewall hardening.
  --source-install  Build from the checkout instead of using the verified Linux
                  release runtime. Intended for contributors and source testing;
                  a checkout with local changes selects this automatically.
  --swap-gb <n>   Override automatic install-time swap size on small Linux hosts
  --no-git-update  Do not fast-forward the checkout from origin before install
  --no-onboard     Skip running onboard (install deps only)
  --verbose       Show build/install command output instead of logging it
  -h, --help       Show this help

All other args are forwarded to:
  fased onboard --install-daemon ...

Remote client mode only connects to an existing Gateway. To use it, install
the CLI and run or pass: fased onboard --mode remote
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto-install)
      AUTO_INSTALL=1
      ;;
    --no-auto-install)
      AUTO_INSTALL=0
      ;;
    --install-dir)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for --install-dir" >&2
        exit 1
      fi
      INSTALL_BASE_DIR="$1"
      ;;
    --hosting)
      HOSTING_REQUESTED=1
      pass_args+=(--mode local --host-profile hosting --gateway-bind loopback --tailscale serve)
      ;;
    --repair-hosting)
      HOSTING_REQUESTED=1
      HOSTING_REPAIR_REQUESTED=1
      RUN_ONBOARD=0
      pass_args+=(--mode local --host-profile hosting --gateway-bind loopback --tailscale serve)
      ;;
    --repair-local)
      LOCAL_REPAIR_REQUESTED=1
      RUN_ONBOARD=0
      pass_args+=(--mode local --host-profile local --tailscale off)
      ;;
    --existing-local-bootstrap)
      LOCAL_EXISTING_BOOTSTRAP_REQUESTED=1
      RUN_ONBOARD=0
      pass_args+=(--mode local --host-profile local --tailscale off)
      ;;
    --resume-local-onboarding)
      LOCAL_ONBOARDING_RESUME_REQUESTED=1
      RUN_ONBOARD=1
      pass_args+=(--mode local --host-profile local --tailscale off)
      ;;
    --local)
      pass_args+=(--mode local --host-profile local --tailscale off)
      ;;
    --source-install)
      SOURCE_INSTALL_REQUESTED=1
      ;;
    --release)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for --release" >&2
        exit 1
      fi
      HOSTING_RELEASE="${1#v}"
      ;;
    --update-channel)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for --update-channel" >&2
        exit 1
      fi
      UPDATE_CHANNEL="$1"
      UPDATE_CHANNEL_EXPLICIT=1
      ;;
    --verified-hosting-bundle)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for --verified-hosting-bundle" >&2
        exit 1
      fi
      VERIFIED_HOSTING_BUNDLE="$1"
      ;;
    --verified-hosting-app-handoff)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for --verified-hosting-app-handoff" >&2
        exit 1
      fi
      VERIFIED_HOSTING_APP_HANDOFF="$1"
      ;;
    --ts-authkey)
      echo "Refusing a Tailscale auth key in process arguments." >&2
      echo "Store the key in a root-owned mode-0600 file and pass --ts-authkey-file /root/path." >&2
      exit 1
      ;;
    --ts-authkey-file)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for --ts-authkey-file" >&2
        exit 1
      fi
      TAILSCALE_AUTHKEY_FILE="$1"
      ;;
    --swap-gb)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for --swap-gb" >&2
        exit 1
      fi
      REQUESTED_SWAP_GB="$1"
      pass_args+=(--swap-gb "$1")
      ;;
    --no-git-update)
      INSTALL_GIT_UPDATE=0
      ;;
    --no-onboard)
      RUN_ONBOARD=0
      ;;
    --verbose)
      INSTALL_VERBOSE=1
      ;;
    --host-security-capable)
      pass_args+=(--host-security-capable)
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        pass_args+=("$1")
        shift
      done
      break
      ;;
    *)
      pass_args+=("$1")
      ;;
  esac
  shift
done

if [[ -n "$install_entry_release_identity" ]]; then
  if [[ -n "$HOSTING_RELEASE" && "$HOSTING_RELEASE" != "$install_entry_release_identity" ]]; then
    echo "The immutable installer identity does not match the requested release." >&2
    exit 1
  fi
  HOSTING_RELEASE="$install_entry_release_identity"
fi

if [[ ! "$UPDATE_CHANNEL" =~ ^(stable|beta)$ ]]; then
  echo "--update-channel must be stable or beta." >&2
  exit 1
fi
if [[ "$LOCAL_EXISTING_BOOTSTRAP_REQUESTED" -eq 1 ]] && \
  [[ ! -s "$FASED_CONFIG_DIR/install.json" && ! -s "$FASED_CONFIG_DIR/fased.json" ]]; then
  echo "The internal existing-Local bootstrap requires recognized persistent Local state." >&2
  exit 1
fi
if [[ "$HOSTING_RELEASE" == *-* && "$UPDATE_CHANNEL" != "beta" ]]; then
  echo "A prerelease --release requires --update-channel beta." >&2
  exit 1
fi

for ((i = 0; i < ${#pass_args[@]}; i++)); do
  if [[ "${pass_args[$i]}" == "--host-profile" && "${pass_args[$((i + 1))]:-}" == "hosting" ]]; then
    HOSTING_REQUESTED=1
    break
  fi
done

if [[ "$SOURCE_INSTALL_REQUESTED" -eq 0 && "$HOSTING_REQUESTED" -eq 0 && \
  -z "$HOSTING_RELEASE" && "$install_entry_is_stream" -eq 0 && \
  -d "$FASED_DIR/.git" ]] && \
  [[ -n "$(git -C "$FASED_DIR" status --porcelain=v1 --untracked-files=normal 2>/dev/null || true)" ]]; then
  SOURCE_INSTALL_REQUESTED=1
  DIRTY_CHECKOUT_SOURCE_AUTO_SELECTED=1
  echo "== Installer: local checkout has changes; building and installing this checkout =="
fi

is_windows_posix_shell() {
  case "$(uname -s 2>/dev/null || true)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

is_wsl_environment() {
  [[ "$(uname -s 2>/dev/null || true)" == "Linux" ]] || return 1
  grep -Eqi '(microsoft|wsl)' /proc/sys/kernel/osrelease /proc/version 2>/dev/null
}

is_wsl2_environment() {
  is_wsl_environment || return 1
  uname -r 2>/dev/null | grep -Eqi '(microsoft-standard|wsl2)'
}

systemd_is_pid_one() {
  [[ "$(ps -p 1 -o comm= 2>/dev/null | tr -d '[:space:]')" == "systemd" ]] &&
    command -v systemctl >/dev/null 2>&1
}

validate_verified_hosting_app_handoff() {
  [[ -n "$VERIFIED_HOSTING_APP_HANDOFF" ]] || return 0
  [[ "$HOSTING_REQUESTED" -eq 1 && "$(id -u)" -ne 0 ]] || {
    echo "The internal Hosting app handoff is valid only for the non-root app phase." >&2
    exit 1
  }
  local handoff=""
  local handoff_parent=""
  handoff="$(readlink -f -- "$VERIFIED_HOSTING_APP_HANDOFF" 2>/dev/null || true)"
  handoff_parent="$(dirname "$handoff")"
  [[ "$handoff" =~ ^/run/fased-installer/app-phase-[0-9a-fA-F-]{36}$ && \
    -f "$handoff" && ! -L "$handoff" && "$handoff_parent" == "/run/fased-installer" ]] || {
    echo "The root-to-app Hosting handoff path is invalid." >&2
    exit 1
  }
  local file_owner="" file_mode="" file_links=""
  local parent_owner="" parent_mode=""
  read -r file_owner file_mode file_links <<<"$(stat -c '%u %a %h' "$handoff" 2>/dev/null || true)"
  read -r parent_owner parent_mode <<<"$(stat -c '%u %a' "$handoff_parent" 2>/dev/null || true)"
  [[ "$file_owner" == "0" && "$file_mode" == "440" && "$file_links" == "1" && \
    "$parent_owner" == "0" && "$parent_mode" == "750" ]] || {
    echo "The root-to-app Hosting handoff ownership or mode is invalid." >&2
    exit 1
  }
  local handoff_uid="" handoff_user="" handoff_release="" handoff_channel=""
  local handoff_repo="" handoff_transaction="" handoff_schema=""
  handoff_schema="$(sed -n 's/^schemaVersion=//p' "$handoff")"
  handoff_uid="$(sed -n 's/^appUid=//p' "$handoff")"
  handoff_user="$(sed -n 's/^appUser=//p' "$handoff")"
  handoff_release="$(sed -n 's/^release=//p' "$handoff")"
  handoff_channel="$(sed -n 's/^updateChannel=//p' "$handoff")"
  handoff_repo="$(sed -n 's/^repoPath=//p' "$handoff")"
  handoff_transaction="$(sed -n 's/^transactionId=//p' "$handoff")"
  local canonical_repo=""
  canonical_repo="$(readlink -f -- "$FASED_DIR" 2>/dev/null || true)"
  [[ "$handoff_schema" == "1" && "$handoff_uid" == "$(id -u)" && \
    "$handoff_user" == "$(id -un)" && "$handoff_release" == "$HOSTING_RELEASE" && \
    "$handoff_channel" == "$UPDATE_CHANNEL" && "$handoff_repo" == "$canonical_repo" && \
    "$handoff_transaction" == "${FASED_HOST_UPDATE_TRANSACTION_ID:-}" && \
    "$handoff_transaction" =~ ^[0-9a-fA-F-]{36}$ && \
    "${FASED_HOST_ROOT_PREPARED:-}" == "1" ]] || {
    echo "The root-to-app Hosting handoff does not match this user, release, checkout, or transaction." >&2
    exit 1
  }
  HOSTING_APP_HANDOFF_VERIFIED=1
}

validate_install_platform() {
  if is_windows_posix_shell; then
    cat >&2 <<'EOF_NATIVE_WINDOWS'
Native Windows Node.js, PowerShell, Git Bash, MSYS2, and Cygwin installs are not supported.
Fased and fased-signerd use Unix sockets. Install Ubuntu in WSL2, enable systemd,
open the Ubuntu terminal, and run the Fased installer there.
See: docs/platforms/windows.md
EOF_NATIVE_WINDOWS
    exit 1
  fi

  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    if [[ "$(uname -s 2>/dev/null || true)" != "Linux" ]]; then
      echo "--hosting requires a supported Linux VPS with systemd." >&2
      exit 1
    fi
    if is_wsl_environment; then
      echo "--hosting is for a Linux VPS, not WSL. Use --local inside WSL2." >&2
      exit 1
    fi
    if [[ "$(id -u)" -ne 0 && "$HOSTING_APP_HANDOFF_VERIFIED" -ne 1 ]]; then
      echo "--hosting must run as root so the isolated signer and Gateway services can be installed." >&2
      echo "Open the VPS provider's root console and follow the one-command Hosting guide:" >&2
      echo "  https://docs.fased.ai/install/vps" >&2
      echo "The Hosting bootstrap selects and verifies the tagged release before privileged Fased installation." >&2
      echo "Never run the app-owned checkout with sudo or grant the app account sudo access." >&2
      exit 1
    fi
    if ! systemd_is_pid_one; then
      echo "--hosting requires systemd as PID 1; no host changes were started." >&2
      echo "Use a supported VPS image with systemd, then rerun the installer." >&2
      exit 1
    fi
  elif is_wsl_environment; then
    if ! is_wsl2_environment; then
      echo "WSL1 is not supported. Convert this distribution to WSL2, then rerun inside Ubuntu." >&2
      echo "From PowerShell: wsl --set-version <DistributionName> 2" >&2
      exit 1
    fi
    if ! systemd_is_pid_one; then
      cat >&2 <<'EOF_WSL_SYSTEMD'
Fased on WSL2 requires systemd for reliable Gateway and signer startup.
Inside Ubuntu, add this to /etc/wsl.conf:
  [boot]
  systemd=true
Then run `wsl --shutdown` from PowerShell, reopen Ubuntu, and rerun the installer.
EOF_WSL_SYSTEMD
      exit 1
    fi
  fi
}

validate_verified_hosting_app_handoff
validate_install_platform

set_installer_state_dir() {
  local state_dir="$1"
  case "$state_dir" in
    "~")
      state_dir="$HOME"
      ;;
    "~/"*)
      state_dir="$HOME/${state_dir#"~/"}"
      ;;
  esac
  FASED_CONFIG_DIR="$state_dir"
  FASED_STATE_DIR="$state_dir"
  export FASED_CONFIG_DIR FASED_STATE_DIR
  if [[ -z "${FASED_CONFIG_PATH_EXPLICIT:-}" ]]; then
    FASED_CONFIG_PATH="$state_dir/fased.json"
    export FASED_CONFIG_PATH
  fi
  INSTALL_MARKER_PATH="$FASED_CONFIG_DIR/install-complete.json"
  INSTALL_CACHE_DIR="$FASED_CONFIG_DIR/install-cache"
  INSTALL_LOG_DIR="$FASED_CONFIG_DIR/logs"
}

backup_existing_local_file() {
  local file="$1"
  local suffix="$2"
  if [[ ! -e "$file" ]]; then
    return 0
  fi
  local backup="${file}.bak-${suffix}"
  local index=1
  while [[ -e "$backup" ]]; do
    backup="${file}.bak-${suffix}-${index}"
    index=$((index + 1))
  done
  mv "$file" "$backup"
  printf '%s\n' "$backup"
}

handle_existing_local_state() {
  set_installer_state_dir "$FASED_CONFIG_DIR"
  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    return 0
  fi
  if [[ ! -d "$FASED_CONFIG_DIR" ]]; then
    return 0
  fi
  if [[ -z "$(find "$FASED_CONFIG_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)" ]]; then
    return 0
  fi
  local profile=""
  if [[ -f "$FASED_CONFIG_DIR/install.json" ]] && \
    grep -Eq '"profile"[[:space:]]*:[[:space:]]*"protected-local"' \
      "$FASED_CONFIG_DIR/install.json"; then
    profile="protected-local"
  elif [[ -s "$FASED_CONFIG_DIR/install.json" || -s "$FASED_CONFIG_DIR/fased.json" ]]; then
    profile="pre-handoff-local"
  fi
  if [[ "$LOCAL_ONBOARDING_RESUME_REQUESTED" -eq 1 ]]; then
    if [[ "$profile" != "protected-local" || \
      "$(read_marker_onboarding_completed || true)" == "true" ]]; then
      echo "Local onboarding resume requires one committed, incomplete Protected Local installation." >&2
      exit 1
    fi
    return 0
  fi
  if [[ "$LOCAL_EXISTING_BOOTSTRAP_REQUESTED" -eq 1 || \
    "$LOCAL_REPAIR_REQUESTED" -eq 1 || "$SOURCE_INSTALL_REQUESTED" -eq 1 ]]; then
    if [[ -z "$profile" ]]; then
      echo "Existing Local state is not a recognized migration or repair source." >&2
      exit 1
    fi
    return 0
  fi
  if [[ "$profile" == "protected-local" ]]; then
    echo "Existing Protected Local installation detected; use fased update." >&2
    exit 1
  fi
  if [[ "$profile" == "pre-handoff-local" ]]; then
    echo "Existing pre-handoff Local state must enter the verified migration path; rerun the public Local installer command." >&2
    exit 1
  fi
  echo "Refusing to overlay unrecognized non-empty Local state: $FASED_CONFIG_DIR" >&2
  echo "No existing data was changed." >&2
  exit 1
}

resolve_requested_swap_gb() {
  if [[ -n "$REQUESTED_SWAP_GB" ]]; then
    printf '%s\n' "$REQUESTED_SWAP_GB"
    return 0
  fi

  local profile
  profile="$(resolved_host_profile || true)"
  local total_mem_mb
  total_mem_mb="$(detect_total_mem_mb || true)"

  if [[ "$profile" == "hosting" ]]; then
    if [[ -z "$total_mem_mb" || "$total_mem_mb" -eq 0 || "$total_mem_mb" -le "$LOW_MEMORY_SWAP_THRESHOLD_MB" ]]; then
      printf '%s\n' "$LOW_MEMORY_SWAP_GB"
      return 0
    fi
    printf '%s\n' "$HOSTING_SWAP_GB"
    return 0
  fi

  if [[ -n "$total_mem_mb" && "$total_mem_mb" -gt 0 && "$total_mem_mb" -le "$LOW_MEMORY_SWAP_THRESHOLD_MB" ]]; then
    printf '%s\n' "$LOW_MEMORY_SWAP_GB"
    return 0
  fi

  printf '0\n'
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

node_runtime_ok_for() {
  local node_bin="$1"
  [[ -n "$node_bin" && -x "$node_bin" ]] || return 1
  "$node_bin" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 14)) process.exit(2); try { require("node:sqlite"); } catch { process.exit(3); }' >/dev/null 2>&1
}

node_runtime_ok() {
  need_cmd node || return 1
  node_runtime_ok_for "$(command -v node)"
}

node_runtime_is_user_managed() {
  need_cmd node || return 1
  local node_bin
  node_bin="$(command -v node)"
  case "$node_bin" in
    "$HOME"/.nvm/*|"$HOME"/.fnm/*|"$HOME"/.volta/*|"$HOME"/.asdf/*|"$HOME"/.local/share/mise/*)
      return 0
      ;;
  esac
  return 1
}

node_runtime_issue() {
  if ! need_cmd node; then
    printf 'node is not installed'
    return 0
  fi
  local node_bin
  node_bin="$(command -v node)"
  local version
  version="$(node -v 2>/dev/null || printf 'unknown')"
  if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 14) ? 0 : 1);' >/dev/null 2>&1; then
    printf 'node %s at %s is too old; need Node 24 recommended or Node >=22.14.0 with node:sqlite' "$version" "$node_bin"
    return 0
  fi
  if ! node -e 'require("node:sqlite")' >/dev/null 2>&1; then
    printf 'node %s at %s was built without node:sqlite' "$version" "$node_bin"
    return 0
  fi
  printf 'node runtime is compatible'
}

print_node_runtime_help() {
  cat >&2 <<EOF_NODE
Node runtime is incompatible: $(node_runtime_issue)

Fased needs Node 24 recommended, or Node >=22.14.0, with the built-in node:sqlite module for full memory support.
EOF_NODE
  if node_runtime_is_user_managed; then
    cat >&2 <<'EOF_NODE'
Your active node appears to be managed by a user-level version manager, so install.sh will not replace it with a system package manager automatically.

For nvm:
  nvm install 24
  nvm use 24
  corepack enable
EOF_NODE
  else
    cat >&2 <<'EOF_NODE'
Install Node 24 with your system package manager or fix PATH so install.sh uses a compatible node.
EOF_NODE
  fi
  cat >&2 <<'EOF_NODE'

Quick check:
  node -e 'require("node:sqlite"); console.log("node:sqlite ok")'
EOF_NODE
}

prefer_compatible_user_node_if_available() {
  local candidate
  for candidate in \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.fnm/node-versions/*/installation/bin/node \
    "$HOME"/.volta/bin/node \
    "$HOME"/.asdf/shims/node \
    "$HOME"/.local/share/mise/shims/node; do
    [[ -e "$candidate" ]] || continue
    if node_runtime_ok_for "$candidate"; then
      export PATH="$(dirname "$candidate"):$PATH"
      hash -r 2>/dev/null || true
      return 0
    fi
  done
  return 1
}

prefer_compatible_system_node_if_available() {
  local candidate
  for candidate in /usr/bin/node /usr/local/bin/node /opt/homebrew/bin/node; do
    if node_runtime_ok_for "$candidate"; then
      export PATH="$(dirname "$candidate"):$PATH"
      hash -r 2>/dev/null || true
      return 0
    fi
  done
  return 1
}

run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif need_cmd sudo; then
    sudo "$@"
  else
    echo "sudo is required for system dependency installation." >&2
    return 1
  fi
}

desired_pnpm_version() {
  local version=""
  if [[ -f "$FASED_DIR/package.json" ]]; then
    version="$(
      awk -F'"' '/"packageManager"[[:space:]]*:[[:space:]]*"pnpm@/ {
        sub(/^pnpm@/, "", $4);
        print $4;
        exit
      }' "$FASED_DIR/package.json" 2>/dev/null || true
    )"
  fi
  printf '%s\n' "${version:-10.23.0}"
}

install_pnpm_for_active_node() {
  local npm_prefix="${FASED_NPM_GLOBAL_PREFIX:-$INSTALL_CACHE_DIR/npm-global}"
  if [[ -d "$npm_prefix/bin" ]]; then
    export PATH="$npm_prefix/bin:$PATH"
    hash -r 2>/dev/null || true
  fi
  if need_cmd pnpm; then
    return 0
  fi
  if ! node_runtime_ok; then
    return 1
  fi

  local pnpm_version
  pnpm_version="$(desired_pnpm_version)"
  if need_cmd corepack; then
    local corepack_bin
    local corepack_dir
    local corepack_enabled=0
    corepack_bin="$(command -v corepack)"
    corepack_dir="$(dirname "$corepack_bin")"
    if [[ -w "$corepack_dir" ]]; then
      if corepack enable >/dev/null 2>&1; then
        corepack_enabled=1
      fi
    elif run_as_root corepack enable >/dev/null 2>&1; then
      corepack_enabled=1
    fi
    if [[ "$corepack_enabled" -eq 1 ]]; then
      corepack prepare "pnpm@${pnpm_version}" --activate >/dev/null 2>&1 || true
      hash -r 2>/dev/null || true
    fi
  fi
  if ! need_cmd pnpm && need_cmd npm; then
    mkdir -p "$npm_prefix"
    npm_config_prefix="$npm_prefix" npm install -g --prefix "$npm_prefix" "pnpm@${pnpm_version}" || {
      echo "User-local pnpm install failed." >&2
      echo "Install pnpm manually or rerun with FASED_INSTALL_VERBOSE=1 for npm details." >&2
      return 1
    }
    export PATH="$npm_prefix/bin:$PATH"
  fi
  hash -r 2>/dev/null || true
  need_cmd pnpm
}

install_nodesource_node_apt() {
  local setup_script
  setup_script="$(mktemp)"
  if curl -fsSL https://deb.nodesource.com/setup_24.x -o "$setup_script" && \
    run_as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a bash "$setup_script" && \
    run_as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y nodejs; then
    rm -f "$setup_script"
    return 0
  fi
  rm -f "$setup_script"
  echo "NodeSource Node 24 install failed; trying distro nodejs/npm packages as fallback." >&2
  run_as_root apt-get update
  run_as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y nodejs npm
}

install_nodesource_node_rpm() {
  local pkg_cmd="$1"
  local setup_script
  setup_script="$(mktemp)"
  curl -fsSL https://rpm.nodesource.com/setup_24.x -o "$setup_script"
  run_as_root bash "$setup_script"
  rm -f "$setup_script"
  run_as_root "$pkg_cmd" install -y nodejs
}

linux_os_summary() {
  if [[ -r /etc/os-release ]]; then
    local pretty=""
    local id=""
    local version=""
    # shellcheck source=/dev/null
    . /etc/os-release
    pretty="${PRETTY_NAME:-}"
    id="${ID:-}"
    version="${VERSION_ID:-}"
    if [[ -n "$pretty" ]]; then
      printf '%s\n' "$pretty"
      return 0
    fi
    printf '%s %s\n' "$id" "$version"
    return 0
  fi
  uname -a
}

install_linux_system_dependencies() {
  local install_pnpm="${1:-1}"
  if [[ "$(uname -s)" != "Linux" ]]; then
    return 1
  fi

  if need_cmd apt-get; then
    local -a apt_packages=(git curl ca-certificates jq acl)
    need_cmd setpriv || apt_packages+=(util-linux)
    run_as_root apt-get update
    run_as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
      apt-get install -y "${apt_packages[@]}"
    hash -r 2>/dev/null || true
    if ! node_runtime_ok; then
      install_nodesource_node_apt
      hash -r 2>/dev/null || true
      prefer_compatible_system_node_if_available || true
    fi
  elif need_cmd dnf || need_cmd dnf5; then
    local dnf_cmd="dnf"
    if ! need_cmd dnf && need_cmd dnf5; then
      dnf_cmd="dnf5"
    fi
    local -a rpm_packages=(ca-certificates)
    need_cmd git || rpm_packages+=(git)
    need_cmd curl || rpm_packages+=(curl)
    need_cmd jq || rpm_packages+=(jq)
    { need_cmd getfacl && need_cmd setfacl; } || rpm_packages+=(acl)
    need_cmd setpriv || rpm_packages+=(util-linux)
    run_as_root "$dnf_cmd" install -y "${rpm_packages[@]}"
    hash -r 2>/dev/null || true
    if ! node_runtime_ok; then
      run_as_root "$dnf_cmd" install -y nodejs24-bin nodejs24-npm-bin || \
        run_as_root "$dnf_cmd" install -y nodejs24 npm || \
        run_as_root "$dnf_cmd" install -y nodejs22-bin nodejs22-npm-bin || \
        install_nodesource_node_rpm "$dnf_cmd" || \
        run_as_root "$dnf_cmd" install -y nodejs npm
      hash -r 2>/dev/null || true
      prefer_compatible_system_node_if_available || true
    fi
  elif need_cmd yum; then
    local -a rpm_packages=(ca-certificates)
    need_cmd git || rpm_packages+=(git)
    need_cmd curl || rpm_packages+=(curl)
    need_cmd jq || rpm_packages+=(jq)
    { need_cmd getfacl && need_cmd setfacl; } || rpm_packages+=(acl)
    need_cmd setpriv || rpm_packages+=(util-linux)
    run_as_root yum install -y "${rpm_packages[@]}"
    hash -r 2>/dev/null || true
    if ! node_runtime_ok; then
      install_nodesource_node_rpm yum || \
        run_as_root yum install -y nodejs npm
      hash -r 2>/dev/null || true
      prefer_compatible_system_node_if_available || true
    fi
  elif need_cmd apk; then
    run_as_root apk add --no-cache git curl ca-certificates jq acl util-linux nodejs npm
    hash -r 2>/dev/null || true
  elif need_cmd pacman; then
    run_as_root pacman -Sy --needed --noconfirm git curl ca-certificates jq acl util-linux nodejs npm
    hash -r 2>/dev/null || true
  elif need_cmd zypper; then
    run_as_root zypper --non-interactive refresh || true
    run_as_root zypper --non-interactive install --no-recommends \
      git curl ca-certificates jq acl util-linux
    hash -r 2>/dev/null || true
    if ! node_runtime_ok; then
      run_as_root zypper --non-interactive install --no-recommends nodejs24 npm24 || \
        run_as_root zypper --non-interactive install --no-recommends nodejs22 npm22 || \
        run_as_root zypper --non-interactive install --no-recommends nodejs npm
      hash -r 2>/dev/null || true
      prefer_compatible_system_node_if_available || true
    fi
  else
    echo "Unsupported Linux package manager for --auto-install." >&2
    echo "Detected system: $(linux_os_summary)" >&2
    echo "Supported auto-install package managers: apt-get, dnf, dnf5, yum, zypper, apk, pacman." >&2
    echo "Install git, curl, jq, Node 24, and pnpm manually, then rerun ./install.sh." >&2
    return 1
  fi

  if ! need_cmd setpriv; then
    echo "Protected Linux lifecycle requires setpriv from util-linux." >&2
    return 1
  fi

  if ! node_runtime_ok; then
    print_node_runtime_help
    return 1
  fi
  if [[ "$install_pnpm" == "1" ]]; then
    install_pnpm_for_active_node
  fi
}

github_cli_supports_attestations() {
  need_cmd gh && gh attestation verify --help >/dev/null 2>&1
}

install_github_cli_for_attestations() {
  if github_cli_supports_attestations; then
    return 0
  fi
  if [[ "$AUTO_INSTALL" -ne 1 ]]; then
    echo "GitHub CLI with 'gh attestation verify' is required for official release assets." >&2
    echo "Install a current GitHub CLI, then rerun the installer." >&2
    return 1
  fi

  echo "Installing GitHub CLI for release attestation verification..."
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if ! need_cmd brew; then
      echo "Automatic GitHub CLI installation on macOS requires Homebrew." >&2
      echo "Install Homebrew from https://brew.sh, then rerun the installer." >&2
      return 1
    fi
    brew install gh || brew upgrade gh
  elif [[ "$(uname -s)" != "Linux" ]]; then
    echo "Automatic GitHub CLI installation is unavailable on $(uname -s)." >&2
    echo "Install a current GitHub CLI, then rerun the installer." >&2
    return 1
  elif need_cmd apt-get; then
    local keyring_tmp
    keyring_tmp="$(mktemp)"
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o "$keyring_tmp"
    run_as_root install -d -m 0755 /etc/apt/keyrings
    run_as_root install -m 0644 "$keyring_tmp" /etc/apt/keyrings/githubcli-archive-keyring.gpg
    rm -f "$keyring_tmp"
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' "$(dpkg --print-architecture)" \
      | run_as_root tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    run_as_root apt-get update
    run_as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y gh
  elif need_cmd dnf5; then
    run_as_root dnf5 install -y dnf5-plugins
    run_as_root dnf5 config-manager addrepo \
      --from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo
    run_as_root dnf5 install -y gh
  elif need_cmd dnf; then
    run_as_root dnf install -y 'dnf-command(config-manager)'
    run_as_root dnf config-manager --add-repo \
      https://cli.github.com/packages/rpm/gh-cli.repo
    run_as_root dnf install -y gh
  elif need_cmd yum; then
    run_as_root yum install -y yum-utils >/dev/null 2>&1 || true
    run_as_root yum-config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo >/dev/null 2>&1 || true
    run_as_root yum install -y gh
  elif need_cmd pacman; then
    run_as_root pacman -Sy --needed --noconfirm github-cli
  elif need_cmd apk; then
    run_as_root apk add --no-cache github-cli
  elif need_cmd zypper; then
    run_as_root zypper --non-interactive install --no-recommends gh
  else
    echo "Automatic GitHub CLI installation is unavailable on this distribution." >&2
    return 1
  fi
  hash -r 2>/dev/null || true
  github_cli_supports_attestations || {
    echo "Installed GitHub CLI does not support attestation verification." >&2
    return 1
  }
}

install_freebsd_system_dependencies() {
  if [[ "$(uname -s)" != "FreeBSD" ]]; then
    return 1
  fi
  if ! need_cmd pkg; then
    echo "FreeBSD auto-install needs pkg." >&2
    echo "Install git, curl, ca_root_nss, Node 24, npm, and pnpm manually, then rerun ./install.sh." >&2
    return 1
  fi

  run_as_root pkg update -f || true
  run_as_root pkg install -y git curl ca_root_nss
  hash -r 2>/dev/null || true
  if ! node_runtime_ok; then
    run_as_root pkg install -y node24 npm-node24 || \
      run_as_root pkg install -y node22 npm-node22 || \
      run_as_root pkg install -y node npm
    hash -r 2>/dev/null || true
    prefer_compatible_system_node_if_available || true
  fi

  if ! node_runtime_ok; then
    print_node_runtime_help
    return 1
  fi
  install_pnpm_for_active_node
}

install_macos_system_dependencies() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 1
  fi
  if ! need_cmd brew; then
    cat >&2 <<'EOF_MACOS'
macOS auto-install needs Homebrew.

Install Homebrew from https://brew.sh, then rerun:
  ./install.sh

Or install Node 24 manually from https://nodejs.org, enable pnpm with Corepack,
and rerun:
  corepack enable
  corepack prepare pnpm@10.23.0 --activate
  ./install.sh
EOF_MACOS
    return 1
  fi

  if ! need_cmd git; then
    brew install git
  fi
  if ! need_cmd curl; then
    brew install curl
  fi
  if ! node_runtime_ok; then
    brew install node || brew upgrade node
    hash -r 2>/dev/null || true
    prefer_compatible_system_node_if_available || true
  fi
  if ! need_cmd pnpm; then
    brew install pnpm || install_pnpm_for_active_node
    hash -r 2>/dev/null || true
  fi

  if ! node_runtime_ok; then
    print_node_runtime_help
    return 1
  fi
  if ! need_cmd pnpm; then
    install_pnpm_for_active_node
  fi
  return 0
}

install_supported_system_dependencies() {
  case "$(uname -s)" in
    Linux)
      install_linux_system_dependencies
      ;;
    Darwin)
      install_macos_system_dependencies
      ;;
    FreeBSD)
      install_freebsd_system_dependencies
      ;;
    *)
      echo "Unsupported operating system for --auto-install: $(uname -s)" >&2
      echo "Supported auto-install targets: Linux with apt-get/dnf/dnf5/yum/zypper/apk/pacman, FreeBSD with pkg, or macOS with Homebrew." >&2
      echo "Install git, curl, Node 24, and pnpm manually, then rerun ./install.sh." >&2
      return 1
      ;;
  esac
}

root_has_active_time_sync_service() {
  if [[ "$(uname -s)" != "Linux" || "$(id -u)" -ne 0 ]] || ! need_cmd systemctl; then
    return 1
  fi
  systemctl is-active --quiet systemd-timesyncd || \
    systemctl is-active --quiet chronyd || \
    systemctl is-active --quiet chrony
}

best_effort_enable_root_host_time_sync() {
  if [[ "$(uname -s)" != "Linux" || "$(id -u)" -ne 0 ]]; then
    return 0
  fi

  echo "== Ensure host clock sync for managed public runtime =="
  if need_cmd timedatectl; then
    timedatectl set-ntp true >/dev/null 2>&1 || true
  fi

  if need_cmd systemctl; then
    systemctl enable --now systemd-timesyncd >/dev/null 2>&1 || \
      systemctl restart systemd-timesyncd >/dev/null 2>&1 || true
  fi

  if root_has_active_time_sync_service; then
    return 0
  fi

  if need_cmd apt-get; then
    apt-get install -y chrony >/dev/null 2>&1 || true
  fi
  if need_cmd systemctl; then
    systemctl enable --now chrony >/dev/null 2>&1 || \
      systemctl enable --now chronyd >/dev/null 2>&1 || \
      systemctl restart chrony >/dev/null 2>&1 || \
      systemctl restart chronyd >/dev/null 2>&1 || true
  fi
  if need_cmd chronyc; then
    chronyc -a makestep >/dev/null 2>&1 || true
  fi
}

is_fased_repo_dir() {
  local dir="$1"
  [[ -f "$dir/package.json" && -d "$dir/src" ]]
}

resolve_fased_dir_from_base() {
  local base="$1"
  if is_fased_repo_dir "$base"; then
    printf '%s\n' "$base"
    return 0
  fi
  return 1
}

shell_quote() {
  printf "%q" "$1"
}

ensure_checkout_origin_remote() {
  local repo_dir="$1"
  local origin_url=""

  if [[ ! -d "$repo_dir/.git" ]]; then
    return 0
  fi

  origin_url="$(git -C "$repo_dir" remote get-url origin 2>/dev/null || true)"
  if [[ -z "$origin_url" ]]; then
    git -C "$repo_dir" remote add origin "$INSTALL_REPO_URL"
    return 0
  fi

  case "$origin_url" in
    /*|file://*)
      git -C "$repo_dir" remote set-url origin "$INSTALL_REPO_URL"
      ;;
  esac
}

refresh_checkout_from_origin() {
  local repo_dir="$1"
  local label="${2:-Installer}"
  local branch=""
  local remote_ref=""
  local before=""
  local after=""

  if [[ "$INSTALL_GIT_UPDATE" == "0" || ! -d "$repo_dir/.git" ]] || ! need_cmd git; then
    return 0
  fi

  ensure_checkout_origin_remote "$repo_dir"

  branch="$(git -C "$repo_dir" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [[ -z "$branch" ]]; then
    echo "== $label: detached checkout detected, skipping git update =="
    return 0
  fi

  if ! git -C "$repo_dir" diff --quiet --ignore-submodules -- || ! git -C "$repo_dir" diff --cached --quiet --ignore-submodules --; then
    if [[ "$DIRTY_CHECKOUT_SOURCE_AUTO_SELECTED" -ne 1 ]]; then
      echo "== $label: local checkout has changes, skipping git update =="
    fi
    return 0
  fi

  remote_ref="origin/$branch"
  git -C "$repo_dir" fetch --quiet origin "$branch" || {
    echo "== $label: could not fetch $remote_ref, continuing with local checkout =="
    return 0
  }

  if ! git -C "$repo_dir" merge-base --is-ancestor HEAD "$remote_ref" >/dev/null 2>&1; then
    echo "== $label: $repo_dir is not a fast-forward from $remote_ref, skipping git update =="
    return 0
  fi

  before="$(git -C "$repo_dir" rev-parse --short HEAD 2>/dev/null || true)"
  after="$(git -C "$repo_dir" rev-parse --short "$remote_ref" 2>/dev/null || true)"
  if [[ -n "$before" && -n "$after" && "$before" != "$after" ]]; then
    echo "== $label: updating $repo_dir from $remote_ref ($before -> $after) =="
    git -C "$repo_dir" merge --ff-only "$remote_ref"
  fi
}

refresh_current_checkout_and_reexec_if_needed() {
  local repo_dir=""
  local before=""
  local after=""

  if [[ "$INSTALL_GIT_UPDATE" == "0" || "${FASED_INSTALL_REEXECED_AFTER_UPDATE:-0}" == "1" ]] || ! need_cmd git; then
    return 0
  fi
  if ! is_fased_repo_dir "$FASED_DIR" || [[ ! -d "$FASED_DIR/.git" ]]; then
    return 0
  fi

  repo_dir="$(cd "$FASED_DIR" && pwd)"
  before="$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null || true)"
  refresh_checkout_from_origin "$repo_dir" "Installer"
  after="$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null || true)"

  if [[ -n "$before" && -n "$after" && "$before" != "$after" ]]; then
    echo "== Installer: restarting after source update =="
    cd "$repo_dir"
    FASED_INSTALL_REEXECED_AFTER_UPDATE=1 exec ./install.sh "${ORIGINAL_INSTALL_ARGS[@]}"
  fi
}

install_user_cli_path_snippet() {
  local bin_dir="$1"
  local file="$2"
  [[ -n "$bin_dir" && -n "$file" ]] || return 0
  if [[ -f "$file" ]] && grep -F "$bin_dir" "$file" >/dev/null 2>&1; then
    return 0
  fi
  if [[ -e "$file" && ! -w "$file" ]]; then
    return 0
  fi
  {
    printf '\n# Fased CLI\n'
    printf 'case ":$PATH:" in\n'
    printf '  *":%s:"*) ;;\n' "$bin_dir"
    printf '  *) export PATH="%s:$PATH" ;;\n' "$bin_dir"
    printf 'esac\n'
  } >>"$file"
}

install_fased_cli_launcher() {
  local launcher="$FASED_DIR/fased.mjs"
  local bin_dir="${FASED_CLI_BIN_DIR:-$HOME/.local/bin}"
  local target="$bin_dir/fased"

  if [[ ! -f "$launcher" ]]; then
    echo "CLI launcher missing: $launcher" >&2
    exit 1
  fi

  mkdir -p "$bin_dir"
  chmod 755 "$launcher" 2>/dev/null || true

  local launcher_real=""
  local target_real=""
  launcher_real="$(readlink -f "$launcher" 2>/dev/null || true)"
  if [[ -e "$target" || -L "$target" ]]; then
    target_real="$(readlink -f "$target" 2>/dev/null || true)"
  fi

  if [[ -n "$launcher_real" && "$target_real" == "$launcher_real" ]]; then
    :
  elif ! ln -sfn "$launcher" "$target" 2>/dev/null; then
    target_real=""
    if [[ -e "$target" || -L "$target" ]]; then
      target_real="$(readlink -f "$target" 2>/dev/null || true)"
    fi
    if [[ -n "$launcher_real" && "$target_real" == "$launcher_real" ]]; then
      :
    else
      rm -f "$target"
      {
        printf '#!/usr/bin/env bash\n'
        printf 'exec %s "$@"\n' "$(shell_quote "$launcher")"
      } >"$target"
      chmod 755 "$target"
    fi
  fi

  export PATH="$bin_dir:$PATH"
  hash -r 2>/dev/null || true
  FASED_CLI_PATH="$target"

  install_user_cli_path_snippet "$bin_dir" "$HOME/.profile"
  install_user_cli_path_snippet "$bin_dir" "$HOME/.bashrc"
  install_user_cli_path_snippet "$bin_dir" "$HOME/.zshrc"

  if ! "$FASED_CLI_PATH" --version >/dev/null 2>&1; then
    echo "Installed CLI did not start correctly: $FASED_CLI_PATH" >&2
    echo "Check $INSTALL_LOG_DIR and rerun ./install.sh --verbose." >&2
    exit 1
  fi

  step_done "CLI installed"
}

use_prebuilt_release_runtime() {
  fased_should_use_prebuilt_release_runtime \
    "$(resolved_host_profile)" \
    "$SOURCE_INSTALL_REQUESTED" \
    "${FASED_SOURCE_INSTALL:-0}" \
    "${FASED_HOSTING_SOURCE_INSTALL:-0}" \
    "$(uname -s 2>/dev/null || true)" \
    "$(uname -m 2>/dev/null || true)"
}

install_prebuilt_release_runtime() {
  local runtime_profile
  runtime_profile="$(resolved_host_profile)"
  local package_spec="${RELEASE_NPM_PACKAGE:-@fased/fased@latest}"
  if [[ -n "$HOSTING_RELEASE" ]]; then
    if [[ ! "$HOSTING_RELEASE" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
      echo "Managed release installation requires one exact --release identity." >&2
      return 1
    fi
    package_spec="@fased/fased@${HOSTING_RELEASE}"
  elif [[ "$runtime_profile" == "hosting" ]]; then
    echo "Maintained Hosting requires one exact stable --release vX.Y.Z." >&2
    return 1
  fi
  local npm_prefix="${FASED_NPM_GLOBAL_PREFIX:-$INSTALL_CACHE_DIR/npm-global}"
  local bin_dir="$npm_prefix/bin"
  local target="$bin_dir/fased"
  local install_log
  install_log="$(install_log_path "npm prebuilt install")"

  mkdir -p "$npm_prefix" "$npm_config_cache"
  spinner_start "Install prebuilt runtime"
  local artifact_result=0
  local -a runtime_install_args=(
    bash "$FASED_DIR/scripts/install-hosted-runtime.sh"
    --package "$package_spec"
    --prefix "$npm_prefix"
    --cache "$INSTALL_CACHE_DIR"
    --state-dir "$FASED_CONFIG_DIR"
    --profile "$runtime_profile"
  )
  if [[ "$INSTALL_VERBOSE" == "1" ]]; then
    "${runtime_install_args[@]}" || artifact_result=$?
  else
    "${runtime_install_args[@]}" >"$install_log" 2>&1 || artifact_result=$?
  fi
  if [[ "$artifact_result" -eq 20 ]]; then
    spinner_failed "Install prebuilt runtime"
    [[ "$INSTALL_VERBOSE" == "1" ]] || tail -n 80 "$install_log" >&2 || true
    return 1
  fi
  if [[ "$artifact_result" -ne 0 ]]; then
    if [[ "$runtime_profile" == "hosting" ]]; then
      spinner_failed "Install prebuilt runtime"
      echo "Exact attested Hosting app/dependency assets for ${package_spec} are unavailable; the current installation was not changed." >&2
      echo "Maintained Hosting never falls back to npm." >&2
      [[ "$INSTALL_VERBOSE" == "1" ]] || tail -n 80 "$install_log" >&2 || true
      return 1
    fi
    if [[ "$INSTALL_VERBOSE" == "1" ]]; then
      echo "Release runtime artifact unavailable; using npm fallback."
      npm_config_prefix="$npm_prefix" npm_config_cache="$npm_config_cache" \
        npm install -g --prefix "$npm_prefix" "$package_spec" --no-audit --no-fund
    else
      npm_config_prefix="$npm_prefix" npm_config_cache="$npm_config_cache" \
        npm install -g --prefix "$npm_prefix" "$package_spec" --no-audit --no-fund >"$install_log" 2>&1 || {
          spinner_failed "Install prebuilt runtime"
          echo "Failed: release runtime and npm fallback install" >&2
          echo "Package: $package_spec" >&2
          echo "Log: $install_log" >&2
          tail -n 80 "$install_log" >&2 || true
          return 1
      }
    fi
  fi

  local installed_package_root="$npm_prefix/lib/node_modules/@fased/fased"
  if [[ "$artifact_result" -ne 0 ]]; then
    local -a managed_install_args=(
      --package-root "$installed_package_root"
      --state-dir "$FASED_CONFIG_DIR"
      --prefix "$npm_prefix"
      --profile "$(resolved_host_profile)"
      --update-channel "$UPDATE_CHANNEL"
    )
    if [[ -n "${FASED_HOST_UPDATE_TRANSACTION_ID:-}" ]]; then
      managed_install_args+=(
        --host-transaction-id "$FASED_HOST_UPDATE_TRANSACTION_ID"
        --host-transaction-version "${FASED_HOST_UPDATE_TRANSACTION_VERSION:-}"
      )
    fi
    node "$installed_package_root/scripts/install-managed-runtime.mjs" \
      "${managed_install_args[@]}" || {
        spinner_failed "Install prebuilt runtime"
        echo "Failed to install the stable Fased updater layout." >&2
        return 1
      }
  fi

  export PATH="$bin_dir:$PATH"
  hash -r 2>/dev/null || true
  FASED_CLI_PATH="$target"

  if ! node "$FASED_DIR/scripts/install-managed-cli-alias.mjs" \
    --target "$target" \
    --source-launcher "$FASED_DIR/fased.mjs"; then
    spinner_failed "Install prebuilt runtime"
    echo "Failed to reconcile the managed Fased CLI launcher." >&2
    return 1
  fi

  install_user_cli_path_snippet "$bin_dir" "$HOME/.profile"
  install_user_cli_path_snippet "$bin_dir" "$HOME/.bashrc"
  install_user_cli_path_snippet "$bin_dir" "$HOME/.zshrc"

  if [[ ! -x "$FASED_CLI_PATH" ]] || ! "$FASED_CLI_PATH" --version >/dev/null 2>&1; then
    spinner_failed "Install prebuilt runtime"
    echo "Installed npm CLI did not start correctly: $FASED_CLI_PATH" >&2
    echo "Log: $install_log" >&2
    return 1
  fi

  PREBUILT_RUNTIME_INSTALLED=1
  spinner_done "Prebuilt runtime ready"
}

pass_args_contains() {
  local needle="$1"
  local arg
  for arg in "${pass_args[@]}"; do
    if [[ "$arg" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

pass_args_value_after() {
  local needle="$1"
  local i
  for ((i = 0; i < ${#pass_args[@]}; i++)); do
    if [[ "${pass_args[$i]}" == "$needle" ]]; then
      printf '%s\n' "${pass_args[$((i + 1))]:-}"
      return 0
    fi
  done
  return 1
}

resolved_host_profile() {
  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    printf 'hosting\n'
    return 0
  fi
  if [[ -f "$FASED_CONFIG_DIR/install.json" ]] && \
    grep -Eq '"profile"[[:space:]]*:[[:space:]]*"protected-local"' "$FASED_CONFIG_DIR/install.json"; then
    # protected-local is an installed service topology, not a release artifact
    # profile. Its application payload is the Local managed runtime.
    printf 'local\n'
    return 0
  fi
  if [[ -f "$FASED_CONFIG_DIR/lifecycle.json" ]] && \
    grep -Eq '"profile"[[:space:]]*:[[:space:]]*"protected-local"' "$FASED_CONFIG_DIR/lifecycle.json"; then
    printf 'local\n'
    return 0
  fi

  local profile
  profile="$(pass_args_value_after "--host-profile" || true)"
  if [[ -z "$profile" ]]; then
    profile="local"
  fi
  printf '%s\n' "$profile"
}

protected_local_target_platform() {
  [[ "$(uname -s 2>/dev/null || true)" == "Linux" ]] || return 1
  systemd_is_pid_one || return 1
  [[ "$(resolved_host_profile)" != "hosting" ]] || return 1
  [[ "$SOURCE_INSTALL_REQUESTED" -eq 0 ]] || return 1
  [[ "$(id -u)" -ne 0 ]] || return 1
}

fresh_protected_local_install_requested() {
  protected_local_target_platform || return 1
  [[ "$LOCAL_REPAIR_REQUESTED" -eq 0 ]] || return 1
  [[ "$LOCAL_EXISTING_BOOTSTRAP_REQUESTED" -eq 0 ]] || return 1
  [[ "$LOCAL_ONBOARDING_RESUME_REQUESTED" -eq 0 ]] || return 1
  [[ -n "$HOSTING_RELEASE" ]] || return 1
  [[ ! -s "$FASED_CONFIG_DIR/install.json" && ! -s "$FASED_CONFIG_DIR/fased.json" ]]
}

protected_local_supported() {
  protected_local_target_platform || return 1
  command -v sudo >/dev/null 2>&1
}

resolve_protected_local_system_node() {
  local candidate=""
  local resolved=""
  for candidate in /usr/bin/node /usr/local/bin/node; do
    node_runtime_ok_for "$candidate" || continue
    resolved="$(readlink -f -- "$candidate" 2>/dev/null || true)"
    case "$resolved" in
      /usr/bin/*|/usr/local/bin/*)
        printf '%s\n' "$resolved"
        return 0
        ;;
    esac
  done
  return 1
}

read_protected_local_env() {
  local config="${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}"
  local projection="$FASED_CONFIG_DIR/lifecycle.json"
  [[ -f "$config" || -f "$projection" ]] || return 1
  protected_local_value() {
    node -e '
      const fs = require("node:fs");
      const configPath = process.argv[1];
      const projectionPath = process.argv[2];
      const key = process.argv[3];
      const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : null;
      const projection = fs.existsSync(projectionPath) ? JSON.parse(fs.readFileSync(projectionPath, "utf8")) : null;
      const result = config?.env?.vars?.[key] ?? projection?.environment?.[key];
      if (typeof result === "string") process.stdout.write(result);
    ' "$config" "$projection" "$1"
  }
  FASED_PROTECTED_LOCAL="$(protected_local_value FASED_PROTECTED_LOCAL)"
  FASED_PROTECTED_LOCAL_INSTANCE="$(protected_local_value FASED_PROTECTED_LOCAL_INSTANCE)"
  FASED_WALLET_LOCAL_SIGNER_LIFECYCLE="$(protected_local_value FASED_WALLET_LOCAL_SIGNER_LIFECYCLE)"
  FASED_WALLET_LOCAL_SIGNER_BIN="$(protected_local_value FASED_WALLET_LOCAL_SIGNER_BIN)"
  FASED_WALLET_LOCAL_SIGNER_SOCKET="$(protected_local_value FASED_WALLET_LOCAL_SIGNER_SOCKET)"
  FASED_HOST_UPDATER_SOCKET="$(protected_local_value FASED_HOST_UPDATER_SOCKET)"
  FASED_HOST_UPDATERCTL_STATE="$(protected_local_value FASED_HOST_UPDATERCTL_STATE)"
  if [[ "$FASED_PROTECTED_LOCAL" != "1" || \
    ! "$FASED_PROTECTED_LOCAL_INSTANCE" =~ ^[a-f0-9]{16}$ || \
    "$FASED_WALLET_LOCAL_SIGNER_LIFECYCLE" != "external" ]]; then
    return 1
  fi
  PROTECTED_LOCAL_INSTANCE="$FASED_PROTECTED_LOCAL_INSTANCE"
  export \
    FASED_PROTECTED_LOCAL \
    FASED_PROTECTED_LOCAL_INSTANCE \
    FASED_WALLET_LOCAL_SIGNER_LIFECYCLE \
    FASED_WALLET_LOCAL_SIGNER_BIN \
    FASED_WALLET_LOCAL_SIGNER_SOCKET \
    FASED_HOST_UPDATER_SOCKET \
    FASED_HOST_UPDATERCTL_STATE
}

resolve_shared_managed_state_group() {
  if [[ "$(resolved_host_profile)" == "hosting" ]]; then
    printf '%s\n' "${FASED_CONFIG_GROUP:-fased-config}"
    return 0
  fi
  local protected_instance="${FASED_PROTECTED_LOCAL_INSTANCE:-}"
  if [[ "${PROTECTED_LOCAL_BOOTSTRAPPED:-0}" -eq 1 && \
    "${FASED_PROTECTED_LOCAL:-0}" == "1" && \
    "$protected_instance" =~ ^[a-f0-9]{16}$ ]]; then
    printf 'fscf-%s\n' "$protected_instance"
    return 0
  fi
  if read_protected_local_env; then
    printf 'fscf-%s\n' "$PROTECTED_LOCAL_INSTANCE"
    return 0
  fi
  return 1
}

ensure_fased_config_dir_permissions() {
  mkdir -p "$FASED_CONFIG_DIR"
  local shared_group=""
  shared_group="$(resolve_shared_managed_state_group || true)"
  if [[ -z "$shared_group" ]]; then
    chmod 0700 "$FASED_CONFIG_DIR"
    return 0
  fi
  local actual_group=""
  actual_group="$(stat -c '%G' "$FASED_CONFIG_DIR" 2>/dev/null || true)"
  if [[ "$actual_group" != "$shared_group" ]]; then
    echo "Fased shared state group mismatch: expected $shared_group, found ${actual_group:-unknown}." >&2
    return 1
  fi
  local actual_mode=""
  actual_mode="$(stat -c '%a' "$FASED_CONFIG_DIR" 2>/dev/null || true)"
  if [[ "$actual_mode" != "2770" ]]; then
    echo "Fased shared state mode mismatch: expected 2770, found ${actual_mode:-unknown}." >&2
    return 1
  fi
}

managed_state_file_mode() {
  if resolve_shared_managed_state_group >/dev/null 2>&1; then
    printf '0660\n'
  else
    printf '0600\n'
  fi
}

bootstrap_protected_local_topology() {
  local gateway_mode="$1"
  protected_local_supported || return 2
  local release_source="$FASED_DIR"
  if [[ ! -f "$release_source/install.sh" || \
    ! -f "$release_source/package.json" ]]; then
    echo "The exact Local release is missing its protected service bootstrap." >&2
    return 1
  fi
  local gateway_port=""
  gateway_port="$(pass_args_value_after "--gateway-port" || true)"
  gateway_port="${gateway_port:-${FASED_GATEWAY_PORT:-18789}}"
  local system_node=""
  system_node="$(resolve_protected_local_system_node || true)"
  if [[ -z "$system_node" && "$AUTO_INSTALL" -eq 1 ]]; then
    echo "Installing a protected system Node.js runtime for Local services..."
    if ! (
      export PATH="/usr/sbin:/usr/bin:/sbin:/bin"
      install_linux_system_dependencies 0
    ); then
      echo "Protected Local could not install a compatible system Node.js runtime." >&2
      return 1
    fi
    hash -r 2>/dev/null || true
    system_node="$(resolve_protected_local_system_node || true)"
  fi
  if [[ -z "$system_node" ]]; then
    echo "Protected Local requires a root-controlled system Node.js runtime." >&2
    return 1
  fi
  local release_version=""
  release_version="$("$system_node" -e 'const v=require(process.argv[1]);process.stdout.write(String(v.version||""))' "$release_source/package.json")"
  if [[ ! "$HOSTING_RELEASE" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ || \
    "$release_version" != "$HOSTING_RELEASE" ]]; then
    echo "The Local release does not have one exact matching release identity." >&2
    return 1
  fi
  spinner_start "Secure signer and Gateway services"
  local bootstrap_log
  bootstrap_log="$(install_log_path "protected local ${gateway_mode}")"
  local -a bootstrap_args=(
    sudo -- /bin/bash "$FASED_DIR/install.sh"
    --protected-local-root-bootstrap
    --release "$release_version"
    --update-channel "$UPDATE_CHANNEL"
    --protected-local-operator-user "$(id -un)"
    --protected-local-state-dir "$FASED_CONFIG_DIR"
    --protected-local-gateway-port "$gateway_port"
  )
  local bootstrap_result=0
  "${bootstrap_args[@]}" >"$bootstrap_log" 2>&1 || bootstrap_result=$?
  if [[ "$bootstrap_result" -ne 0 ]]; then
    spinner_failed "Secure signer and Gateway services"
    [[ "$INSTALL_VERBOSE" == "1" ]] || tail -n 80 "$bootstrap_log" >&2 || true
    return "$bootstrap_result"
  fi
  spinner_done "Signer and Gateway services ready"
  if [[ "$gateway_mode" == "rollback" ]]; then
    PROTECTED_LOCAL_BOOTSTRAPPED=0
    return 0
  fi
  read_protected_local_env || {
    echo "Protected Local bootstrap returned without its exact operator environment." >&2
    return 1
  }
  PROTECTED_LOCAL_BOOTSTRAPPED=1
  if [[ "$gateway_mode" == "activate" ]]; then
    PROTECTED_LOCAL_LIFECYCLE_COMMITTED=1
  fi
}

is_app_service_session() {
  local current_user="${USER:-${LOGNAME:-}}"
  local install_user="${FASED_INSTALL_USER:-app}"
  [[ -n "$current_user" && "$current_user" == "$install_user" ]]
}

resolve_repo_root() {
  if is_fased_repo_dir "$FASED_DIR"; then
    (cd "$FASED_DIR" && pwd)
    return 0
  fi
  (cd "$FASED_DIR/../.." && pwd)
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

read_marker_repo_path() {
  if [[ ! -f "$INSTALL_MARKER_PATH" ]]; then
    return 0
  fi
  if need_cmd node; then
    node -e 'const fs=require("fs");try{const p=process.argv[1];const o=JSON.parse(fs.readFileSync(p,"utf8"));if(typeof o.repoPath==="string")process.stdout.write(o.repoPath);}catch{}' "$INSTALL_MARKER_PATH"
    return 0
  fi
  sed -n 's/.*"repoPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALL_MARKER_PATH" | head -n 1
}

read_marker_onboarding_completed() {
  if [[ ! -f "$INSTALL_MARKER_PATH" ]]; then
    return 0
  fi
  if need_cmd node; then
    node -e 'const fs=require("fs");try{const p=process.argv[1];const o=JSON.parse(fs.readFileSync(p,"utf8"));if(o.onboardingCompleted===true)process.stdout.write("true");else if(o.onboardingCompleted===false)process.stdout.write("false");}catch{}' "$INSTALL_MARKER_PATH"
    return 0
  fi
  if grep -q '"onboardingCompleted"[[:space:]]*:[[:space:]]*true' "$INSTALL_MARKER_PATH" 2>/dev/null; then
    printf 'true\n'
  elif grep -q '"onboardingCompleted"[[:space:]]*:[[:space:]]*false' "$INSTALL_MARKER_PATH" 2>/dev/null; then
    printf 'false\n'
  fi
}

assert_marker_matches_repo() {
  local repo_root="$1"
  local marker_repo
  marker_repo="$(read_marker_repo_path || true)"
  if [[ -n "$marker_repo" && "$marker_repo" != "$repo_root" ]]; then
    if [[ "$HOSTING_REQUESTED" -ne 1 ]]; then
      echo "Existing local install marker points at another checkout; continuing with this checkout."
      echo "The Gateway service will be checked and reinstalled if it is stale."
      return 0
    fi
    echo "Install marker mismatch." >&2
    echo "Marker repoPath: $marker_repo" >&2
    echo "Current repoPath: $repo_root" >&2
    echo "Use the canonical repo path from marker, or remove $INSTALL_MARKER_PATH if you are intentionally moving installs." >&2
    exit 1
  fi
}

write_install_marker() {
  local repo_root="$1"
  local onboarding_completed="$2"
  local escaped_repo
  escaped_repo="$(json_escape "$repo_root")"
  ensure_fased_config_dir_permissions
  cat >"$INSTALL_MARKER_PATH" <<EOF
{
  "repoPath": "$escaped_repo",
  "fasedDir": "$escaped_repo",
  "onboardingCompleted": $onboarding_completed,
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  chmod 600 "$INSTALL_MARKER_PATH" 2>/dev/null || true
}

prepare_protected_local_onboarding_scaffold() {
  [[ "${PROTECTED_LOCAL_BOOTSTRAPPED:-0}" -eq 1 ]] || return 0
  read_protected_local_env || {
    echo "Committed Protected Local identity is unavailable before onboarding." >&2
    return 1
  }
  local config_path="${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}"
  if [[ -e "$config_path" || -L "$config_path" ]]; then
    [[ -f "$config_path" && ! -L "$config_path" ]] || {
      echo "Fased onboarding config must be a regular non-symlink file." >&2
      return 1
    }
    return 0
  fi
  CONFIG_PATH="$config_path" FASED_UPDATE_CHANNEL="$UPDATE_CHANNEL" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const configPath = process.env.CONFIG_PATH;
const channel = process.env.FASED_UPDATE_CHANNEL;
const instance = process.env.FASED_PROTECTED_LOCAL_INSTANCE;
if (
  !configPath ||
  !path.isAbsolute(configPath) ||
  !new Set(["stable", "beta"]).has(channel) ||
  process.env.FASED_PROTECTED_LOCAL !== "1" ||
  !/^[a-f0-9]{16}$/u.test(instance || "") ||
  process.env.FASED_WALLET_LOCAL_SIGNER_LIFECYCLE !== "external"
) {
  throw new Error("Protected Local onboarding scaffold identity is invalid");
}
const variables = {};
for (const key of [
  "FASED_HOST_PROFILE",
  "FASED_HOST_UPDATER_SOCKET",
  "FASED_PROTECTED_LOCAL",
  "FASED_PROTECTED_LOCAL_INSTANCE",
  "FASED_WALLET_LOCAL_SIGNER_BIN",
  "FASED_WALLET_LOCAL_SIGNER_LIFECYCLE",
  "FASED_WALLET_LOCAL_SIGNER_SOCKET",
]) {
  const value = process.env[key];
  if (typeof value === "string" && value.length > 0) variables[key] = value;
}
variables.FASED_UPDATE_CHANNEL = channel;
const temporary = `${configPath}.installer-${process.pid}`;
let descriptor;
try {
  descriptor = fs.openSync(temporary, "wx", 0o600);
  fs.writeFileSync(descriptor, `${JSON.stringify({ env: { vars: variables } }, null, 2)}\n`);
  fs.fsyncSync(descriptor);
  fs.closeSync(descriptor);
  descriptor = undefined;
  fs.renameSync(temporary, configPath);
} finally {
  if (descriptor !== undefined) fs.closeSync(descriptor);
  try { fs.unlinkSync(temporary); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
NODE
}

persist_runtime_update_channel() {
  local transaction_phase="${1:-active}"
  RUNTIME_UPDATE_CHANNEL_CHANGED=0
  if [[ "$UPDATE_CHANNEL_EXPLICIT" -ne 1 && "$HOSTING_REQUESTED" -ne 1 ]]; then
    return 0
  fi
  local config_path="${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}"
  [[ -f "$config_path" && ! -L "$config_path" ]] || return 0
  local config_mode=""
  if [[ "$transaction_phase" == "protected-local-pre-activation" ]]; then
    local config_uid=""
    config_uid="$(stat -c '%u' "$config_path" 2>/dev/null || true)"
    if [[ "$config_uid" != "$(id -u)" ]]; then
      echo "Prepared Protected Local config is not owned by the operator." >&2
      return 1
    fi
    config_mode="0600"
  elif [[ "$transaction_phase" == "active" ]]; then
    ensure_fased_config_dir_permissions
    config_mode="$(managed_state_file_mode)"
  else
    echo "Unknown update-channel persistence phase: $transaction_phase" >&2
    return 1
  fi
  local result=""
  result="$(
    CONFIG_PATH="$config_path" CONFIG_MODE="$config_mode" UPDATE_CHANNEL="$UPDATE_CHANNEL" node <<'NODE'
const fs = require("node:fs");

const configPath = process.env.CONFIG_PATH;
const configMode = Number.parseInt(process.env.CONFIG_MODE || "", 8);
const channel = process.env.UPDATE_CHANNEL;
if (
  !configPath ||
  !Number.isSafeInteger(configMode) ||
  !new Set([0o600, 0o660]).has(configMode) ||
  !new Set(["stable", "beta"]).has(channel)
) {
  process.exit(1);
}
const stat = fs.lstatSync(configPath);
if (!stat.isFile() || stat.isSymbolicLink()) {
  throw new Error("Fased config must be a regular non-symlink file");
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.update = config.update && typeof config.update === "object" ? config.update : {};
if (config.update.channel === channel) {
  fs.chmodSync(configPath, configMode);
  process.stdout.write("unchanged");
  process.exit(0);
}
config.update.channel = channel;
const temporary = `${configPath}.update-channel-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
  mode: configMode,
  flag: "wx",
});
fs.renameSync(temporary, configPath);
fs.chmodSync(configPath, configMode);
process.stdout.write("changed");
NODE
  )"
  if [[ "$result" == "changed" ]]; then
    RUNTIME_UPDATE_CHANNEL_CHANGED=1
  fi
}

wait_for_protected_local_gateway_config_convergence() {
  local previous_pid="$1"
  [[ "$RUNTIME_UPDATE_CHANNEL_CHANGED" -eq 1 ]] || return 0
  [[ "$PROTECTED_LOCAL_INSTANCE" =~ ^[a-f0-9]{16}$ ]] || return 1
  local unit="fased-gateway-$PROTECTED_LOCAL_INSTANCE.service"
  local current_pid=""
  local active=""
  local deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do
    current_pid="$(systemctl show -p MainPID --value "$unit" 2>/dev/null || true)"
    active="$(systemctl is-active "$unit" 2>/dev/null || true)"
    if [[ "$active" == "active" && "$current_pid" =~ ^[1-9][0-9]*$ && \
      "$current_pid" != "$previous_pid" ]]; then
      wait_for_gateway_health_after_restart
      return $?
    fi
    sleep 0.5
  done
  echo "Protected Local Gateway did not settle after its update-channel change." >&2
  return 1
}

repair_tailscale_serve_gateway_config() {
  local config_path="${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}"
  if [[ ! -f "$config_path" ]] || ! need_cmd node; then
    return 0
  fi

  local output
  output="$(
    CONFIG_PATH="$config_path" node <<'NODE'
const fs = require("fs");

const configPath = process.env.CONFIG_PATH;
if (!configPath || !fs.existsSync(configPath)) {
  process.exit(0);
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  process.exit(0);
}

const gateway = cfg && typeof cfg === "object" ? (cfg.gateway ?? {}) : {};
const tailscale = gateway && typeof gateway === "object" ? (gateway.tailscale ?? {}) : {};
if (!tailscale || tailscale.mode !== "serve") {
  process.exit(0);
}

let changed = false;
cfg.gateway = gateway;

const trusted = Array.isArray(gateway.trustedProxies) ? [...gateway.trustedProxies] : [];
for (const proxy of ["127.0.0.1/32", "::1/128"]) {
  if (!trusted.includes(proxy)) {
    trusted.push(proxy);
    changed = true;
  }
}
gateway.trustedProxies = trusted;

const controlUi =
  gateway.controlUi && typeof gateway.controlUi === "object" ? gateway.controlUi : {};
if (controlUi.allowInsecureAuth === true) {
  delete controlUi.allowInsecureAuth;
  changed = true;
}
gateway.controlUi = controlUi;

if (gateway.bind !== "loopback") {
  gateway.bind = "loopback";
  changed = true;
}

if (!changed) {
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
try {
  fs.copyFileSync(configPath, `${configPath}.bak-hosted-serve-${stamp}`);
} catch {
  // best-effort backup; continue with atomic-enough write below
}
fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
try {
  fs.chmodSync(configPath, 0o600);
} catch {}
console.log("changed");
NODE
  )" || return 0

  if [[ "$output" == *changed* ]]; then
    step_done "Hosted dashboard config repaired"
  fi
}

is_tailscale_serve_gateway_config() {
  local config_path="${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}"
  if [[ ! -f "$config_path" ]] || ! need_cmd node; then
    return 1
  fi
  CONFIG_PATH="$config_path" node <<'NODE'
const fs = require("fs");
try {
  const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf8"));
  process.exit(cfg?.gateway?.tailscale?.mode === "serve" ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

has_system_gateway_service() {
  if ! need_cmd systemctl; then
    return 1
  fi
  systemctl list-unit-files fased-gateway.service --no-legend 2>/dev/null | grep -q '^fased-gateway.service' && return 0
  sudo -n systemctl list-unit-files fased-gateway.service --no-legend 2>/dev/null | grep -q '^fased-gateway.service' && return 0
  systemctl status fased-gateway.service >/dev/null 2>&1 && return 0
  sudo -n systemctl status fased-gateway.service >/dev/null 2>&1 && return 0
  return 1
}

has_user_gateway_service() {
  if ! need_cmd systemctl; then
    return 1
  fi
  systemctl --user list-unit-files fased-gateway.service --no-legend 2>/dev/null | grep -q '^fased-gateway.service' && return 0
  systemctl --user status fased-gateway.service >/dev/null 2>&1 && return 0
  return 1
}

restart_existing_gateway_service_after_install() {
  local profile
  profile="$(resolved_host_profile)"

  if [[ "$profile" == "hosting" ]]; then
    echo "Hosted systemd lifecycle is owned by the provider-console root installer coordinator." >&2
    return 1
  fi

  if [[ "$profile" != "hosting" ]] && has_user_gateway_service; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    if systemctl --user restart fased-gateway.service >/dev/null 2>&1; then
      return 0
    fi
    if systemctl --user start fased-gateway.service >/dev/null 2>&1; then
      return 0
    fi
  fi

  if has_system_gateway_service; then
    sudo -n systemctl daemon-reload >/dev/null 2>&1 || true
    if sudo -n systemctl restart --no-block fased-gateway.service >/dev/null 2>&1; then
      return 0
    fi
    if sudo -n systemctl start --no-block fased-gateway.service >/dev/null 2>&1; then
      return 0
    fi
  fi

  return 1
}

refresh_existing_local_gateway_service_after_install() {
  local profile
  profile="$(resolved_host_profile)"

  if [[ "$profile" == "hosting" ]]; then
    return 0
  fi
  if ! has_user_gateway_service && ! has_system_gateway_service; then
    return 0
  fi

  echo "Refreshing the existing Gateway service to the managed runtime..."
  if ! "$FASED_CLI_PATH" gateway install --force; then
    echo "Gateway service refresh failed; the previous service was left in place." >&2
    echo "Persistent state under $FASED_CONFIG_DIR was not removed." >&2
    return 1
  fi
  GATEWAY_SERVICE_REFRESHED=1
}

verify_gateway_runtime_identity_after_install() {
  local expected_version=""
  local -a verify_args=()
  expected_version="$("$FASED_CLI_PATH" --version 2>/dev/null | head -n 1 | tr -d '\r')"
  if [[ -z "$expected_version" ]]; then
    echo "Could not read the installed Fased CLI version." >&2
    return 1
  fi

  if ! use_prebuilt_release_runtime; then
    verify_args+=(--allow-source-checkout true)
  fi
  node "$FASED_DIR/scripts/verify-gateway-runtime-identity.mjs" \
    --expected-version "$expected_version" \
    --config "${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}" \
    "${verify_args[@]}"
}

local_signer_transaction_script() {
  local current_root=""
  current_root="$(readlink -f "$FASED_CONFIG_DIR/runtime/current" 2>/dev/null || true)"
  if [[ -n "$current_root" && -x "$current_root/scripts/install-fased-signerd.sh" ]]; then
    printf '%s\n' "$current_root/scripts/install-fased-signerd.sh"
    return 0
  fi
  if [[ -x "$FASED_DIR/scripts/install-fased-signerd.sh" ]]; then
    printf '%s\n' "$FASED_DIR/scripts/install-fased-signerd.sh"
    return 0
  fi
  return 1
}

local_signer_is_installed_or_configured() {
  [[ -f "$FASED_CONFIG_DIR/bin/fased-signerd" ]] && return 0
  [[ -f "$FASED_CONFIG_DIR/wallet/signerd-v2.db" ]] && return 0
  local registry="$FASED_CONFIG_DIR/wallet/provider-registry.v1.json"
  [[ -f "$registry" ]] || return 1
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.exit((value.wallets || []).some((wallet) => wallet?.providerId === "local-socket-signer") ? 0 : 1);
  ' "$registry" >/dev/null 2>&1
}

local_legacy_signer_material_detected() {
  [[ -f "$FASED_CONFIG_DIR/wallet/signerd-v2.db" ]] && return 1
  [[ -f "$FASED_CONFIG_DIR/wallet/wallet-keys.json" ]] && return 0
  local candidate=""
  shopt -s nullglob
  for candidate in \
    "$FASED_CONFIG_DIR/wallet"/keystore-solana*.v1.enc \
    "$FASED_CONFIG_DIR/wallet"/keystore-evm*.v1.enc; do
    if [[ -f "$candidate" && ! -L "$candidate" ]]; then
      shopt -u nullglob
      return 0
    fi
  done
  shopt -u nullglob
  return 1
}

prepare_existing_local_signer_after_runtime_install() {
  local profile=""
  local script=""
  local version=""
  profile="$(resolved_host_profile)"
  if [[ "$profile" == "hosting" || "$PREBUILT_RUNTIME_INSTALLED" -ne 1 ]]; then
    return 0
  fi
  if local_legacy_signer_material_detected; then
    echo "Pre-v2 Local wallet detected. Runtime repair will install the new CLI without touching wallet material."
    echo "After repair, run: fased wallet setup --mode local-signer-import --wallet-id <wallet-id> --role <agent|mining|vault>"
    return 0
  fi
  if ! local_signer_is_installed_or_configured; then
    return 0
  fi
  script="$(local_signer_transaction_script || true)"
  if [[ -z "$script" ]]; then
    echo "The managed runtime is missing its transactional Local signer installer." >&2
    return 1
  fi
  version="$("$FASED_CLI_PATH" --version 2>/dev/null | head -n 1 | tr -d '\r')"
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
    echo "Could not resolve the exact installed Fased version for signer pairing." >&2
    return 1
  fi
  echo "Preparing the exact matching Local signer and offline rollback snapshot..."
  if ! bash "$script" --version "$version" --defer-commit; then
    echo "The Local signer transaction failed; the new runtime will be rolled back." >&2
    return 1
  fi
  LOCAL_SIGNER_INSTALL_TRANSACTION_OPEN=1
}

commit_local_signer_after_runtime_install() {
  [[ "$LOCAL_SIGNER_INSTALL_TRANSACTION_OPEN" -eq 1 ]] || return 0
  local script=""
  script="$(local_signer_transaction_script || true)"
  [[ -n "$script" ]] || return 1
  bash "$script" --commit
  LOCAL_SIGNER_INSTALL_TRANSACTION_OPEN=0
}

verify_local_signer_after_runtime_install() {
  [[ "$LOCAL_SIGNER_INSTALL_TRANSACTION_OPEN" -eq 1 ]] || return 0
  local script=""
  local version=""
  script="$(local_signer_transaction_script || true)"
  [[ -n "$script" ]] || return 1
  version="$("$FASED_CLI_PATH" --version 2>/dev/null | head -n 1 | tr -d '\r')"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]] || return 1
  bash "$script" --verify --version "$version"
}

rollback_local_signer_after_runtime_install() {
  local script=""
  script="$(local_signer_transaction_script || true)"
  [[ -n "$script" ]] || return 1
  if bash "$script" --status 2>/dev/null | grep -q '"journal":null'; then
    LOCAL_SIGNER_INSTALL_TRANSACTION_OPEN=0
    return 0
  fi
  bash "$script" --rollback
  LOCAL_SIGNER_INSTALL_TRANSACTION_OPEN=0
}

prepare_existing_local_bootstrap_manifest_snapshot() {
  [[ "$LOCAL_EXISTING_BOOTSTRAP_REQUESTED" -eq 1 ]] || return 0
  local manifest="$FASED_CONFIG_DIR/install.json"
  local snapshot="$FASED_CONFIG_DIR/runtime/.pre-handoff-install.json"
  local temporary=""
  local owner=""
  mkdir -p "$FASED_CONFIG_DIR/runtime"
  if [[ -e "$snapshot" || -L "$snapshot" ]]; then
    if [[ ! -f "$snapshot" || -L "$snapshot" ]]; then
      echo "The interrupted Local bootstrap manifest snapshot is unsafe." >&2
      return 1
    fi
    owner="$(stat -c '%u' "$snapshot" 2>/dev/null || true)"
    if [[ "$owner" != "$(id -u)" ]]; then
      echo "The interrupted Local bootstrap manifest snapshot has the wrong owner." >&2
      return 1
    fi
    LOCAL_EXISTING_BOOTSTRAP_MANIFEST_SNAPSHOT="$snapshot"
    return 0
  fi
  [[ -e "$manifest" || -L "$manifest" ]] || return 0
  if [[ ! -f "$manifest" || -L "$manifest" ]]; then
    echo "The existing Local install manifest is unsafe." >&2
    return 1
  fi
  owner="$(stat -c '%u' "$manifest" 2>/dev/null || true)"
  if [[ "$owner" != "$(id -u)" ]]; then
    echo "The existing Local install manifest has the wrong owner." >&2
    return 1
  fi
  temporary="$(mktemp "$FASED_CONFIG_DIR/runtime/.pre-handoff-install.json.tmp.XXXXXX")"
  if ! cp -p -- "$manifest" "$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$snapshot"
  LOCAL_EXISTING_BOOTSTRAP_MANIFEST_SNAPSHOT="$snapshot"
}

restore_existing_local_bootstrap_manifest_snapshot() {
  local snapshot="$LOCAL_EXISTING_BOOTSTRAP_MANIFEST_SNAPSHOT"
  local manifest="$FASED_CONFIG_DIR/install.json"
  local temporary=""
  [[ -n "$snapshot" ]] || return 0
  if [[ ! -f "$snapshot" || -L "$snapshot" ]]; then
    echo "The Local bootstrap rollback manifest snapshot is unavailable or unsafe." >&2
    return 1
  fi
  temporary="$(mktemp "$FASED_CONFIG_DIR/.install.json.rollback.XXXXXX")"
  if ! cp -p -- "$snapshot" "$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$manifest"
  rm -f -- "$snapshot"
  LOCAL_EXISTING_BOOTSTRAP_MANIFEST_SNAPSHOT=""
}

discard_existing_local_bootstrap_manifest_snapshot() {
  local snapshot="$LOCAL_EXISTING_BOOTSTRAP_MANIFEST_SNAPSHOT"
  [[ -n "$snapshot" ]] || return 0
  if [[ ! -f "$snapshot" || -L "$snapshot" ]]; then
    echo "The completed Local bootstrap manifest snapshot is unavailable or unsafe." >&2
    return 1
  fi
  rm -f -- "$snapshot"
  LOCAL_EXISTING_BOOTSTRAP_MANIFEST_SNAPSHOT=""
}

rollback_managed_runtime_after_failed_install() {
  local current_root
  local rollback_script
  local require_existing_gateway_restore=0
  local paired_updater="$FASED_CONFIG_DIR/updater/fased-managed-updater.mjs"
  if [[ "$(resolved_host_profile)" == "hosting" && \
    -f "$FASED_CONFIG_DIR/hosted-update-transaction.json" && \
    -f "$paired_updater" ]]; then
    echo "Hosted runtime verification failed; restoring the paired app and signer transaction..." >&2
    node "$paired_updater" hosted-transaction rollback
    return $?
  fi
  if [[ "$(resolved_host_profile)" != "hosting" ]]; then
    rollback_local_signer_after_runtime_install || true
  fi
  if [[ -n "$LOCAL_EXISTING_BOOTSTRAP_MANIFEST_SNAPSHOT" ]]; then
    require_existing_gateway_restore=1
  fi
  current_root="$(readlink -f "$FASED_CONFIG_DIR/runtime/current" 2>/dev/null || true)"
  rollback_script="$current_root/scripts/install-managed-runtime.mjs"
  if [[ -z "$current_root" || ! -f "$rollback_script" || ! -e "$FASED_CONFIG_DIR/runtime/previous" ]]; then
    return 1
  fi
  echo "Managed runtime verification failed; restoring the previous release..." >&2
  if ! node "$rollback_script" \
    --rollback \
    --state-dir "$FASED_CONFIG_DIR" \
    --prefix "${FASED_NPM_GLOBAL_PREFIX:-$INSTALL_CACHE_DIR/npm-global}"; then
    return 1
  fi
  if ! restore_existing_local_bootstrap_manifest_snapshot; then
    return 1
  fi
  FASED_CLI_PATH="$FASED_CONFIG_DIR/bin/fased"
  if [[ "$(resolved_host_profile)" != "hosting" ]]; then
    if ! has_user_gateway_service && ! has_system_gateway_service; then
      if [[ "$require_existing_gateway_restore" -eq 1 ]]; then
        echo "Managed runtime rollback did not restore the prior Gateway service." >&2
        return 1
      fi
      return 0
    fi
    if ! restart_existing_gateway_service_after_install; then
      echo "Managed runtime rollback could not restart the prior Gateway service." >&2
      return 1
    fi
    if ! wait_for_gateway_health_after_restart; then
      echo "Managed runtime rollback restarted the prior Gateway, but it did not become healthy." >&2
      return 1
    fi
    if ! verify_gateway_runtime_identity_after_install; then
      echo "Managed runtime rollback restored a Gateway with the wrong runtime identity." >&2
      return 1
    fi
  fi
  return 0
}

wait_for_gateway_health_after_restart() {
  if [[ -z "${FASED_CLI_PATH:-}" || ! -x "$FASED_CLI_PATH" ]]; then
    return 1
  fi
  local attempt
  for attempt in {1..20}; do
    if "$FASED_CLI_PATH" health --json --timeout 3000 >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

upsert_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  local mode="${4:-0600}"
  local tmp
  tmp="$(mktemp)"
  if [[ -f "$file" ]]; then
    awk -v k="$key" -v v="$value" '
      BEGIN { found = 0 }
      $0 ~ ("^" k "=") { print k "=" v; found = 1; next }
      { print }
      END { if (!found) print k "=" v }
    ' "$file" >"$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >"$tmp"
  fi
  mv "$tmp" "$file"
  chmod "$mode" "$file"
}

persist_managed_env_var() {
  local key="$1"
  local value="$2"
  local env_file="$FASED_CONFIG_DIR/.env"
  ensure_fased_config_dir_permissions
  local env_mode=""
  env_mode="$(managed_state_file_mode)"
  upsert_env_var "$env_file" "$key" "$value" "$env_mode"
}

install_log_path() {
  local label="$1"
  local slug
  slug="$(printf '%s' "$label" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g')"
  mkdir -p "$INSTALL_LOG_DIR"
  printf '%s/install-%s-%s.log\n' "$INSTALL_LOG_DIR" "$(date -u +%Y%m%dT%H%M%SZ)" "${slug:-step}"
}

step_start() {
  local label="$1"
  if [[ "$INSTALL_STATUS_FRAME_OPEN" -eq 1 ]]; then
    block_line "$(color_yellow "•") ${label}..."
  else
    printf '%s %s\n' "$(color_yellow "•")" "$(color_yellow "${label}...")"
  fi
}

step_done() {
  local label="$1"
  if [[ "$INSTALL_STATUS_FRAME_OPEN" -eq 1 ]]; then
    block_line "$(color_green "✓") ${label}"
  else
    printf '%s %s\n' "$(color_green "✓")" "$label"
  fi
}

step_skip() {
  local label="$1"
  if [[ "$INSTALL_STATUS_FRAME_OPEN" -eq 1 ]]; then
    block_line "$(color_green "✓") $(color_dim "${label} unchanged")"
  else
    printf '%s %s\n' "$(color_green "✓")" "$(color_dim "${label} unchanged")"
  fi
}

SPINNER_PID=""

spinner_start() {
  local label="$1"
  if [[ "$INSTALL_STATUS_FRAME_OPEN" -eq 1 ]]; then
    step_start "$label"
    return 0
  fi
  if [[ "$INSTALL_VERBOSE" == "1" || ! -t 1 ]]; then
    step_start "$label"
    return 0
  fi
  (
    local frame
    while true; do
      for frame in '-' '\' '|' '/'; do
        printf '\r%s %s %s' "$(color_yellow "•")" "$(color_yellow "$label")" "$(color_dim "$frame")"
        sleep 0.12
      done
    done
  ) &
  SPINNER_PID="$!"
}

spinner_clear() {
  if [[ "$INSTALL_STATUS_FRAME_OPEN" -eq 1 ]]; then
    return 0
  fi
  if [[ -n "${SPINNER_PID:-}" ]]; then
    kill "$SPINNER_PID" >/dev/null 2>&1 || true
    wait "$SPINNER_PID" 2>/dev/null || true
    SPINNER_PID=""
    if [[ -t 1 ]]; then
      printf '\r\033[K'
    fi
  fi
}

spinner_done() {
  local label="$1"
  spinner_clear
  step_done "$label"
}

spinner_failed() {
  local label="$1"
  spinner_clear
  printf '%s %s\n' "$(color_red "✕")" "$(color_red "$label")" >&2
}

run_logged_in() {
  local dir="$1"
  local label="$2"
  shift 2
  local log_path
  log_path="$(install_log_path "$label")"
  spinner_start "$label"
  if [[ "$INSTALL_VERBOSE" == "1" ]]; then
    (cd "$dir" && "$@")
    local verbose_status=$?
    if [[ "$verbose_status" -eq 0 ]]; then
      spinner_done "$label"
    else
      spinner_failed "$label"
    fi
    return "$verbose_status"
  fi
  if (cd "$dir" && "$@") >"$log_path" 2>&1; then
    spinner_done "$label"
    return 0
  fi
  spinner_failed "$label"
  printf '%s %s\n' "$(color_red "Failed:")" "$label" >&2
  printf '%s %s\n' "$(color_dim "Full log:")" "$log_path" >&2
  printf '%s\n' "$(color_dim "Last lines:")" >&2
  tail -n 30 "$log_path" >&2 || true
  return 1
}

fingerprint_targets() {
  local root="$1"
  shift
  local tmp
  tmp="$(mktemp)"
  local rel
  for rel in "$@"; do
    if [[ -d "$root/$rel" ]]; then
      find "$root/$rel" \
        -type f \
        ! -path '*/node_modules/*' \
        ! -path '*/dist/*' \
        ! -path '*/.turbo/*' \
        ! -path '*/.vite/*' \
        -print >>"$tmp"
    elif [[ -f "$root/$rel" ]]; then
      printf '%s\n' "$root/$rel" >>"$tmp"
    fi
  done
  if [[ ! -s "$tmp" ]]; then
    rm -f "$tmp"
    printf 'empty\n'
    return 0
  fi
  sort -u "$tmp" | while IFS= read -r file; do
    if need_cmd sha256sum; then
      sha256sum "$file"
    elif need_cmd shasum; then
      shasum -a 256 "$file"
    else
      cksum "$file"
    fi
  done | if need_cmd sha256sum; then
    sha256sum
  elif need_cmd shasum; then
    shasum -a 256
  else
    cksum
  fi | awk '{print $1}'
  rm -f "$tmp"
}

cache_file_for() {
  local name="$1"
  mkdir -p "$INSTALL_CACHE_DIR"
  printf '%s/%s.sha256\n' "$INSTALL_CACHE_DIR" "$name"
}

cache_matches() {
  local name="$1"
  local fingerprint="$2"
  local cache_file
  cache_file="$(cache_file_for "$name")"
  [[ -f "$cache_file" && "$(cat "$cache_file" 2>/dev/null)" == "$fingerprint" ]]
}

write_cache() {
  local name="$1"
  local fingerprint="$2"
  local cache_file
  cache_file="$(cache_file_for "$name")"
  printf '%s\n' "$fingerprint" >"$cache_file"
}

upsert_managed_block() {
  local file="$1"
  local start_marker="$2"
  local end_marker="$3"
  local block="$4"
  local tmp
  mkdir -p "$(dirname "$file")"
  tmp="$(mktemp)"
  if [[ -f "$file" ]]; then
    awk -v start="$start_marker" -v end="$end_marker" '
      $0 == start { skipping = 1; next }
      $0 == end { skipping = 0; next }
      skipping != 1 { print }
    ' "$file" >"$tmp"
  else
    : >"$tmp"
  fi
  {
    printf '\n%s\n' "$start_marker"
    printf '%s\n' "$block"
    printf '%s\n' "$end_marker"
  } >>"$tmp"
  mv "$tmp" "$file"
}

configure_target_user_fased_shell_dir() {
  local target_user="$1"
  local target_home="$2"
  local target_repo_dir="$3"
  local start_marker="# >>> fased hosted shell directory >>>"
  local end_marker="# <<< fased hosted shell directory <<<"
  local block
  block=$(cat <<EOF
if [ -z "\${FASED_NO_AUTO_CD:-}" ] && [ -d "$target_repo_dir" ]; then
  case "\$-" in
    *i*) cd "$target_repo_dir" ;;
  esac
fi
EOF
)
  upsert_managed_block "$target_home/.bashrc" "$start_marker" "$end_marker" "$block"
  upsert_managed_block "$target_home/.profile" "$start_marker" "$end_marker" "$block"
  chown "$target_user:$target_user" "$target_home/.bashrc" "$target_home/.profile" 2>/dev/null || true
}

copy_bootstrap_ssh_keys_for_target_user() {
  local target_user="$1"
  local target_home="$2"
  local source_keys=""
  local candidate
  for candidate in "$HOME/.ssh/authorized_keys" "/root/.ssh/authorized_keys"; do
    if [[ -s "$candidate" ]]; then
      source_keys="$candidate"
      break
    fi
  done
  if [[ -z "$source_keys" ]]; then
    return 0
  fi

  mkdir -p "$target_home/.ssh"
  touch "$target_home/.ssh/authorized_keys"
  local tmp
  tmp="$(mktemp)"
  {
    cat "$target_home/.ssh/authorized_keys" 2>/dev/null || true
    cat "$source_keys"
  } | awk 'NF { print }' | sort -u >"$tmp"

  if need_cmd install; then
    install -m 600 -o "$target_user" -g "$target_user" "$tmp" "$target_home/.ssh/authorized_keys"
  else
    cp "$tmp" "$target_home/.ssh/authorized_keys"
    chmod 600 "$target_home/.ssh/authorized_keys"
    chown "$target_user:$target_user" "$target_home/.ssh/authorized_keys" 2>/dev/null || true
  fi
  rm -f "$tmp"
  chmod 700 "$target_home/.ssh"
  chown "$target_user:$target_user" "$target_home/.ssh" 2>/dev/null || true
  echo "== Root bootstrap: copied SSH authorized_keys to '$target_user' for tailnet SSH =="
}

REMOVED_BOOTSTRAP_CHECKOUT=""

remove_root_bootstrap_checkout_after_success() {
  local source_dir="$1"
  local target_repo_dir="$2"
  if [[ "${FASED_KEEP_BOOTSTRAP_CHECKOUT:-0}" == "1" ]]; then
    return 0
  fi
  if [[ "$(id -u)" -ne 0 || "$HOSTING_REQUESTED" -ne 1 || "$RUN_ONBOARD" -ne 1 ]]; then
    return 0
  fi
  if [[ -z "$source_dir" || -z "$target_repo_dir" || "$source_dir" == "$target_repo_dir" ]]; then
    return 0
  fi
  if [[ "$source_dir" != "$HOME"/* || "$source_dir" == "$HOME" || "$source_dir" == "/" ]]; then
    return 0
  fi
  if [[ ! -f "$source_dir/install.sh" || ! -f "$source_dir/package.json" || ! -d "$source_dir/src" ]]; then
    return 0
  fi
  REMOVED_BOOTSTRAP_CHECKOUT="$source_dir"
  cd /
  rm -rf "$source_dir"
}

read_target_fased_config_value() {
  local target_user="$1"
  local js_expr="$2"
  local target_home
  target_home="$(getent passwd "$target_user" 2>/dev/null | cut -d: -f6)"
  if [[ -z "$target_home" ]]; then
    target_home="/home/$target_user"
  fi
  local config_path="$target_home/.fased/fased.json"
  if [[ ! -f "$config_path" || ! -r "$config_path" ]]; then
    return 0
  fi
  CONFIG_PATH="$config_path" JS_EXPR="$js_expr" node -e '
const fs = require("node:fs");
const configPath = process.env.CONFIG_PATH;
const expr = process.env.JS_EXPR;
try {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const value = Function("cfg", `"use strict"; return (${expr});`)(cfg);
  if (typeof value === "string" && value.trim()) {
    process.stdout.write(value.trim());
  }
} catch {}
' 2>/dev/null || true
}

build_dashboard_url() {
  local scheme="$1"
  local web_host="$2"
  local token="$3"
  local base_path="$4"
  WEB_SCHEME="$scheme" WEB_HOST="$web_host" GATEWAY_TOKEN="$token" CONTROL_BASE_PATH="$base_path" node -e '
const scheme = String(process.env.WEB_SCHEME || "https").trim();
const host = String(process.env.WEB_HOST || "YOUR_VPS_TAILSCALE_NAME").trim();
const token = String(process.env.GATEWAY_TOKEN || "").trim();
const rawBasePath = String(process.env.CONTROL_BASE_PATH || "").trim();
const url = new URL(`${scheme}://${host}/`);
if (rawBasePath && rawBasePath !== "/") {
  const clean = rawBasePath.replace(/^\/+|\/+$/g, "");
  url.pathname = clean ? `/${clean}/` : "/";
}
if (token) {
  const hash = new URLSearchParams();
  hash.set("token", token);
  url.hash = `#${hash.toString()}`;
}
process.stdout.write(url.toString());
' 2>/dev/null || printf '%s://%s/' "$scheme" "$web_host"
}

build_hosted_dashboard_url() {
  build_dashboard_url "https" "$1" "$2" "$3"
}

print_local_handoff_block() {
  local config_path="${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}"
  local gateway_token=""
  local gateway_port="18789"
  local control_base_path=""
  if [[ -f "$config_path" ]]; then
    gateway_token="$(node -e 'try{const c=require(process.argv[1]);process.stdout.write(String(c?.gateway?.auth?.token||""))}catch{}' "$config_path" 2>/dev/null || true)"
    gateway_port="$(node -e 'try{const c=require(process.argv[1]);const p=Number(c?.gateway?.port||18789);process.stdout.write(String(Number.isInteger(p)?p:18789))}catch{process.stdout.write("18789")}' "$config_path" 2>/dev/null || printf '18789')"
    control_base_path="$(node -e 'try{const c=require(process.argv[1]);process.stdout.write(String(c?.gateway?.controlUi?.basePath||""))}catch{}' "$config_path" 2>/dev/null || true)"
  fi
  local dashboard_url
  dashboard_url="$(build_dashboard_url "http" "localhost:${gateway_port}" "$gateway_token" "$control_base_path")"

  block_top "DASHBOARD READY"
  block_line "Setup complete."
  block_line
  block_line "$(color_yellow "${C_BOLD}WEB UI${C_RESET}")"
  block_line "  $dashboard_url"
  if [[ -n "$gateway_token" ]]; then
    block_line
    block_line "$(color_yellow "${C_BOLD}TOKEN BACKUP${C_RESET}")"
    block_line "  $gateway_token"
  fi
  block_line
  block_line "$(color_yellow "${C_BOLD}NEXT${C_RESET}")"
  block_line "  - In the dashboard, go to Agent > Models and connect a model provider."
  block_line "  - Open Chat and send a test message."
  block_bottom
}

print_hosted_handoff_block() {
  local target_user="$1"
  local target_repo_dir="$2"
  local tailscale_dns="$3"
  local removed_checkout="$4"
  local ssh_host="${tailscale_dns:-YOUR_VPS_TAILSCALE_NAME}"
  local web_host="${tailscale_dns:-YOUR_VPS_TAILSCALE_NAME}"
  local gateway_token="${5:-}"
  local control_base_path="${6:-}"
  local dashboard_url
  dashboard_url="$(build_hosted_dashboard_url "$web_host" "$gateway_token" "$control_base_path")"

  block_top "HOSTED ACCESS"
  block_line "Setup complete."
  block_line
  block_line "$(color_yellow "${C_BOLD}RUN AS${C_RESET}")"
  block_line "  $target_user"
  block_line
  block_line "$(color_yellow "${C_BOLD}WEB UI${C_RESET}")"
  block_line "  Open this on your own Tailscale-connected computer."
  block_line
  block_line "  $(color_green "$dashboard_url")"
  block_line
  block_line "$(color_yellow "${C_BOLD}TOKEN${C_RESET}")"
  if [[ -n "$gateway_token" ]]; then
    block_line "  Only paste this if the browser asks."
    block_line
    block_line "  $(color_green "$gateway_token")"
  else
    block_line "  $(color_yellow "(token not available in root handoff)")"
    block_line
    block_line "  Run fased dashboard --no-open as ${target_user} to print a fresh tokenized URL."
  fi
  block_line
  block_line "$(color_yellow "${C_BOLD}SSH${C_RESET}")"
  block_line "  Run:"
  block_line
  block_line "  $(color_green "ssh ${target_user}@${ssh_host}")"
  block_line
  block_line "  Starts in ${target_repo_dir}"
  block_line
  block_line "$(color_yellow "${C_BOLD}FALLBACK TUNNEL${C_RESET}")"
  block_line "  Run this locally and leave it open:"
  block_line
  block_line "  $(color_green "ssh -N -L 18789:127.0.0.1:18789 ${target_user}@${ssh_host}")"
  block_line
  block_line "  Then open:"
  block_line
  block_line "  $(color_green "http://localhost:18789/")"
  block_line
  block_line "$(color_yellow "${C_BOLD}LOCAL PORT BUSY${C_RESET}")"
  block_line "  If 18789 is already in use locally, use 18790 instead."
  block_line
  block_line "  $(color_green "ssh -N -L 18790:127.0.0.1:18789 ${target_user}@${ssh_host}")"
  block_line
  block_line "  Then open:"
  block_line
  block_line "  $(color_green "http://localhost:18790/")"
  block_line
  block_line "$(color_yellow "${C_BOLD}APP COMMANDS${C_RESET}")"
  block_line "  $(color_green "cd ${target_repo_dir}")"
  block_line "  $(color_green "fased status")"
  block_line "  $(color_green "fased dashboard --no-open")"
  block_line
  block_line "Use the app checkout for normal operation; root was only for bootstrap."
  if [[ -n "$removed_checkout" ]]; then
    block_line
    block_line "$(color_green "✓ Removed temporary root checkout")"
    block_line "$(color_yellow "Removed:") $(color_green "$removed_checkout")"
  fi
  block_bottom
}

runtime_assets_ready() {
  [[ -f "$FASED_DIR/src/canvas-host/a2ui/a2ui.bundle.js" ]] || return 1
  [[ -f "$FASED_DIR/dist/canvas-host/a2ui/a2ui.bundle.js" ]] || return 1
  [[ -f "$FASED_DIR/dist/export-html/template.html" ]] || return 1
  [[ -f "$FASED_DIR/dist/export-html/vendor/marked.min.js" ]] || return 1
  [[ -f "$FASED_DIR/dist/bundled/boot-md/HOOK.md" ]] || return 1
  [[ -f "$FASED_DIR/dist/build-info.json" ]] || return 1
  [[ -f "$FASED_DIR/dist/cli/daemon-cli.js" ]] || return 1
}

go_modern_enough() {
  local gocmd=""
  if [[ -x /usr/local/go/bin/go ]]; then
    gocmd="/usr/local/go/bin/go"
  elif need_cmd go; then
    gocmd="$(command -v go)"
  else
    return 1
  fi
  local v
  v="$("$gocmd" version 2>/dev/null | awk '{print $3}' | sed 's/^go//')"
  local major minor
  major="$(echo "$v" | cut -d. -f1)"
  minor="$(echo "$v" | cut -d. -f2)"
  [[ "${major:-0}" -gt 1 ]] || ([[ "${major:-0}" -eq 1 ]] && [[ "${minor:-0}" -ge 21 ]])
}

detect_total_mem_mb() {
  if [[ -r /proc/meminfo ]]; then
    awk '/^MemTotal:/ { printf "%d\n", $2 / 1024; exit }' /proc/meminfo
    return 0
  fi
  if need_cmd getconf; then
    local pages page_size
    pages="$(getconf _PHYS_PAGES 2>/dev/null || true)"
    page_size="$(getconf PAGE_SIZE 2>/dev/null || true)"
    if [[ -n "$pages" && -n "$page_size" ]]; then
      printf '%d\n' "$((pages * page_size / 1024 / 1024))"
      return 0
    fi
  fi
  printf '0\n'
}

node_options_with_old_space() {
  local base="$1"
  local old_space_mb="$2"
  if [[ "$base" == *"--max-old-space-size="* || -z "$old_space_mb" ]]; then
    printf '%s\n' "$base"
    return 0
  fi
  printf '%s%s--max-old-space-size=%s\n' "$base" "${base:+ }" "$old_space_mb"
}

recommended_onboard_old_space_mb() {
  if [[ -n "${FASED_ONBOARD_MAX_OLD_SPACE_MB:-}" ]]; then
    printf '%s\n' "$FASED_ONBOARD_MAX_OLD_SPACE_MB"
    return 0
  fi

  local total_mem_mb
  total_mem_mb="$(detect_total_mem_mb || true)"
  if [[ -n "$total_mem_mb" && "$total_mem_mb" -gt 0 && "$total_mem_mb" -le 1536 ]]; then
    printf '1024\n'
    return 0
  fi
  if [[ -n "$total_mem_mb" && "$total_mem_mb" -gt 0 && "$total_mem_mb" -le 2304 ]]; then
    printf '1280\n'
    return 0
  fi
  printf '1536\n'
}

resolved_core_build_profile() {
  if [[ -n "${FASED_BUILD_PROFILE:-}" ]]; then
    printf '%s\n' "$FASED_BUILD_PROFILE"
    return 0
  fi

  local profile
  profile="$(resolved_host_profile)"
  if [[ "$profile" == "hosting" ]]; then
    printf 'vps\n'
    return 0
  fi

  local total_mem_mb
  total_mem_mb="$(detect_total_mem_mb || true)"
  if [[ -n "$total_mem_mb" && "$total_mem_mb" -gt 0 && "$total_mem_mb" -le 1536 ]]; then
    printf 'vps\n'
    return 0
  fi

  printf '\n'
}

has_active_swap() {
  if ! need_cmd swapon; then
    return 1
  fi
  swapon --show 2>/dev/null | tail -n +2 | grep -q .
}

configure_swapfile() {
  local swap_gb="$1"
  shift
  local runner=("$@")
  if [[ ! "$swap_gb" =~ ^[0-9]+$ || "$swap_gb" -le 0 ]]; then
    echo "Invalid swap size: ${swap_gb}G" >&2
    return 1
  fi

  if ! "${runner[@]}" fallocate -l "${swap_gb}G" /swapfile 2>/dev/null; then
    if ! "${runner[@]}" dd if=/dev/zero of=/swapfile bs=1M count=$((swap_gb * 1024)) status=none; then
      echo "Could not allocate /swapfile (${swap_gb}G)." >&2
      return 1
    fi
  fi
  if ! "${runner[@]}" chmod 600 /swapfile; then
    echo "Could not secure /swapfile permissions." >&2
    return 1
  fi
  if ! "${runner[@]}" mkswap /swapfile >/dev/null; then
    echo "Could not initialize /swapfile as swap." >&2
    return 1
  fi
  if ! "${runner[@]}" swapon /swapfile; then
    echo "Could not enable /swapfile swap." >&2
    return 1
  fi
  if [[ "${runner[*]}" == sudo\ -n ]]; then
    if ! sudo -n grep -q '^/swapfile ' /etc/fstab; then
      if ! echo '/swapfile none swap sw 0 0' | sudo -n tee -a /etc/fstab >/dev/null; then
        echo "Could not persist /swapfile in /etc/fstab." >&2
        return 1
      fi
    fi
  else
    if ! grep -q '^/swapfile ' /etc/fstab; then
      if ! echo '/swapfile none swap sw 0 0' >> /etc/fstab; then
        echo "Could not persist /swapfile in /etc/fstab." >&2
        return 1
      fi
    fi
  fi
}

ensure_low_memory_swap_if_possible() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    return 0
  fi

  local profile
  profile="$(resolved_host_profile || true)"
  local total_mem_mb
  total_mem_mb="$(detect_total_mem_mb)"
  if [[ -z "$total_mem_mb" || "$total_mem_mb" -eq 0 || "$total_mem_mb" -gt "$LOW_MEMORY_SWAP_THRESHOLD_MB" ]]; then
    return 0
  fi
  if has_active_swap; then
    return 0
  fi
  local swap_gb
  swap_gb="$(resolve_requested_swap_gb)"
  if [[ -z "$swap_gb" || "$swap_gb" == "0" ]]; then
    return 0
  fi

  local runner=()
  if [[ "$(id -u)" -eq 0 ]]; then
    runner=()
  elif need_cmd sudo && sudo -n true >/dev/null 2>&1; then
    runner=(sudo -n)
  else
    echo "== Low-memory host detected (${total_mem_mb} MiB RAM) but no swap is active =="
    if [[ "$profile" == "hosting" ]]; then
      echo "Hosting install cannot continue safely without ${swap_gb}G swap." >&2
      echo "Rerun the first hosted install as root with: ./install.sh --hosting" >&2
      return 1
    fi
    echo "== Continuing without automatic swap because passwordless sudo is unavailable =="
    return 0
  fi

  echo "== Low-memory host detected (${total_mem_mb} MiB RAM); configuring ${swap_gb}G swap for install stability =="
  if ! configure_swapfile "$swap_gb" "${runner[@]}"; then
    if [[ "$profile" == "hosting" ]]; then
      echo "Hosting install cannot continue safely because swap setup failed." >&2
      return 1
    fi
    echo "== Automatic swap setup failed; continuing because this is not the hosting profile =="
    return 0
  fi
}

pnpm_install_with_adaptive_profile() {
  local total_mem_mb
  total_mem_mb="$(detect_total_mem_mb)"
  local child_concurrency=2
  local network_concurrency=8
  local retry_child_concurrency=1
  local retry_network_concurrency=2
  local node_opts="${NODE_OPTIONS:-}"

  if [[ -n "$total_mem_mb" && "$total_mem_mb" -gt 0 ]]; then
    if [[ "$total_mem_mb" -le 1536 ]]; then
      child_concurrency=1
      network_concurrency=2
      retry_network_concurrency=1
      node_opts="${node_opts}${node_opts:+ }--max-old-space-size=512"
    elif [[ "$total_mem_mb" -le 2304 ]]; then
      child_concurrency=1
      network_concurrency=4
      node_opts="${node_opts}${node_opts:+ }--max-old-space-size=768"
    fi
  fi

  spinner_start "Installing dependencies"
  local install_log
  install_log="$(install_log_path "pnpm install")"
  if [[ "$INSTALL_VERBOSE" == "1" ]]; then
    env NODE_OPTIONS="$node_opts" pnpm --dir "$FASED_DIR" install --child-concurrency="$child_concurrency" --network-concurrency="$network_concurrency"
    local verbose_status=$?
    if [[ "$verbose_status" -eq 0 ]]; then
      spinner_done "Dependencies ready"
    else
      spinner_failed "Installing dependencies"
    fi
    return "$verbose_status"
  fi
  if env NODE_OPTIONS="$node_opts" pnpm --dir "$FASED_DIR" install --child-concurrency="$child_concurrency" --network-concurrency="$network_concurrency" >"$install_log" 2>&1; then
    spinner_done "Dependencies ready"
    return 0
  fi

  spinner_clear
  echo "Dependency install needed a slower retry."
  ensure_low_memory_swap_if_possible || true
  local retry_log
  retry_log="$(install_log_path "pnpm install retry")"
  spinner_start "Retrying dependencies"
  env NODE_OPTIONS="${node_opts}${node_opts:+ }--max-old-space-size=512" \
    pnpm --dir "$FASED_DIR" install --child-concurrency="$retry_child_concurrency" --network-concurrency="$retry_network_concurrency" >"$retry_log" 2>&1 || {
      spinner_failed "Retrying dependencies"
      echo "Failed: dependency install" >&2
      echo "Log: $install_log" >&2
      echo "Retry log: $retry_log" >&2
      tail -n 80 "$retry_log" >&2 || true
      return 1
    }
  spinner_done "Dependencies ready"
}

install_modern_go_linux() {
  local arch
  arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  case "$arch" in
    amd64|x86_64) arch="amd64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) echo "Unsupported CPU arch for Go auto-install: $arch" >&2; return 1 ;;
  esac
  local goversion="${FASED_GO_VERSION:-1.23.6}"
  local url="https://go.dev/dl/go${goversion}.linux-${arch}.tar.gz"
  local tmp
  tmp="$(mktemp)"
  curl -fsSL "$url" -o "$tmp"
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf "$tmp"
  rm -f "$tmp"
  sudo ln -sf /usr/local/go/bin/go /usr/local/bin/go
}

ensure_early_swap_for_hosting() {
  if [[ "$HOSTING_REQUESTED" -ne 1 || "$(uname -s)" != "Linux" || "$(id -u)" -ne 0 ]]; then
    return 0
  fi

  local swap_gb
  swap_gb="$(resolve_requested_swap_gb)"
  if [[ -z "$swap_gb" || "$swap_gb" == "0" ]]; then
    return 0
  fi

  if swapon --show | tail -n +2 | grep -q .; then
    return 0
  fi

  echo "== Root bootstrap: configuring ${swap_gb}G swap before dependency install =="
  if ! configure_swapfile "$swap_gb"; then
    echo "Root hosting bootstrap cannot continue safely because swap setup failed." >&2
    exit 1
  fi
}

install_missing_deps_as_root_if_needed() {
  if [[ "$AUTO_INSTALL" -ne 1 || "$(uname -s)" != "Linux" || "$(id -u)" -ne 0 ]]; then
    return 0
  fi

  local missing=()
  for cmd in git curl jq; do
    need_cmd "$cmd" || missing+=("$cmd")
  done
  if ! need_cmd getfacl || ! need_cmd setfacl; then
    missing+=("acl")
  fi
  if ! need_cmd node; then
    missing+=("node")
  fi

  if [[ ${#missing[@]} -gt 0 ]] || ! node_runtime_ok; then
    echo "== Root bootstrap: installing missing system dependencies =="
    if [[ ${#missing[@]} -gt 0 ]]; then
      echo "Installing missing dependencies: ${missing[*]}"
    fi
    if ! node_runtime_ok; then
      echo "Installing or selecting compatible Node runtime: $(node_runtime_issue)"
    fi
    install_linux_system_dependencies 0
  fi
  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    install_github_cli_for_attestations
  fi
}

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Root installation must enter through the verified Go lifecycle bootstrap." >&2
  exit 1
fi

if [[ ! -f "$FASED_DIR/package.json" || ! -d "$FASED_DIR/src" ]]; then
  echo "== Bootstrap repository =="
  if ! need_cmd git; then
    if [[ "$AUTO_INSTALL" -eq 1 ]]; then
      echo "git is missing; installing bootstrap dependencies first."
      install_supported_system_dependencies
      hash -r 2>/dev/null || true
    fi
  fi
  if ! need_cmd git; then
    echo "git is required to bootstrap the repository checkout." >&2
    echo "Install git manually or rerun with --auto-install on a supported OS." >&2
    exit 1
  fi
  if [[ ! -e "$INSTALL_BASE_DIR" ]]; then
    mkdir -p "$(dirname "$INSTALL_BASE_DIR")"
    git clone "$INSTALL_REPO_URL" "$INSTALL_BASE_DIR"
  elif [[ -d "$INSTALL_BASE_DIR/.git" ]]; then
    :
  else
    echo "Refusing to overwrite existing path: $INSTALL_BASE_DIR" >&2
    echo "That path exists but is not a recognized fased repository checkout." >&2
    echo "Set --install-dir to a new directory or clean the existing one, then rerun." >&2
    exit 1
  fi
  BOOTSTRAP_REPO_DIR="$(resolve_fased_dir_from_base "$INSTALL_BASE_DIR" || true)"
  if [[ -z "$BOOTSTRAP_REPO_DIR" ]]; then
    echo "Bootstrap failed: could not find install.sh under $INSTALL_BASE_DIR" >&2
    echo "Expected a standalone fased repository checkout." >&2
    exit 1
  fi
  exec "$BOOTSTRAP_REPO_DIR/install.sh" "${pass_args[@]}"
fi

if [[ "$(id -u)" -ne 0 ]] && ! pass_args_contains "--host-security-capable" && is_app_service_session; then
  pass_args+=(--host-maintenance-session)
fi

refresh_current_checkout_and_reexec_if_needed

handle_existing_local_state

if fresh_protected_local_install_requested; then
  FRESH_PROTECTED_LOCAL_REQUESTED=1
fi

REPO_ROOT="$(resolve_repo_root)"
assert_marker_matches_repo "$REPO_ROOT"
prefer_compatible_user_node_if_available || prefer_compatible_system_node_if_available || true
export COREPACK_HOME="${COREPACK_HOME:-$INSTALL_CACHE_DIR/corepack}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT="${COREPACK_ENABLE_DOWNLOAD_PROMPT:-0}"
export npm_config_cache="${npm_config_cache:-$INSTALL_CACHE_DIR/npm-cache}"
mkdir -p "$COREPACK_HOME" "$npm_config_cache"
if [[ -d "$INSTALL_CACHE_DIR/npm-global/bin" ]]; then
  export PATH="$INSTALL_CACHE_DIR/npm-global/bin:$PATH"
  hash -r 2>/dev/null || true
fi

missing=()
required_tools=(git curl)
if use_prebuilt_release_runtime && [[ "$FRESH_PROTECTED_LOCAL_REQUESTED" -ne 1 ]] && \
  [[ "$LOCAL_ONBOARDING_RESUME_REQUESTED" -ne 1 ]] && \
  [[ "$LOCAL_EXISTING_BOOTSTRAP_REQUESTED" -ne 1 ]]; then
  required_tools+=(npm)
elif ! use_prebuilt_release_runtime; then
  required_tools+=(pnpm)
fi
for cmd in "${required_tools[@]}"; do
  need_cmd "$cmd" || missing+=("$cmd")
done
if ! need_cmd node; then
  missing+=("node")
fi

if [[ ${#missing[@]} -gt 0 || ! node_runtime_ok ]]; then
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Installing missing dependencies: ${missing[*]}"
  fi
  if ! node_runtime_ok && node_runtime_is_user_managed; then
    print_node_runtime_help
    exit 1
  fi
  if ! node_runtime_ok; then
    echo "Installing or selecting compatible Node runtime: $(node_runtime_issue)"
  fi
  if [[ "$AUTO_INSTALL" -eq 1 ]]; then
    install_supported_system_dependencies
  else
    cat <<'EOF_HELP'
Install missing tools, then rerun install.sh:
  - git
  - curl
  - node (Node 24 recommended, or v22.14+ with node:sqlite)
  - pnpm

Automatic install:
  ./install.sh --auto-install

Supported auto-install package managers:
  - apt-get on Debian/Ubuntu/Kali/WSL Ubuntu
  - dnf/dnf5 on Fedora, CentOS, AlmaLinux, Rocky Linux, CloudLinux, Oracle Linux, Amazon Linux
  - yum on older RHEL-family systems
  - zypper on openSUSE/SLES
  - apk on Alpine
  - pacman on Arch
  - pkg on FreeBSD
  - Homebrew on macOS

Disable auto install:
  ./install.sh --no-auto-install
EOF_HELP
    exit 1
  fi
fi

if ! node_runtime_ok; then
  print_node_runtime_help
  exit 1
fi
if use_prebuilt_release_runtime || [[ "$(uname -s)" == "Darwin" ]]; then
  install_github_cli_for_attestations
fi

FASED_INSTALL_VERSION="$(node -e 'const fs=require("fs");try{const p=process.argv[1];const o=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(o.version||"0.0.0")}catch{process.stdout.write("0.0.0")}' "$FASED_DIR/package.json" 2>/dev/null || printf '0.0.0')"
print_installer_banner "$FASED_INSTALL_VERSION"
status_frame_start

export CI="${CI:-1}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
section "System preparation"
ensure_low_memory_swap_if_possible
build_old_space_mb="$(recommended_onboard_old_space_mb)"
build_node_options="$(node_options_with_old_space "${NODE_OPTIONS:-}" "$build_old_space_mb")"
if [[ "$FRESH_PROTECTED_LOCAL_REQUESTED" -eq 1 || \
  "$LOCAL_ONBOARDING_RESUME_REQUESTED" -eq 1 || \
  "$LOCAL_EXISTING_BOOTSTRAP_REQUESTED" -eq 1 ]]; then
  :
elif use_prebuilt_release_runtime; then
  if ! prepare_existing_local_bootstrap_manifest_snapshot; then
    status_frame_end
    echo "Could not prepare the transactional Local bootstrap rollback boundary." >&2
    exit 1
  fi
  install_prebuilt_release_runtime
else
  pnpm_install_with_adaptive_profile
fi

if [[ -n "${FASED_SAT_PROGRAM_ID:-}" && -n "${FASED_SAT_BOND_PROGRAM_ID:-}" && -n "${FASED_SAT_MINT_ADDRESS:-}" && -n "${FASED_SAT_MINT_PROGRAM_ID:-}" ]]; then
  persist_managed_env_var "FASED_SAT_PROGRAM_ID" "$FASED_SAT_PROGRAM_ID"
  persist_managed_env_var "FASED_SAT_BOND_PROGRAM_ID" "$FASED_SAT_BOND_PROGRAM_ID"
  persist_managed_env_var "FASED_SAT_MINT_ADDRESS" "$FASED_SAT_MINT_ADDRESS"
  persist_managed_env_var "FASED_SAT_MINT_PROGRAM_ID" "$FASED_SAT_MINT_PROGRAM_ID"
  if [[ -n "${FASED_SAT_RUNTIME_MANIFEST_PATH:-}" && -n "${FASED_SAT_RUNTIME_MANIFEST_SHA256:-}" && -n "${FASED_SAT_RUNTIME_MANIFEST_SIGNATURE_PATH:-}" ]]; then
    persist_managed_env_var "FASED_SAT_RUNTIME_MANIFEST_PATH" "$FASED_SAT_RUNTIME_MANIFEST_PATH"
    persist_managed_env_var "FASED_SAT_RUNTIME_MANIFEST_SHA256" "$FASED_SAT_RUNTIME_MANIFEST_SHA256"
    persist_managed_env_var "FASED_SAT_RUNTIME_MANIFEST_SIGNATURE_PATH" "$FASED_SAT_RUNTIME_MANIFEST_SIGNATURE_PATH"
  fi
else
  :
fi
export FASED_SAT_BOND_LAYOUT_PATH="${FASED_SAT_BOND_LAYOUT_PATH:-$FASED_DIR/token/sat/bond-api/bond-position-layout.json}"
export FASED_SAT_BOND_POLICY_LAYOUT_PATH="${FASED_SAT_BOND_POLICY_LAYOUT_PATH:-$FASED_DIR/token/sat/bond-api/bond-tier-policy-layout.json}"

if [[ "$FRESH_PROTECTED_LOCAL_REQUESTED" -eq 1 || \
  "$LOCAL_ONBOARDING_RESUME_REQUESTED" -eq 1 || \
  "$LOCAL_EXISTING_BOOTSTRAP_REQUESTED" -eq 1 ]]; then
  section "Runtime"
  step_done "Lifecycle-managed runtime"
elif use_prebuilt_release_runtime; then
  section "Runtime"
  step_done "Using prebuilt runtime"
else
  section "Build"
  core_build_profile="$(resolved_core_build_profile)"
  core_cache_name="core-build-${core_build_profile:-default}"
  core_fingerprint="$(fingerprint_targets "$FASED_DIR" package.json pnpm-lock.yaml tsconfig.json tsdown.config.ts src scripts extensions config tools/fased-signerd)"
  if [[ -f "$FASED_DIR/dist/entry.js" && -f "$FASED_DIR/dist/index.js" ]] && cache_matches "$core_cache_name" "$core_fingerprint"; then
    step_skip "Core build"
  else
    rm -rf "$FASED_DIR/dist"
    if [[ -n "$core_build_profile" ]]; then
      run_logged_in "$FASED_DIR" "Build core" env NODE_OPTIONS="$build_node_options" FASED_BUILD_PROFILE="$core_build_profile" pnpm --silent run build:fast
    else
      run_logged_in "$FASED_DIR" "Build core" env NODE_OPTIONS="$build_node_options" pnpm --silent run build:fast
    fi
    write_cache "$core_cache_name" "$core_fingerprint"
  fi

  runtime_assets_fingerprint="$(fingerprint_targets "$FASED_DIR" package.json pnpm-lock.yaml scripts/bundle-a2ui.sh scripts/canvas-a2ui-copy.ts scripts/copy-export-html-templates.ts scripts/copy-hook-metadata.ts scripts/write-build-info.ts scripts/write-cli-compat.ts src/canvas-host/a2ui apps/shared/FasedAgentKit/Tools/CanvasA2UI vendor/a2ui/renderers/lit src/auto-reply/reply/export-html src/hooks/bundled src/cli/daemon-cli-compat.ts)"
  if runtime_assets_ready && cache_matches "runtime-assets" "$runtime_assets_fingerprint"; then
    step_skip "Runtime assets"
  else
    run_logged_in "$FASED_DIR" "Prepare runtime assets" env NODE_OPTIONS="$build_node_options" pnpm --silent run build:runtime-assets
    write_cache "runtime-assets" "$runtime_assets_fingerprint"
  fi

  ui_fingerprint="$(fingerprint_targets "$FASED_DIR" package.json pnpm-lock.yaml ui/package.json ui/vite.config.ts ui/tsconfig.json ui/index.html ui/src)"
  if [[ -f "$FASED_DIR/dist/control-ui/index.html" ]] && cache_matches "control-ui-build" "$ui_fingerprint"; then
    step_skip "Control UI"
  else
    run_logged_in "$FASED_DIR" "Build Control UI" env NODE_OPTIONS="$build_node_options" pnpm --silent run ui:build
    if [[ ! -f "$FASED_DIR/dist/control-ui/index.html" ]]; then
      spinner_failed "Build Control UI"
      echo "Control UI build completed but dist/control-ui/index.html is missing." >&2
      exit 1
    fi
    write_cache "control-ui-build" "$ui_fingerprint"
  fi

  install_fased_cli_launcher
fi

if protected_local_target_platform; then
  if ! protected_local_supported; then
    status_frame_end
    echo "Protected Local Linux requires normal OS administrator authorization, but sudo is unavailable." >&2
    echo "Install sudo or run from an administrator-capable desktop account; do not run Fased itself as root." >&2
    exit 1
  fi
  if [[ "$LOCAL_ONBOARDING_RESUME_REQUESTED" -eq 1 ]]; then
    if ! read_protected_local_env; then
      status_frame_end
      echo "Committed Protected Local onboarding state is incomplete or invalid." >&2
      exit 1
    fi
    PROTECTED_LOCAL_BOOTSTRAPPED=1
    PROTECTED_LOCAL_LIFECYCLE_COMMITTED=1
  else
    if ! bootstrap_protected_local_topology activate; then
      if [[ -n "$LOCAL_EXISTING_BOOTSTRAP_MANIFEST_SNAPSHOT" ]] && \
        ! rollback_managed_runtime_after_failed_install; then
        status_frame_end
        echo "Protected Local lifecycle failed and the prior managed runtime could not be restored." >&2
        exit 1
      fi
      status_frame_end
      echo "Protected Local lifecycle did not commit. Do not assume restoration succeeded unless the lifecycle output explicitly reports complete recovery." >&2
      exit 1
    fi
    if [[ -n "$LOCAL_EXISTING_BOOTSTRAP_MANIFEST_SNAPSHOT" ]] && \
      ! discard_existing_local_bootstrap_manifest_snapshot; then
      status_frame_end
      echo "Protected Local bootstrap succeeded, but its temporary rollback snapshot could not be removed." >&2
      exit 1
    fi
  fi
  FASED_CLI_PATH="$FASED_CONFIG_DIR/bin/fased"
  export PATH="$FASED_CONFIG_DIR/bin:$PATH"
  hash -r 2>/dev/null || true
  install_user_cli_path_snippet "$FASED_CONFIG_DIR/bin" "$HOME/.profile"
  install_user_cli_path_snippet "$FASED_CONFIG_DIR/bin" "$HOME/.bashrc"
  install_user_cli_path_snippet "$FASED_CONFIG_DIR/bin" "$HOME/.zshrc"
  if [[ ! -x "$FASED_CLI_PATH" ]] || ! "$FASED_CLI_PATH" --version >/dev/null 2>&1; then
    status_frame_end
    echo "Committed Protected Local lifecycle did not install a usable CLI." >&2
    exit 1
  fi
fi

if [[ "$RUN_ONBOARD" -eq 0 ]]; then
  status_frame_end
  if [[ "$HOSTING_REPAIR_REQUESTED" -eq 1 ]]; then
    repair_tailscale_serve_gateway_config
    marker_onboarding_completed="$(read_marker_onboarding_completed || true)"
    if [[ "$marker_onboarding_completed" == "true" || \
      -s "${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}" ]]; then
      write_install_marker "$REPO_ROOT" "true"
    else
      write_install_marker "$REPO_ROOT" "false"
    fi
    echo "Hosted application runtime repair staged. The root installer coordinator will restart and verify the fixed systemd service."
    exit 0
  fi
  if [[ "$PROTECTED_LOCAL_BOOTSTRAPPED" -eq 1 ]]; then
    marker_onboarding_completed="$(read_marker_onboarding_completed || true)"
    if [[ "$marker_onboarding_completed" == "true" ]]; then
      write_install_marker "$REPO_ROOT" "true"
    else
      write_install_marker "$REPO_ROOT" "false"
    fi
    protected_gateway_pid_before_channel="$(
      systemctl show -p MainPID --value \
        "fased-gateway-$PROTECTED_LOCAL_INSTANCE.service" 2>/dev/null || true
    )"
    if [[ "$PROTECTED_LOCAL_LIFECYCLE_COMMITTED" -ne 1 ]]; then
      persist_runtime_update_channel
    fi
    if ! wait_for_protected_local_gateway_config_convergence \
      "$protected_gateway_pid_before_channel"; then
      status_frame_end
      echo "Protected Local services were installed, but the final Gateway configuration did not become healthy." >&2
      exit 1
    fi
    step_done "Protected Local signer, Gateway, and controller online"
    if [[ "$LOCAL_EXISTING_BOOTSTRAP_REQUESTED" -eq 1 ]]; then
      echo "Verified Local lifecycle handoff complete. Onboarding was not rerun; future releases use fased update."
    elif [[ "$LOCAL_REPAIR_REQUESTED" -eq 1 ]]; then
      echo "Protected Local runtime and service repair complete. Onboarding was not rerun."
    else
      echo "Onboarding skipped (--no-onboard)."
    fi
    echo "Open: fased dashboard --no-open"
    exit 0
  fi
  if ! prepare_existing_local_signer_after_runtime_install; then
    rollback_managed_runtime_after_failed_install || true
    exit 1
  fi
  if ! refresh_existing_local_gateway_service_after_install; then
    rollback_managed_runtime_after_failed_install || true
    exit 1
  fi
  no_onboard_profile="$(resolved_host_profile)"
  marker_onboarding_completed="$(read_marker_onboarding_completed || true)"
  if [[ "$marker_onboarding_completed" == "true" ]] || has_system_gateway_service || { [[ "$no_onboard_profile" != "hosting" ]] && has_user_gateway_service; }; then
    write_install_marker "$REPO_ROOT" "true"
  else
    write_install_marker "$REPO_ROOT" "false"
  fi
  repair_tailscale_serve_gateway_config
  persist_runtime_update_channel
  if restart_existing_gateway_service_after_install; then
    step_done "Gateway restart requested"
    if wait_for_gateway_health_after_restart; then
      if [[ "$GATEWAY_SERVICE_REFRESHED" -eq 1 ]] && ! verify_gateway_runtime_identity_after_install; then
        echo "Gateway restarted, but runtime identity verification failed." >&2
        echo "Persistent state under $FASED_CONFIG_DIR was not removed." >&2
        rollback_managed_runtime_after_failed_install || true
        exit 1
      fi
      GATEWAY_RUNTIME_HEALTH_VERIFIED=1
      step_done "Gateway online"
    else
      if [[ "$GATEWAY_SERVICE_REFRESHED" -eq 1 ]]; then
        echo "Gateway service was refreshed but did not become healthy." >&2
        echo "Check: $FASED_CLI_PATH gateway status" >&2
        rollback_managed_runtime_after_failed_install || true
        exit 1
      fi
      echo "Gateway restart requested; still warming up."
      echo "Check: fased health"
    fi
  else
    if is_tailscale_serve_gateway_config; then
      echo "Hosted Gateway service is not installed yet."
      echo "Finish hosted service setup: ./install.sh --hosting"
    else
      echo "No existing Gateway service was found to restart."
    fi
  fi
  if [[ "$LOCAL_SIGNER_INSTALL_TRANSACTION_OPEN" -eq 1 ]]; then
    if [[ "$GATEWAY_RUNTIME_HEALTH_VERIFIED" -ne 1 ]]; then
      echo "The matching Local signer remains read-only because exact Gateway health was not verified." >&2
      rollback_managed_runtime_after_failed_install || true
      exit 1
    fi
    if ! verify_local_signer_after_runtime_install; then
      echo "The matching Local signer failed its final read-only protocol-v2 health check." >&2
      rollback_managed_runtime_after_failed_install || true
      exit 1
    fi
  fi
  if ! commit_local_signer_after_runtime_install; then
    echo "The Local Gateway passed installation, but signer commit cleanup is pending." >&2
    echo "Run fased update to recover the paired transaction; do not replace the signer manually." >&2
    exit 1
  fi
  if [[ "$LOCAL_EXISTING_BOOTSTRAP_REQUESTED" -eq 1 ]]; then
    echo "Verified Local lifecycle handoff complete. Onboarding was not rerun; future releases use fased update."
  elif [[ "$LOCAL_REPAIR_REQUESTED" -eq 1 ]]; then
    echo "Local runtime and gateway service repair complete. Onboarding was not rerun."
  else
    echo "Onboarding skipped (--no-onboard)."
  fi
  if has_system_gateway_service || { [[ "$no_onboard_profile" != "hosting" ]] && has_user_gateway_service; }; then
    echo "Open: fased dashboard --no-open"
  elif [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    echo "Run when ready: ./install.sh --hosting"
  else
    echo "Run when ready: fased onboard --install-daemon"
  fi
  exit 0
fi

section "Interactive setup"
step_start "Start setup"
status_frame_end
if ! prepare_protected_local_onboarding_scaffold; then
  echo "Protected Local lifecycle committed, but the onboarding identity could not be prepared." >&2
  exit 1
fi
onboard_old_space_mb="$(recommended_onboard_old_space_mb)"
onboard_node_options="$(node_options_with_old_space "${NODE_OPTIONS:-}" "$onboard_old_space_mb")"
onboard_color_env=()
if supports_color && [[ -z "${NO_COLOR:-}" && -z "${FORCE_COLOR:-}" ]]; then
  onboard_color_env=(FORCE_COLOR=1)
fi
onboard_lifecycle_env=()
if [[ "$PROTECTED_LOCAL_LIFECYCLE_COMMITTED" -eq 1 ]]; then
  onboard_lifecycle_env=(FASED_INSTALL_LIFECYCLE_COMMITTED=1)
fi
if ! (cd "$FASED_DIR" && env NODE_OPTIONS="$onboard_node_options" "${onboard_color_env[@]}" "${onboard_lifecycle_env[@]}" FASED_INSTALLER_ONBOARD=1 "$FASED_CLI_PATH" onboard --install-daemon "${pass_args[@]}"); then
  if [[ "$PROTECTED_LOCAL_LIFECYCLE_COMMITTED" -eq 1 ]]; then
    write_install_marker "$REPO_ROOT" "false"
    echo "Protected Local services are committed and healthy, but onboarding did not complete." >&2
    echo "Rerun the same Local installer command to resume onboarding." >&2
  fi
  exit 1
fi
if [[ ! -f "${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}" ]]; then
  write_install_marker "$REPO_ROOT" "false"
  echo "Onboarding did not create ${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}." >&2
  echo "Rerun ./install.sh from an interactive terminal, or pass non-interactive onboarding flags after --." >&2
  exit 1
fi
if [[ "$PROTECTED_LOCAL_LIFECYCLE_COMMITTED" -eq 1 ]]; then
  lifecycle_binary="${FASED_WALLET_LOCAL_SIGNER_BIN%/fased-signerd}/fased-lifecycled"
  lifecycle_request_id="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || true)"
  if [[ ! -x "$lifecycle_binary" || ! "$lifecycle_request_id" =~ ^[0-9a-f-]{36}$ ]] || \
    ! "$lifecycle_binary" request \
      --socket "$FASED_HOST_UPDATER_SOCKET" \
      --operation COMPLETE_ONBOARDING \
      --request-id "$lifecycle_request_id" >/dev/null; then
    write_install_marker "$REPO_ROOT" "false"
    echo "Protected Local onboarding completed, but the Go lifecycle service could not activate and verify the Gateway." >&2
    echo "Rerun the same Local installer command; do not start the service manually." >&2
    exit 1
  fi
fi
if [[ "$PROTECTED_LOCAL_BOOTSTRAPPED" -eq 1 ]]; then
  :
else
  persist_runtime_update_channel
fi
write_install_marker "$REPO_ROOT" "true"
if [[ "$PROTECTED_LOCAL_BOOTSTRAPPED" -eq 1 ]]; then
  "$FASED_CLI_PATH" dashboard >/dev/null 2>&1 || true
  print_local_handoff_block
fi
