#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$(mktemp -d "${ROOT}/.generation-test.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/runtime"
printf '%s\n' "console.log('fixture');" >"$FIXTURE/runtime/fased.mjs"
printf '#!/bin/sh\nexit 0\n' >"$FIXTURE/signer"
chmod 0755 "$FIXTURE/signer"
LIFECYCLED="${FASED_TEST_LIFECYCLED:-$ROOT/dist-native/fased-lifecycled}"
if [[ ! -x "$LIFECYCLED" ]]; then
  bash "$ROOT/scripts/build-fased-lifecycled.sh"
fi

node "$ROOT/scripts/build-lifecycle-generation.mjs" \
  --runtime "$FIXTURE/runtime" \
  --signer "$FIXTURE/signer" \
  --lifecycled "$LIFECYCLED" \
  --output "$FIXTURE/generation" \
  --version 1.2.3 \
  --commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --tree bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb >"$FIXTURE/result.json"

node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const root = process.argv[1];
  const generation = JSON.parse(fs.readFileSync(path.join(root, "result.json"), "utf8"));
  const inventory = JSON.parse(fs.readFileSync(path.join(root, "generation", "inventory.json"), "utf8"));
  if (!/^sha256:[a-f0-9]{64}$/.test(generation.id)) process.exit(1);
  const expected = ["bin/fased-gateway-launch", "bin/fased-lifecycled", "bin/fased-signerd", "runtime/fased.mjs"];
  if (JSON.stringify(inventory.artifacts.map((entry) => entry.path)) !== JSON.stringify(expected)) process.exit(1);
  if (inventory.stateSchemas.managedInstall !== 2 || inventory.stateSchemas.signer !== 2) process.exit(1);
' "$FIXTURE"

ln -s fased.mjs "$FIXTURE/runtime/alias.mjs"
if node "$ROOT/scripts/build-lifecycle-generation.mjs" \
  --runtime "$FIXTURE/runtime" --signer "$FIXTURE/signer" --lifecycled "$LIFECYCLED" \
  --output "$FIXTURE/rejected" --version 1.2.3 \
  --commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --tree bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb >/dev/null 2>&1; then
  echo "generation builder accepted a symlink" >&2
  exit 1
fi
