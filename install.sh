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
install_entry_source_install=0
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
    --source-install)
      install_entry_source_install=1
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

if [[ "$install_entry_source_install" -eq 1 || "${FASED_SOURCE_INSTALL:-0}" == "1" || \
  "${FASED_HOSTING_SOURCE_INSTALL:-0}" == "1" ]]; then
  if [[ "$install_entry_is_stream" -eq 1 ]]; then
    echo "Source installation requires a contributor checkout." >&2
    exit 1
  fi
  install_entry_source_dir="$(cd "$(dirname "$install_entry_source")" && pwd -P)"
  exec "$install_entry_source_dir/scripts/install-development.sh" "$@"
fi

if [[ "$install_entry_is_stream" -eq 0 && -z "$install_entry_release_identity" && \
  "$install_entry_hosting" -eq 0 && "$install_entry_protected_local_root" -eq 0 ]]; then
  install_entry_source_dir="$(cd "$(dirname "$install_entry_source")" && pwd -P)"
  if [[ -x "$install_entry_source_dir/scripts/install-development.sh" ]]; then
    exec "$install_entry_source_dir/scripts/install-development.sh" "$@"
  fi
fi

if [[ "$install_entry_is_stream" -eq 0 && "$install_entry_hosting" -eq 0 && \
  "$install_entry_protected_local_root" -eq 0 ]]; then
  install_entry_local_file_bootstrap=1
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
      bootstrap_as_root apt-get update -qq
      bootstrap_as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
        apt-get install -y -qq curl ca-certificates >/dev/null
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
      bootstrap_as_root apt-get update -qq
      bootstrap_as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
        apt-get install -y -qq gh >/dev/null
    elif command -v dnf5 >/dev/null 2>&1; then
      bootstrap_as_root dnf5 install -y -q dnf5-plugins
      bootstrap_as_root dnf5 config-manager addrepo \
        --from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo
      bootstrap_as_root dnf5 install -y -q gh
    elif command -v dnf >/dev/null 2>&1; then
      bootstrap_as_root dnf install -y -q 'dnf-command(config-manager)'
      bootstrap_as_root dnf config-manager --add-repo \
        https://cli.github.com/packages/rpm/gh-cli.repo
      bootstrap_as_root dnf install -y -q gh
    elif command -v yum >/dev/null 2>&1; then
      bootstrap_as_root yum install -y yum-utils >/dev/null 2>&1 || true
      bootstrap_as_root yum-config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo >/dev/null 2>&1 || true
      bootstrap_as_root yum install -y -q gh
    elif command -v zypper >/dev/null 2>&1; then
      bootstrap_as_root zypper --non-interactive --quiet install gh
    elif command -v apk >/dev/null 2>&1; then
      bootstrap_as_root apk add --no-cache --quiet github-cli
    elif command -v pacman >/dev/null 2>&1; then
      bootstrap_as_root pacman -Sy --needed --noconfirm --quiet github-cli
    elif command -v brew >/dev/null 2>&1; then
      brew install gh || brew upgrade gh
    else
      return 1
    fi
    hash -r 2>/dev/null || true
    command -v gh >/dev/null 2>&1 && gh attestation verify --help >/dev/null 2>&1
  }

  select_root_controlled_bootstrap_node() {
    local candidate=""
    local resolved=""
    local owner=""
    local mode=""
    for candidate in \
      /usr/bin/node-24 /usr/bin/node24 /usr/bin/node-22 /usr/bin/node22 \
      /usr/local/bin/node-24 /usr/local/bin/node24 \
      /usr/local/bin/node-22 /usr/local/bin/node22 \
      /usr/local/bin/node /usr/bin/node /usr/bin/nodejs; do
      [[ -x "$candidate" ]] || continue
      resolved="$(readlink -f -- "$candidate" 2>/dev/null || true)"
      [[ -n "$resolved" && -f "$resolved" && -x "$resolved" ]] || continue
      read -r owner mode < <(stat -c '%u %a' "$resolved" 2>/dev/null || true)
      [[ "$owner" == "0" && "$mode" =~ ^[0-7]{3,4}$ ]] || continue
      (( (8#$mode & 0022) == 0 )) || continue
      if "$resolved" -e '
        const [a, b] = process.versions.node.split(".").map(Number);
        if (a < 22 || (a === 22 && b < 14)) process.exit(1);
        require("node:sqlite");
      ' >/dev/null 2>&1; then
        printf '%s\n' "$resolved"
        return 0
      fi
    done
    return 1
  }

  install_root_controlled_bootstrap_node() {
    if select_root_controlled_bootstrap_node >/dev/null 2>&1; then
      return 0
    fi
    [[ "$auto_install" -eq 1 ]] || return 1

    local setup_script=""
    local package_manager=""
    if command -v apt-get >/dev/null 2>&1; then
      bootstrap_as_root apt-get update -qq
      bootstrap_as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
        apt-get install -y -qq ca-certificates curl gnupg >/dev/null
      setup_script="$(mktemp)"
      if ! curl -q -fsSL --proto '=https' --tlsv1.2 \
        https://deb.nodesource.com/setup_24.x -o "$setup_script" || \
        ! bootstrap_as_root env DEBIAN_FRONTEND=noninteractive bash "$setup_script" \
          >/dev/null; then
        rm -f -- "$setup_script"
        return 1
      fi
      rm -f -- "$setup_script"
      bootstrap_as_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
        apt-get install -y -qq nodejs >/dev/null
    else
      for package_manager in dnf5 dnf yum; do
        command -v "$package_manager" >/dev/null 2>&1 && break
        package_manager=""
      done
      if [[ -n "$package_manager" ]]; then
        bootstrap_as_root "$package_manager" install -y -q ca-certificates curl
        setup_script="$(mktemp)"
        if ! curl -q -fsSL --proto '=https' --tlsv1.2 \
          https://rpm.nodesource.com/setup_24.x -o "$setup_script" || \
          ! bootstrap_as_root bash "$setup_script" >/dev/null; then
          rm -f -- "$setup_script"
          return 1
        fi
        rm -f -- "$setup_script"
        bootstrap_as_root "$package_manager" install -y -q nodejs
      elif command -v zypper >/dev/null 2>&1; then
        bootstrap_as_root zypper --non-interactive --quiet install nodejs24 || \
          bootstrap_as_root zypper --non-interactive --quiet install nodejs22
      elif command -v apk >/dev/null 2>&1; then
        bootstrap_as_root apk add --no-cache --quiet nodejs-current || \
          bootstrap_as_root apk add --no-cache --quiet nodejs
      elif command -v pacman >/dev/null 2>&1; then
        bootstrap_as_root pacman -Sy --needed --noconfirm --quiet nodejs
      else
        return 1
      fi
    fi
    hash -r 2>/dev/null || true
    select_root_controlled_bootstrap_node >/dev/null 2>&1
  }

  prepare_lifecycle_bootstrap_exec_root() {
    local parent="/usr/local/libexec"
    local root="${parent}/fased-installer"
    local candidate=""
    local owner=""
    local mode=""

    for candidate in /usr /usr/local; do
      [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
      read -r owner mode < <(stat -c '%u %a' "$candidate" 2>/dev/null || true)
      [[ "$owner" == "0" && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
      (( (8#$mode & 0022) == 0 )) || return 1
    done

    if [[ ! -e "$parent" && ! -L "$parent" ]]; then
      bootstrap_as_root install -d -m 0755 -o root -g root "$parent"
    fi
    [[ -d "$parent" && ! -L "$parent" ]] || return 1
    read -r owner mode < <(stat -c '%u %a' "$parent" 2>/dev/null || true)
    [[ "$owner" == "0" && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
    (( (8#$mode & 0022) == 0 )) || return 1

    if [[ ! -e "$root" && ! -L "$root" ]]; then
      bootstrap_as_root install -d -m 0700 -o root -g root "$root"
    fi
    [[ -d "$root" && ! -L "$root" ]] || return 1
    read -r owner mode < <(stat -c '%u %a' "$root" 2>/dev/null || true)
    [[ "$owner" == "0" && "$mode" == "700" ]] || return 1
    printf '%s\n' "$root"
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
        apt-get update -qq
        env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
          apt-get install -y -qq "${packages[@]}" >/dev/null
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

    local bootstrap_node=""
    if ! bootstrap_node="$(select_root_controlled_bootstrap_node)"; then
      if ! install_root_controlled_bootstrap_node || \
        ! bootstrap_node="$(select_root_controlled_bootstrap_node)"; then
        echo "A root-controlled Node.js 24 runtime is required before release evidence verification." >&2
        echo "Automatic Node installation failed; install Node.js 24 from the provider root console, then retry the exact command." >&2
        exit 1
      fi
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
      local lifecycle_exec_root=""
      lifecycle_node="$(select_root_controlled_bootstrap_node 2>/dev/null || true)"
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
      lifecycle_exec_root="$(prepare_lifecycle_bootstrap_exec_root)" || {
        echo "A secure root-controlled lifecycle executable directory is required." >&2
        return 1
      }
      [[ "$lifecycle_exec_root" == "/usr/local/libexec/fased-installer" ]] || return 1
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

    curl -q -fsSL --proto '=https' --tlsv1.2 "$release_url/fased-hosted-release-v2.json" -o "$release_manifest"
    curl -q -fsSL --proto '=https' --tlsv1.2 "$release_url/fased-hosted-release-v2.json.attestation.json" -o "$release_manifest_bundle"
    curl -q -fsSL --proto '=https' --tlsv1.2 "$release_url/fased-lifecycle-trust-v1.json" -o "$lifecycle_metadata"
    curl -q -fsSL --proto '=https' --tlsv1.2 "$release_url/fased-lifecycle-trust-v1.json.attestation.json" -o "$lifecycle_metadata_bundle"
    curl -q -fsSL --proto '=https' --tlsv1.2 "$release_url/fased-privileged-release-evidence.mjs" -o "$evidence_verifier"
    curl -q -fsSL --proto '=https' --tlsv1.2 "$release_url/fased-privileged-provenance-v1.intoto.json" -o "$provenance"
    curl -q -fsSL --proto '=https' --tlsv1.2 "$release_url/fased-privileged-provenance-v1.intoto.json.attestation.json" -o "$provenance_bundle"
    curl -q -fsSL --proto '=https' --tlsv1.2 "$release_url/fased-privileged-sbom-v1.spdx.json" -o "$sbom"
    curl -q -fsSL --proto '=https' --tlsv1.2 "$release_url/fased-privileged-vex-v1.openvex.json" -o "$vex"
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
    local evidence_node="$bootstrap_node"
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
    curl -q -fsSL --proto '=https' --tlsv1.2 "$release_url/$asset" -o "$archive"
    curl -q -fsSL --proto '=https' --tlsv1.2 "$release_url/$dependency_asset" -o "$dependency_archive"
    curl -q -fsSL --proto '=https' --tlsv1.2 "$release_url/$signer_asset" -o "$signer_binary"
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

echo "Unsupported legacy installer handoff. Use the immutable public installer or scripts/install-development.sh." >&2
exit 1
