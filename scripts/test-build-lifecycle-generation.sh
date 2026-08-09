#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_ROOT="${TMPDIR:-$ROOT}"
mkdir -p "$FIXTURE_ROOT"
FIXTURE="$(mktemp -d "${FIXTURE_ROOT}/fased-generation-test.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/runtime"
printf '%s\n' "console.log('fixture');" >"$FIXTURE/runtime/fased.mjs"
mkdir -p "$FIXTURE/runtime/node_modules/tool/bin" "$FIXTURE/runtime/node_modules/.bin"
printf '#!/usr/bin/env node\n' >"$FIXTURE/runtime/node_modules/tool/bin/cli.js"
chmod 0755 "$FIXTURE/runtime/node_modules/tool/bin/cli.js"
ln -s ../tool/bin/cli.js "$FIXTURE/runtime/node_modules/.bin/tool"
printf '#!/bin/sh\nexit 0\n' >"$FIXTURE/signer"
chmod 0755 "$FIXTURE/signer"
cat >"$FIXTURE/release-manifest.json" <<'EOF'
{
  "schemaVersion": 2,
  "release": {
    "version": "1.2.3",
    "tag": "v1.2.3",
    "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
EOF
LIFECYCLED="${FASED_TEST_LIFECYCLED:-$ROOT/dist-native/fased-lifecycled}"
if [[ ! -x "$LIFECYCLED" ]]; then
  bash "$ROOT/scripts/build-fased-lifecycled.sh"
fi

node "$ROOT/scripts/build-lifecycle-generation.mjs" \
  --runtime "$FIXTURE/runtime" \
  --release-manifest "$FIXTURE/release-manifest.json" \
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
  const expected = ["bin/fased-gateway-launch", "bin/fased-lifecycled", "bin/fased-signerd", "runtime/.fased-hosted-release-v2.json", "runtime/fased.mjs", "runtime/node_modules/.bin/tool", "runtime/node_modules/tool/bin/cli.js"];
  if (JSON.stringify(inventory.artifacts.map((entry) => entry.path)) !== JSON.stringify(expected)) process.exit(1);
  const link = inventory.artifacts.find((entry) => entry.path === "runtime/node_modules/.bin/tool");
  if (link.kind !== "symlink" || link.linkTarget !== "../tool/bin/cli.js") process.exit(1);
  if (inventory.stateSchemas.managedInstall !== 2 || inventory.stateSchemas.signer !== 2) process.exit(1);
' "$FIXTURE"

printf 'outside\n' >"$FIXTURE/outside"
ln -s ../outside "$FIXTURE/runtime/escape"
if node "$ROOT/scripts/build-lifecycle-generation.mjs" \
  --runtime "$FIXTURE/runtime" --release-manifest "$FIXTURE/release-manifest.json" \
  --signer "$FIXTURE/signer" --lifecycled "$LIFECYCLED" \
  --output "$FIXTURE/rejected" --version 1.2.3 \
  --commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --tree bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb >/dev/null 2>&1; then
  echo "generation builder accepted an escaping symlink" >&2
  exit 1
fi
