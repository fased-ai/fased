package platform

import (
	"errors"
	"fmt"
	"path/filepath"

	"fased-lifecycled/model"
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
	projection, err := CanonicalCLIProjection(config)
	if err != nil {
		return nil, err
	}
	script := fmt.Sprintf(`#!/usr/bin/env bash
set -euo pipefail
install_root=%q
export FASED_RUNTIME_SOURCE=%q
export FASED_MANAGED_RUNTIME_ROOT=%q
export FASED_LIFECYCLE_PROFILE=%q
export FASED_LIFECYCLE_INSTANCE=%q
export FASED_LIFECYCLE_CONFIG=%q
export FASED_LIFECYCLE_INSTALL_ROOT=%q
export FASED_HOST_PROFILE=%q
export FASED_HOST_UPDATER_SOCKET=%q
export FASED_WALLET_LOCAL_SIGNER_BIN=%q
export FASED_WALLET_LOCAL_SIGNER_SOCKET=%q
%s
current="$install_root/current"
inventory="$current/inventory.json"
runtime="$current/payload/runtime/fased.mjs"
[[ -f "$inventory" && ! -L "$inventory" && -f "$runtime" && ! -L "$runtime" ]] || {
  echo "Fased runtime is not committed; run the verified installer or fased update." >&2
  exit 1
}
node_bin="$current/payload/bin/node"
[[ -f "$node_bin" && ! -L "$node_bin" && -x "$node_bin" ]] || {
  echo "Fased generation Node runtime is unavailable." >&2
  exit 1
}
dependency_identity="$("$node_bin" -e '
  const fs=require("node:fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const hash=value?.dependency?.hash;
  const archive=value?.dependency?.archiveSHA256;
  if(typeof hash!=="string"||!/^[a-f0-9]{64}$/.test(hash)||typeof archive!=="string"||!/^sha256:[a-f0-9]{64}$/.test(archive))process.exit(1);
  process.stdout.write(hash+" "+archive.slice(7));
' "$inventory")" || { echo "Fased dependency identity is invalid." >&2; exit 1; }
read -r dependency_hash dependency_archive_hash <<<"$dependency_identity"
binding="$current/node_modules"
binding_target="$(readlink "$binding" 2>/dev/null || true)"
case "$binding_target" in
  "../../dependencies/$dependency_hash-$dependency_archive_hash/node_modules")
    dependency="$install_root/dependencies/$dependency_hash-$dependency_archive_hash/node_modules"
    ;;
  "../../dependencies/$dependency_hash/node_modules")
    dependency="$install_root/dependencies/$dependency_hash/node_modules"
    ;;
  *)
    echo "Fased generation dependency binding is invalid." >&2
    exit 1
    ;;
esac
[[ -d "$dependency" && ! -L "$dependency" ]] || { echo "Fased dependency layer is unavailable." >&2; exit 1; }
[[ -L "$binding" && "$(readlink -f "$binding")" == "$dependency" ]] || {
  echo "Fased generation dependency binding is invalid." >&2
  exit 1
}
export NODE_PATH="$dependency"
exec "$node_bin" "$runtime" "$@"
`, config.InstallRoot,
		projection.Environment["FASED_RUNTIME_SOURCE"], projection.Environment["FASED_MANAGED_RUNTIME_ROOT"],
		projection.Environment["FASED_LIFECYCLE_PROFILE"], projection.Environment["FASED_LIFECYCLE_INSTANCE"],
		projection.Environment["FASED_LIFECYCLE_CONFIG"], projection.Environment["FASED_LIFECYCLE_INSTALL_ROOT"],
		projection.Environment["FASED_HOST_PROFILE"], projection.Environment["FASED_HOST_UPDATER_SOCKET"],
		projection.Environment["FASED_WALLET_LOCAL_SIGNER_BIN"], projection.Environment["FASED_WALLET_LOCAL_SIGNER_SOCKET"],
		localLauncherEnvironment(projection))
	return []byte(script), nil
}

func localLauncherEnvironment(projection CLIProjection) string {
	if projection.Profile != model.ProfileProtectedLocal {
		return ""
	}
	return fmt.Sprintf("export FASED_PROTECTED_LOCAL=%q\nexport FASED_PROTECTED_LOCAL_INSTANCE=%q\nexport FASED_WALLET_LOCAL_SIGNER_LIFECYCLE=%q",
		projection.Environment["FASED_PROTECTED_LOCAL"], projection.Environment["FASED_PROTECTED_LOCAL_INSTANCE"], projection.Environment["FASED_WALLET_LOCAL_SIGNER_LIFECYCLE"])
}
