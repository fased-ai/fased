#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_fixture="$repo_root/scripts/protected-local-supervisor-client-root-fixture.mjs"

if [[ "$(id -u)" -eq 0 ]]; then
  exec node "$source_fixture"
fi

if ! command -v unshare >/dev/null 2>&1; then
  echo "The focused supervisor-client traversal fixture requires util-linux unshare." >&2
  exit 1
fi

staging="$(mktemp -d /tmp/fased-supervisor-client-traversal.XXXXXXXX)"
cleanup() {
  rm -rf "$staging"
}
trap cleanup EXIT INT TERM

mkdir -p "$staging/scripts" "$staging/tmp"
for file in \
  protected-local-supervisor-client-root-fixture.mjs \
  protected-local-bootstrap.mjs \
  fased-host-updater.mjs \
  fased-host-updaterctl.mjs \
  protected-local-layout.mjs \
  protected-local-service-plan.mjs; do
  install -m 0644 "$repo_root/scripts/$file" "$staging/scripts/$file"
done
chmod 0755 "$staging"
chmod 0777 "$staging/tmp"

unshare \
  --map-auto \
  --setuid 0 \
  --setgid 0 \
  env TMPDIR="$staging/tmp" node "$staging/scripts/protected-local-supervisor-client-root-fixture.mjs"
