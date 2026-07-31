#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$repo_root/scripts/fased-lifecycle-root-fixture.mjs"

if [[ "$(id -u)" -eq 0 ]]; then
  exec node "$fixture"
fi

if ! command -v unshare >/dev/null 2>&1; then
  echo "The isolated root-capable lifecycle fixture requires util-linux unshare." >&2
  exit 1
fi

staging="$(mktemp -d /tmp/fased-lifecycle-root-fixture.XXXXXXXX)"
cleanup() {
  rm -rf "$staging"
}
trap cleanup EXIT INT TERM

install -m 0755 "$fixture" "$staging/fased-lifecycle-root-fixture.mjs"
install -m 0644 "$repo_root/scripts/fased-host-updater.mjs" "$staging/fased-host-updater.mjs"
install \
  -m 0644 \
  "$repo_root/scripts/fased-host-updaterctl.mjs" \
  "$staging/fased-host-updaterctl.mjs"
install \
  -m 0644 \
  "$repo_root/scripts/fased-lifecycle-supervisor.mjs" \
  "$staging/fased-lifecycle-supervisor.mjs"
mkdir "$staging/tmp"
chmod 0755 "$staging"
chmod 0777 "$staging/tmp"

unshare \
  --map-auto \
  --setuid 0 \
  --setgid 0 \
  env TMPDIR="$staging/tmp" node "$staging/fased-lifecycle-root-fixture.mjs"
