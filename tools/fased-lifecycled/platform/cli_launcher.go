package platform

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"fased-lifecycled/model"
)

const ManagedCLIProjectionPath = "/usr/local/bin/fased"

// RenderCLILauncher creates the stable owner-facing command. Runtime and
// dependency identities remain selected by root-owned current/inventory data.
// Mutating managed updates enter the separately installed static bootstrap
// before reading replaceable application-generation bytes.
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
	bootstrapStat := `read -r bootstrap_uid bootstrap_mode bootstrap_links <<<"$(/usr/bin/stat -Lc '%u %a %h' "$bootstrap")"`
	if config.IsDarwinLaunchd() {
		bootstrapStat = `read -r bootstrap_uid bootstrap_mode bootstrap_links <<<"$(/usr/bin/stat -f '%u %Lp %l' "$bootstrap")"`
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
managed_operation=""
managed_status_from_update=0
if [[ "${1:-}" == "--update" ]]; then
  managed_operation="update"
elif [[ "${1:-}" == "update" ]]; then
  if [[ "${2:-}" == "status" ]]; then
    managed_operation="status"
    managed_status_from_update=1
  elif [[ "${2:-}" != "wizard" && "${2:-}" != "--help" && "${2:-}" != "-h" ]]; then
    managed_operation="update"
  fi
elif [[ "${1:-}" == "status" ]]; then
  managed_operation="status"
elif [[ "${1:-}" == "repair" ]]; then
  managed_operation="${1}"
elif [[ "${1:-}" == "uninstall" && "${2:-}" != "--help" && "${2:-}" != "-h" ]]; then
  managed_operation="uninstall"
elif [[ "${1:-}" == "rollback" && "${2:-}" != "--help" && "${2:-}" != "-h" ]]; then
  managed_operation="rollback"
fi
if [[ -n "$managed_operation" ]]; then
  bootstrap=%q
  [[ -f "$bootstrap" && ! -L "$bootstrap" && -x "$bootstrap" ]] || {
    echo "Fased lifecycle client is unavailable; rerun the verified installer." >&2
    exit 1
  }
  %s
  [[ "$bootstrap_uid" == "0" && "$bootstrap_mode" == "555" && "$bootstrap_links" == "1" ]] || {
    echo "Fased lifecycle client is unsafe; rerun the verified installer." >&2
    exit 1
  }
  shift
  if [[ "$managed_status_from_update" == "1" ]]; then
    shift
  fi
  if [[ "$(id -u)" == "0" ]]; then
    exec "$bootstrap" "$managed_operation" --profile "$FASED_LIFECYCLE_PROFILE" "$@"
  fi
  exec /usr/bin/sudo -n "$bootstrap" "$managed_operation" --profile "$FASED_LIFECYCLE_PROFILE" "$@"
fi
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
binding_target="$(/usr/bin/readlink "$binding" 2>/dev/null || true)"
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
binding_real="$("$node_bin" -e 'const fs=require("node:fs");process.stdout.write(fs.realpathSync(process.argv[1]))' "$binding")" || {
  echo "Fased generation dependency binding is invalid." >&2
  exit 1
}
[[ -L "$binding" && "$binding_real" == "$dependency" ]] || {
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
		localLauncherEnvironment(projection), config.BootstrapHostPath(), bootstrapStat)
	return []byte(script), nil
}

// RenderManagedCLIProjection creates the root-owned conventional command that
// dispatches only to this installation's canonical owner launcher.
func RenderManagedCLIProjection(config Config) ([]byte, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	launcher := filepath.Join(config.OwnerStateRoot, "bin", "fased")
	if !filepath.IsAbs(launcher) || filepath.Clean(launcher) != launcher {
		return nil, errors.New("managed CLI projection launcher is invalid")
	}
	return []byte(fmt.Sprintf("#!/usr/bin/env bash\nset -euo pipefail\nexec %q \"$@\"\n", launcher)), nil
}

// InstallManagedCLIProjectionTransactional installs the conventional public
// command only into a root-owned, non-writable system ancestry. An existing
// projection is accepted solely when its bytes and metadata already match this
// exact configured installation, so another program's command is never
// adopted or overwritten.
func InstallManagedCLIProjectionTransactional(config Config) (*FileReplacement, error) {
	data, err := RenderManagedCLIProjection(config)
	if err != nil {
		return nil, err
	}
	return installManagedCLIProjectionTransactional(ManagedCLIProjectionPath, "/", data, 0, 0)
}

func installManagedCLIProjectionTransactional(path, ancestryRoot string, data []byte, uid, gid uint32) (*FileReplacement, error) {
	if err := validateManagedCLIProjectionAncestry(path, ancestryRoot, uid); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(path); err == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o755 ||
			stat.Uid != uid || stat.Gid != gid || stat.Nlink != 1 {
			return nil, errors.New("existing managed CLI projection is unsafe")
		}
		if info.Size() != int64(len(data)) {
			return nil, errors.New("existing managed CLI projection is unrelated")
		}
		existing, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		if !bytes.Equal(existing, data) {
			return nil, errors.New("existing managed CLI projection is unrelated")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return InstallFileTransactional(path, data, 0o755, uid, gid)
}

func validateManagedCLIProjectionAncestry(path, ancestryRoot string, expectedUID uint32) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || !filepath.IsAbs(ancestryRoot) ||
		filepath.Clean(ancestryRoot) != ancestryRoot {
		return errors.New("managed CLI projection path is invalid")
	}
	relative, err := filepath.Rel(ancestryRoot, filepath.Dir(path))
	if err != nil || relative == "." || relative == ".." || filepath.IsAbs(relative) || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errors.New("managed CLI projection ancestry is invalid")
	}
	directories := []string{ancestryRoot}
	directory := ancestryRoot
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		directory = filepath.Join(directory, component)
		directories = append(directories, directory)
	}
	for _, directory := range directories {
		info, err := os.Lstat(directory)
		if err != nil {
			return errors.Join(err, errors.New("managed CLI projection ancestry is unsafe"))
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 || stat.Uid != expectedUID {
			return errors.New("managed CLI projection ancestry is unsafe")
		}
	}
	return nil
}

func localLauncherEnvironment(projection CLIProjection) string {
	if projection.Profile != model.ProfileProtectedLocal {
		return ""
	}
	return fmt.Sprintf("export FASED_PROTECTED_LOCAL=%q\nexport FASED_PROTECTED_LOCAL_INSTANCE=%q\nexport FASED_WALLET_LOCAL_SIGNER_LIFECYCLE=%q",
		projection.Environment["FASED_PROTECTED_LOCAL"], projection.Environment["FASED_PROTECTED_LOCAL_INSTANCE"], projection.Environment["FASED_WALLET_LOCAL_SIGNER_LIFECYCLE"])
}
