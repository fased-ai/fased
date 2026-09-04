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
SHA256SUM_BIN="/usr/bin/sha256sum"
JQ_BIN="/usr/bin/jq"
TAILSCALE_BIN="/usr/bin/tailscale"
OWNER_LOCK="${FASED_SIGNER_OWNER_LOCK:-/run/lock/fased-signer-owner.lock}"
UPDATE_GATE="${FASED_SIGNER_UPDATE_GATE:-/var/lib/fased-signer-update-gate/active}"
UPDATE_JOURNAL="${FASED_SIGNER_UPDATE_JOURNAL:-/var/lib/fased-host-updater/active-signer-transaction.json}"
HOSTING_MUTATION_LOCK="${FASED_HOSTING_MUTATION_LOCK:-/run/lock/fased-bootstrap-hosting.lock}"
HOSTING_RECEIPT="${FASED_HOSTING_RECEIPT:-/etc/fased/hosting-prerequisites}"
WEBAUTHN_ENV="${FASED_SIGNER_WEBAUTHN_ENV:-/etc/fased/signerd-webauthn.env}"
OUTPUT_USER="${FASED_SIGNER_OUTPUT_USER:-root}"
OUTPUT_UID="${FASED_SIGNER_OUTPUT_UID:-0}"
OUTPUT_GID="${FASED_SIGNER_OUTPUT_GID:-0}"

usage() {
  cat >&2 <<'EOF'
usage: fased-signer-owner wallet <command> [typed fased-signerd admin flags]
       fased-signer-owner policy <get|put> [typed fased-signerd admin flags]
       fased-signer-owner webauthn-enroll [authenticator label]

Allowed commands:
  recovery-export
  recovery-import
  export-raw
  reencrypt
  rotate-successor
  rotation-status
  rotation-commit

Policy commands:
  get
  put (requires --confirm-digest sha256:<exact-policy-file-digest>)

The launcher supplies the signer control socket, runs one bounded native
administrative command as the signer owner, and exits. It never grants the
ordinary operator or Gateway persistent control-socket access.
EOF
}

ENROLLMENT=0
ADMIN_DOMAIN=""
LABEL=""
if [[ "${1:-}" == "webauthn-enroll" ]]; then
  [[ $# -le 2 ]] || {
    usage
    exit 64
  }
  ENROLLMENT=1
  LABEL="${2:-Wallet Operator}"
  [[ -n "$LABEL" && "${#LABEL}" -le 64 && "$LABEL" != *$'\n'* && "$LABEL" != *$'\r'* ]] || {
    echo "Authenticator label must be one non-empty line of at most 64 characters." >&2
    exit 64
  }
  shift "$#"
elif [[ "${1:-}" == "policy" ]]; then
  [[ $# -ge 2 ]] || {
    usage
    exit 64
  }
  ADMIN_DOMAIN="policy"
  command_name="$2"
  shift 2
  case "$command_name" in
    get|put) ;;
    *)
      usage
      exit 64
      ;;
  esac
else
  [[ $# -ge 2 && "$1" == "wallet" ]] || {
    usage
    exit 64
  }
  ADMIN_DOMAIN="wallet"
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

for executable in "$SIGNER_BIN" "$RUNUSER_BIN" "$ENV_BIN" "$STAT_BIN" "$FLOCK_BIN" "$SHA256SUM_BIN"; do
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
hosting_work_dir=""
handoff_dir=""
server_pid=""
serve_changed=0
serve_snapshot=""
cleanup() {
  local status=$?
  local restore_failed=0
  trap - EXIT INT TERM HUP
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
  if [[ "$serve_changed" == "1" && -s "$serve_snapshot" ]]; then
    if "$JQ_BIN" -e '
      (keys - ["Version", "version", "TCP", "Web", "Services"] | length) == 0 and
      ((.TCP // {}) | length) == 0 and ((.Web // {}) | length) == 0 and
      ((.Services // {}) | length) == 0
    ' "$serve_snapshot" >/dev/null; then
      "$TAILSCALE_BIN" serve reset >/dev/null 2>&1 || restore_failed=1
    else
      "$TAILSCALE_BIN" serve set-config "$serve_snapshot" --all >/dev/null 2>&1 || restore_failed=1
    fi
  fi
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -rf -- "$work_dir"
  fi
  if [[ -n "$hosting_work_dir" && -d "$hosting_work_dir" ]]; then
    rm -rf -- "$hosting_work_dir"
  fi
  if [[ -n "$handoff_dir" && -d "$handoff_dir" ]]; then
    rm -rf -- "$handoff_dir"
  fi
  if [[ "$restore_failed" == "1" ]]; then
    echo "CRITICAL: could not restore the prior private Tailscale Serve configuration." >&2
    exit 1
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM HUP

run_hosting_enrollment() {
  local rp_id=""
  local origin=""
  local status_json=""
  local serve_json=""
  local enrollment_url=""
  local public_path="/_fased/signer-enrollment"
  local listen="127.0.0.1:18791"

  for executable in "$TAILSCALE_BIN" "$JQ_BIN"; do
    [[ -f "$executable" && -x "$executable" && ! -L "$executable" ]] || {
      echo "Required root-controlled executable is missing or unsafe: $executable" >&2
      return 1
    }
    read -r owner mode links <<<"$($STAT_BIN -Lc '%u %a %h' "$executable")"
    [[ "$owner" == "0" && "$links" -ge 1 && $((8#$mode & 8#22)) -eq 0 ]] || {
      echo "Required executable is not root-owned and non-writable: $executable" >&2
      return 1
    }
  done
  for path in "$HOSTING_RECEIPT" "$WEBAUTHN_ENV"; do
    [[ -f "$path" && ! -L "$path" ]] || {
      echo "Committed Hosting identity is missing or unsafe: $path" >&2
      return 1
    }
    read -r owner mode links <<<"$($STAT_BIN -Lc '%u %a %h' "$path")"
    [[ "$owner" == "0" && "$mode" == "644" && "$links" == "1" ]] || {
      echo "Committed Hosting identity has unsafe metadata: $path" >&2
      return 1
    }
  done
  grep -Fqx 'firewallReady=true' "$HOSTING_RECEIPT" || {
    echo "Hosting hardening is not durably committed." >&2
    return 1
  }
  while IFS='=' read -r name value; do
    case "$name" in
      FASED_WALLET_WEBAUTHN_RP_ID) rp_id="$value" ;;
      FASED_WALLET_WEBAUTHN_ORIGINS) origin="$value" ;;
      "") ;;
      *) echo "Signer WebAuthn environment contains an unsupported setting." >&2; return 1 ;;
    esac
  done <"$WEBAUTHN_ENV"
  [[ "$rp_id" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "$origin" == "https://${rp_id}" ]] || {
    echo "Signer WebAuthn identity differs from its private Tailscale origin." >&2
    return 1
  }

  install -d -m 0755 -o root -g root "$(dirname "$HOSTING_MUTATION_LOCK")"
  exec 8>"$HOSTING_MUTATION_LOCK"
  chmod 0600 "$HOSTING_MUTATION_LOCK"
  "$FLOCK_BIN" -n 8 || {
    echo "A Hosting lifecycle transaction is active; retry after it completes." >&2
    return 1
  }
  [[ ! -e "$UPDATE_GATE" && ! -e "$UPDATE_JOURNAL" ]] || {
    echo "A paired signer update raced with enrollment; retry after recovery." >&2
    return 1
  }

  status_json="$($TAILSCALE_BIN status --json)"
  "$JQ_BIN" -e --arg dns "$rp_id" '
    .BackendState == "Running" and ((.Self.DNSName // "") | rtrimstr(".")) == $dns
  ' <<<"$status_json" >/dev/null || {
    echo "Tailscale is not authenticated as the committed Hosting identity." >&2
    return 1
  }
  serve_snapshot="$hosting_work_dir/tailscale-serve.json"
  "$TAILSCALE_BIN" serve get-config --all >"$serve_snapshot"
  chmod 0600 "$serve_snapshot"
  if "$JQ_BIN" -e '.. | objects | select(.AllowFunnel == true)' "$serve_snapshot" >/dev/null; then
    echo "Hosted signer enrollment refuses to run while Tailscale Funnel is active." >&2
    return 1
  fi

  coproc SIGNER_ENROLLMENT_SERVER {
    "$RUNUSER_BIN" -u "$SIGNER_USER" -- \
      "$ENV_BIN" -i \
      HOME="$SIGNER_HOME" \
      LANG="C.UTF-8" \
      PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
      "$SIGNER_BIN" admin webauthn enrollment serve \
      --control-socket "$CONTROL_SOCKET" \
      --listen "$listen" \
      --origin "$origin" \
      --base-path "${public_path}/" \
      --label "$LABEL" \
      --update-gate "$UPDATE_GATE" \
      --lock-file "$SIGNER_HOME/webauthn-enrollment.lock" \
      --timeout 5m
  }
  server_pid="$SIGNER_ENROLLMENT_SERVER_PID"
  if ! IFS= read -r enrollment_url <&"${SIGNER_ENROLLMENT_SERVER[0]}"; then
    wait "$server_pid" || true
    server_pid=""
    echo "Native signer enrollment server did not start." >&2
    return 1
  fi
  case "$enrollment_url" in
    "${origin}${public_path}/#"?*) ;;
    *) echo "Native signer returned an invalid enrollment URL." >&2; return 1 ;;
  esac

  serve_changed=1
  "$TAILSCALE_BIN" serve --yes --bg --set-path "$public_path" "http://${listen}" >/dev/null
  serve_json="$($TAILSCALE_BIN serve status --json)"
  "$JQ_BIN" -e --arg path "$public_path" --arg proxy "http://${listen}" '
    (tojson | contains($path)) and (tojson | contains($proxy)) and
    ([.. | objects | select(.AllowFunnel == true)] | length) == 0
  ' <<<"$serve_json" >/dev/null || {
    echo "Private Tailscale Serve did not acknowledge the signer enrollment route." >&2
    return 1
  }

  echo "Open this one-time URL on your own Tailscale-connected computer:"
  echo "$enrollment_url"
  echo "The URL expires in five minutes and becomes invalid after one successful enrollment."
  unset enrollment_url
  if ! wait "$server_pid"; then
    server_pid=""
    echo "Signer-owned WebAuthn enrollment did not complete." >&2
    return 1
  fi
  server_pid=""
  echo "Signer-owned WebAuthn credential enrolled successfully."
}

args=("$@")
output_path=""
input_path=""
policy_path=""
confirm_digest=""
forward_args=()
for ((index = 0; index < ${#args[@]}; index++)); do
  case "${args[$index]}" in
    --confirm-digest)
      ((index + 1 < ${#args[@]})) || {
        echo "--confirm-digest requires a value." >&2
        exit 64
      }
      confirm_digest="${args[$((index + 1))]}"
      index=$((index + 1))
      ;;
    --output)
      ((index + 1 < ${#args[@]})) || {
        echo "--output requires a path." >&2
        exit 64
      }
      output_path="${args[$((index + 1))]}"
      forward_args+=("${args[$index]}" "${args[$((index + 1))]}")
      index=$((index + 1))
      ;;
    --recovery-file)
      ((index + 1 < ${#args[@]})) || {
        echo "--recovery-file requires a path." >&2
        exit 64
      }
      input_path="${args[$((index + 1))]}"
      forward_args+=("${args[$index]}" "${args[$((index + 1))]}")
      index=$((index + 1))
      ;;
    --policy-file)
      ((index + 1 < ${#args[@]})) || {
        echo "--policy-file requires a path." >&2
        exit 64
      }
      policy_path="${args[$((index + 1))]}"
      forward_args+=("${args[$index]}" "${args[$((index + 1))]}")
      index=$((index + 1))
      ;;
    *)
      forward_args+=("${args[$index]}")
      ;;
  esac
done
args=("${forward_args[@]}")

if [[ "$ADMIN_DOMAIN" == "policy" && "$command_name" == "put" ]]; then
  [[ -n "$policy_path" ]] || {
    echo "Policy put requires --policy-file." >&2
    exit 64
  }
  [[ "$confirm_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    echo "Policy put requires an exact lowercase sha256:<hex> --confirm-digest." >&2
    exit 64
  }
elif [[ -n "$policy_path" || -n "$confirm_digest" ]]; then
  echo "Policy-file confirmation is accepted only for policy put." >&2
  exit 64
fi

if [[ "$ENROLLMENT" == "1" ]]; then
  if [[ "${FASED_SIGNER_OWNER_LOCAL:-0}" == "1" ]]; then
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
  else
    hosting_work_dir="$(mktemp -d /run/fased-signer-enrollment.XXXXXX)"
    chmod 0700 "$hosting_work_dir"
    run_hosting_enrollment
  fi
  exit 0
fi

work_dir="$(mktemp -d "$SIGNER_HOME/.owner-ceremony.XXXXXX")"
chown "$SIGNER_USER:$SIGNER_USER" "$work_dir"
chmod 0700 "$work_dir"

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

if [[ -n "$policy_path" ]]; then
  [[ "$policy_path" == /* && -f "$policy_path" && ! -L "$policy_path" ]] || {
    echo "Policy input must be an absolute non-symlink regular file." >&2
    exit 1
  }
  staged_policy="$work_dir/policy.json"
  install -m 0600 -o "$SIGNER_USER" -g "$SIGNER_USER" "$policy_path" "$staged_policy"
  read -r actual_policy_digest _ < <("$SHA256SUM_BIN" "$staged_policy")
  actual_policy_digest="sha256:$actual_policy_digest"
  [[ "$actual_policy_digest" == "$confirm_digest" ]] || {
    echo "Policy input digest does not match --confirm-digest." >&2
    exit 1
  }
  for ((index = 0; index < ${#args[@]}; index++)); do
    if [[ "${args[$index]}" == "--policy-file" ]]; then
      args[$((index + 1))]="$staged_policy"
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
  "$SIGNER_BIN" admin "$ADMIN_DOMAIN" "$command_name" \
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
