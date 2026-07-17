#!/usr/bin/env bash
set -euo pipefail

umask 077

if [[ "${EUID}" != "0" ]]; then
  echo "Hosted signer network activation must run as root from a root SSH or provider-console session." >&2
  exit 1
fi

PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH
SIGNER_USER="fased-signer"
SIGNER_HOME="/var/lib/fased-signerd"
SIGNER_BIN="/opt/fased/signer/fased-signerd"
CONTROL_SOCKET="/run/fased-signerd/control.sock"
RUNUSER_BIN="/usr/sbin/runuser"
ENV_BIN="/usr/bin/env"
NODE_BIN="$(command -v node || true)"
STAT_BIN="/usr/bin/stat"

usage() {
  cat >&2 <<'EOF'
usage: /usr/local/sbin/fased-signer-network --wallet-id WALLET_ID --network-file /root/fased-network.json

The root-owned network file must be mode 0400 or 0600 and contain exactly:
  {"schemaVersion":1,"primaryRpcUrl":"https://...","fallbackRpcUrl":"https://..."}

fallbackRpcUrl is optional. RPC credentials stay in the root-only file and signer-owned database.
EOF
}

wallet_id=""
network_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wallet-id)
      shift
      wallet_id="${1:-}"
      ;;
    --network-file)
      shift
      network_file="${1:-}"
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage
      exit 64
      ;;
  esac
  shift
done

[[ "$wallet_id" =~ ^[a-z0-9_]{1,64}$ ]] || {
  echo "wallet ID must be the canonical native signer ID." >&2
  exit 64
}
[[ "$network_file" == /* && -f "$network_file" && ! -L "$network_file" ]] || {
  echo "network file must be one absolute, non-symlink regular file." >&2
  exit 1
}
read -r file_owner file_mode file_links <<<"$($STAT_BIN -c '%u %a %h' "$network_file")"
[[ "$file_owner" == "0" && "$file_links" == "1" && ( "$file_mode" == "400" || "$file_mode" == "600" ) ]] || {
  echo "network file must be root-owned, single-link, and mode 0400 or 0600." >&2
  exit 1
}

for executable in "$SIGNER_BIN" "$RUNUSER_BIN" "$ENV_BIN" "$NODE_BIN" "$STAT_BIN"; do
  [[ -f "$executable" && -x "$executable" && ! -L "$executable" ]] || {
    echo "Required root-controlled executable is missing or unsafe: $executable" >&2
    exit 1
  }
  read -r owner mode <<<"$($STAT_BIN -Lc '%u %a' "$executable")"
  [[ "$owner" == "0" && $((8#$mode & 8#22)) -eq 0 ]] || {
    echo "Required executable is not root-owned and non-writable: $executable" >&2
    exit 1
  }
done
[[ -S "$CONTROL_SOCKET" && ! -L "$CONTROL_SOCKET" ]] || {
  echo "Root-managed signer control socket is unavailable." >&2
  exit 1
}
SIGNER_UID="$(id -u "$SIGNER_USER")"
read -r socket_owner socket_mode <<<"$($STAT_BIN -c '%u %a' "$CONTROL_SOCKET")"
[[ "$SIGNER_UID" != "0" && "$socket_owner" == "$SIGNER_UID" && "$socket_mode" == "600" ]] || {
  echo "Signer control socket ownership or mode is unsafe." >&2
  exit 1
}

common=(
  "$RUNUSER_BIN" -u "$SIGNER_USER" --
  "$ENV_BIN" -i
  HOME="$SIGNER_HOME"
  PATH="/usr/bin:/bin:/usr/sbin:/sbin"
  LANG="C.UTF-8"
  "$SIGNER_BIN" admin network
)
current="$("${common[@]}" get --control-socket "$CONTROL_SOCKET" --wallet-id "$wallet_id")"

# Validate strict JSON and bind the update to the exact signer-owned current version. Secrets are
# transported only on stdin; they never appear in argv, environment variables, or app-owned files.
request="$($NODE_BIN - "$network_file" "$wallet_id" "$current" <<'NODE'
const fs = require("node:fs");
const [file, walletId, currentRaw] = process.argv.slice(2);
const raw = fs.readFileSync(file, "utf8");
if (!raw.trim() || Buffer.byteLength(raw) > 8192) throw new Error("network file is empty or too large");
const keyTokens = [...raw.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)].map((match) =>
  JSON.parse(match[0].slice(0, match[0].lastIndexOf(":")).trim()),
);
if (new Set(keyTokens).size !== keyTokens.length) throw new Error("network file has duplicate fields");
const value = JSON.parse(raw);
if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("network file must be an object");
const keys = Object.keys(value).sort();
const expected = value.fallbackRpcUrl === undefined
  ? ["primaryRpcUrl", "schemaVersion"]
  : ["fallbackRpcUrl", "primaryRpcUrl", "schemaVersion"];
if (keys.join(",") !== expected.join(",") || value.schemaVersion !== 1) {
  throw new Error("network file contains unsupported fields or version");
}
function rpc(name, input) {
  if (typeof input !== "string" || !input.trim() || input.length > 2048) throw new Error(`${name} is invalid`);
  const parsed = new URL(input.trim());
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${name} must be HTTPS and must not use URL userinfo`);
  }
  return parsed.toString();
}
const current = JSON.parse(currentRaw);
if (current.walletId !== walletId || !Number.isSafeInteger(current.version) || current.version < 0) {
  throw new Error("signer returned invalid current network metadata");
}
process.stdout.write(JSON.stringify({
  expectedVersion: current.version,
  primaryRpcUrl: rpc("primaryRpcUrl", value.primaryRpcUrl),
  ...(value.fallbackRpcUrl ? { fallbackRpcUrl: rpc("fallbackRpcUrl", value.fallbackRpcUrl) } : {}),
}));
NODE
)"
printf '%s\n' "$request" | "${common[@]}" put --control-socket "$CONTROL_SOCKET" --wallet-id "$wallet_id"
unset request current
