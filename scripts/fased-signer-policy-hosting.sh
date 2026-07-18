#!/usr/bin/env bash
set -euo pipefail

umask 077

if [[ "${EUID}" != "0" ]]; then
  echo "Hosted signer policy setup must run as root from a root SSH or provider-console session." >&2
  exit 1
fi

PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH
NODE_BIN="$(command -v node || true)"
HELPER="/usr/local/libexec/fased-signer-owner-policy.mjs"
STAT_BIN="/usr/bin/stat"

case "$NODE_BIN" in
  /usr/bin/node|/usr/local/bin/node|/bin/node) ;;
  *)
    echo "A supported system Node.js executable is unavailable." >&2
    exit 1
    ;;
esac

for executable in "$NODE_BIN" "$STAT_BIN"; do
  [[ -f "$executable" && -x "$executable" ]] || {
    echo "Required root-controlled executable is missing: $executable" >&2
    exit 1
  }
  read -r owner mode <<<"$($STAT_BIN -Lc '%u %a' "$executable")"
  [[ "$owner" == "0" && $((8#$mode & 8#22)) -eq 0 ]] || {
    echo "Required executable is not root-owned and non-writable: $executable" >&2
    exit 1
  }
done

[[ -f "$HELPER" && ! -L "$HELPER" ]] || {
  echo "Installed Hosted signer policy helper is missing or unsafe: $HELPER" >&2
  exit 1
}
read -r helper_owner helper_mode helper_links <<<"$($STAT_BIN -c '%u %a %h' "$HELPER")"
[[ "$helper_owner" == "0" && "$helper_links" -eq 1 && $((8#$helper_mode & 8#22)) -eq 0 ]] || {
  echo "Hosted signer policy helper must be a single-link root-owned non-writable file." >&2
  exit 1
}
if [[ $# -eq 1 && "$1" == "--help" ]]; then
  exec "$NODE_BIN" "$HELPER" --help
fi

exec "$NODE_BIN" "$HELPER" --profile hosting "$@"
