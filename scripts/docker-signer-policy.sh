#!/usr/bin/env bash
set -euo pipefail

umask 077

usage() {
  cat <<'EOF'
Usage:
  scripts/docker-signer-policy.sh --initial-install \
    --wallet-id <canonical_signer_wallet_id> \
    --policy-file </absolute/path/to/reviewed-policy.json> \
    [--confirm-digest <sha256>]

Installs only the first explicit policy over a fresh version-1 deny-all Docker
wallet. Later policy changes must use the reviewed owner-administration flow.
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

initial_install=0
wallet_id=""
policy_file=""
confirmed_digest=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --initial-install)
      initial_install=1
      shift
      ;;
    --wallet-id)
      [[ $# -ge 2 ]] || fail "--wallet-id requires a value."
      wallet_id="$2"
      shift 2
      ;;
    --policy-file)
      [[ $# -ge 2 ]] || fail "--policy-file requires a value."
      policy_file="$2"
      shift 2
      ;;
    --confirm-digest)
      [[ $# -ge 2 ]] || fail "--confirm-digest requires a value."
      confirmed_digest="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ "$initial_install" == "1" ]] || fail "--initial-install is required."
[[ "$wallet_id" =~ ^[a-z0-9_]{1,64}$ ]] || fail "wallet ID must already be canonical lowercase letters, numbers, or underscores."
[[ "$policy_file" == /* ]] || fail "--policy-file must be an absolute path."
[[ -f "$policy_file" && ! -L "$policy_file" ]] || fail "policy must be a regular non-symlink file."

if mode="$(stat -c '%a' "$policy_file" 2>/dev/null)" && owner="$(stat -c '%u' "$policy_file" 2>/dev/null)"; then
  :
elif mode="$(stat -f '%Lp' "$policy_file" 2>/dev/null)" && owner="$(stat -f '%u' "$policy_file" 2>/dev/null)"; then
  :
else
  fail "could not inspect policy file permissions."
fi
[[ "$owner" == "$EUID" ]] || fail "policy file must be owned by the current local user."
if (( (8#$mode & 8#077) != 0 )); then
  fail "policy file must not be accessible to group or other users (run chmod 600)."
fi
if LC_ALL=C grep -q 'REPLACE_WITH_' "$policy_file"; then
  fail "policy still contains inactive REPLACE_WITH_ placeholders."
fi

if command -v sha256sum >/dev/null 2>&1; then
  digest="$(sha256sum "$policy_file" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  digest="$(shasum -a 256 "$policy_file" | awk '{print $1}')"
else
  fail "sha256sum or shasum is required."
fi
[[ "$digest" =~ ^[a-f0-9]{64}$ ]] || fail "could not calculate a canonical SHA-256 digest."

echo "Reviewed policy: $policy_file"
echo "Canonical wallet ID: $wallet_id"
echo "Policy file SHA-256: $digest"
if [[ -z "$confirmed_digest" ]]; then
  if [[ ! -r /dev/tty ]]; then
    fail "interactive confirmation requires a terminal; automation must pass --confirm-digest with the exact digest."
  fi
  printf 'Type the complete SHA-256 digest to install this initial policy: ' >/dev/tty
  IFS= read -r confirmed_digest </dev/tty
fi
[[ "$confirmed_digest" == "$digest" ]] || fail "policy digest confirmation did not match."

command -v docker >/dev/null 2>&1 || fail "Docker is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."

control_socket="/run/fased-signerd-control/control.sock"
stage_path="/tmp/fased-owner-policy-${wallet_id}-${RANDOM}.json"
stage_created=0
cleanup() {
  if [[ "$stage_created" == "1" ]]; then
    docker compose exec -T fased-signerd rm -f -- "$stage_path" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker compose exec -T fased-signerd \
  node /app/scripts/docker-signer-health.mjs /run/fased-signerd/app.sock >/dev/null

echo "Current signer policy (must be version 1 deny-all):"
docker compose exec -T fased-signerd /usr/local/bin/fased-signerd admin policy get \
  --control-socket "$control_socket" \
  --wallet-id "$wallet_id"

stage_created=1
docker compose exec -T fased-signerd sh -c \
  'umask 077; cat > "$1"; chmod 600 "$1"' sh "$stage_path" <"$policy_file"

docker compose exec -T fased-signerd /usr/local/bin/fased-signerd admin policy put \
  --control-socket "$control_socket" \
  --wallet-id "$wallet_id" \
  --expected-version 1 \
  --policy-file "$stage_path"

cleanup
stage_created=0
trap - EXIT INT TERM

echo "Signer-acknowledged installed policy:"
docker compose exec -T fased-signerd /usr/local/bin/fased-signerd admin policy get \
  --control-socket "$control_socket" \
  --wallet-id "$wallet_id"
