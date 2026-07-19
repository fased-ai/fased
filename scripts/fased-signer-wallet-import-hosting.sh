#!/usr/bin/env bash
set -euo pipefail

umask 077
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

if [[ "${EUID}" != "0" ]]; then
  echo "Hosted signer wallet import requires the VPS provider root console." >&2
  exit 1
fi

wallet_id=""
locked_role=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wallet-id)
      [[ $# -ge 2 ]] || { echo "missing --wallet-id value" >&2; exit 64; }
      wallet_id="$2"
      shift 2
      ;;
    --locked-role)
      [[ $# -ge 2 ]] || { echo "missing --locked-role value" >&2; exit 64; }
      locked_role="$2"
      shift 2
      ;;
    *)
      echo "unsupported hosted wallet-import argument" >&2
      exit 64
      ;;
  esac
done

[[ "$wallet_id" =~ ^[a-z0-9_]{1,64}$ ]] || {
  echo "wallet id must already be normalized lowercase letters, numbers, or underscores" >&2
  exit 64
}
case "$locked_role" in
  agent|mining|vault) ;;
  *) echo "locked role must be agent, mining, or vault" >&2; exit 64 ;;
esac

signer_bin="/opt/fased/signer/fased-signerd"
control_socket="/run/fased-signerd/control.sock"
runuser_bin="/usr/sbin/runuser"
env_bin="/usr/bin/env"
stat_bin="/usr/bin/stat"
signer_user="fased-signer"

for executable in "$signer_bin" "$runuser_bin" "$env_bin" "$stat_bin"; do
  [[ -f "$executable" && -x "$executable" && ! -L "$executable" ]] || {
    echo "required hosted signer executable is missing or unsafe" >&2
    exit 1
  }
  read -r owner mode <<<"$($stat_bin -Lc '%u %a' "$executable")"
  [[ "$owner" == "0" && $((8#$mode & 8#22)) -eq 0 ]] || {
    echo "required hosted signer executable is not root-owned and non-writable" >&2
    exit 1
  }
done

[[ -S "$control_socket" && ! -L "$control_socket" ]] || {
  echo "hosted signer control socket is unavailable" >&2
  exit 1
}

# The root-console caller supplies only a new wallet id, an immutable role, and
# one keypair on stdin. The signer creates a deny-all policy and refuses
# replacement. The app/Gateway account has no sudo rule for this helper.
exec "$runuser_bin" -u "$signer_user" -- \
  "$env_bin" -i \
  HOME=/var/lib/fased-signerd \
  LANG=C.UTF-8 \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  "$signer_bin" admin wallet import \
  --control-socket "$control_socket" \
  --wallet-id "$wallet_id" \
  --locked-role "$locked_role"
