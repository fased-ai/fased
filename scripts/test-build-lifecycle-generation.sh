#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_ROOT="${TMPDIR:-$ROOT}"
mkdir -p "$FIXTURE_ROOT"
FIXTURE="$(mktemp -d "${FIXTURE_ROOT}/fased-generation-test.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/runtime"
printf '%s\n' "console.log('fixture');" >"$FIXTURE/runtime/fased.mjs"
printf '%s\n' '{"schemaVersion":1,"type":"fased-plugin-lock","entries":[]}' >"$FIXTURE/runtime/plugin.lock.json"
PLUGIN_LOCK_DIGEST="sha256:$(printf '%s' '{"schemaVersion":1,"type":"fased-plugin-lock","entries":[]}' | sha256sum | awk '{print $1}')"
mkdir -p "$FIXTURE/runtime/node_modules/tool/bin" "$FIXTURE/runtime/node_modules/.bin"
printf '#!/usr/bin/env node\n' >"$FIXTURE/runtime/node_modules/tool/bin/cli.js"
chmod 0755 "$FIXTURE/runtime/node_modules/tool/bin/cli.js"
ln -s ../tool/bin/cli.js "$FIXTURE/runtime/node_modules/.bin/tool"
printf '#!/bin/sh\nexit 0\n' >"$FIXTURE/signer"
chmod 0755 "$FIXTURE/signer"
printf '#!/bin/sh\nexit 0\n' >"$FIXTURE/node"
chmod 0755 "$FIXTURE/node"
printf 'Node fixture license\n' >"$FIXTURE/node.LICENSE"
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
  --node "$FIXTURE/node" \
  --node-license "$FIXTURE/node.LICENSE" \
  --output "$FIXTURE/generation" \
  --version 1.2.3 \
  --commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --tree bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  --dependency-hash cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
  --dependency-asset fased-hosted-deps-linux-x64-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.tar.gz \
  --dependency-archive-sha256 sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd \
  --plugin-lock-digest "$PLUGIN_LOCK_DIGEST" \
  >"$FIXTURE/result.json"

node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const root = process.argv[1];
  const generation = JSON.parse(fs.readFileSync(path.join(root, "result.json"), "utf8"));
  const inventory = JSON.parse(fs.readFileSync(path.join(root, "generation", "inventory.json"), "utf8"));
  if (!/^sha256:[a-f0-9]{64}$/.test(generation.id)) process.exit(1);
  const expected = ["bin/fased-gateway-launch", "bin/fased-signerd", "bin/node", "licenses/node.LICENSE", "runtime/.fased-hosted-release-v2.json", "runtime/fased.mjs", "runtime/plugin.lock.json"];
  if (JSON.stringify(inventory.artifacts.map((entry) => entry.path)) !== JSON.stringify(expected)) process.exit(1);
  if (fs.existsSync(path.join(root, "generation", "payload", "runtime", "node_modules", "tool"))) process.exit(1);
  if (inventory.dependency.hash !== "c".repeat(64)) process.exit(1);
  if (inventory.dependency.archiveSHA256 !== `sha256:${"d".repeat(64)}`) process.exit(1);
  if (!inventory.dependency.asset.endsWith(".tar.gz")) process.exit(1);
  if (inventory.stateSchemas.managedInstall !== 2 || inventory.stateSchemas.signer !== 2) process.exit(1);
' "$FIXTURE"

printf 'outside\n' >"$FIXTURE/outside"
ln -s ../outside "$FIXTURE/runtime/escape"
if node "$ROOT/scripts/build-lifecycle-generation.mjs" \
  --runtime "$FIXTURE/runtime" --release-manifest "$FIXTURE/release-manifest.json" \
  --signer "$FIXTURE/signer" --lifecycled "$LIFECYCLED" \
  --node "$FIXTURE/node" --node-license "$FIXTURE/node.LICENSE" \
  --output "$FIXTURE/rejected" --version 1.2.3 \
  --commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --tree bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  --dependency-hash cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
  --dependency-asset fased-hosted-deps-linux-x64-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.tar.gz \
  --dependency-archive-sha256 sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd \
  --plugin-lock-digest "$PLUGIN_LOCK_DIGEST" \
  >/dev/null 2>&1; then
  echo "generation builder accepted an escaping symlink" >&2
  exit 1
fi
