#!/usr/bin/env bash
set -euo pipefail

umask 077

if [[ "${EUID}" != "0" ]]; then
  echo "Hosted signer enrollment must run as root from a root SSH or provider-console session." >&2
  exit 1
fi
if [[ $# -gt 1 ]]; then
  echo "usage: sudo /usr/local/sbin/fased-signer-enroll [authenticator label]" >&2
  exit 64
fi

SIGNER_USER="fased-signer"
SIGNER_HOME="/var/lib/fased-signerd"
SIGNER_BIN="/opt/fased/signer/fased-signerd"
CONTROL_SOCKET="/run/fased-signerd/control.sock"
WEBAUTHN_ENV="/etc/fased/signerd-webauthn.env"
UPDATE_GATE="/var/lib/fased-signer-update-gate/active"
UPDATE_JOURNAL="/var/lib/fased-host-updater/active-signer-transaction.json"
ENROLLMENT_LOCK="/var/lib/fased-signerd/webauthn-enrollment.lock"
PROCESS_LOCK="/var/lib/fased-host-updater/signer-enrollment.lock"
UPDATER_STATE_DIR="/var/lib/fased-host-updater"
PUBLIC_PATH="/_fased/signer-enrollment"
LISTEN="127.0.0.1:18791"
LABEL="${1:-Wallet Operator}"

TAILSCALE_BIN="/usr/bin/tailscale"
RUNUSER_BIN="/usr/sbin/runuser"
ENV_BIN="/usr/bin/env"
FLOCK_BIN="/usr/bin/flock"
MKTEMP_BIN="/usr/bin/mktemp"
RM_BIN="/usr/bin/rm"
STAT_BIN="/usr/bin/stat"
GREP_BIN="/usr/bin/grep"
CHMOD_BIN="/usr/bin/chmod"
ID_BIN="/usr/bin/id"
SYSTEMCTL_BIN="/usr/bin/systemctl"

require_root_executable() {
  local path="$1"
  [[ -f "$path" && -x "$path" && ! -L "$path" ]] || {
    echo "Required root-controlled executable is missing or unsafe: $path" >&2
    exit 1
  }
  local metadata
  metadata="$($STAT_BIN -c '%u %a %h' "$path")"
  local owner mode links
  read -r owner mode links <<<"$metadata"
  [[ "$owner" == "0" && "$links" -ge 1 && $((8#$mode & 8#22)) -eq 0 ]] || {
    echo "Required executable is not root-owned and non-writable: $path" >&2
    exit 1
  }
}

for executable in \
  "$TAILSCALE_BIN" "$RUNUSER_BIN" "$ENV_BIN" "$FLOCK_BIN" \
  "$MKTEMP_BIN" "$RM_BIN" "$STAT_BIN" "$GREP_BIN"; do
  require_root_executable "$executable"
done
require_root_executable "$CHMOD_BIN"
require_root_executable "$ID_BIN"
require_root_executable "$SYSTEMCTL_BIN"
require_root_executable "$SIGNER_BIN"

SIGNER_UID="$($ID_BIN -u "$SIGNER_USER")"
[[ "$SIGNER_UID" =~ ^[0-9]+$ && "$SIGNER_UID" != "0" ]] || {
  echo "Dedicated fased-signer account is unavailable." >&2
  exit 1
}
[[ -d "$SIGNER_HOME" && ! -L "$SIGNER_HOME" ]] || {
  echo "Signer state directory is missing or unsafe: $SIGNER_HOME" >&2
  exit 1
}
read -r state_owner state_mode <<<"$($STAT_BIN -c '%u %a' "$SIGNER_HOME")"
[[ "$state_owner" == "$SIGNER_UID" && "$state_mode" == "700" ]] || {
  echo "Signer state directory must be signer-owned mode 0700." >&2
  exit 1
}
[[ -S "$CONTROL_SOCKET" && ! -L "$CONTROL_SOCKET" ]] || {
  echo "Root-managed signer control socket is unavailable: $CONTROL_SOCKET" >&2
  exit 1
}
read -r socket_owner socket_mode <<<"$($STAT_BIN -c '%u %a' "$CONTROL_SOCKET")"
[[ "$socket_owner" == "$SIGNER_UID" && "$socket_mode" == "600" ]] || {
  echo "Signer control socket ownership or mode is unsafe." >&2
  exit 1
}
[[ -f "$WEBAUTHN_ENV" && ! -L "$WEBAUTHN_ENV" ]] || {
  echo "Signer WebAuthn configuration is missing or unsafe: $WEBAUTHN_ENV" >&2
  exit 1
}
read -r env_owner env_mode env_links <<<"$($STAT_BIN -c '%u %a %h' "$WEBAUTHN_ENV")"
[[ "$env_owner" == "0" && "$env_mode" == "644" && "$env_links" -eq 1 ]] || {
  echo "Signer WebAuthn configuration must be root-owned mode 0644 with one link." >&2
  exit 1
}
[[ -d "$UPDATER_STATE_DIR" && ! -L "$UPDATER_STATE_DIR" ]] || {
  echo "Root updater state directory is missing or unsafe: $UPDATER_STATE_DIR" >&2
  exit 1
}
read -r updater_owner updater_mode <<<"$($STAT_BIN -c '%u %a' "$UPDATER_STATE_DIR")"
[[ "$updater_owner" == "0" && "$updater_mode" == "700" ]] || {
  echo "Root updater state directory must be root-owned mode 0700." >&2
  exit 1
}

RP_ID=""
ORIGIN=""
while IFS='=' read -r name value; do
  [[ -z "$name" ]] && continue
  case "$name" in
    FASED_WALLET_WEBAUTHN_RP_ID) RP_ID="$value" ;;
    FASED_WALLET_WEBAUTHN_ORIGINS) ORIGIN="$value" ;;
    *) echo "Signer WebAuthn environment contains an unsupported setting." >&2; exit 1 ;;
  esac
done <"$WEBAUTHN_ENV"
[[ "$RP_ID" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "$ORIGIN" == "https://${RP_ID}" ]] || {
  echo "Signer WebAuthn must use the exact configured Tailscale HTTPS origin." >&2
  exit 1
}
if ! "$TAILSCALE_BIN" serve get-config --help >/dev/null 2>&1 || \
   ! "$TAILSCALE_BIN" serve set-config --help >/dev/null 2>&1; then
  echo "This enrollment flow requires a current Tailscale CLI with serve get-config/set-config." >&2
  echo "Update Tailscale, then retry; the existing Gateway route was not changed." >&2
  exit 1
fi

if [[ -e "$UPDATE_GATE" || -e "$UPDATE_JOURNAL" ]]; then
  echo "A signer update is active or awaiting a durable decision; finish it before enrollment." >&2
  exit 1
fi

if [[ -e "$PROCESS_LOCK" || -L "$PROCESS_LOCK" ]]; then
  [[ -f "$PROCESS_LOCK" && ! -L "$PROCESS_LOCK" ]] || {
    echo "Hosted enrollment process lock is not a safe regular file." >&2
    exit 1
  }
  read -r process_lock_owner process_lock_mode process_lock_links <<<"$($STAT_BIN -c '%u %a %h' "$PROCESS_LOCK")"
  [[ "$process_lock_owner" == "0" && "$process_lock_links" -eq 1 && $((8#$process_lock_mode & 8#77)) -eq 0 ]] || {
    echo "Hosted enrollment process lock has unsafe ownership or permissions." >&2
    exit 1
  }
fi
exec 9>"$PROCESS_LOCK"
"$CHMOD_BIN" 0600 "$PROCESS_LOCK"
read -r process_lock_owner process_lock_mode process_lock_links <<<"$($STAT_BIN -c '%u %a %h' "$PROCESS_LOCK")"
[[ -f "$PROCESS_LOCK" && ! -L "$PROCESS_LOCK" && "$process_lock_owner" == "0" && "$process_lock_mode" == "600" && "$process_lock_links" -eq 1 ]] || {
  echo "Hosted enrollment process lock could not be secured." >&2
  exit 1
}
$FLOCK_BIN -n 9 || {
  echo "Another hosted signer enrollment session is already active." >&2
  exit 1
}

WORK_DIR=""
SNAPSHOT_PATH=""
STATUS_PATH=""
SERVER_PID=""
ROUTE_CHANGED=0
UPDATER_STOPPED=0

cleanup() {
  local status=$?
  local restore_failed=0
  trap - EXIT INT TERM HUP
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$ROUTE_CHANGED" == "1" && -f "$SNAPSHOT_PATH" ]]; then
    if ! "$TAILSCALE_BIN" serve set-config "$SNAPSHOT_PATH" --all >/dev/null; then
      echo "CRITICAL: could not restore the prior Tailscale Serve configuration." >&2
      restore_failed=1
    fi
  fi
  if [[ "$UPDATER_STOPPED" == "1" ]]; then
    if ! "$SYSTEMCTL_BIN" start fased-host-updater.service; then
      echo "CRITICAL: could not restart the root signer updater." >&2
      restore_failed=1
    fi
  fi
  if [[ -n "$WORK_DIR" ]]; then
    "$RM_BIN" -rf -- "$WORK_DIR"
  fi
  if [[ "$restore_failed" == "1" ]]; then
    exit 1
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM HUP

"$SYSTEMCTL_BIN" is-active --quiet fased-host-updater.service || {
  echo "The root signer updater must be active before enrollment can take its update lock." >&2
  exit 1
}
UPDATER_STOPPED=1
"$SYSTEMCTL_BIN" stop fased-host-updater.service
if "$SYSTEMCTL_BIN" is-active --quiet fased-host-updater.service; then
  echo "Could not quiesce the signer updater for enrollment." >&2
  exit 1
fi
if [[ -e "$UPDATE_GATE" || -e "$UPDATE_JOURNAL" ]]; then
  echo "A signer update raced with enrollment; the updater will recover before you retry." >&2
  exit 1
fi

WORK_DIR="$($MKTEMP_BIN -d /run/fased-signer-enrollment.XXXXXX)"
SNAPSHOT_PATH="${WORK_DIR}/tailscale-serve.json"
STATUS_PATH="${WORK_DIR}/tailscale-status.json"

"$TAILSCALE_BIN" status --json >"$STATUS_PATH"
if ! "$GREP_BIN" -Fq "\"DNSName\": \"${RP_ID}.\"" "$STATUS_PATH" && \
   ! "$GREP_BIN" -Fq "\"DNSName\":\"${RP_ID}.\"" "$STATUS_PATH"; then
  echo "Configured signer RP ID does not match this Tailscale node." >&2
  exit 1
fi
"$TAILSCALE_BIN" serve get-config "$SNAPSHOT_PATH" --all
"$CHMOD_BIN" 0600 "$SNAPSHOT_PATH" "$STATUS_PATH"
if "$GREP_BIN" -Fq '"AllowFunnel"' "$SNAPSHOT_PATH"; then
  echo "Hosted signer enrollment refuses to run while any Tailscale Funnel route is active." >&2
  echo "Temporarily disable Funnel on this host, enroll through tailnet-only Serve, then restore Funnel." >&2
  exit 1
fi

coproc SIGNER_ENROLLMENT_SERVER {
  "$RUNUSER_BIN" -u "$SIGNER_USER" -- \
    "$ENV_BIN" -i \
    HOME="$SIGNER_HOME" \
    PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    LANG="C.UTF-8" \
    "$SIGNER_BIN" admin webauthn enrollment serve \
    --control-socket "$CONTROL_SOCKET" \
    --listen "$LISTEN" \
    --origin "$ORIGIN" \
    --base-path "${PUBLIC_PATH}/" \
    --label "$LABEL" \
    --update-gate "$UPDATE_GATE" \
    --lock-file "$ENROLLMENT_LOCK" \
    --timeout 5m
}
SERVER_PID="$SIGNER_ENROLLMENT_SERVER_PID"
if ! IFS= read -r ENROLLMENT_URL <&"${SIGNER_ENROLLMENT_SERVER[0]}"; then
  wait "$SERVER_PID" || true
  SERVER_PID=""
  echo "Native signer enrollment server did not start." >&2
  exit 1
fi
case "$ENROLLMENT_URL" in
  "${ORIGIN}${PUBLIC_PATH}/#"?*) ;;
  *) echo "Native signer returned an invalid enrollment URL." >&2; exit 1 ;;
esac

ROUTE_CHANGED=1
"$TAILSCALE_BIN" serve --yes --bg --set-path "$PUBLIC_PATH" "http://${LISTEN}" >/dev/null
"$TAILSCALE_BIN" serve status --json >"$STATUS_PATH"
if ! "$GREP_BIN" -Fq "$PUBLIC_PATH" "$STATUS_PATH" || ! "$GREP_BIN" -Fq "$LISTEN" "$STATUS_PATH"; then
  echo "Tailscale did not acknowledge the temporary signer enrollment route." >&2
  exit 1
fi

echo "Open this one-time URL on your own Tailscale-connected computer:"
echo "$ENROLLMENT_URL"
echo "The URL expires in five minutes and becomes invalid after one successful enrollment."
unset ENROLLMENT_URL

if ! wait "$SERVER_PID"; then
  SERVER_PID=""
  echo "Signer-owned WebAuthn enrollment did not complete." >&2
  exit 1
fi
SERVER_PID=""
echo "Signer-owned WebAuthn credential enrolled successfully."
