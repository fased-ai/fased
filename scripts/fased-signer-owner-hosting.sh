#!/usr/bin/env bash
set -euo pipefail

umask 077
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

if [[ "${EUID}" != "0" ]]; then
  echo "Signer-owner maintenance must run as root from a provider-console or root SSH session." >&2
  exit 1
fi

SIGNER_USER="${FASED_SIGNER_USER:-fased-signer}"
SIGNER_HOME="${FASED_SIGNER_HOME:-/var/lib/fased-signerd}"
SIGNER_BIN="${FASED_SIGNER_BIN:-/opt/fased/signer/fased-signerd}"
CONTROL_SOCKET="${FASED_SIGNER_CONTROL_SOCKET:-/run/fased-signerd/control.sock}"
RUNUSER_BIN="/usr/sbin/runuser"
ENV_BIN="/usr/bin/env"
STAT_BIN="/usr/bin/stat"
FLOCK_BIN="/usr/bin/flock"
OWNER_LOCK="${FASED_SIGNER_OWNER_LOCK:-/run/lock/fased-signer-owner.lock}"
UPDATE_GATE="${FASED_SIGNER_UPDATE_GATE:-/var/lib/fased-signer-update-gate/active}"
UPDATE_JOURNAL="${FASED_SIGNER_UPDATE_JOURNAL:-/var/lib/fased-host-updater/active-signer-transaction.json}"
OUTPUT_USER="${FASED_SIGNER_OUTPUT_USER:-root}"
OUTPUT_UID="${FASED_SIGNER_OUTPUT_UID:-0}"
OUTPUT_GID="${FASED_SIGNER_OUTPUT_GID:-0}"

usage() {
  cat >&2 <<'EOF'
usage: fased-signer-owner wallet <command> [typed fased-signerd admin flags]
       fased-signer-owner webauthn-enroll [authenticator label]

Allowed commands:
  recovery-export
  recovery-import
  export-raw
  reencrypt
  rotate-successor
  rotation-status
  rotation-commit

The launcher supplies the signer control socket, runs one bounded native
administrative command as the signer owner, and exits. It never grants the
ordinary operator or Gateway persistent control-socket access.
EOF
}

LOCAL_ENROLLMENT=0
LABEL=""
if [[ "${1:-}" == "webauthn-enroll" ]]; then
  [[ "${FASED_SIGNER_OWNER_LOCAL:-0}" == "1" && $# -le 2 ]] || {
    usage
    exit 64
  }
  LOCAL_ENROLLMENT=1
  LABEL="${2:-Wallet Operator}"
  [[ -n "$LABEL" && "${#LABEL}" -le 64 && "$LABEL" != *$'\n'* && "$LABEL" != *$'\r'* ]] || {
    echo "Authenticator label must be one non-empty line of at most 64 characters." >&2
    exit 64
  }
  shift "$#"
else
  [[ $# -ge 2 && "$1" == "wallet" ]] || {
    usage
    exit 64
  }
  command_name="$2"
  shift 2
  case "$command_name" in
    recovery-export|recovery-import|export-raw|reencrypt|rotate-successor|rotation-status|rotation-commit) ;;
    *)
      usage
      exit 64
      ;;
  esac
fi

for argument in "$@"; do
  case "$argument" in
    --control-socket|--control-socket=*|--operator-socket|--operator-socket=*)
      echo "Signer socket flags are fixed by the root-owned owner launcher." >&2
      exit 64
      ;;
  esac
done

for executable in "$SIGNER_BIN" "$RUNUSER_BIN" "$ENV_BIN" "$STAT_BIN" "$FLOCK_BIN"; do
  [[ -f "$executable" && -x "$executable" && ! -L "$executable" ]] || {
    echo "Required root-controlled executable is missing or unsafe: $executable" >&2
    exit 1
  }
  read -r owner mode links <<<"$($STAT_BIN -Lc '%u %a %h' "$executable")"
  [[ "$owner" == "0" && "$links" -ge 1 && $((8#$mode & 8#22)) -eq 0 ]] || {
    echo "Required executable is not root-owned and non-writable: $executable" >&2
    exit 1
  }
done

SIGNER_UID="$(id -u "$SIGNER_USER")"
[[ "$SIGNER_UID" =~ ^[0-9]+$ && "$SIGNER_UID" != "0" ]] || {
  echo "Dedicated signer owner is unavailable." >&2
  exit 1
}
[[ "$OUTPUT_UID" =~ ^[0-9]+$ && "$OUTPUT_GID" =~ ^[0-9]+$ ]] || {
  echo "Signer-owner output identity is invalid." >&2
  exit 1
}
[[ "$(id -u "$OUTPUT_USER" 2>/dev/null || true)" == "$OUTPUT_UID" &&
  "$(id -g "$OUTPUT_USER" 2>/dev/null || true)" == "$OUTPUT_GID" ]] || {
  echo "Signer-owner output account does not match its fixed UID/GID." >&2
  exit 1
}
[[ -d "$SIGNER_HOME" && ! -L "$SIGNER_HOME" ]] || {
  echo "Signer state directory is missing or unsafe." >&2
  exit 1
}
read -r state_owner state_mode <<<"$($STAT_BIN -c '%u %a' "$SIGNER_HOME")"
[[ "$state_owner" == "$SIGNER_UID" && "$state_mode" == "700" ]] || {
  echo "Signer state directory must be signer-owned mode 0700." >&2
  exit 1
}
[[ -S "$CONTROL_SOCKET" && ! -L "$CONTROL_SOCKET" ]] || {
  echo "Signer control socket is unavailable." >&2
  exit 1
}
read -r socket_owner socket_mode <<<"$($STAT_BIN -c '%u %a' "$CONTROL_SOCKET")"
[[ "$socket_owner" == "$SIGNER_UID" && "$socket_mode" == "600" ]] || {
  echo "Signer control socket ownership or mode is unsafe." >&2
  exit 1
}
[[ ! -e "$UPDATE_GATE" && ! -e "$UPDATE_JOURNAL" ]] || {
  echo "A paired signer update is active; finish it before owner maintenance." >&2
  exit 1
}

install -d -m 0755 -o root -g root "$(dirname "$OWNER_LOCK")"
exec 9>"$OWNER_LOCK"
chmod 0600 "$OWNER_LOCK"
"$FLOCK_BIN" -n 9 || {
  echo "Another signer-owner ceremony is already active." >&2
  exit 1
}

work_dir=""
handoff_dir=""
cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -rf -- "$work_dir"
  fi
  if [[ -n "$handoff_dir" && -d "$handoff_dir" ]]; then
    rm -rf -- "$handoff_dir"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM HUP

args=("$@")
output_path=""
input_path=""
for ((index = 0; index < ${#args[@]}; index++)); do
  case "${args[$index]}" in
    --output)
      ((index + 1 < ${#args[@]})) || {
        echo "--output requires a path." >&2
        exit 64
      }
      output_path="${args[$((index + 1))]}"
      ;;
    --recovery-file)
      ((index + 1 < ${#args[@]})) || {
        echo "--recovery-file requires a path." >&2
        exit 64
      }
      input_path="${args[$((index + 1))]}"
      ;;
  esac
done

work_dir="$(mktemp -d "$SIGNER_HOME/.owner-ceremony.XXXXXX")"
chown "$SIGNER_USER:$SIGNER_USER" "$work_dir"
chmod 0700 "$work_dir"

if [[ "$LOCAL_ENROLLMENT" == "1" ]]; then
  "$RUNUSER_BIN" -u "$SIGNER_USER" -- \
    "$ENV_BIN" -i \
    HOME="$SIGNER_HOME" \
    LANG="C.UTF-8" \
    PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    "$SIGNER_BIN" admin webauthn enrollment serve \
    --control-socket "$CONTROL_SOCKET" \
    --listen 127.0.0.1:18791 \
    --origin http://localhost:18791 \
    --base-path /_fased/signer-enrollment/ \
    --label "$LABEL" \
    --update-gate "$UPDATE_GATE" \
    --lock-file "$SIGNER_HOME/webauthn-enrollment.lock" \
    --timeout 5m
  exit 0
fi

if [[ -n "$input_path" ]]; then
  [[ "$input_path" == /* && -f "$input_path" && ! -L "$input_path" ]] || {
    echo "Recovery input must be an absolute non-symlink regular file." >&2
    exit 1
  }
  staged_input="$work_dir/recovery.json"
  install -m 0600 -o "$SIGNER_USER" -g "$SIGNER_USER" "$input_path" "$staged_input"
  for ((index = 0; index < ${#args[@]}; index++)); do
    if [[ "${args[$index]}" == "--recovery-file" ]]; then
      args[$((index + 1))]="$staged_input"
    fi
  done
fi

staged_output=""
if [[ -n "$output_path" ]]; then
  [[ "$output_path" == /* && ! -e "$output_path" && ! -L "$output_path" ]] || {
    echo "Output must be a new absolute path." >&2
    exit 1
  }
  [[ -d "$(dirname "$output_path")" && ! -L "$(dirname "$output_path")" ]] || {
    echo "Output parent must be an existing non-symlink directory." >&2
    exit 1
  }
  if [[ "$OUTPUT_UID" == "0" ]]; then
    read -r output_parent_owner output_parent_mode <<<"$($STAT_BIN -Lc '%u %a' "$(dirname "$output_path")")"
    [[ "$output_parent_owner" == "0" && $((8#$output_parent_mode & 8#22)) -eq 0 ]] || {
      echo "Root-owned output requires a root-owned, non-writable parent directory." >&2
      exit 1
    }
  fi
  staged_output="$work_dir/output"
  for ((index = 0; index < ${#args[@]}; index++)); do
    if [[ "${args[$index]}" == "--output" ]]; then
      args[$((index + 1))]="$staged_output"
    fi
  done
fi

"$RUNUSER_BIN" -u "$SIGNER_USER" -- \
  "$ENV_BIN" -i \
  HOME="$SIGNER_HOME" \
  LANG="C.UTF-8" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  "$SIGNER_BIN" admin wallet "$command_name" \
  --control-socket "$CONTROL_SOCKET" \
  "${args[@]}"

if [[ -n "$staged_output" ]]; then
  [[ -f "$staged_output" && ! -L "$staged_output" ]] || {
    echo "Signer-owner command did not produce its expected output." >&2
    exit 1
  }
  if [[ "$OUTPUT_UID" == "0" ]]; then
    (
      set -o noclobber
      : >"$output_path"
    ) || {
      echo "Output path appeared during the owner ceremony; refusing to overwrite it." >&2
      exit 1
    }
    chmod 0600 "$output_path"
    if ! dd if="$staged_output" of="$output_path" conv=notrunc status=none; then
      rm -f -- "$output_path"
      exit 1
    fi
  else
    handoff_dir="$(mktemp -d "${TMPDIR:-/tmp}/fased-signer-owner-output.XXXXXX")"
    install -m 0600 -o "$OUTPUT_USER" -g "$OUTPUT_GID" "$staged_output" "$handoff_dir/output"
    chown "$OUTPUT_USER:$OUTPUT_GID" "$handoff_dir"
    chmod 0700 "$handoff_dir"
    "$RUNUSER_BIN" -u "$OUTPUT_USER" -- \
      /usr/bin/install -m 0600 "$handoff_dir/output" "$output_path"
  fi
  sync -f "$output_path" "$(dirname "$output_path")" 2>/dev/null || true
  echo "Signer-owner output written: $output_path"
fi
