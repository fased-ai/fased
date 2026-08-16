#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "The Go lifecycle T2 fixture requires one root execution on the current host." >&2
  echo "It creates only unique temporary groups, units, and scoped fixture roots." >&2
  exit 77
fi

source_uid="$(stat -c %u "$repo_root")"
source_gid="$(stat -c %g "$repo_root")"
if [[ "$source_uid" == 0 || "$source_gid" == 0 ]]; then
  echo "The Go lifecycle T2 source root must belong to its non-root operator." >&2
  exit 1
fi

ensure_clean_source_worktree() {
  local phase="$1"
  local status
  status="$(git -C "$repo_root" status --porcelain=v1 --untracked-files=normal)"
  if [[ -n "$status" ]]; then
    echo "Refusing root T2 $phase: source worktree is dirty." >&2
    printf '%s\n' "$status" >&2
    exit 1
  fi
}

ensure_source_identity_unchanged() {
  local current_commit
  local current_tree
  current_commit="$(git -C "$repo_root" rev-parse HEAD)"
  current_tree="$(git -C "$repo_root" rev-parse 'HEAD^{tree}')"
  if [[ "$current_commit" != "$source_commit" || "$current_tree" != "$source_tree" ]]; then
    echo "Refusing T2 PASS: source HEAD/tree changed during execution." >&2
    exit 1
  fi
  ensure_clean_source_worktree "post-receipt verification"
}

source_commit="$(git -C "$repo_root" rev-parse HEAD)"
source_tree="$(git -C "$repo_root" rev-parse 'HEAD^{tree}')"
ensure_clean_source_worktree "preflight"
instance="t2$(/usr/bin/od -An -N6 -tx1 /dev/urandom | /usr/bin/tr -d ' \n')"
worker_root="$(mktemp -d /tmp/fased-lifecycle-t2-worker.XXXXXX)"
receipt="/tmp/fased-lifecycle-t2-${instance}.json"

for group in "fscf-$instance" "fsop-$instance" "fsgw-$instance"; do
  if getent group "$group" >/dev/null; then
    echo "Refusing a colliding T2 group identity: $group" >&2
    exit 1
  fi
done
test ! -e "$receipt" || {
  echo "Refusing to replace an existing T2 receipt: $receipt" >&2
  exit 1
}

cleanup() {
  local unit
  for unit in "fased-gateway-${instance}.service" "fased-signerd-${instance}.service"; do
    /usr/bin/systemctl stop "$unit" >/dev/null 2>&1 || true
    /usr/bin/systemctl disable "$unit" >/dev/null 2>&1 || true
    rm -f -- "/etc/systemd/system/$unit"
  done
  /usr/bin/systemctl daemon-reload >/dev/null 2>&1 || true
  rm -rf -- "/opt/fased/local/$instance" "/var/lib/fased-local/$instance" "/var/lib/.fased-t2-$instance" "$worker_root"
  /usr/sbin/groupdel --force "fscf-$instance" >/dev/null 2>&1 || true
  /usr/sbin/groupdel --force "fsop-$instance" >/dev/null 2>&1 || true
  /usr/sbin/groupdel --force "fsgw-$instance" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "$worker_root/go-tmp" "$worker_root/go-cache"
GOTMPDIR="$worker_root/go-tmp" \
GOCACHE="$worker_root/go-cache" \
  go build -o "$worker_root/fased-t2-worker" \
  "$repo_root/tools/fased-lifecycled/platform/testdata/t2-worker.go"
chmod 0755 "$worker_root/fased-t2-worker"

cd "$repo_root/tools/fased-lifecycled"
FASED_T2_INSTANCE="$instance" \
FASED_T2_WORKER="$worker_root/fased-t2-worker" \
FASED_T2_RECEIPT_OUTPUT="$receipt" \
FASED_T2_SOURCE_ROOT="$repo_root" \
FASED_T2_SOURCE_COMMIT="$source_commit" \
FASED_T2_SOURCE_TREE="$source_tree" \
GOTMPDIR="$worker_root/go-tmp" \
GOCACHE="$worker_root/go-cache" \
  go test -v -count=1 -tags=systemd_t2 ./platform \
  -run '^TestLifecycleT2SystemdControllerTransition$'

test -s "$receipt"
ensure_source_identity_unchanged
jq -e --arg commit "$source_commit" --arg tree "$source_tree" \
  '.status == "PASS" and .sourceCommit == $commit and .sourceTree == $tree and
   .failureInjected == true and .exactRollback == true and .retryCommitted == true and
   .criticalBefore == .criticalAfterRollback and .criticalBefore == .criticalAfterCommit and
   .initial.generationId == .restored.generationId and .committed.generationId != .initial.generationId and
   .initial.signer.mainPid > 0 and .initial.gateway.mainPid > 0 and
   .restored.signer.mainPid > 0 and .restored.gateway.mainPid > 0 and
   .committed.signer.mainPid > 0 and .committed.gateway.mainPid > 0 and
   .initial.signer.invocationId != .restored.signer.invocationId and
   .initial.gateway.invocationId != .restored.gateway.invocationId and
   .restored.signer.invocationId != .committed.signer.invocationId and
   .restored.gateway.invocationId != .committed.gateway.invocationId and
   .initial.signer.unit != "" and .initial.gateway.unit != "" and
   .committed.signer.executable != "" and .committed.gateway.executable != "" and
   .committed.socket.path != "" and .committed.socket.mode == 432 and
   .retention.activeGenerationId == .committed.generationId and
   .retention.currentPointer == .retention.activeGenerationId and
   .retention.previousPointer == .retention.previousGenerationId and
   (.retention.removedGenerations | length == 1) and
   (.retention.removedDependencies | length == 1) and
   .retention.removedInboxObjects == 1' \
  "$receipt" >/dev/null
chown "$source_uid:$source_gid" "$receipt"
chmod 0600 "$receipt"
printf 'T2 PASS receipt: %s\n' "$receipt"
