#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FASED_DIR="$SCRIPT_DIR"
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
AUTO_INSTALL=1
RUN_ONBOARD=1
HOSTING_REQUESTED=0
REQUESTED_SWAP_GB=""
TEMP_SUDOERS=""
FASED_CLI_PATH=""
LOW_MEMORY_SWAP_THRESHOLD_MB=2304
LOW_MEMORY_SWAP_GB=4
HOSTING_SWAP_GB=2

ORIGINAL_INSTALL_ARGS=("$@")
pass_args=()

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
  --auto-install   install missing deps with apt/dnf/yum or Homebrew (default)
  --no-auto-install  Disable automatic dependency installation
  --install-dir <path>  Checkout/install directory (default: $HOME/fased)
  --hosting       VPS/always-on server profile. Requires Tailscale; applies hosted
                  onboarding defaults and may change SSH/firewall behavior.
  --local         Laptop/dev-box profile. Tailscale is optional; on a VPS this does
                  not apply hosting SSH/firewall hardening.
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
    --local)
      pass_args+=(--mode local --host-profile local --tailscale off)
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
  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    set_installer_state_dir "$FASED_CONFIG_DIR"
    return 0
  fi
  if [[ -n "${FASED_STATE_DIR_EXPLICIT:-}" || -n "${FASED_CONFIG_DIR_EXPLICIT:-}" ]]; then
    set_installer_state_dir "$FASED_CONFIG_DIR"
    return 0
  fi
  if [[ ! -d "$FASED_CONFIG_DIR" ]]; then
    set_installer_state_dir "$FASED_CONFIG_DIR"
    return 0
  fi
  if [[ "$RUN_ONBOARD" -eq 0 ]]; then
    set_installer_state_dir "$FASED_CONFIG_DIR"
    return 0
  fi

  local action="${FASED_EXISTING_DATA_ACTION:-}"
  if [[ -z "$action" && ( ! -t 0 || ! -t 1 ) ]]; then
    action="keep"
  fi

  if [[ -z "$action" ]]; then
    action="keep"
  fi

  case "$action" in
    keep)
      set_installer_state_dir "$FASED_CONFIG_DIR"
      ;;
    reset-config)
      local suffix
      suffix="$(date -u +%Y%m%dT%H%M%SZ)"
      local backed_up=()
      local backup
      backup="$(backup_existing_local_file "$FASED_CONFIG_DIR/fased.json" "local-reset-$suffix" || true)"
      [[ -n "$backup" ]] && backed_up+=("$backup")
      backup="$(backup_existing_local_file "$INSTALL_MARKER_PATH" "local-reset-$suffix" || true)"
      [[ -n "$backup" ]] && backed_up+=("$backup")
      set_installer_state_dir "$FASED_CONFIG_DIR"
      if [[ ${#backed_up[@]} -gt 0 ]]; then
        echo "Backed up local config metadata:"
        printf '  %s\n' "${backed_up[@]}"
      else
        echo "No local config file or install marker needed backup."
      fi
      ;;
    separate-state)
      local separate_dir="${FASED_EXISTING_DATA_DIR:-}"
      if [[ -z "$separate_dir" && -t 0 && -t 1 ]]; then
        printf "State directory [$HOME/.fased-local]: "
        read -r separate_dir || separate_dir=""
      fi
      separate_dir="${separate_dir:-$HOME/.fased-local}"
      set_installer_state_dir "$separate_dir"
      mkdir -p "$FASED_CONFIG_DIR"
      chmod 700 "$FASED_CONFIG_DIR" 2>/dev/null || true
      echo "Using separate Fased state directory: $FASED_CONFIG_DIR"
      ;;
    *)
      echo "Unknown FASED_EXISTING_DATA_ACTION=$action; expected keep, reset-config, or separate-state." >&2
      exit 1
      ;;
  esac
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
    corepack enable || run_as_root corepack enable || true
    corepack prepare "pnpm@${pnpm_version}" --activate || true
  fi
  if ! need_cmd pnpm && need_cmd npm; then
    mkdir -p "$npm_prefix"
    npm install -g --prefix "$npm_prefix" "pnpm@${pnpm_version}" || {
      echo "User-local pnpm install failed; trying system npm install." >&2
      run_as_root npm install -g "pnpm@${pnpm_version}"
    }
    export PATH="$npm_prefix/bin:$PATH"
  fi
  hash -r 2>/dev/null || true
  need_cmd pnpm
}

install_nodesource_node_apt() {
  local setup_script
  setup_script="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/setup_24.x -o "$setup_script"
  run_as_root bash "$setup_script"
  rm -f "$setup_script"
  run_as_root apt-get install -y nodejs
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
  if [[ "$(uname -s)" != "Linux" ]]; then
    return 1
  fi

  if need_cmd apt-get; then
    run_as_root apt-get update
    run_as_root apt-get install -y git curl ca-certificates
    hash -r 2>/dev/null || true
    if ! node_runtime_ok; then
      install_nodesource_node_apt
      hash -r 2>/dev/null || true
      prefer_compatible_system_node_if_available || true
    fi
  elif need_cmd dnf; then
    run_as_root dnf install -y git curl ca-certificates
    hash -r 2>/dev/null || true
    if ! node_runtime_ok; then
      run_as_root dnf install -y nodejs24-bin nodejs24-npm-bin || \
        run_as_root dnf install -y nodejs22-bin nodejs22-npm-bin || \
        run_as_root dnf install -y nodejs npm
      hash -r 2>/dev/null || true
      prefer_compatible_system_node_if_available || true
    fi
  elif need_cmd yum; then
    run_as_root yum install -y git curl ca-certificates
    hash -r 2>/dev/null || true
    if ! node_runtime_ok; then
      run_as_root yum install -y nodejs npm
      hash -r 2>/dev/null || true
      prefer_compatible_system_node_if_available || true
    fi
  else
    echo "Unsupported Linux package manager for --auto-install." >&2
    echo "Detected system: $(linux_os_summary)" >&2
    echo "Supported auto-install package managers: apt-get, dnf, yum." >&2
    echo "Install git, curl, Node 24, and pnpm manually, then rerun ./install.sh." >&2
    return 1
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
    *)
      echo "Unsupported operating system for --auto-install: $(uname -s)" >&2
      echo "Supported auto-install targets: Linux with apt-get/dnf/yum, or macOS with Homebrew." >&2
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
    echo "== $label: local checkout has changes, skipping git update =="
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

  local profile
  profile="$(pass_args_value_after "--host-profile" || true)"
  printf '%s\n' "$profile"
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
  mkdir -p "$FASED_CONFIG_DIR"
  chmod 700 "$FASED_CONFIG_DIR" 2>/dev/null || true
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
if (controlUi.allowInsecureAuth !== true) {
  controlUi.allowInsecureAuth = true;
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
  chmod 600 "$file" 2>/dev/null || true
}

persist_managed_env_var() {
  local key="$1"
  local value="$2"
  local env_file="$FASED_CONFIG_DIR/.env"
  mkdir -p "$FASED_CONFIG_DIR"
  chmod 700 "$FASED_CONFIG_DIR" 2>/dev/null || true
  upsert_env_var "$env_file" "$key" "$value"
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
  printf '• %s...\n' "$label"
}

step_done() {
  local label="$1"
  printf '✓ %s\n' "$label"
}

step_skip() {
  local label="$1"
  printf '✓ %s unchanged\n' "$label"
}

SPINNER_PID=""

spinner_start() {
  local label="$1"
  if [[ "$INSTALL_VERBOSE" == "1" || ! -t 1 ]]; then
    step_start "$label"
    return 0
  fi
  (
    local frame
    while true; do
      for frame in '-' '\' '|' '/'; do
        printf '\r• %s %s' "$label" "$frame"
        sleep 0.12
      done
    done
  ) &
  SPINNER_PID="$!"
}

spinner_clear() {
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
  printf '✕ %s\n' "$label" >&2
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
  echo "Failed: $label" >&2
  echo "Full log: $log_path" >&2
  echo "Last lines:" >&2
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
  echo "== Root bootstrap: removing temporary checkout $source_dir =="
  cd /
  rm -rf "$source_dir"
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

reexec_as_app_user() {
  local target_user="${FASED_INSTALL_USER:-app}"
  local target_home
  if ! id -u "$target_user" >/dev/null 2>&1; then
    echo "== Root bootstrap: creating non-root user '$target_user' =="
    if need_cmd useradd; then
      useradd -m -s /bin/bash "$target_user"
    else
      adduser --disabled-password --gecos "" --shell /bin/bash "$target_user"
    fi
    usermod -aG sudo "$target_user" 2>/dev/null || true
  fi
  usermod -s /bin/bash "$target_user" 2>/dev/null || true

  target_home="$(getent passwd "$target_user" | cut -d: -f6)"
  if [[ -z "$target_home" ]]; then
    target_home="/home/$target_user"
  fi
  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    ensure_host_signer_isolation_user "$target_user"
  fi
  local target_install_dir="${FASED_INSTALL_DIR:-$INSTALL_BASE_DIR}"
  if [[ -z "${FASED_INSTALL_DIR:-}" && "$target_install_dir" == "$HOME/fased" && "$target_home" != "$HOME" ]]; then
    target_install_dir="$target_home/fased"
  fi
  local target_repo_dir=""

  echo "== Root bootstrap: preparing repo for '$target_user' at $target_install_dir =="
  bootstrap_repo_for_target_user "$target_user" "$target_install_dir"

  target_repo_dir="$(resolve_fased_dir_from_base "$target_install_dir" || true)"
  if [[ -z "$target_repo_dir" ]]; then
    echo "Install bootstrap failed: could not find Fased repo under $target_install_dir" >&2
    echo "Expected a standalone fased repository checkout." >&2
    exit 1
  fi
  configure_target_user_fased_shell_dir "$target_user" "$target_home" "$target_repo_dir"
  copy_bootstrap_ssh_keys_for_target_user "$target_user" "$target_home"

  local cmd="cd $(shell_quote "$target_repo_dir") && ./install.sh"
  cmd+=" --host-security-capable"
  for arg in "${pass_args[@]}"; do
    cmd+=" $(shell_quote "$arg")"
  done

  if [[ "$RUN_ONBOARD" -eq 1 ]]; then
    TEMP_SUDOERS="/etc/sudoers.d/fased-install-${target_user}"
    echo "== Root bootstrap: granting temporary passwordless sudo to '$target_user' for onboarding =="
    printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$target_user" >"$TEMP_SUDOERS"
    chmod 440 "$TEMP_SUDOERS"
  fi

  cleanup_temp_sudoers() {
    if [[ -n "${TEMP_SUDOERS:-}" && -f "$TEMP_SUDOERS" ]]; then
      rm -f "$TEMP_SUDOERS"
    fi
  }
  trap cleanup_temp_sudoers EXIT

  echo "== Root bootstrap: re-executing installer as '$target_user' =="
  local child_status=0
  if need_cmd sudo; then
    if sudo -u "$target_user" -H bash -lc "$cmd"; then
      child_status=0
    else
      child_status=$?
    fi
  else
    if runuser -u "$target_user" -- bash -lc "$cmd"; then
      child_status=0
    else
      child_status=$?
    fi
  fi

  if [[ "$child_status" -eq 0 && "$HOSTING_REQUESTED" -eq 1 && "$RUN_ONBOARD" -eq 1 ]]; then
    local tailscale_dns=""
    if need_cmd tailscale; then
      tailscale_dns="$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const o=JSON.parse(s);process.stdout.write(String(o?.Self?.DNSName||"").replace(/\.$/,""));}catch{}})' 2>/dev/null || true)"
    fi
    echo ""
    echo "== Hosted handoff =="
    echo "Initial root bootstrap is complete."
    echo "Steady-state Fased commands should run as '$target_user'."
    if [[ -n "$tailscale_dns" ]]; then
      echo "Reconnect from your local machine over Tailscale with:"
      echo "  ssh ${target_user}@${tailscale_dns}"
      echo "Your shell starts in $target_repo_dir."
      echo "If your tailnet enables Tailscale SSH, this also works:"
      echo "  tailscale ssh ${target_user}@${tailscale_dns}"
      echo "Then run:"
      echo "  fased status"
      echo "  fased dashboard"
    else
      echo "Reconnect over your Tailscale network as '$target_user', then run:"
      echo "  fased status"
      echo "  fased dashboard"
      echo "The '$target_user' shell is configured to start in $target_repo_dir."
    fi
    echo "Do not use the root checkout for normal operation after hosted hardening."
    remove_root_bootstrap_checkout_after_success "$FASED_DIR" "$target_repo_dir"
  fi

  exit "$child_status"
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
  for cmd in git curl pnpm; do
    need_cmd "$cmd" || missing+=("$cmd")
  done
  if ! need_cmd node; then
    missing+=("node")
  fi

  if [[ ${#missing[@]} -eq 0 ]] && node_runtime_ok; then
    return 0
  fi

  echo "== Root bootstrap: installing missing system dependencies =="
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Installing missing dependencies: ${missing[*]}"
  fi
  if ! node_runtime_ok; then
    echo "Installing or selecting compatible Node runtime: $(node_runtime_issue)"
  fi

  install_linux_system_dependencies
}

bootstrap_repo_for_target_user() {
  local target_user="$1"
  local target_install_dir="$2"
  local source_repo=""

  if is_fased_repo_dir "$FASED_DIR"; then
    source_repo="$(cd "$FASED_DIR" && pwd)"
    refresh_checkout_from_origin "$source_repo" "Root bootstrap"
  fi

  mkdir -p "$(dirname "$target_install_dir")"
  if [[ ! -e "$target_install_dir" ]]; then
    if [[ -n "$source_repo" && -d "$source_repo/.git" ]]; then
      echo "== Root bootstrap: copying current checkout into $target_install_dir =="
      git clone --local --no-hardlinks "$source_repo" "$target_install_dir"
      ensure_checkout_origin_remote "$target_install_dir"
    else
      echo "== Root bootstrap: cloning repository into $target_install_dir =="
      git clone "$INSTALL_REPO_URL" "$target_install_dir"
    fi
  elif [[ -d "$target_install_dir/.git" ]]; then
    if [[ -n "$source_repo" && -d "$source_repo/.git" ]]; then
      local source_head=""
      local target_head=""
      source_head="$(git -C "$source_repo" rev-parse HEAD 2>/dev/null || true)"
      target_head="$(git -C "$target_install_dir" rev-parse HEAD 2>/dev/null || true)"
      if [[ -n "$source_head" && "$source_head" != "$target_head" ]]; then
        local temp_clone="${target_install_dir}.refresh.$$"
        rm -rf "$temp_clone"
        echo "== Root bootstrap: refreshing $target_install_dir from current checkout =="
        git clone --local --no-hardlinks "$source_repo" "$temp_clone"
        ensure_checkout_origin_remote "$temp_clone"
        rm -rf "$target_install_dir"
        mv "$temp_clone" "$target_install_dir"
      else
        echo "== Root bootstrap: existing repository detected, reusing $target_install_dir =="
      fi
    else
      echo "== Root bootstrap: existing repository detected, reusing $target_install_dir =="
    fi
  else
    echo "Refusing to overwrite existing path: $target_install_dir" >&2
    echo "That path exists but is not a recognized fased repository checkout." >&2
    echo "Set FASED_INSTALL_DIR to a new directory or clean the existing one, then rerun." >&2
    exit 1
  fi

  ensure_checkout_origin_remote "$target_install_dir"
  local target_repo_dir=""
  target_repo_dir="$(resolve_fased_dir_from_base "$target_install_dir" || true)"
  if [[ -n "$target_repo_dir" ]]; then
    refresh_checkout_from_origin "$target_repo_dir" "Root bootstrap"
  fi

  chown -R "$target_user:$target_user" "$target_install_dir" 2>/dev/null || true
}

install_host_maintenance_sudoers() {
  local target_user="$1"
  local signer_user="${FASED_SIGNER_USER:-fased-signer}"
  local sudoers_path="/etc/sudoers.d/fased-host-maintenance-${target_user}"
  cat >"$sudoers_path" <<EOF
${target_user} ALL=(root) NOPASSWD: /usr/bin/tailscale *
${target_user} ALL=(root) NOPASSWD: /usr/sbin/ufw *
${target_user} ALL=(root) NOPASSWD: /usr/bin/timedatectl set-ntp true
${target_user} ALL=(root) NOPASSWD: /usr/bin/timedatectl status
${target_user} ALL=(root) NOPASSWD: /usr/bin/timedatectl timesync-status
${target_user} ALL=(root) NOPASSWD: /usr/bin/chronyc -a makestep
${target_user} ALL=(root) NOPASSWD: /usr/bin/apt-get update
${target_user} ALL=(root) NOPASSWD: /usr/bin/apt-get install -y ufw
${target_user} ALL=(root) NOPASSWD: /usr/bin/apt-get install -y fail2ban
${target_user} ALL=(root) NOPASSWD: /usr/bin/apt-get install -y chrony
${target_user} ALL=(root) NOPASSWD: /usr/bin/apt-get install -y unattended-upgrades
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl daemon-reload
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl is-active --quiet ssh
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl is-active --quiet sshd
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl enable --now systemd-timesyncd
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl restart systemd-timesyncd
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl enable --now chrony
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl enable --now chronyd
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl restart chrony
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl restart chronyd
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl enable --now fail2ban
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl enable --now unattended-upgrades
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl enable --now apt-daily.timer apt-daily-upgrade.timer
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl restart ssh
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl restart sshd
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl restart fased-gateway.service
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl restart --no-block fased-gateway.service
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block fased-gateway.service
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl enable --now fased-gateway.service
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl status fased-gateway.service
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl status fased-gateway.service *
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl status fased-gateway *
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl is-active fased-gateway.service
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl is-active fased-gateway.service *
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl is-active fased-gateway *
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl show fased-gateway.service *
${target_user} ALL=(root) NOPASSWD: /usr/bin/systemctl show fased-gateway *
${target_user} ALL=(root) NOPASSWD: /usr/bin/journalctl -u fased-gateway.service *
${target_user} ALL=(root) NOPASSWD: /usr/bin/journalctl -u fased-gateway *
${target_user} ALL=(root) NOPASSWD: /usr/local/sbin/fased-install-gateway-service fased-gateway ${target_user}
${target_user} ALL=(root) NOPASSWD:SETENV: /usr/local/sbin/fased-signer-isolation ${target_user} ${signer_user} *
${target_user} ALL=(root) NOPASSWD: /usr/bin/sed -i * /etc/ssh/sshd_config
EOF
  chmod 440 "$sudoers_path"
  if need_cmd visudo; then
    visudo -cf "$sudoers_path" >/dev/null
  fi
}

install_host_signer_isolation_helper() {
  local helper_path="/usr/local/sbin/fased-signer-isolation"
  cat >"$helper_path" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

app_user="${1:-}"
signer_user="${2:-}"
command_name="${3:-}"
if [[ $# -lt 3 ]]; then
  echo "usage: fased-signer-isolation <app-user> <signer-user> <command> [args...]" >&2
  exit 2
fi
shift 3

valid_user_name() {
  [[ -n "$1" && "$1" != "root" && "$1" =~ ^[A-Za-z0-9_.@-]+$ ]]
}

require_app_user() {
  valid_user_name "$app_user" || {
    echo "invalid app user: $app_user" >&2
    exit 2
  }
  id -u "$app_user" >/dev/null 2>&1 || {
    echo "app user does not exist: $app_user" >&2
    exit 2
  }
}

ensure_signer_user() {
  valid_user_name "$signer_user" || {
    echo "invalid signer user: $signer_user" >&2
    exit 2
  }
  case "$signer_user" in
    fased-signer|fased-signer-*) ;;
    *)
      echo "unsupported signer user: $signer_user" >&2
      exit 2
      ;;
  esac
  if ! id -u "$signer_user" >/dev/null 2>&1; then
    if command -v useradd >/dev/null 2>&1; then
      useradd --system --create-home --home-dir "/home/${signer_user}" --shell /usr/sbin/nologin "$signer_user"
    else
      adduser --system --home "/home/${signer_user}" --shell /usr/sbin/nologin "$signer_user"
    fi
  fi
  passwd -l "$signer_user" >/dev/null 2>&1 || true
}

home_dir_for_user() {
  local user="$1"
  getent passwd "$user" | cut -d: -f6
}

canonical_path() {
  realpath -m "$1"
}

is_under() {
  local child root
  child="$(canonical_path "$1")"
  root="$(canonical_path "$2")"
  [[ "$child" == "$root" || "$child" == "$root"/* ]]
}

require_under() {
  local path_value="$1"
  local root_value="$2"
  local label="$3"
  if ! is_under "$path_value" "$root_value"; then
    echo "$label must be under $root_value: $path_value" >&2
    exit 3
  fi
}

require_process_owned_by_signer() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  local proc_user proc_cmd
  proc_user="$(ps -o user= -p "$pid" 2>/dev/null | awk '{print $1}' || true)"
  proc_cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  [[ "$proc_user" == "$signer_user" ]] || return 1
  case "$proc_cmd" in
    *fased-signerd*|*"wallet signer broker"*) return 0 ;;
    *) return 1 ;;
  esac
}

prepare_common() {
  require_app_user
  ensure_signer_user
  local app_home signer_home app_group
  app_home="$(home_dir_for_user "$app_user")"
  signer_home="$(home_dir_for_user "$signer_user")"
  app_group="$app_user"
  [[ -n "$app_home" && -n "$signer_home" ]] || {
    echo "could not resolve app/signer home" >&2
    exit 2
  }
  usermod -aG "$app_group" "$signer_user" >/dev/null 2>&1 || true
  install -d -m 0750 -o "$app_user" -g "$app_group" "${app_home}/.fased"
  install -d -m 0710 -o "$signer_user" -g "$app_group" "$signer_home"
  install -d -m 0710 -o "$signer_user" -g "$app_group" "${signer_home}/.fased"
}

collect_signer_env_args() {
  local key value
  while IFS='=' read -r -d '' key value; do
    [[ "$key" == FASED_WALLET_* ]] || continue
    printf '%s=%s\0' "$key" "$value"
  done < <(env -0)
}

prepare_paths() {
  local material_dir="${1:-}"
  local backend_socket="${2:-}"
  local app_socket="${3:-}"
  local bin_path="${4:-}"
  prepare_common
  local app_home signer_home app_group
  app_home="$(home_dir_for_user "$app_user")"
  signer_home="$(home_dir_for_user "$signer_user")"
  app_group="$app_user"
  require_under "$material_dir" "${signer_home}/.fased/wallet" "signer material directory"
  require_under "$(dirname "$backend_socket")" "${signer_home}/.fased/wallet" "signer backend socket directory"
  require_under "$(dirname "$app_socket")" "${app_home}/.fased/wallet" "app signer socket directory"
  install -d -m 0700 -o "$signer_user" -g "$signer_user" "$material_dir"
  install -d -m 0700 -o "$signer_user" -g "$signer_user" "$(dirname "$backend_socket")"
  install -d -m 2770 -o "$signer_user" -g "$app_group" "$(dirname "$app_socket")"
  if [[ -n "$bin_path" ]]; then
    require_under "$bin_path" "${signer_home}/.fased/bin" "signer binary"
    install -d -m 0755 -o "$signer_user" -g "$signer_user" "$(dirname "$bin_path")"
  fi
}

ensure_passphrase() {
  local material_dir="${1:-}"
  prepare_common
  local signer_home passphrase_path tmp
  signer_home="$(home_dir_for_user "$signer_user")"
  require_under "$material_dir" "${signer_home}/.fased/wallet" "signer material directory"
  install -d -m 0700 -o "$signer_user" -g "$signer_user" "$material_dir"
  passphrase_path="${material_dir}/passphrase"
  if [[ ! -s "$passphrase_path" ]]; then
    tmp="$(mktemp)"
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -base64 32 >"$tmp"
    else
      head -c 32 /dev/urandom | base64 >"$tmp"
    fi
    install -m 0600 -o "$signer_user" -g "$signer_user" "$tmp" "$passphrase_path"
    rm -f "$tmp"
  fi
  printf '%s\n' "$passphrase_path"
}

install_binary() {
  local source_path="${1:-}"
  local target_path="${2:-}"
  prepare_common
  local app_home signer_home
  app_home="$(home_dir_for_user "$app_user")"
  signer_home="$(home_dir_for_user "$signer_user")"
  require_under "$source_path" "$app_home" "signer binary source"
  require_under "$target_path" "${signer_home}/.fased/bin" "signer binary target"
  [[ -f "$source_path" ]] || {
    echo "signer binary source not found: $source_path" >&2
    exit 4
  }
  install -d -m 0755 -o "$signer_user" -g "$signer_user" "$(dirname "$target_path")"
  install -m 0755 -o "$signer_user" -g "$signer_user" "$source_path" "$target_path"
}

install_passphrase() {
  local source_path="${1:-}"
  local material_dir="${2:-}"
  prepare_common
  local app_home signer_home target_path
  app_home="$(home_dir_for_user "$app_user")"
  signer_home="$(home_dir_for_user "$signer_user")"
  target_path="${material_dir}/passphrase"
  require_under "$source_path" "$app_home" "passphrase source"
  require_under "$material_dir" "${signer_home}/.fased/wallet" "signer material directory"
  [[ -f "$source_path" ]] || {
    echo "passphrase source not found: $source_path" >&2
    exit 4
  }
  if [[ -e "$target_path" ]]; then
    echo "passphrase already exists: $target_path" >&2
    exit 5
  fi
  install -d -m 0700 -o "$signer_user" -g "$signer_user" "$material_dir"
  install -m 0600 -o "$signer_user" -g "$signer_user" "$source_path" "$target_path"
  rm -f "$source_path"
  printf '%s\n' "$target_path"
}

copy_keystore() {
  local source_path="${1:-}"
  local target_path="${2:-}"
  prepare_common
  local app_home signer_home
  app_home="$(home_dir_for_user "$app_user")"
  signer_home="$(home_dir_for_user "$signer_user")"
  require_under "$source_path" "$app_home" "keystore source"
  require_under "$target_path" "${signer_home}/.fased/wallet" "keystore target"
  case "$(basename "$target_path")" in
    keystore-solana*.v1.enc|keystore-evm*.v1.enc) ;;
    *)
      echo "unsupported keystore target: $target_path" >&2
      exit 3
      ;;
  esac
  [[ -f "$source_path" ]] || {
    echo "keystore source not found: $source_path" >&2
    exit 4
  }
  install -D -m 0600 -o "$signer_user" -g "$signer_user" "$source_path" "$target_path"
  rm -f "$source_path"
}

stop_sidecar() {
  local socket_path="${1:-}"
  local pid_path="${2:-}"
  prepare_common
  local app_home signer_home
  app_home="$(home_dir_for_user "$app_user")"
  signer_home="$(home_dir_for_user "$signer_user")"
  if ! is_under "$socket_path" "$app_home" && ! is_under "$socket_path" "$signer_home"; then
    echo "socket path outside allowed homes: $socket_path" >&2
    exit 3
  fi
  if ! is_under "$pid_path" "$app_home" && ! is_under "$pid_path" "$signer_home"; then
    echo "pid path outside allowed homes: $pid_path" >&2
    exit 3
  fi
  local pid=""
  if [[ -f "$pid_path" ]]; then
    pid="$(cat "$pid_path" 2>/dev/null || true)"
  fi
  if require_process_owned_by_signer "$pid"; then
    kill "$pid" >/dev/null 2>&1 || true
    sleep 0.5
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$socket_path" "$pid_path"
}

start_signerd() {
  local bin_path="${1:-}"
  local socket_path="${2:-}"
  local pid_path="${3:-}"
  local audit_path="${4:-}"
  prepare_common
  local signer_home
  signer_home="$(home_dir_for_user "$signer_user")"
  require_under "$bin_path" "${signer_home}/.fased/bin" "signer binary"
  require_under "$socket_path" "${signer_home}/.fased/wallet" "signer socket"
  require_under "$pid_path" "${signer_home}/.fased/wallet" "signer pid file"
  require_under "$audit_path" "${signer_home}/.fased/wallet" "signer audit log"
  [[ -x "$bin_path" ]] || {
    echo "signer binary is not executable: $bin_path" >&2
    exit 4
  }
  local env_args=()
  while IFS= read -r -d '' env_arg; do
    env_args+=("$env_arg")
  done < <(collect_signer_env_args)
  exec runuser -u "$signer_user" -- env -i \
    HOME="$signer_home" \
    PATH="/usr/bin:/bin:/usr/local/bin" \
    "${env_args[@]}" \
    "$bin_path" -socket "$socket_path" -pid-file "$pid_path" -audit-log "$audit_path"
}

start_broker() {
  local node_bin="${1:-}"
  local gateway_entry="${2:-}"
  local app_socket="${3:-}"
  local backend_socket="${4:-}"
  local pid_path="${5:-}"
  local audit_path="${6:-}"
  prepare_common
  local app_home signer_home
  app_home="$(home_dir_for_user "$app_user")"
  signer_home="$(home_dir_for_user "$signer_user")"
  if ! is_under "$node_bin" "/usr" && ! is_under "$node_bin" "/bin" && ! is_under "$node_bin" "$app_home"; then
    echo "node binary outside allowed paths: $node_bin" >&2
    exit 3
  fi
  require_under "$gateway_entry" "$app_home" "broker CLI"
  require_under "$app_socket" "${app_home}/.fased/wallet" "app signer socket"
  require_under "$backend_socket" "${signer_home}/.fased/wallet" "signer backend socket"
  require_under "$pid_path" "${app_home}/.fased/wallet" "broker pid file"
  require_under "$audit_path" "${app_home}/.fased/wallet" "broker audit log"
  local env_args=()
  while IFS= read -r -d '' env_arg; do
    env_args+=("$env_arg")
  done < <(collect_signer_env_args)
  exec runuser -u "$signer_user" -- env -i \
    HOME="$signer_home" \
    PATH="/usr/bin:/bin:/usr/local/bin" \
    "${env_args[@]}" \
    "$node_bin" "$gateway_entry" wallet signer broker \
      --socket "$app_socket" \
      --backend-socket "$backend_socket" \
      --pid-file "$pid_path" \
      --audit-log "$audit_path"
}

case "$command_name" in
  prepare) prepare_paths "$@" ;;
  ensure-passphrase) ensure_passphrase "$@" ;;
  install-passphrase) install_passphrase "$@" ;;
  install-binary) install_binary "$@" ;;
  copy-keystore) copy_keystore "$@" ;;
  stop) stop_sidecar "$@" ;;
  start-signerd) start_signerd "$@" ;;
  start-broker) start_broker "$@" ;;
  *)
    echo "unsupported command: $command_name" >&2
    exit 2
    ;;
esac
EOF
  chmod 755 "$helper_path"
}

ensure_host_signer_isolation_user() {
  local target_user="$1"
  local signer_user="${FASED_SIGNER_USER:-fased-signer}"
  local target_home
  if [[ "$(id -u)" -ne 0 || "$HOSTING_REQUESTED" -ne 1 ]]; then
    return 0
  fi
  target_home="$(getent passwd "$target_user" | cut -d: -f6)"
  if [[ -z "$target_home" ]]; then
    target_home="/home/$target_user"
  fi
  /usr/local/sbin/fased-signer-isolation "$target_user" "$signer_user" prepare \
    "/home/${signer_user}/.fased/wallet" \
    "/home/${signer_user}/.fased/wallet/local-signer.sock" \
    "${target_home}/.fased/wallet/local-signer.sock" \
    "/home/${signer_user}/.fased/bin/fased-signerd" >/dev/null
}

install_host_gateway_service_helper() {
  local helper_path="/usr/local/sbin/fased-install-gateway-service"
  cat >"$helper_path" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

service_name="${1:-}"
run_as_user="${2:-}"

if [[ "$service_name" != "fased-gateway" ]]; then
  echo "unsupported service: $service_name" >&2
  exit 2
fi
if [[ -z "$run_as_user" || "$run_as_user" == "root" || ! "$run_as_user" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
  echo "invalid run-as user: $run_as_user" >&2
  exit 2
fi

unit_path="/etc/systemd/system/${service_name}.service"
tmp="$(mktemp)"
cleanup() {
  rm -f "$tmp"
}
trap cleanup EXIT
cat >"$tmp"

require_line() {
  local pattern="$1"
  local label="$2"
  if ! grep -Eq "$pattern" "$tmp"; then
    echo "invalid gateway unit: missing $label" >&2
    exit 3
  fi
}

reject_line() {
  local pattern="$1"
  local label="$2"
  if grep -Eq "$pattern" "$tmp"; then
    echo "invalid gateway unit: forbidden $label" >&2
    exit 3
  fi
}

require_line '^\[Unit\]$' "[Unit]"
require_line '^\[Service\]$' "[Service]"
require_line '^\[Install\]$' "[Install]"
require_line "^User=${run_as_user}$" "User=${run_as_user}"
require_line "^Group=${run_as_user}$" "Group=${run_as_user}"
require_line "^ExecStart=/bin/bash /home/${run_as_user}/fased/scripts/start-managed\\.sh$" "managed ExecStart"
require_line "^WorkingDirectory=/home/${run_as_user}/fased$" "hosted WorkingDirectory"
require_line '^Environment=FASED_GATEWAY_MODE=managed$' "managed mode"
require_line '^Environment=FASED_MANAGED_INTERNAL=1$' "managed internal flag"
require_line '^Environment=FASED_GATEWAY_PORT=18789$' "loopback gateway port"
require_line '^NoNewPrivileges=true$' "NoNewPrivileges"
require_line '^PrivateTmp=true$' "PrivateTmp"
require_line '^WantedBy=multi-user\.target$' "multi-user target"

reject_line '^User=root$' "root user"
reject_line '^Group=root$' "root group"
reject_line '^Exec(Start|Stop|Reload)(Pre|Post)=' "extra privileged lifecycle command"
reject_line '^PermissionsStartOnly=' "PermissionsStartOnly"
reject_line '^AmbientCapabilities=' "AmbientCapabilities"
reject_line '^CapabilityBoundingSet=' "CapabilityBoundingSet"

install -o root -g root -m 0644 "$tmp" "$unit_path"
systemctl daemon-reload
systemctl enable --now "${service_name}.service"
EOF
  chmod 755 "$helper_path"
}

if [[ "$(id -u)" -eq 0 ]]; then
  install_host_gateway_service_helper
  install_host_signer_isolation_helper
  install_host_maintenance_sudoers "${FASED_INSTALL_USER:-app}"
  ensure_early_swap_for_hosting
  install_missing_deps_as_root_if_needed
  best_effort_enable_root_host_time_sync
  reexec_as_app_user
fi

if [[ ! -f "$FASED_DIR/package.json" || ! -d "$FASED_DIR/src" ]]; then
  echo "== Bootstrap repository =="
  if ! need_cmd git; then
    echo "git is required to bootstrap the repository checkout." >&2
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
for cmd in git curl pnpm; do
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
  - apt-get on Debian/Ubuntu/WSL Ubuntu
  - dnf on Fedora/RHEL-family systems
  - yum on older RHEL-family systems
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

FASED_INSTALL_VERSION="$(node -e 'const fs=require("fs");try{const p=process.argv[1];const o=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(o.version||"0.0.0")}catch{process.stdout.write("0.0.0")}' "$FASED_DIR/package.json" 2>/dev/null || printf '0.0.0')"
printf '\nFased Agent v%s\n' "$FASED_INSTALL_VERSION"
printf 'Setup\n\n'

export CI="${CI:-1}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ensure_low_memory_swap_if_possible
pnpm_install_with_adaptive_profile
build_old_space_mb="$(recommended_onboard_old_space_mb)"
build_node_options="$(node_options_with_old_space "${NODE_OPTIONS:-}" "$build_old_space_mb")"

if [[ -n "${FASED_SAT_PROGRAM_ID:-}" && -n "${FASED_SAT_BOND_PROGRAM_ID:-}" && -n "${FASED_SAT_MINT_ADDRESS:-}" && -n "${FASED_SAT_MINT_PROGRAM_ID:-}" ]]; then
  persist_managed_env_var "FASED_SAT_PROGRAM_ID" "$FASED_SAT_PROGRAM_ID"
  persist_managed_env_var "FASED_SAT_BOND_PROGRAM_ID" "$FASED_SAT_BOND_PROGRAM_ID"
  persist_managed_env_var "FASED_SAT_MINT_ADDRESS" "$FASED_SAT_MINT_ADDRESS"
  persist_managed_env_var "FASED_SAT_MINT_PROGRAM_ID" "$FASED_SAT_MINT_PROGRAM_ID"
else
  :
fi
export FASED_SAT_BOND_LAYOUT_PATH="${FASED_SAT_BOND_LAYOUT_PATH:-$FASED_DIR/token/sat/bond-api/bond-position-layout.json}"
export FASED_SAT_BOND_POLICY_LAYOUT_PATH="${FASED_SAT_BOND_POLICY_LAYOUT_PATH:-$FASED_DIR/token/sat/bond-api/bond-tier-policy-layout.json}"

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

if [[ "$RUN_ONBOARD" -eq 0 ]]; then
  no_onboard_profile="$(resolved_host_profile)"
  marker_onboarding_completed="$(read_marker_onboarding_completed || true)"
  if [[ "$marker_onboarding_completed" == "true" ]] || has_system_gateway_service || { [[ "$no_onboard_profile" != "hosting" ]] && has_user_gateway_service; }; then
    write_install_marker "$REPO_ROOT" "true"
  else
    write_install_marker "$REPO_ROOT" "false"
  fi
  repair_tailscale_serve_gateway_config
  if restart_existing_gateway_service_after_install; then
    step_done "Gateway restart requested"
    if wait_for_gateway_health_after_restart; then
      step_done "Gateway online"
    else
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
  echo "Onboarding skipped (--no-onboard)."
  if has_system_gateway_service || { [[ "$no_onboard_profile" != "hosting" ]] && has_user_gateway_service; }; then
    echo "Open: fased dashboard --no-open"
  elif [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    echo "Run when ready: ./install.sh --hosting"
  else
    echo "Run when ready: fased onboard --install-daemon"
  fi
  exit 0
fi

step_start "Start setup"
onboard_old_space_mb="$(recommended_onboard_old_space_mb)"
onboard_node_options="$(node_options_with_old_space "${NODE_OPTIONS:-}" "$onboard_old_space_mb")"
(cd "$FASED_DIR" && env NODE_OPTIONS="$onboard_node_options" FASED_INSTALLER_ONBOARD=1 "$FASED_CLI_PATH" onboard --install-daemon "${pass_args[@]}")
if [[ ! -f "${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}" ]]; then
  write_install_marker "$REPO_ROOT" "false"
  echo "Onboarding did not create ${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}." >&2
  echo "Rerun ./install.sh from an interactive terminal, or pass non-interactive onboarding flags after --." >&2
  exit 1
fi
write_install_marker "$REPO_ROOT" "true"

echo
step_done "Setup complete"
