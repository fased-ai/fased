#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$repo_root/scripts/protected-local-t2-systemd-fixture.mjs"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "The minimal T2 generated-unit fixture requires one root execution on the current host." >&2
  echo "It does not install packages, create users or containers, or touch the owner installation." >&2
  exit 77
fi

exec /usr/bin/node "$fixture"
