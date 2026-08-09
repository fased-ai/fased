package platform

import (
	"errors"
	"fmt"
	"path/filepath"
)

// RenderCLILauncher creates the stable owner-facing command. Runtime and
// dependency identities remain selected by root-owned current/inventory data;
// the launcher never chooses a release version or mutates lifecycle state.
func RenderCLILauncher(config Config) ([]byte, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(config.InstallRoot) || filepath.Clean(config.InstallRoot) != config.InstallRoot {
		return nil, errors.New("CLI launcher install root is invalid")
	}
	script := fmt.Sprintf(`#!/usr/bin/env bash
set -euo pipefail
install_root=%q
export FASED_RUNTIME_SOURCE="go-lifecycle"
export FASED_MANAGED_RUNTIME_ROOT="$install_root/current/payload/runtime"
export FASED_LIFECYCLE_PROFILE=%q
export FASED_LIFECYCLE_INSTANCE=%q
export FASED_LIFECYCLE_CONFIG=%q
export FASED_LIFECYCLE_INSTALL_ROOT="$install_root"
current="$install_root/current"
inventory="$current/inventory.json"
runtime="$current/payload/runtime/fased.mjs"
[[ -f "$inventory" && ! -L "$inventory" && -f "$runtime" && ! -L "$runtime" ]] || {
  echo "Fased runtime is not committed; run the verified installer or fased update." >&2
  exit 1
}
node_bin=""
for candidate in "${FASED_NODE_BIN:-}" /usr/local/bin/node /usr/bin/node /usr/bin/node-24 /usr/bin/node-22; do
  [[ -n "$candidate" && -x "$candidate" ]] || continue
  if "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<14))process.exit(1);require("node:sqlite")' >/dev/null 2>&1; then
    node_bin="$candidate"
    break
  fi
done
[[ -n "$node_bin" ]] || { echo "Compatible Node runtime not found for Fased." >&2; exit 1; }
dependency_hash="$("$node_bin" -e '
  const fs=require("node:fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const hash=value?.dependency?.hash;
  if(typeof hash!=="string"||!/^[a-f0-9]{64}$/.test(hash))process.exit(1);
  process.stdout.write(hash);
' "$inventory")" || { echo "Fased dependency identity is invalid." >&2; exit 1; }
dependency="$install_root/dependencies/$dependency_hash/node_modules"
[[ -d "$dependency" && ! -L "$dependency" ]] || { echo "Fased dependency layer is unavailable." >&2; exit 1; }
export NODE_PATH="$dependency"
exec "$node_bin" "$runtime" "$@"
`, config.InstallRoot, config.Profile, config.InstanceID, filepath.Join(config.LifecycleRoot, "platform.json"))
	return []byte(script), nil
}
