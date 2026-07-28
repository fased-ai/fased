#!/usr/bin/env bash
set -euo pipefail

LAUNCHER_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
LAUNCHER_STATE_DIR="$(cd "$(dirname "$LAUNCHER_PATH")/.." && pwd)"
STATE_DIR="${FASED_STATE_DIR:-${FASED_CONFIG_DIR:-$LAUNCHER_STATE_DIR}}"
CURRENT_LINK="$STATE_DIR/runtime/current"
UPDATER="$STATE_DIR/updater/fased-managed-updater.mjs"

node_runtime_ok() {
  local candidate="$1"
  [[ -n "$candidate" && -x "$candidate" ]] || return 1
  "$candidate" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 14)) process.exit(1); require("node:sqlite");' >/dev/null 2>&1
}

resolve_node() {
  local candidate
  for candidate in \
    "${FASED_NODE:-}" \
    "${FASED_NODE_BIN:-}" \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.fnm/node-versions/*/installation/bin/node \
    "$HOME"/.volta/bin/node \
    "$HOME"/.asdf/shims/node \
    "$HOME"/.local/share/mise/shims/node \
    /usr/local/bin/node \
    /usr/bin/node \
    /opt/homebrew/bin/node; do
    [[ -n "$candidate" && -e "$candidate" ]] || continue
    if node_runtime_ok "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  if command -v node >/dev/null 2>&1 && node_runtime_ok "$(command -v node)"; then
    command -v node
    return 0
  fi
  return 1
}

NODE_BIN="$(resolve_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Fased requires Node >=22.14 with node:sqlite. Run the official installer to repair the runtime." >&2
  exit 1
fi

CONFIG_PATH="${FASED_CONFIG_PATH:-$STATE_DIR/fased.json}"
export FASED_STATE_DIR="$STATE_DIR"
export FASED_CONFIG_DIR="$STATE_DIR"
export FASED_CONFIG_PATH="$CONFIG_PATH"

# The updater is the recovery boundary for a managed installation.  Dispatch it
# before reading application-owned configuration so a stale login session can
# still update after a protected Local migration creates supplementary groups
# or after the Gateway atomically replaces fased.json.
if [[ "${1:-}" == "update" && -f "$UPDATER" ]]; then
  exec "$NODE_BIN" "$UPDATER" "$@"
fi

load_managed_profile_environment() {
  [[ -f "$CONFIG_PATH" && ! -L "$CONFIG_PATH" ]] || return 0
  local assignments=""
  assignments="$("$NODE_BIN" -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const vars = config?.env?.vars;
    if (!vars || typeof vars !== "object" || Array.isArray(vars)) process.exit(0);
    const keys = [
      "FASED_HOST_PROFILE",
      "FASED_PROTECTED_LOCAL",
      "FASED_PROTECTED_LOCAL_INSTANCE",
      "FASED_WALLET_LOCAL_SIGNER_LIFECYCLE",
      "FASED_WALLET_LOCAL_SIGNER_BIN",
      "FASED_WALLET_LOCAL_SIGNER_SOCKET",
      "FASED_HOST_UPDATER_SOCKET",
      "FASED_HOST_UPDATERCTL_STATE",
    ];
    for (const key of keys) {
      const value = vars[key];
      if (typeof value !== "string") continue;
      if (value.includes("\n") || value.includes("\r") || value.includes("\0")) process.exit(78);
      process.stdout.write(`${key}=${value}\n`);
    }
  ' "$CONFIG_PATH")" || {
    echo "Fased managed profile configuration is invalid. Run fased doctor --non-interactive." >&2
    exit 1
  }
  local assignment=""
  while IFS= read -r assignment; do
    [[ -n "$assignment" ]] || continue
    export "$assignment"
  done <<<"$assignments"
}

load_managed_profile_environment

RUNTIME_ROOT="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
if [[ -z "$RUNTIME_ROOT" || ! -f "$RUNTIME_ROOT/fased.mjs" ]]; then
  echo "Fased managed runtime is missing. Run the official Local or Hosting repair installer once." >&2
  exit 1
fi

export FASED_MANAGED_RUNTIME_ROOT="$RUNTIME_ROOT"
export FASED_RUNTIME_SOURCE="managed-package"
exec "$NODE_BIN" "$RUNTIME_ROOT/fased.mjs" "$@"
