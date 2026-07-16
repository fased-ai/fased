#!/usr/bin/env bash
# scripts/start-managed.sh
# Starts the FasedAgent in managed public runtime mode.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FASED_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_MARKER_PATH="${FASED_CONFIG_DIR:-$HOME/.fased}/install-complete.json"

runtime_root_has_build() {
  local root="$1"
  [[ -n "$root" ]] || return 1
  [[ -f "$root/scripts/run-node.mjs" ]] || return 1
  [[ -f "$root/dist/index.js" || -f "$root/dist/index.mjs" || -f "$root/dist/entry.js" || -f "$root/dist/entry.mjs" ]]
}

resolve_managed_runtime_root() {
  local root
  if runtime_root_has_build "${FASED_MANAGED_RUNTIME_ROOT:-}"; then
    printf '%s\n' "$FASED_MANAGED_RUNTIME_ROOT"
    return 0
  fi

  # A service script owned by a source checkout must run that checkout. This
  # prevents an old managed package cache from silently replacing current code.
  if [[ -d "$FASED_ROOT/.git" ]] && runtime_root_has_build "$FASED_ROOT"; then
    printf '%s\n' "$FASED_ROOT"
    return 0
  fi

  for root in \
    "$HOME/.fased/install-cache/npm-global/lib/node_modules/@fased/fased" \
    "$FASED_ROOT"; do
    if runtime_root_has_build "$root"; then
      printf '%s\n' "$root"
      return 0
    fi
  done
  printf '%s\n' "$FASED_ROOT"
}

FASED_RUNTIME_ROOT="$(resolve_managed_runtime_root)"
RUN_NODE_SCRIPT="$FASED_RUNTIME_ROOT/scripts/run-node.mjs"
if [[ -z "${FASED_RUNTIME_SOURCE:-}" ]]; then
  if [[ "$FASED_RUNTIME_ROOT" == "$FASED_ROOT" && -d "$FASED_ROOT/.git" ]]; then
    export FASED_RUNTIME_SOURCE="source-checkout"
  elif [[ "$FASED_RUNTIME_ROOT" == *"/node_modules/@fased/fased" ]]; then
    export FASED_RUNTIME_SOURCE="managed-package"
  else
    export FASED_RUNTIME_SOURCE="packaged-runtime"
  fi
fi

node_runtime_ok_for() {
  local node_bin="$1"
  [[ -n "$node_bin" && -x "$node_bin" ]] || return 1
  "$node_bin" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 14)) process.exit(2); try { require("node:sqlite"); } catch { process.exit(3); }' >/dev/null 2>&1
}

resolve_node_bin() {
  if node_runtime_ok_for "${FASED_NODE_BIN:-}"; then
    printf '%s\n' "${FASED_NODE_BIN}"
    return 0
  fi

  local candidate
  for candidate in \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.fnm/node-versions/*/installation/bin/node \
    "$HOME"/.volta/bin/node \
    "$HOME"/.asdf/shims/node \
    "$HOME"/.local/share/mise/shims/node \
    /usr/bin/node \
    /usr/local/bin/node \
    /opt/homebrew/bin/node; do
    [[ -e "$candidate" ]] || continue
    if node_runtime_ok_for "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  if command -v node >/dev/null 2>&1 && node_runtime_ok_for "$(command -v node)"; then
    command -v node
    return 0
  fi
  return 1
}

if [[ "${FASED_MANAGED_INTERNAL:-0}" != "1" ]]; then
  if [[ ! -f "$INSTALL_MARKER_PATH" ]]; then
    echo "==> Canonical onboarding not detected ($INSTALL_MARKER_PATH missing)."
    echo "==> Recommended first run: $FASED_ROOT/install.sh"
    if [[ "${FASED_AUTO_INSTALL_ON_START:-0}" == "1" ]]; then
      echo "==> Auto-bootstrap enabled (FASED_AUTO_INSTALL_ON_START=1): running installer in no-start mode..."
      "$FASED_ROOT/install.sh" --no-start
    fi
  fi
  echo "==> Delegating to managed orchestrator (node $RUN_NODE_SCRIPT managed up)..."
  NODE_BIN="$(resolve_node_bin || true)"
  if [[ -z "$NODE_BIN" ]]; then
    echo "==> ERROR: compatible node binary not found. Install Node 24 or Node >=22.14.0 with node:sqlite."
    exit 1
  fi
  export PATH="$(dirname "$NODE_BIN"):$PATH"
  FASED_SKIP_BUILD="${FASED_SKIP_BUILD:-1}" exec "$NODE_BIN" "$RUN_NODE_SCRIPT" managed up "$@"
fi

set -euo pipefail

NODE_BIN="$(resolve_node_bin || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "[managed] ERROR: compatible node binary not found. Install Node 24 or Node >=22.14.0 with node:sqlite, then reinstall or restart the gateway service."
  exit 1
fi

# The service unit can outlive several application updates. Stamp the process
# from the selected runtime so stale unit metadata cannot misreport its build.
RUNTIME_VERSION="$("$NODE_BIN" -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const root = process.argv[1];
  const parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (typeof parsed.version !== "string" || !parsed.version.trim()) process.exit(1);
  process.stdout.write(parsed.version.trim());
' "$FASED_RUNTIME_ROOT" 2>/dev/null || true)"
if [[ -n "$RUNTIME_VERSION" ]]; then
  export FASED_VERSION="$RUNTIME_VERSION"
fi

# Config
export PATH="$(dirname "$NODE_BIN"):$HOME/.zrok/bin:$PATH"
export FASED_GATEWAY_MODE=managed
export FASED_GATEWAY_FAST_START="${FASED_GATEWAY_FAST_START:-1}"
export FASED_GATEWAY_STARTUP_TRACE="${FASED_GATEWAY_STARTUP_TRACE:-1}"
export FASED_DISABLE_CONTROL_UI_AUTOBUILD="${FASED_DISABLE_CONTROL_UI_AUTOBUILD:-1}"
export FASED_FEDERATION_URL=https://ff1.fased.app
export FASED_GATEWAY_PORT="${FASED_GATEWAY_PORT:-18789}"
export FASED_CONFIG_DIR="${FASED_CONFIG_DIR:-$HOME/.fased}"
FASED_GATEWAY_MAX_OLD_SPACE_MB="${FASED_GATEWAY_MAX_OLD_SPACE_MB:-1024}"
if [[ "${NODE_OPTIONS:-}" != *"--max-old-space-size="* ]]; then
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=${FASED_GATEWAY_MAX_OLD_SPACE_MB}"
fi
GATEWAY_NODE_ARGS=()
if [[ "${FASED_SUPPRESS_NODE_EXPERIMENTAL_WARNINGS:-1}" != "0" ]]; then
  GATEWAY_NODE_ARGS+=(--disable-warning=ExperimentalWarning)
fi
if [[ "${FASED_SUPPRESS_NODE_PUNYCODE_WARNING:-1}" != "0" ]]; then
  GATEWAY_NODE_ARGS+=(--disable-warning=DEP0040)
fi
TOKEN_PATH="$FASED_CONFIG_DIR/federation/access-token.json"
GW_TOKEN_PATH="$FASED_CONFIG_DIR/gateway-secret"
INITIAL_TOKEN_SIG=""
LOG_DIR="${FASED_LOG_DIR:-$FASED_CONFIG_DIR/logs}"
GATEWAY_BOOT_LOG="$LOG_DIR/start-managed-gateway.log"
ZROK_RUNTIME_LOG="$LOG_DIR/start-managed-zrok.log"
WALLET_SETUP_LOG="$LOG_DIR/start-managed-wallet.log"
VERBOSE_STARTUP="${FASED_VERBOSE_STARTUP:-0}"
# First boots on small VPS can take several minutes (control-ui asset prep, cold fs/cache, etc).
# Keep timeout generous to avoid restart loops that kill startup progress before listener comes up.
GATEWAY_READY_TIMEOUT="${FASED_GATEWAY_READY_TIMEOUT:-600}"
WALLET_BASELINE_MODE="${FASED_WALLET_BASELINE_MODE:-enforce}"   # enforce|skip
WALLET_BASELINE_TIMEOUT_SECONDS="${FASED_WALLET_BASELINE_TIMEOUT_SECONDS:-25}"
SIGNERD_READY_TIMEOUT_SECONDS="${FASED_SIGNERD_READY_TIMEOUT_SECONDS:-10}"
ZROK_MONITOR_PID_FILE="$FASED_CONFIG_DIR/.zrok-monitor.pid"
ZROK_MONITOR_PID=""
ZROK_INITIAL_START_RETRIES="${FASED_ZROK_INITIAL_START_RETRIES:-5}"
ZROK_INITIAL_START_RETRY_DELAY_SECONDS="${FASED_ZROK_INITIAL_START_RETRY_DELAY_SECONDS:-2}"
CLOCK_SYNC_SKEW_THRESHOLD_SECONDS="${FASED_CLOCK_SYNC_SKEW_THRESHOLD_SECONDS:-2}"

resolve_gateway_cli_entry() {
  local candidates=(
    "$FASED_RUNTIME_ROOT/dist/entry.js"
    "$FASED_RUNTIME_ROOT/dist/entry.mjs"
    "$FASED_RUNTIME_ROOT/dist/index.js"
    "$FASED_RUNTIME_ROOT/dist/index.mjs"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      printf "%s" "$candidate"
      return 0
    fi
  done
  return 1
}

resolve_wallet_broker_cli_entry() {
  local candidates=(
    "$FASED_RUNTIME_ROOT/dist/entry.js"
    "$FASED_RUNTIME_ROOT/dist/entry.mjs"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      printf "%s" "$candidate"
      return 0
    fi
  done
  return 1
}

mask_secret() {
  local raw="$1"
  local n=${#raw}
  if [[ $n -le 10 ]]; then
    printf "%s" "$raw"
    return
  fi
  printf "%s...%s" "${raw:0:6}" "${raw: -4}"
}

is_gateway_listener_ready() {
  (echo >"/dev/tcp/127.0.0.1/${FASED_GATEWAY_PORT}") >/dev/null 2>&1
}

abs_int() {
  local value="${1:-0}"
  value="${value#-}"
  if [[ -z "$value" ]]; then
    value="0"
  fi
  printf '%s\n' "$value"
}

fetch_remote_epoch_from_http_date() {
  local url="$1"
  local date_header=""
  local remote_epoch=""
  date_header="$(
    curl -fsSI --max-time 10 "$url" 2>/dev/null \
      | tr -d '\r' \
      | awk 'BEGIN{IGNORECASE=1} /^Date:/ { sub(/^Date:[[:space:]]*/, "", $0); print; exit }'
  )"
  if [[ -z "$date_header" ]]; then
    return 1
  fi
  remote_epoch="$(date -u -d "$date_header" +%s 2>/dev/null || true)"
  if [[ -z "$remote_epoch" ]]; then
    return 1
  fi
  printf '%s\n' "$remote_epoch"
}

measure_managed_clock_skew_seconds() {
  local probe_urls=(
    "${ZROK_API_ENDPOINT:-https://zrok.fased.app}"
    "${FASED_FEDERATION_URL:-https://ff1.fased.app}"
  )
  local url=""
  local remote_epoch=""
  local local_epoch=""
  for url in "${probe_urls[@]}"; do
    remote_epoch="$(fetch_remote_epoch_from_http_date "$url" || true)"
    if [[ -z "$remote_epoch" ]]; then
      continue
    fi
    local_epoch="$(date -u +%s)"
    printf '%s\n' "$((remote_epoch - local_epoch))"
    return 0
  done
  return 1
}

zrok_log_indicates_clock_skew() {
  tail -n 80 "$ZROK_RUNTIME_LOG" 2>/dev/null | grep -Fqi "issuedAt of token is in the future"
}

attempt_managed_clock_sync_repair() {
  # Host time synchronization is installed during root bootstrap. The running
  # Gateway intentionally has no privilege path for changing the host clock.
  return 1
}

ensure_managed_clock_sync() {
  local threshold="${CLOCK_SYNC_SKEW_THRESHOLD_SECONDS:-2}"
  local skew_seconds=""
  local remaining_skew=""

  skew_seconds="$(measure_managed_clock_skew_seconds || true)"
  if [[ -z "$skew_seconds" ]]; then
    return 0
  fi
  if (( $(abs_int "$skew_seconds") < threshold )); then
    return 0
  fi

  echo "[tunnel] WARNING: Host clock skew detected (${skew_seconds}s versus public control plane)."
  if ! attempt_managed_clock_sync_repair; then
    echo "[tunnel] WARNING: Rerun ./install.sh --repair-hosting as root to repair host time sync."
    return 1
  fi

  remaining_skew="$(measure_managed_clock_skew_seconds || true)"
  if [[ -n "$remaining_skew" ]] && (( $(abs_int "$remaining_skew") < threshold )); then
    echo "[tunnel] Host clock sync repaired (remaining skew ${remaining_skew}s)."
    return 0
  fi

  echo "[tunnel] WARNING: Host clock repair did not fully converge (remaining skew ${remaining_skew:-unknown}s)."
  return 1
}

start_initial_zrok_share() {
  local slug="$1"
  local attempts="${ZROK_INITIAL_START_RETRIES:-5}"
  local retry_delay="${ZROK_INITIAL_START_RETRY_DELAY_SECONDS:-2}"
  local attempt=1

  while (( attempt <= attempts )); do
    echo "[tunnel] Starting tunnel for ${slug} (attempt ${attempt}/${attempts})..."
    "$ZROK_BIN" share reserved "$RES_TOKEN" --headless >>"$ZROK_RUNTIME_LOG" 2>&1 &
    ZROK_PID=$!
    echo "$ZROK_PID" > "$FASED_CONFIG_DIR/.zrok-pid"
    sleep 5

    if ! kill -0 "$AGENT_PID" 2>/dev/null; then
      if is_gateway_listener_ready; then
        echo "[gateway] WARNING: Gateway launcher exited, but listener is healthy on 127.0.0.1:${FASED_GATEWAY_PORT}; continuing."
      else
        echo "[gateway] ERROR: Gateway process exited during tunnel startup."
        if [[ "$VERBOSE_STARTUP" != "1" ]]; then
          echo "[debug] Last gateway startup logs:"
          tail -n 80 "$GATEWAY_BOOT_LOG" || true
        fi
        return 1
      fi
    fi

    if ! is_gateway_listener_ready; then
      echo "[gateway] ERROR: Gateway listener on 127.0.0.1:${FASED_GATEWAY_PORT} is not reachable."
      if [[ "$VERBOSE_STARTUP" != "1" ]]; then
        echo "[debug] Last gateway startup logs:"
        tail -n 80 "$GATEWAY_BOOT_LOG" || true
      fi
      return 1
    fi

    if kill -0 "$ZROK_PID" 2>/dev/null; then
      echo "[tunnel] ✓ Tunnel active."
      return 0
    fi

    echo "[tunnel] WARNING: zrok share died during startup."
    if [[ "$VERBOSE_STARTUP" != "1" ]]; then
      echo "[debug] Last zrok startup logs:"
      tail -n 40 "$ZROK_RUNTIME_LOG" || true
    fi
    if zrok_log_indicates_clock_skew; then
      echo "[tunnel] Detected zrok auth failure caused by host clock skew."
      ensure_managed_clock_sync || true
    fi

    if (( attempt == attempts )); then
      echo "[tunnel] ERROR: zrok share failed to stay up after ${attempts} attempts."
      return 1
    fi

    echo "[tunnel] Retrying zrok startup in ${retry_delay}s..."
    sleep "$retry_delay"
    if [[ "$retry_delay" =~ ^[0-9]+$ ]] && (( retry_delay < 8 )); then
      retry_delay=$((retry_delay * 2))
    fi
    attempt=$((attempt + 1))
  done

  return 1
}

force_stop_local_gateway() {
  if ! is_gateway_listener_ready; then
    return 0
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${FASED_GATEWAY_PORT}/tcp" >/dev/null 2>&1 || true
  fi
  if command -v lsof >/dev/null 2>&1; then
    mapfile -t PORT_PIDS < <(lsof -t -iTCP:"${FASED_GATEWAY_PORT}" -sTCP:LISTEN 2>/dev/null || true)
    if [[ ${#PORT_PIDS[@]} -gt 0 ]]; then
      kill "${PORT_PIDS[@]}" >/dev/null 2>&1 || true
    fi
  fi
  pkill -f "scripts/run-node.mjs gateway" >/dev/null 2>&1 || true
  pkill -f "fased-gateway" >/dev/null 2>&1 || true
}

wait_for_gateway_listener() {
  local retries="$1"
  local count=0
  echo "==> Waiting for local gateway listener on 127.0.0.1:${FASED_GATEWAY_PORT} (max ${retries}s)..."
  while true; do
    if is_gateway_listener_ready; then
      return 0
    fi
    if ! kill -0 "$AGENT_PID" 2>/dev/null; then
      echo "[gateway] ERROR: Gateway process exited before listener became ready."
      if [[ "$VERBOSE_STARTUP" != "1" ]]; then
        echo "[debug] Last gateway startup logs:"
        tail -n 80 "$GATEWAY_BOOT_LOG" || true
      fi
      return 1
    fi
    sleep 1
    count=$((count + 1))
    if [[ $count -ge $retries ]]; then
      echo "[gateway] ERROR: Timed out waiting for local listener on port ${FASED_GATEWAY_PORT}."
      if [[ "$VERBOSE_STARTUP" != "1" ]]; then
        echo "[debug] Last gateway startup logs:"
        tail -n 80 "$GATEWAY_BOOT_LOG" || true
      fi
      return 1
    fi
  done
}

start_gateway_if_needed() {
  if [[ -n "${AGENT_PID:-}" ]] && kill -0 "$AGENT_PID" 2>/dev/null; then
    if is_gateway_listener_ready; then
      return 0
    fi
  fi

  echo "==> Starting FasedAgent Gateway..."
  # Capture pre-existing token fingerprint so we can detect a real refresh.
  if [[ -f "$TOKEN_PATH" ]]; then
    INITIAL_TOKEN_SIG=$(sha256sum "$TOKEN_PATH" | awk '{print $1}')
  fi
  GATEWAY_ENTRY="$(resolve_gateway_cli_entry || true)"
  if [[ -z "$GATEWAY_ENTRY" ]]; then
    echo "[gateway] ERROR: Unable to resolve built gateway entry under $FASED_ROOT/dist"
    exit 1
  fi
  if [[ "$VERBOSE_STARTUP" == "1" ]]; then
    FASED_SKIP_BUILD=1 "$NODE_BIN" "${GATEWAY_NODE_ARGS[@]}" "$GATEWAY_ENTRY" gateway --allow-unconfigured --force --bind loopback --port "$FASED_GATEWAY_PORT" &
  else
    : > "$GATEWAY_BOOT_LOG"
    FASED_SKIP_BUILD=1 "$NODE_BIN" "${GATEWAY_NODE_ARGS[@]}" "$GATEWAY_ENTRY" gateway --allow-unconfigured --force --bind loopback --port "$FASED_GATEWAY_PORT" >>"$GATEWAY_BOOT_LOG" 2>&1 &
  fi
  AGENT_PID=$!

  if ! wait_for_gateway_listener "$GATEWAY_READY_TIMEOUT"; then
    exit 1
  fi
}

# Ensure Gateway Token exists
mkdir -p "$FASED_CONFIG_DIR"
mkdir -p "$LOG_DIR"
: > "$ZROK_RUNTIME_LOG"
: > "$WALLET_SETUP_LOG"
SERVICE_GATEWAY_TOKEN="${FASED_GATEWAY_TOKEN:-}"
if [ ! -f "$GW_TOKEN_PATH" ]; then
  if [[ -n "$SERVICE_GATEWAY_TOKEN" ]]; then
    printf '%s\n' "$SERVICE_GATEWAY_TOKEN" > "$GW_TOKEN_PATH"
  else
    openssl rand -hex 32 > "$GW_TOKEN_PATH"
  fi
fi
export FASED_GATEWAY_TOKEN="$(tr -d '\n' < "$GW_TOKEN_PATH")"

# 0. Clean up stale state
# rm -f "$TOKEN_PATH" # (Disabled: Preserve identity for stable Zrok tunnels)
# Note: --force on gateway start will handle the port conflict, 
# but we still kill zrok to ensure no tunnel conflicts.
if [[ "${FASED_MANAGED_INTERNAL:-0}" != "1" ]]; then
  FASED_SKIP_BUILD=1 "$NODE_BIN" "$RUN_NODE_SCRIPT" gateway stop >/dev/null 2>&1 || true
fi
force_stop_local_gateway

# Start the dashboard backend before slower hosted setup. Signer, wallet,
# federation, and tunnel work must not prevent the owner from opening the UI.
start_gateway_if_needed

# 0a. Start local key signer daemon (fased-signerd) if available
SIGNERD_BIN="${FASED_CONFIG_DIR}/bin/fased-signerd"
SIGNERD_SOCKET="${FASED_CONFIG_DIR}/wallet/local-signer.sock"
SIGNERD_BACKEND_SOCKET="$SIGNERD_SOCKET"
SIGNERD_MATERIAL_DIR="${FASED_CONFIG_DIR}/wallet"
SIGNERD_PASSPHRASE_FILE="$SIGNERD_MATERIAL_DIR/passphrase"
SIGNERD_EVM_KEYSTORE="$SIGNERD_MATERIAL_DIR/keystore-evm.v1.enc"
SIGNERD_SOL_KEYSTORE="$SIGNERD_MATERIAL_DIR/keystore-solana.v1.enc"
SIGNERD_LOG="${LOG_DIR}/fased-signerd.log"
SIGNERD_BROKER_LOG="${LOG_DIR}/local-signer-broker.log"
SIGNER_MAINTENANCE_HELPER="/usr/local/sbin/fased-signer-maintenance"
SIGNER_ISOLATION_HELPER="/usr/local/sbin/fased-signer-isolation"
CONFIG_JSON="${FASED_CONFIG_DIR}/fased.json"
SIGNERD_ENV_FILE="${FASED_CONFIG_DIR}/wallet/signer.env"
WALLET_REGISTRY_JSON="${FASED_CONFIG_DIR}/wallet/provider-registry.v1.json"
SIGNERD_STARTUP_MODE="disabled"
SIGNERD_ERROR=""

mark_signerd_degraded() {
  SIGNERD_STARTUP_MODE="degraded"
  SIGNERD_ERROR="$1"
  echo "[signerd] WARNING: $1"
  echo "[signerd]          Dashboard stays online; wallet actions remain degraded until signer is fixed."
}

load_wallet_signer_env_from_config() {
  if [[ ! -f "$CONFIG_JSON" ]]; then
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    return 0
  fi
  while IFS= read -r line; do
    [[ "$line" == *=* ]] || continue
    local key="${line%%=*}"
    local value="${line#*=}"
    if [[ "$key" =~ ^FASED_WALLET_(EVM|SOLANA)_(RPC_URL|KEYSTORE_PATH)(__[A-Za-z0-9_-]+)?$ ]] \
      || [[ "$key" == "FASED_WALLET_CHAINS" ]] \
      || [[ "$key" == "FASED_WALLET_PASSPHRASE_FILE" ]] \
      || [[ "$key" == "FASED_WALLET_LOCAL_SIGNER_SOCKET" ]] \
      || [[ "$key" == "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET" ]] \
      || [[ "$key" == "FASED_WALLET_SIGNER_STATE_DIR" ]] \
      || [[ "$key" == "FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER" ]] \
      || [[ "$key" == "FASED_WALLET_LOCAL_SIGNER_BIN" ]] \
      || [[ "$key" =~ ^FASED_WALLET_LOCAL_SIGNER_(ROLE|DIRECT_SIGNING|CAPS_ENABLED|SOLANA_MAX_PER_TX|SOLANA_MAX_DAILY|SOLANA_ALLOW_PROGRAMS)(__[A-Za-z0-9_-]+)?$ ]]; then
      export "$key=$value"
    fi
  done < <(
    jq -r '
      .env.vars // {}
      | to_entries[]
      | select(
          .key
          | test("^FASED_WALLET_(EVM|SOLANA)_(RPC_URL|KEYSTORE_PATH)(__[A-Za-z0-9_-]+)?$")
            or . == "FASED_WALLET_CHAINS"
            or . == "FASED_WALLET_PASSPHRASE_FILE"
            or . == "FASED_WALLET_LOCAL_SIGNER_SOCKET"
            or . == "FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET"
            or . == "FASED_WALLET_SIGNER_STATE_DIR"
            or . == "FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER"
            or . == "FASED_WALLET_LOCAL_SIGNER_BIN"
            or test("^FASED_WALLET_LOCAL_SIGNER_(ROLE|DIRECT_SIGNING|CAPS_ENABLED|SOLANA_MAX_PER_TX|SOLANA_MAX_DAILY|SOLANA_ALLOW_PROGRAMS)(__[A-Za-z0-9_-]+)?$")
        )
      | "\(.key)=\(.value|tostring)"
    ' "$CONFIG_JSON" 2>/dev/null || true
  )
}

load_wallet_signer_env_file() {
  if [[ ! -f "$SIGNERD_ENV_FILE" ]]; then
    return 0
  fi

  set -a
  # signer.env is generated by onboarding.wallet.ts; only import export lines, not the launch command.
  source <(grep -E '^export FASED_WALLET_' "$SIGNERD_ENV_FILE" || true)
  set +a
}

has_scoped_wallet_env_value() {
  local prefix="$1"
  local name=""
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if [[ -n "${!name:-}" ]]; then
      return 0
    fi
  done < <(compgen -A variable "${prefix}__" || true)
  return 1
}

normalize_wallet_env_suffix() {
  local raw="${1:-}"
  printf '%s' "$raw" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/_/g; s/^_+//; s/_+$//'
}

normalize_wallet_filename_id() {
  local raw="${1:-}"
  printf '%s' "$raw" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//'
}

hydrate_scoped_wallet_keystore_env_from_registry() {
  local material_dir="$1"
  if [[ ! -f "$WALLET_REGISTRY_JSON" ]] || ! command -v jq >/dev/null 2>&1; then
    return 0
  fi

  while IFS=$'\t' read -r wallet_id provider_id; do
    [[ -n "$wallet_id" ]] || continue
    if [[ "$provider_id" != "local-socket-signer" && "$provider_id" != "embedded-keystore" ]]; then
      continue
    fi
    local env_suffix
    local file_suffix
    env_suffix="$(normalize_wallet_env_suffix "$wallet_id")"
    file_suffix="$(normalize_wallet_filename_id "$wallet_id")"
    [[ -n "$env_suffix" && -n "$file_suffix" ]] || continue

    local sol_key="FASED_WALLET_SOLANA_KEYSTORE_PATH__${env_suffix^^}"
    if [[ -z "${!sol_key:-}" ]]; then
      local sol_candidate="${material_dir}/keystore-solana-${file_suffix}.v1.enc"
      if [[ -f "$sol_candidate" ]]; then
        export "$sol_key=$sol_candidate"
      fi
    fi

    local evm_key="FASED_WALLET_EVM_KEYSTORE_PATH__${env_suffix^^}"
    if [[ -z "${!evm_key:-}" ]]; then
      local evm_candidate="${material_dir}/keystore-evm-${file_suffix}.v1.enc"
      if [[ -f "$evm_candidate" ]]; then
        export "$evm_key=$evm_candidate"
      fi
    fi
  done < <(
    jq -r '
      (.wallets // [])
      | .[]
      | select(.id != null and .providerId != null)
      | "\(.id|tostring)\t\(.providerId|tostring)"
    ' "$WALLET_REGISTRY_JSON" 2>/dev/null || true
  )
}

resolve_signerd_keystore_export() {
  local explicit_value="$1"
  local scoped_prefix="$2"
  local default_path="$3"

  if has_scoped_wallet_env_value "$scoped_prefix"; then
    printf '\n'
    return 0
  fi

  if [[ -n "$explicit_value" && "$explicit_value" != "$default_path" ]]; then
    printf '%s\n' "$explicit_value"
    return 0
  fi

  if [[ -n "$explicit_value" ]]; then
    printf '%s\n' "$explicit_value"
    return 0
  fi

  printf '%s\n' "$default_path"
}

resolve_wallet_chains_from_config() {
  if [[ ! -f "$CONFIG_JSON" ]] || ! command -v jq >/dev/null 2>&1; then
    printf '%s\n' "evm,solana"
    return 0
  fi
  jq -r '
    [
      ((.env.vars.FASED_WALLET_CHAINS // "") | split(",")[]?),
      (.wallet.runtime.chains // [] | .[]?)
    ]
    | map((.|tostring|ascii_downcase|gsub("^\\s+|\\s+$"; "")))
    | map(select(. == "evm" or . == "solana"))
    | unique
    | if length > 0 then join(",") else "evm,solana" end
  ' "$CONFIG_JSON" 2>/dev/null || printf '%s\n' "evm,solana"
}

resolve_local_signer_sidecar_path() {
  local socket_path="$1"
  local kind="$2"
  local socket_dir
  local socket_name
  local sidecar_base
  socket_dir="$(dirname "$socket_path")"
  socket_name="$(basename "$socket_path")"
  sidecar_base="${socket_name%.sock}"
  if [[ "$sidecar_base" == "$socket_name" ]]; then
    sidecar_base="$socket_name"
  fi
  if [[ "$kind" == "pid" ]]; then
    printf '%s\n' "${socket_dir}/${sidecar_base}.pid"
  else
    printf '%s\n' "${socket_dir}/${sidecar_base}.audit.jsonl"
  fi
}

registry_has_local_signer_wallet() {
  if [[ ! -f "$WALLET_REGISTRY_JSON" ]] || ! command -v jq >/dev/null 2>&1; then
    return 1
  fi
  jq -e '
    (.wallets // [])
    | any(.providerId == "local-socket-signer")
  ' "$WALLET_REGISTRY_JSON" >/dev/null 2>&1
}

has_local_signer_keystore_material() {
  if [[ -n "${FASED_WALLET_SOLANA_KEYSTORE_PATH:-}" ]] || has_scoped_wallet_env_value "FASED_WALLET_SOLANA_KEYSTORE_PATH"; then
    return 0
  fi
  local candidate
  for candidate in "$SIGNERD_MATERIAL_DIR"/keystore-solana*.v1.enc "$SIGNERD_MATERIAL_DIR"/keystore-evm*.v1.enc; do
    [[ -f "$candidate" ]] && return 0
  done
  return 1
}

should_start_signerd() {
  registry_has_local_signer_wallet || has_local_signer_keystore_material
}

collect_existing_signerd_pids() {
  local pid_file app_pid_file
  pid_file="$(resolve_local_signer_sidecar_path "$SIGNERD_BACKEND_SOCKET" "pid")"
  app_pid_file="$(resolve_local_signer_sidecar_path "$SIGNERD_SOCKET" "pid")"
  {
    if [[ -f "$pid_file" ]]; then
      cat "$pid_file" 2>/dev/null || true
    fi
    if [[ "$app_pid_file" != "$pid_file" && -f "$app_pid_file" ]]; then
      cat "$app_pid_file" 2>/dev/null || true
    fi
    pgrep -f "$SIGNERD_BIN" 2>/dev/null || true
    pgrep -f "wallet signer broker" 2>/dev/null || true
  } | awk '/^[0-9]+$/ { if (!seen[$1]++) print $1 }'
}

count_existing_signerd_pids() {
  local count=0
  while IFS= read -r _pid; do
    count=$((count + 1))
  done < <(collect_existing_signerd_pids)
  printf '%s\n' "$count"
}

dump_existing_signerd_processes() {
  pgrep -af "$SIGNERD_BIN" 2>/dev/null || true
}

stop_existing_signerd() {
  local pid_file app_pid_file
  pid_file="$(resolve_local_signer_sidecar_path "$SIGNERD_BACKEND_SOCKET" "pid")"
  app_pid_file="$(resolve_local_signer_sidecar_path "$SIGNERD_SOCKET" "pid")"
  if signer_isolation_helper_available; then
    run_signer_isolation_helper stop "$SIGNERD_BACKEND_SOCKET" "$pid_file" >/dev/null 2>&1 || true
    if [[ "$SIGNERD_SOCKET" != "$SIGNERD_BACKEND_SOCKET" ]]; then
      run_signer_isolation_helper stop "$SIGNERD_SOCKET" "$app_pid_file" >/dev/null 2>&1 || true
    fi
    return 0
  fi
  local pid=""
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    kill "$pid" >/dev/null 2>&1 || true
  done < <(collect_existing_signerd_pids)
  sleep 0.5
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    kill -9 "$pid" >/dev/null 2>&1 || true
  done < <(collect_existing_signerd_pids)
  rm -f "$SIGNERD_SOCKET" "$SIGNERD_BACKEND_SOCKET" "$pid_file" "$app_pid_file"
}

wait_for_signerd_ready() {
  local retries="$1"
  local count=0
  while true; do
    local active_count
    active_count="$(count_existing_signerd_pids)"
    if [[ "$active_count" == "1" && -S "$SIGNERD_BACKEND_SOCKET" ]]; then
      return 0
    fi
    if [[ "$active_count" -gt 1 ]]; then
      echo "[signerd] ERROR: multiple fased-signerd processes detected; refusing to start gateway."
      dump_existing_signerd_processes
      return 1
    fi
    sleep 1
    count=$((count + 1))
    if [[ $count -ge $retries ]]; then
      echo "[signerd] ERROR: fased-signerd did not become healthy within ${retries}s."
      dump_existing_signerd_processes
      tail -n 40 "$SIGNERD_LOG" 2>/dev/null || true
      return 1
    fi
  done
}

wait_for_signer_broker_ready() {
  local retries="$1"
  local count=0
  while true; do
    if [[ -S "$SIGNERD_SOCKET" ]]; then
      return 0
    fi
    sleep 1
    count=$((count + 1))
    if [[ $count -ge $retries ]]; then
      echo "[signerd] ERROR: signer broker did not create app socket within ${retries}s."
      tail -n 40 "$SIGNERD_BROKER_LOG" 2>/dev/null || true
      return 1
    fi
  done
}

collect_wallet_env_args() {
  local key value
  while IFS='=' read -r key value; do
    [[ "$key" == FASED_WALLET_* ]] || continue
    printf '%s=%s\0' "$key" "$value"
  done < <(env)
}

current_app_user() {
  id -un 2>/dev/null || printf '%s\n' "${USER:-app}"
}

signer_isolation_helper_available() {
  [[ -n "${FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER:-}" ]] || return 1
  [[ -x "$SIGNER_MAINTENANCE_HELPER" || -x "$SIGNER_ISOLATION_HELPER" ]] || return 1
  command -v sudo >/dev/null 2>&1 || return 1
}

run_signer_isolation_helper() {
  if [[ -x "$SIGNER_MAINTENANCE_HELPER" ]]; then
    sudo -n -E "$SIGNER_MAINTENANCE_HELPER" "$@"
  else
    local app_user
    app_user="$(current_app_user)"
    sudo -n -E "$SIGNER_ISOLATION_HELPER" "$app_user" "$FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER" "$@"
  fi
}

start_signerd_process() {
  local pid_file audit_log
  pid_file="$(resolve_local_signer_sidecar_path "$SIGNERD_BACKEND_SOCKET" "pid")"
  audit_log="$(resolve_local_signer_sidecar_path "$SIGNERD_BACKEND_SOCKET" "audit")"
  if [[ -n "${FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER:-}" ]]; then
    if signer_isolation_helper_available; then
      run_signer_isolation_helper start-signerd \
        "$SIGNERD_BIN" \
        "$SIGNERD_BACKEND_SOCKET" \
        "$pid_file" \
        "$audit_log" \
        >>"$SIGNERD_LOG" 2>&1 &
      return 0
    fi
    if ! command -v sudo >/dev/null 2>&1; then
      return 1
    fi
    local env_args=()
    while IFS= read -r -d '' env_arg; do
      env_args+=("$env_arg")
    done < <(collect_wallet_env_args)
    sudo -n -u "$FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER" -H env "${env_args[@]}" \
      "$SIGNERD_BIN" \
        -socket "$SIGNERD_BACKEND_SOCKET" \
        -pid-file "$pid_file" \
        -audit-log "$audit_log" \
        >>"$SIGNERD_LOG" 2>&1 &
    return 0
  fi
  "$SIGNERD_BIN" \
    -socket "$SIGNERD_BACKEND_SOCKET" \
    -pid-file "$pid_file" \
    -audit-log "$audit_log" \
    >>"$SIGNERD_LOG" 2>&1 &
}

start_signer_broker_process() {
  if [[ "$SIGNERD_SOCKET" == "$SIGNERD_BACKEND_SOCKET" ]]; then
    return 0
  fi
  local gateway_entry
  gateway_entry="$(resolve_wallet_broker_cli_entry || true)"
  if [[ -z "$gateway_entry" ]]; then
    echo "[signerd] ERROR: signer broker CLI entry unavailable under $FASED_ROOT/dist"
    return 1
  fi
  if [[ -n "${FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER:-}" ]]; then
    if signer_isolation_helper_available; then
      run_signer_isolation_helper start-broker \
        "$NODE_BIN" \
        "$gateway_entry" \
        "$SIGNERD_SOCKET" \
        "$SIGNERD_BACKEND_SOCKET" \
        "$(resolve_local_signer_sidecar_path "$SIGNERD_SOCKET" "pid")" \
        "$(resolve_local_signer_sidecar_path "$SIGNERD_SOCKET" "audit")" \
        >>"$SIGNERD_BROKER_LOG" 2>&1 &
      return 0
    fi
    if ! command -v sudo >/dev/null 2>&1; then
      return 1
    fi
    local env_args=()
    while IFS= read -r -d '' env_arg; do
      env_args+=("$env_arg")
    done < <(collect_wallet_env_args)
    sudo -n -u "$FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER" -H env "${env_args[@]}" \
      "$NODE_BIN" "$gateway_entry" wallet signer broker \
        --socket "$SIGNERD_SOCKET" \
        --backend-socket "$SIGNERD_BACKEND_SOCKET" \
        --pid-file "$(resolve_local_signer_sidecar_path "$SIGNERD_SOCKET" "pid")" \
        --audit-log "$(resolve_local_signer_sidecar_path "$SIGNERD_SOCKET" "audit")" \
        >>"$SIGNERD_BROKER_LOG" 2>&1 &
    return 0
  fi
  "$NODE_BIN" "$gateway_entry" wallet signer broker \
    --socket "$SIGNERD_SOCKET" \
    --backend-socket "$SIGNERD_BACKEND_SOCKET" \
    --pid-file "$(resolve_local_signer_sidecar_path "$SIGNERD_SOCKET" "pid")" \
    --audit-log "$(resolve_local_signer_sidecar_path "$SIGNERD_SOCKET" "audit")" \
    >>"$SIGNERD_BROKER_LOG" 2>&1 &
}

load_wallet_signer_env_from_config
load_wallet_signer_env_file
SIGNERD_BIN="${FASED_WALLET_LOCAL_SIGNER_BIN:-$SIGNERD_BIN}"
SIGNERD_MATERIAL_DIR="${FASED_WALLET_SIGNER_STATE_DIR:-$SIGNERD_MATERIAL_DIR}"
if [[ -n "${FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER:-}" ]]; then
  SIGNERD_BROKER_LOG="$(dirname "${FASED_WALLET_LOCAL_SIGNER_SOCKET:-$SIGNERD_SOCKET}")/local-signer-broker.log"
fi
hydrate_scoped_wallet_keystore_env_from_registry "$SIGNERD_MATERIAL_DIR"
HOSTED_ROOT_SIGNER=0
if [[ "${FASED_HOST_PROFILE:-}" == "hosting" ]]; then
  HOSTED_ROOT_SIGNER=1
  SIGNERD_SOCKET="/run/fased-signerd/app.sock"
  SIGNERD_BACKEND_SOCKET="$SIGNERD_SOCKET"
  export FASED_WALLET_LOCAL_SIGNER_SOCKET="$SIGNERD_SOCKET"
  export FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET="$SIGNERD_SOCKET"
  unset FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER
  if [[ -S "$SIGNERD_SOCKET" ]]; then
    SIGNERD_STARTUP_MODE="external"
    echo "==> Using root-managed fased-signerd service (socket: $SIGNERD_SOCKET)"
  else
    mark_signerd_degraded "root-managed fased-signerd socket is unavailable. Run ./install.sh --repair-hosting as root."
  fi
elif should_start_signerd; then
  SIGNERD_STARTUP_MODE="healthy"
  SIGNERD_SOCKET="${FASED_WALLET_LOCAL_SIGNER_SOCKET:-$SIGNERD_SOCKET}"
  SIGNERD_BACKEND_SOCKET="${FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET:-$SIGNERD_SOCKET}"
  SIGNERD_EVM_KEYSTORE="$(resolve_signerd_keystore_export "${FASED_WALLET_EVM_KEYSTORE_PATH:-}" "FASED_WALLET_EVM_KEYSTORE_PATH" "$SIGNERD_MATERIAL_DIR/keystore-evm.v1.enc")"
  SIGNERD_SOL_KEYSTORE="$(resolve_signerd_keystore_export "${FASED_WALLET_SOLANA_KEYSTORE_PATH:-}" "FASED_WALLET_SOLANA_KEYSTORE_PATH" "$SIGNERD_MATERIAL_DIR/keystore-solana.v1.enc")"
  SIGNERD_PASSPHRASE="${FASED_WALLET_PASSPHRASE:-}"
  SIGNERD_PASSPHRASE_FILE="${FASED_WALLET_PASSPHRASE_FILE:-}"
  SIGNERD_CHAINS="${FASED_WALLET_CHAINS:-$(resolve_wallet_chains_from_config)}"
  export FASED_WALLET_LOCAL_SIGNER_SOCKET="$SIGNERD_SOCKET"
  export FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET="$SIGNERD_BACKEND_SOCKET"
  export FASED_WALLET_SIGNER_STATE_DIR="$SIGNERD_MATERIAL_DIR"
  export FASED_WALLET_CHAINS="${SIGNERD_CHAINS:-evm,solana}"
  if [[ -n "$SIGNERD_EVM_KEYSTORE" ]]; then
    export FASED_WALLET_EVM_KEYSTORE_PATH="$SIGNERD_EVM_KEYSTORE"
  else
    unset FASED_WALLET_EVM_KEYSTORE_PATH
  fi
  if [[ -n "$SIGNERD_SOL_KEYSTORE" ]]; then
    export FASED_WALLET_SOLANA_KEYSTORE_PATH="$SIGNERD_SOL_KEYSTORE"
  else
    unset FASED_WALLET_SOLANA_KEYSTORE_PATH
  fi
  if [[ -n "$SIGNERD_PASSPHRASE" ]]; then
    export FASED_WALLET_PASSPHRASE="$SIGNERD_PASSPHRASE"
    unset FASED_WALLET_PASSPHRASE_FILE
  else
    SIGNERD_PASSPHRASE_FILE="${SIGNERD_PASSPHRASE_FILE:-$SIGNERD_MATERIAL_DIR/passphrase}"
    export FASED_WALLET_PASSPHRASE_FILE="$SIGNERD_PASSPHRASE_FILE"
    unset FASED_WALLET_PASSPHRASE
  fi
  if [[ -f "$SIGNERD_BIN" ]]; then
    if [[ -S "$SIGNERD_SOCKET" ]] || [[ -S "$SIGNERD_BACKEND_SOCKET" ]] || [[ -f "$(resolve_local_signer_sidecar_path "$SIGNERD_BACKEND_SOCKET" "pid")" ]] || [[ "$(count_existing_signerd_pids)" -gt 0 ]]; then
      echo "==> Restarting fased-signerd to apply current wallet chain/runtime config..."
      stop_existing_signerd
    fi
    echo "==> Starting fased-signerd (Go key signer)..."
    mkdir -p "$LOG_DIR"
    mkdir -p "$(dirname "$SIGNERD_LOG")" "$(dirname "$SIGNERD_BROKER_LOG")" 2>/dev/null || true
    if start_signerd_process; then
      SIGNERD_PID=$!
    else
      mark_signerd_degraded "failed to start isolated fased-signerd as ${FASED_WALLET_LOCAL_SIGNER_RUN_AS_USER:-current user}. Check sudoers and $SIGNERD_LOG"
      SIGNERD_PID=""
    fi
    if [[ -n "$SIGNERD_PID" ]] && wait_for_signerd_ready "$SIGNERD_READY_TIMEOUT_SECONDS"; then
      if ! start_signer_broker_process; then
        mark_signerd_degraded "fased-signerd started but signer broker failed. Check $SIGNERD_BROKER_LOG"
      elif wait_for_signer_broker_ready "$SIGNERD_READY_TIMEOUT_SECONDS"; then
        echo "==> fased-signerd started (PID=$SIGNERD_PID, socket: $SIGNERD_BACKEND_SOCKET)"
      else
        mark_signerd_degraded "fased-signerd broker did not become ready. Check $SIGNERD_BROKER_LOG"
      fi
    else
      mark_signerd_degraded "fased-signerd did not create socket. Check $SIGNERD_LOG"
    fi
  else
    mark_signerd_degraded "fased-signerd is not installed; dashboard stays online. Configure wallet signer from the dashboard or run fased wallet signer setup."
  fi
else
  unset FASED_WALLET_LOCAL_SIGNER_SOCKET
  unset FASED_WALLET_LOCAL_SIGNER_BACKEND_SOCKET
  unset FASED_WALLET_SIGNER_STATE_DIR
  unset FASED_WALLET_CHAINS
  unset FASED_WALLET_SOLANA_KEYSTORE_PATH
  unset FASED_WALLET_EVM_KEYSTORE_PATH
  unset FASED_WALLET_PASSPHRASE
  unset FASED_WALLET_PASSPHRASE_FILE
  echo "==> Wallet signer not configured; skipping fased-signerd startup."
fi
if [[ -f "$ZROK_MONITOR_PID_FILE" ]]; then
  OLD_MONITOR_PID=$(cat "$ZROK_MONITOR_PID_FILE" 2>/dev/null || true)
  if [[ -n "$OLD_MONITOR_PID" ]] && kill -0 "$OLD_MONITOR_PID" 2>/dev/null; then
    kill "$OLD_MONITOR_PID" 2>/dev/null || true
  fi
  rm -f "$ZROK_MONITOR_PID_FILE" || true
fi
pkill -f "zrok share" || true
sleep 1

# === Tunnel Helper Functions ===

start_health_monitor() {
  local SLUG="$1"
  local RES_TOKEN="$2"
  local retry_delay=30
  local max_retry_delay=300
  while true; do
    sleep "$retry_delay"
    local pid=""
    if [[ -f "$FASED_CONFIG_DIR/.zrok-pid" ]]; then
      pid="$(cat "$FASED_CONFIG_DIR/.zrok-pid" 2>/dev/null || true)"
    fi
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      retry_delay=30
      continue
    fi

    echo "[tunnel] zrok share is not active, attempting restart..."
    if zrok_log_indicates_clock_skew; then
      echo "[tunnel] Detected zrok auth failure caused by host clock skew."
      ensure_managed_clock_sync || true
    fi
    if [[ -n "$RES_TOKEN" ]]; then
      "$ZROK_BIN" share reserved "$RES_TOKEN" --headless >>"$ZROK_RUNTIME_LOG" 2>&1 &
    else
      "$ZROK_BIN" share public "http://127.0.0.1:${FASED_GATEWAY_PORT}" --unique-name "$SLUG" >>"$ZROK_RUNTIME_LOG" 2>&1 &
    fi
    pid=$!
    echo "$pid" > "$FASED_CONFIG_DIR/.zrok-pid"
    sleep 5
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "[tunnel] ✓ Tunnel active."
      retry_delay=30
      continue
    fi

    echo "[tunnel] WARNING: zrok share restart failed."
    if zrok_log_indicates_clock_skew; then
      echo "[tunnel] Detected zrok auth failure caused by host clock skew."
      ensure_managed_clock_sync || true
    fi
    if (( retry_delay < max_retry_delay )); then
      retry_delay=$((retry_delay * 2))
      if (( retry_delay > max_retry_delay )); then
        retry_delay=$max_retry_delay
      fi
    fi
  done
}

# === Execution Flow ===

MANAGED_TUNNEL_DISABLED=0
TUNNEL_ERROR=""
disable_managed_tunnel() {
  MANAGED_TUNNEL_DISABLED=1
  TUNNEL_STARTED=0
  FINAL_URL="N/A"
  TUNNEL_ERROR="$1"
  echo "[tunnel] WARNING: $1"
  echo "[tunnel]          Dashboard gateway stays online; Fased Network tunnel remains degraded until repaired."
}

# 1. Wait for the agent to enroll/refresh access token.
# We do not treat a stale pre-existing token as ready if it has no zrok metadata.
echo "==> Waiting for agent enrollment/token refresh (max 60s)..."
MAX_RETRIES=60
COUNT=0
while true; do
  if [[ -f "$TOKEN_PATH" ]]; then
    CURRENT_ZROK=$(jq -r '.zrokToken // empty' "$TOKEN_PATH" 2>/dev/null || true)
    if [[ -n "$CURRENT_ZROK" ]]; then
      break
    fi

    CURRENT_SIG=$(sha256sum "$TOKEN_PATH" | awk '{print $1}')
    # If token changed after startup, proceed even if zrok is still missing.
    # Recovery logic below will decide strict-mode outcome.
    if [[ -n "$INITIAL_TOKEN_SIG" && "$CURRENT_SIG" != "$INITIAL_TOKEN_SIG" ]]; then
      break
    fi

    # No initial token: once we have a token file, give it a short chance to gain zrok fields.
    if [[ -z "$INITIAL_TOKEN_SIG" && $COUNT -ge 3 ]]; then
      break
    fi
  fi
  sleep 1
  COUNT=$((COUNT + 1))
  if [[ $COUNT -ge $MAX_RETRIES ]]; then
    if [[ -f "$TOKEN_PATH" ]]; then
      echo "[tunnel] WARNING: Token refresh did not complete in time; continuing with current token."
      break
    fi
    disable_managed_tunnel "Agent enrollment/token refresh did not complete in time and no token is available."
    if [[ "$VERBOSE_STARTUP" != "1" ]]; then
      echo "[debug] Last gateway startup logs:"
      tail -n 40 "$GATEWAY_BOOT_LOG" || true
    fi
    break
  fi
done

# === Tunneling (zrok) ===

FINAL_URL="N/A"
TUNNEL_STARTED=0
SLUG="N/A"
RES_TOKEN=""

ZROK_VDIR="$HOME/.zrok"
ZROK_BIN="$ZROK_VDIR/bin/zrok"

if [[ "$MANAGED_TUNNEL_DISABLED" != "1" ]]; then

# Check if zrok is installed; if not, install it
if [[ ! -f "$ZROK_BIN" ]]; then
  echo "[tunnel] Installing zrok CLI..."
  echo "[tunnel] Destination: $ZROK_VDIR/bin"
  mkdir -p "$ZROK_VDIR/bin"
  
  # Temporarily disable pipefail to capture install errors
  set +e
  curl -sLf https://get.openziti.io/zrok/install/get.bash | bash -s -- --install-dir "$ZROK_VDIR/bin" > /tmp/zrok-install.log 2>&1
  INSTALL_EXIT=$?
  set -e
  
  if [[ $INSTALL_EXIT -ne 0 ]]; then
    echo "[tunnel] ERROR: zrok installation failed (Exit: $INSTALL_EXIT). Log:"
    cat /tmp/zrok-install.log
    echo "[tunnel] Attempting manual download as fallback (v1.1.11)..."
    
    TMP_ZROK_DIR=$(mktemp -d)
    ZROK_URL="https://github.com/openziti/zrok/releases/download/v1.1.11/zrok_1.1.11_linux_amd64.tar.gz"
    
    if curl -sLf "$ZROK_URL" -o "$TMP_ZROK_DIR/zrok.tar.gz"; then
        tar -xzf "$TMP_ZROK_DIR/zrok.tar.gz" -C "$TMP_ZROK_DIR"
        
        # Find zrok binary safely within the temp dir
        ZROK_FOUND=$(find "$TMP_ZROK_DIR" -name zrok -type f | head -n 1)
        
        if [[ -n "$ZROK_FOUND" ]]; then
            mv "$ZROK_FOUND" "$ZROK_VDIR/bin/"
            chmod +x "$ZROK_VDIR/bin/zrok"
            echo "[tunnel] Manual download success."
        else
             echo "[tunnel] Extracted but 'zrok' binary not found."
             ls -R "$TMP_ZROK_DIR"
             rm -rf "$TMP_ZROK_DIR"
             disable_managed_tunnel "zrok manual download extracted without a zrok binary."
        fi
    else
        echo "[tunnel] Download failed (curl)."
        rm -rf "$TMP_ZROK_DIR"
        disable_managed_tunnel "zrok manual download failed."
    fi
    rm -rf "$TMP_ZROK_DIR" /tmp/zrok-install.log
  fi
fi

if [[ "$MANAGED_TUNNEL_DISABLED" != "1" && ! -f "$ZROK_BIN" ]]; then
  disable_managed_tunnel "zrok binary not found at $ZROK_BIN after install."
fi

fi

if [[ "$MANAGED_TUNNEL_DISABLED" != "1" ]]; then

chmod +x "$ZROK_BIN"
echo "[tunnel] zrok version: $($ZROK_BIN version)"

echo "==> Consuming server-issued zrok credentials..."

# Read zrok token from the enrolled agent's access token
if [[ ! -f "$TOKEN_PATH" ]]; then
  disable_managed_tunnel "Agent enrollment token is unavailable. Tunnel cannot start yet."
fi

fi

if [[ "$MANAGED_TUNNEL_DISABLED" != "1" ]]; then

if ! command -v jq >/dev/null 2>&1; then
  disable_managed_tunnel "jq is not installed. Managed tunnel token parsing is disabled until jq is installed."
fi

fi

if [[ "$MANAGED_TUNNEL_DISABLED" != "1" ]]; then

ZROK_TOKEN=$(jq -r .zrokToken "$TOKEN_PATH")
SERVER_SLUG=$(jq -r '.agentSlug // empty' "$TOKEN_PATH")
AGENT_HANDLE=$(jq -r '.handle // empty' "$TOKEN_PATH")

if [[ -n "$SERVER_SLUG" ]]; then
  SLUG="$SERVER_SLUG"
elif [[ -n "$AGENT_HANDLE" ]]; then
  SLUG=$(echo "$AGENT_HANDLE" | sed 's/[^a-zA-Z0-9]/-/g' | sed 's/^-//' | sed 's/-$//' | tr '[:upper:]' '[:lower:]')
else
  SLUG=""
fi

if [[ -z "$SLUG" ]]; then
  disable_managed_tunnel "Unable to resolve tunnel slug from enrollment token."
fi

fi

if [[ "$MANAGED_TUNNEL_DISABLED" != "1" ]]; then

echo "[tunnel] Target Slug: $SLUG"

# Reservation persistence
RES_FILE="$FASED_CONFIG_DIR/${SLUG}.zrok-reservation"
RES_TOKEN=""
if [[ -f "$RES_FILE" ]]; then
   RES_TOKEN=$(cat "$RES_FILE")
   echo "[tunnel] Found cached reservation: $RES_TOKEN"
fi

# Recovery when exact slug file is missing: use the only reservation token in config dir.
if [[ -z "$RES_TOKEN" ]]; then
  mapfile -t RES_FILES < <(ls "$FASED_CONFIG_DIR"/*.zrok-reservation 2>/dev/null || true)
  if [[ ${#RES_FILES[@]} -eq 1 ]]; then
    RES_FILE="${RES_FILES[0]}"
    RES_TOKEN=$(cat "$RES_FILE")
    RECOVERED_BASENAME=$(basename "$RES_FILE")
    RECOVERED_SLUG="${RECOVERED_BASENAME%.zrok-reservation}"
    if [[ -n "$RECOVERED_SLUG" ]]; then
      SLUG="$RECOVERED_SLUG"
      echo "[tunnel] Recovered slug from cached reservation filename: $SLUG"
    fi
    echo "[tunnel] Recovered cached reservation: $RES_TOKEN"
  fi
fi

TUNNEL_STARTED=0

if [[ "$ZROK_TOKEN" == "null" || -z "$ZROK_TOKEN" ]]; then
  echo "[tunnel] WARNING: No zrok credentials found in enrollment result."
  echo "[tunnel] Attempting strict managed recovery using cached reservation + existing zrok identity..."
  export ZROK_API_ENDPOINT="${ZROK_API_ENDPOINT:-https://zrok.fased.app}"
  "$ZROK_BIN" config set apiEndpoint "$ZROK_API_ENDPOINT" 2>/dev/null || true

  HAS_ZROK_IDENTITY=0
  if "$ZROK_BIN" overview --json >/dev/null 2>&1; then
    HAS_ZROK_IDENTITY=1
  fi

  if [[ -n "$RES_TOKEN" && "$HAS_ZROK_IDENTITY" -eq 1 ]]; then
    echo "[tunnel] Recovery prerequisites satisfied (cached reservation found)."
    FINAL_URL="https://${SLUG}.agents.fased.app"
    TUNNEL_STARTED=1
  else
    echo "[tunnel] ERROR: Managed mode is strict and cannot continue without tunnel credentials."
    echo "[tunnel]        Required for recovery: existing zrok identity + cached *.zrok-reservation token."
    echo "[tunnel]        Remediation:"
    echo "[tunnel]          1) Check server logs: journalctl -u fased -n 100 --no-pager | grep 'zrok:'"
    echo "[tunnel]          2) Ensure enroll returns zrokToken/agentSlug"
    echo "[tunnel]          3) Re-enroll only after server provisioning is healthy"
    disable_managed_tunnel "No zrok credentials or cached reservation are available yet."
  fi
fi

if [[ "$MANAGED_TUNNEL_DISABLED" != "1" && "$ZROK_TOKEN" != "null" && -n "$ZROK_TOKEN" ]]; then
  echo "[tunnel] Enabling zrok environment..."
  export ZROK_API_ENDPOINT="${ZROK_API_ENDPOINT:-https://zrok.fased.app}"
  ensure_managed_clock_sync || true
  "$ZROK_BIN" config set apiEndpoint "$ZROK_API_ENDPOINT" 2>/dev/null
  
  # zrok enable (idempotent-ish, or just try)
  # Remove --force as it's not supported in v1.1+
  # We ignore error if already enabled, but capture output to be safe
  "$ZROK_BIN" enable "$ZROK_TOKEN" --description "fased-agent" 2>/dev/null || true
  
  # If no token, check if we already reserved it (recovery from lost file)
  if [[ -z "$RES_TOKEN" ]]; then
      echo "[tunnel] Checking for existing reservation..."
      OVERVIEW_JSON=$("$ZROK_BIN" overview --json 2>/dev/null || echo "{}")
      EXISTING_TOKEN=$(echo "$OVERVIEW_JSON" | jq -r --arg SLUG "$SLUG" '(.shares // [])[] | select(.frontendEndpoints[] | contains($SLUG)) | .token' 2>/dev/null | head -n 1 || true)
      
      if [[ -n "$EXISTING_TOKEN" ]]; then
          echo "[tunnel] Recovered existing token: $EXISTING_TOKEN"
          RES_TOKEN="$EXISTING_TOKEN"
          echo "$RES_TOKEN" > "$RES_FILE"
      fi
  fi

  # If still no token, try to reserve
  if [[ -z "$RES_TOKEN" ]]; then
      echo "[tunnel] Reserving public share..."
      # Use --json-output to parse output reliably; separate stderr
      PARAMS="--unique-name $SLUG --backend-mode proxy --json-output"
      
      # Capture logic: stdout to variable, stderr to temp file
      ZROK_LOG="/tmp/zrok-reserve.log"
      rm -f "$ZROK_LOG"
      
      if OUT=$("$ZROK_BIN" reserve public "http://127.0.0.1:${FASED_GATEWAY_PORT}" $PARAMS 2> "$ZROK_LOG"); then
          RES_TOKEN=$(echo "$OUT" | jq -r '.token // empty')
      else
          echo "[tunnel] Reserve failed. Log:"
          cat "$ZROK_LOG"
      fi
      
      if [[ -z "$RES_TOKEN" ]]; then
          echo "[tunnel] Reservation failed or already reserved. Output: $OUT"
          disable_managed_tunnel "Could not establish reserved tunnel for '$SLUG'."
      else
          echo "$RES_TOKEN" > "$RES_FILE"
          echo "[tunnel] Reserved: $RES_TOKEN"
      fi
  fi
  
fi

if [[ "$MANAGED_TUNNEL_DISABLED" != "1" ]]; then
  FINAL_URL="https://${SLUG}.agents.fased.app"
  TUNNEL_STARTED=1
fi

if [[ "$TUNNEL_STARTED" -eq 1 ]]; then
  if ! start_initial_zrok_share "$SLUG"; then
    echo "[tunnel] WARNING: Continuing in degraded mode without a public tunnel."
    echo "[tunnel] WARNING: The local gateway remains up and background tunnel retries will continue."
    rm -f "$FASED_CONFIG_DIR/.zrok-pid" 2>/dev/null || true
  fi
  if [[ -f "$ZROK_MONITOR_PID_FILE" ]]; then
    OLD_MONITOR_PID=$(cat "$ZROK_MONITOR_PID_FILE" 2>/dev/null || true)
    if [[ -n "$OLD_MONITOR_PID" ]] && kill -0 "$OLD_MONITOR_PID" 2>/dev/null; then
      kill "$OLD_MONITOR_PID" 2>/dev/null || true
    fi
  fi
  start_health_monitor "$SLUG" "$RES_TOKEN" &
  ZROK_MONITOR_PID=$!
  echo "$ZROK_MONITOR_PID" > "$ZROK_MONITOR_PID_FILE"
fi

fi

WALLET_JSON=""
WALLET_HEALTHY="false"
WALLET_PID="N/A"
WALLET_MODE="n/a"
WALLET_SERVICE="n/a"
WALLET_CHAINS="n/a"
WALLET_DIRECT_SIGNING="n/a"
WALLET_TOOL_SCOPE="n/a"
WALLET_KEYS_PATH="n/a"
WALLET_STARTUP_MODE="healthy"
WALLET_AUTH_STATE="unknown"
WALLET_AUTH_MODE="unknown"
WALLET_AUTH_SOURCE="unknown"
WALLET_ERROR=""

echo "==> Enforcing wallet baseline (wallet service)..."
if [[ "${WALLET_BASELINE_MODE,,}" == "skip" ]]; then
  WALLET_STARTUP_MODE="degraded"
  WALLET_ERROR="Wallet baseline skipped (FASED_WALLET_BASELINE_MODE=skip)."
  echo "[wallet] WARNING: Wallet baseline skipped; continuing startup immediately."
else
  # Keep stderr visible to avoid hidden sudo/docker prompts while also logging.
  WALLET_SETUP_CMD=(
    env
    FASED_SKIP_BUILD=1
    FASED_WALLET_SETUP_ALLOW_DEGRADED=1
    "$NODE_BIN"
    "$RUN_NODE_SCRIPT"
    wallet
    setup
    --json
  )
  USE_TIMEOUT=0
  if command -v timeout >/dev/null 2>&1; then
    if [[ "$WALLET_BASELINE_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] && [[ "$WALLET_BASELINE_TIMEOUT_SECONDS" -gt 0 ]]; then
      USE_TIMEOUT=1
    fi
  fi
  if [[ "$USE_TIMEOUT" == "1" ]]; then
    echo "[wallet] Baseline timeout: ${WALLET_BASELINE_TIMEOUT_SECONDS}s (override: FASED_WALLET_BASELINE_TIMEOUT_SECONDS, disable timeout with 0)."
    if WALLET_OUTPUT=$(timeout --signal=TERM "${WALLET_BASELINE_TIMEOUT_SECONDS}" "${WALLET_SETUP_CMD[@]}" 2> >(tee "$WALLET_SETUP_LOG" >&2)); then
      WALLET_SETUP_RC=0
    else
      WALLET_SETUP_RC=$?
    fi
  else
    if WALLET_OUTPUT=$("${WALLET_SETUP_CMD[@]}" 2> >(tee "$WALLET_SETUP_LOG" >&2)); then
      WALLET_SETUP_RC=0
    else
      WALLET_SETUP_RC=$?
    fi
  fi

  if [[ "${WALLET_SETUP_RC:-0}" == "0" ]]; then
    WALLET_JSON=$(printf '%s\n' "$WALLET_OUTPUT" | sed -n '/^{/,$p')
    if [[ -z "$WALLET_JSON" ]]; then
      WALLET_STARTUP_MODE="degraded"
      WALLET_ERROR="Wallet setup returned no JSON payload."
    else
      WALLET_HEALTHY=$(printf '%s\n' "$WALLET_JSON" | jq -r '.status.service.healthy // false' 2>/dev/null || echo "false")
      WALLET_PID=$(printf '%s\n' "$WALLET_JSON" | jq -r '.status.service.pid // "N/A"' 2>/dev/null || echo "N/A")
      WALLET_MODE=$(printf '%s\n' "$WALLET_JSON" | jq -r '.status.mode // "n/a"' 2>/dev/null || echo "n/a")
      WALLET_SERVICE=$(printf '%s\n' "$WALLET_JSON" | jq -r '.status.service.host + ":" + ((.status.service.port // 0)|tostring)' 2>/dev/null || echo "n/a")
      WALLET_CHAINS=$(printf '%s\n' "$WALLET_JSON" | jq -r '.status.chains // [] | join(",")' 2>/dev/null || echo "n/a")
      WALLET_DIRECT_SIGNING=$(printf '%s\n' "$WALLET_JSON" | jq -r '.status.policy.directSigning // "n/a"' 2>/dev/null || echo "n/a")
      WALLET_TOOL_SCOPE=$(printf '%s\n' "$WALLET_JSON" | jq -r '.status.policy.toolAccessMode // "n/a"' 2>/dev/null || echo "n/a")
      WALLET_KEYS_PATH=$(printf '%s\n' "$WALLET_JSON" | jq -r '.status.paths.keysPath // "n/a"' 2>/dev/null || echo "n/a")
      WALLET_STARTUP_MODE=$(printf '%s\n' "$WALLET_JSON" | jq -r '.status.startupState // "healthy"' 2>/dev/null || echo "healthy")
      WALLET_AUTH_STATE=$(printf '%s\n' "$WALLET_JSON" | jq -r '.status.authState // "unknown"' 2>/dev/null || echo "unknown")
      WALLET_AUTH_MODE=$(printf '%s\n' "$WALLET_JSON" | jq -r '.status.authMode // "unknown"' 2>/dev/null || echo "unknown")
      WALLET_AUTH_SOURCE=$(printf '%s\n' "$WALLET_JSON" | jq -r '.status.authSource // "unknown"' 2>/dev/null || echo "unknown")
      WALLET_ERROR=$(printf '%s\n' "$WALLET_JSON" | jq -r '.status.error // empty' 2>/dev/null || true)
      if [[ "$WALLET_HEALTHY" != "true" && "$WALLET_STARTUP_MODE" == "healthy" ]]; then
        WALLET_STARTUP_MODE="degraded"
      fi
    fi
  else
    WALLET_STARTUP_MODE="degraded"
    if [[ "${WALLET_SETUP_RC:-1}" == "124" || "${WALLET_SETUP_RC:-1}" == "143" ]]; then
      WALLET_ERROR="Wallet baseline timed out after ${WALLET_BASELINE_TIMEOUT_SECONDS}s (startup continued)."
      echo "[wallet] WARNING: Wallet baseline timed out; continuing startup in degraded mode."
    else
      WALLET_ERROR=$(tail -n 1 "$WALLET_SETUP_LOG" 2>/dev/null || echo "wallet setup failed")
      echo "[wallet] WARNING: Wallet baseline failed; continuing startup in degraded mode."
    fi
    echo "[wallet]          See: $WALLET_SETUP_LOG"
  fi

  if [[ "$WALLET_HEALTHY" != "true" ]]; then
    WALLET_STARTUP_MODE="degraded"
  fi
fi

TAILSCALE_DNS_NAME=""
TAILSCALE_ADMIN_URL="N/A"
TAILSCALE_SSH_CMD="N/A"
TAILSCALE_SERVE_READY=0
if command -v tailscale >/dev/null 2>&1; then
  if [[ "${FASED_TAILSCALE_AUTO_SERVE:-1}" == "1" ]]; then
    tailscale serve --bg "http://127.0.0.1:${FASED_GATEWAY_PORT}" >/dev/null 2>&1 || \
      tailscale serve https / "http://127.0.0.1:${FASED_GATEWAY_PORT}" >/dev/null 2>&1 || true
  fi
  if tailscale serve status 2>/dev/null | grep -q "127.0.0.1:${FASED_GATEWAY_PORT}"; then
    TAILSCALE_SERVE_READY=1
  fi
  if command -v jq >/dev/null 2>&1; then
    TAILSCALE_DNS_NAME=$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | tr -d '\n' || true)
  fi
  TAILSCALE_DNS_NAME="${TAILSCALE_DNS_NAME%.}"
  if [[ -n "$TAILSCALE_DNS_NAME" ]]; then
    TAILSCALE_SSH_CMD="tailscale ssh app@${TAILSCALE_DNS_NAME}"
    if [[ "$TAILSCALE_SERVE_READY" == "1" ]]; then
      TAILSCALE_ADMIN_URL="https://${TAILSCALE_DNS_NAME}"
    fi
  fi
fi

FED_HANDLE="N/A"
FED_TOKEN_ID="N/A"
FED_EXPIRES_AT="N/A"
FED_AGENT_SLUG="N/A"
FED_PUBLIC_URL="N/A"
FED_ZROK_TOKEN=""
if command -v jq >/dev/null 2>&1; then
  FED_HANDLE=$(jq -r '.handle // "N/A"' "$TOKEN_PATH" 2>/dev/null || echo "N/A")
  FED_TOKEN_ID=$(jq -r '.tokenId // "N/A"' "$TOKEN_PATH" 2>/dev/null || echo "N/A")
  FED_EXPIRES_AT=$(jq -r '.expiresAt // "N/A"' "$TOKEN_PATH" 2>/dev/null || echo "N/A")
  FED_AGENT_SLUG=$(jq -r '.agentSlug // "N/A"' "$TOKEN_PATH" 2>/dev/null || echo "N/A")
  FED_PUBLIC_URL=$(jq -r '.publicUrl // "N/A"' "$TOKEN_PATH" 2>/dev/null || echo "N/A")
  FED_ZROK_TOKEN=$(jq -r '.zrokToken // empty' "$TOKEN_PATH" 2>/dev/null || true)
fi
FED_ZROK_TOKEN_MASKED="N/A"
if [[ -n "$FED_ZROK_TOKEN" ]]; then
  FED_ZROK_TOKEN_MASKED=$(mask_secret "$FED_ZROK_TOKEN")
fi
RES_TOKEN_MASKED="N/A"
if [[ -n "${RES_TOKEN:-}" ]]; then
  RES_TOKEN_MASKED=$(mask_secret "$RES_TOKEN")
fi
GATEWAY_TOKEN_MASKED=$(mask_secret "$(tr -d '\n' < "$GW_TOKEN_PATH")")

echo "==> Agent Running."
echo ""
echo "================== FASED STARTUP SUMMARY =================="
echo "Gateway"
echo "  PID:                 $AGENT_PID"
echo "  Port:                $FASED_GATEWAY_PORT"
echo "  Boot log:            $GATEWAY_BOOT_LOG"
echo "Federation"
echo "  Handle:              $FED_HANDLE"
echo "  Token ID:            $FED_TOKEN_ID"
echo "  Expires At:          $FED_EXPIRES_AT"
echo "  Agent Slug:          $FED_AGENT_SLUG"
echo "  Public URL (token):  $FED_PUBLIC_URL"
echo "  zrokToken:           $FED_ZROK_TOKEN_MASKED"
echo "Federation/A2A Tunnel (zrok)"
echo "  PID:                 ${ZROK_PID:-N/A}"
echo "  Slug:                ${SLUG:-N/A}"
echo "  Reservation token:   $RES_TOKEN_MASKED"
echo "  Public URL (A2A):    $FINAL_URL"
echo "  Runtime log:         $ZROK_RUNTIME_LOG"
if [[ "$MANAGED_TUNNEL_DISABLED" == "1" ]]; then
  echo "  Startup Mode:        degraded"
  echo "  Warning:             ${TUNNEL_ERROR:-Fased Network tunnel unavailable; dashboard gateway kept online}"
fi
echo "Wallet"
  echo "  Healthy:             $WALLET_HEALTHY"
echo "  Startup Mode:        $WALLET_STARTUP_MODE"
echo "  Auth State:          $WALLET_AUTH_STATE"
echo "  Auth Mode:           $WALLET_AUTH_MODE"
echo "  Auth Source:         $WALLET_AUTH_SOURCE"
echo "  Mode:                $WALLET_MODE"
echo "  PID:                 $WALLET_PID"
echo "  Service:             $WALLET_SERVICE"
echo "  Chains:              $WALLET_CHAINS"
echo "  Direct Signing:      $WALLET_DIRECT_SIGNING"
echo "  Tool Scope:          $WALLET_TOOL_SCOPE"
echo "  Keys path:           $WALLET_KEYS_PATH"
echo "  Runtime log:         $WALLET_SETUP_LOG"
if [[ "$WALLET_STARTUP_MODE" == "degraded" ]]; then
  echo "  Warning:             wallet degraded; gateway/tunnel kept online"
  if [[ -n "$WALLET_ERROR" ]]; then
    echo "  Last Error:          $WALLET_ERROR"
  fi
fi
echo "Signer"
echo "  Startup Mode:        $SIGNERD_STARTUP_MODE"
if [[ -n "$SIGNERD_ERROR" ]]; then
  echo "  Last Error:          $SIGNERD_ERROR"
fi
echo "Admin Access (Tailscale)"
echo "  Admin URL:           $TAILSCALE_ADMIN_URL"
  if [[ "$TAILSCALE_ADMIN_URL" == "N/A" ]]; then
  if [[ -n "$TAILSCALE_DNS_NAME" ]]; then
    echo "  Status:              DNS present but tailscale serve is not active for 127.0.0.1:${FASED_GATEWAY_PORT}"
    echo "  Fix:                 tailscale serve --bg http://127.0.0.1:${FASED_GATEWAY_PORT}"
  else
    echo "  Status:              tailscale DNS unavailable; run 'tailscale up --ssh' and verify with 'tailscale status'"
  fi
else
  echo "  Status:              tailnet-only URL (not public internet)"
fi
echo "  SSH command:         $TAILSCALE_SSH_CMD"
echo "  Auth:                Gateway token/password still required by Fased UI/API"
echo "  Public login link:   disabled (no one-time public dashboard links)"
echo "Secrets"
echo "  Gateway token file:  $GW_TOKEN_PATH"
echo "  Gateway token:       $GATEWAY_TOKEN_MASKED"
echo "  Federation token:    $TOKEN_PATH"
echo "==========================================================="

echo ""
echo "Stream gateway logs: tail -f $GATEWAY_BOOT_LOG"
echo "Stream zrok logs:    tail -f $ZROK_RUNTIME_LOG"

cleanup_managed_runtime() {
  local current_zrok_pid=""
  local current_monitor_pid=""
  if [[ -f "$FASED_CONFIG_DIR/.zrok-pid" ]]; then
    current_zrok_pid="$(cat "$FASED_CONFIG_DIR/.zrok-pid" 2>/dev/null || true)"
  fi
  if [[ -f "$ZROK_MONITOR_PID_FILE" ]]; then
    current_monitor_pid="$(cat "$ZROK_MONITOR_PID_FILE" 2>/dev/null || true)"
  fi
  if [[ -n "${AGENT_PID:-}" ]] && kill -0 "$AGENT_PID" 2>/dev/null; then
    kill "$AGENT_PID" 2>/dev/null || true
  fi
  if [[ -n "$current_zrok_pid" ]] && kill -0 "$current_zrok_pid" 2>/dev/null; then
    kill "$current_zrok_pid" 2>/dev/null || true
  fi
  if [[ -n "${ZROK_PID:-}" ]] && kill -0 "$ZROK_PID" 2>/dev/null; then
    kill "$ZROK_PID" 2>/dev/null || true
  fi
  if [[ -n "$current_monitor_pid" ]] && kill -0 "$current_monitor_pid" 2>/dev/null; then
    kill "$current_monitor_pid" 2>/dev/null || true
  fi
  if [[ -n "${ZROK_MONITOR_PID:-}" ]] && kill -0 "$ZROK_MONITOR_PID" 2>/dev/null; then
    kill "$ZROK_MONITOR_PID" 2>/dev/null || true
  fi
  rm -f "$FASED_CONFIG_DIR/.zrok-pid" "$ZROK_MONITOR_PID_FILE" 2>/dev/null || true
  if [[ "${HOSTED_ROOT_SIGNER:-0}" != "1" ]]; then
    stop_existing_signerd >/dev/null 2>&1 || true
  fi
  force_stop_local_gateway
}

MANAGED_RUNTIME_SHUTTING_DOWN=0

handle_managed_runtime_signal() {
  MANAGED_RUNTIME_SHUTTING_DOWN=1
  cleanup_managed_runtime
  exit 0
}

trap cleanup_managed_runtime EXIT
trap handle_managed_runtime_signal INT TERM
if kill -0 "$AGENT_PID" 2>/dev/null; then
  wait "$AGENT_PID" || true
fi

if [[ "$MANAGED_RUNTIME_SHUTTING_DOWN" == "1" ]]; then
  exit 0
fi

echo "[gateway] supervising listener on port ${FASED_GATEWAY_PORT}."
while true; do
  if ! is_gateway_listener_ready; then
    echo "[gateway] ERROR: Gateway listener stopped on port ${FASED_GATEWAY_PORT}."
    exit 1
  fi
  sleep 5
done
