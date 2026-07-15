#!/usr/bin/env bash
set -euo pipefail

LAUNCHER_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
LAUNCHER_STATE_DIR="$(cd "$(dirname "$LAUNCHER_PATH")/.." && pwd)"
STATE_DIR="${FASED_STATE_DIR:-${FASED_CONFIG_DIR:-$LAUNCHER_STATE_DIR}}"
CURRENT_LINK="$STATE_DIR/runtime/current"
RUNTIME_ROOT="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"

if [[ -z "$RUNTIME_ROOT" || ! -f "$RUNTIME_ROOT/fased.mjs" ]]; then
  echo "Managed Fased runtime is unavailable: $CURRENT_LINK" >&2
  exit 1
fi

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
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    if "$candidate" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 14)) process.exit(1); require("node:sqlite");' >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(resolve_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Compatible Node runtime not found for the Fased service." >&2
  exit 1
fi

export FASED_MANAGED_RUNTIME_ROOT="$RUNTIME_ROOT"
export FASED_RUNTIME_SOURCE="managed-package"
export FASED_MANAGED_INSTALL_MANIFEST="$STATE_DIR/install.json"

mode="${1:-gateway}"
shift || true
if [[ "$mode" == "managed" ]]; then
  export FASED_NODE_BIN="$NODE_BIN"
  exec /bin/bash "$RUNTIME_ROOT/scripts/start-managed.sh" "$@"
fi
if [[ "$mode" != "gateway" ]]; then
  echo "Unknown managed Fased service mode: $mode" >&2
  exit 1
fi
exec "$NODE_BIN" "$RUNTIME_ROOT/fased.mjs" gateway "$@"
