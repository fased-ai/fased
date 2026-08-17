package platform

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fased-lifecycled/model"
)

func TestCLILauncherUsesOnlyCurrentGenerationAndBoundDependency(t *testing.T) {
	config, err := NewConfigWithGatewayPort(model.ProfileProtectedLocal, "0123456789abcdef", "/home/owner/.fased", 18789,
		Principal{UID: 1000, GID: 1000}, Principal{UID: 1001, GID: 1001}, Principal{UID: 1002, GID: 1002})
	if err != nil {
		t.Fatal(err)
	}
	data, err := RenderCLILauncher(config)
	if err != nil {
		t.Fatal(err)
	}
	source := string(data)
	for _, required := range []string{`install_root="` + config.InstallRoot + `"`, `FASED_RUNTIME_SOURCE="go-lifecycle"`, `FASED_MANAGED_RUNTIME_ROOT="` + filepath.Join(config.InstallRoot, "current", "payload", "runtime") + `"`, `FASED_LIFECYCLE_PROFILE="protected-local"`, `FASED_LIFECYCLE_INSTANCE="0123456789abcdef"`, `FASED_LIFECYCLE_CONFIG="` + filepath.Join(config.LifecycleRoot, "platform.json") + `"`, `FASED_LIFECYCLE_INSTALL_ROOT="` + config.InstallRoot + `"`, `FASED_WALLET_LOCAL_SIGNER_BIN="` + filepath.Join(config.InstallRoot, "current", "payload", "bin", "fased-signerd") + `"`, `FASED_PROTECTED_LOCAL="1"`, `[[ "${1:-}" == "--update" ]]`, `"${1:-}" == "status"`, `managed_status_from_update=1`, `"${1:-}" == "repair"`, `"${1:-}" == "uninstall"`, `bootstrap="/opt/fased/lifecycle/bootstrap-v1/fased-bootstrap"`, `/usr/bin/stat -Lc`, `exec /usr/bin/sudo -n "$bootstrap" "$managed_operation" --profile "$FASED_LIFECYCLE_PROFILE" "$@"`, `current="$install_root/current"`, `node_bin="$current/payload/bin/node"`, "inventory.json", "dependency?.hash", "dependency?.archiveSHA256", `binding="$current/node_modules"`, `"../../dependencies/$dependency_hash-$dependency_archive_hash/node_modules"`, `"../../dependencies/$dependency_hash/node_modules"`, `fs.realpathSync`, `exec "$node_bin" "$runtime" "$@"`} {
		if !strings.Contains(source, required) {
			t.Fatalf("launcher omitted %q", required)
		}
	}
	if !strings.Contains(source, `managed_operation="rollback"`) {
		t.Fatal("launcher omitted managed rollback routing")
	}
	updateRoute := strings.Index(source, `managed_operation=""`)
	runtimeRoute := strings.Index(source, `current="$install_root/current"`)
	if updateRoute < 0 || runtimeRoute < 0 || updateRoute >= runtimeRoute {
		t.Fatalf("stable update route does not precede the replaceable generation: update=%d runtime=%d", updateRoute, runtimeRoute)
	}
	for _, forbidden := range []string{"npm view", "curl ", "github.com", "systemctl", "FASED_NODE_BIN", "/usr/bin/node", "/usr/local/bin/node"} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("launcher contains forbidden authority %q", forbidden)
		}
	}
}

func TestManagedCLIProjectionBindsTheConfiguredOwnerLauncher(t *testing.T) {
	for _, profile := range []model.Profile{model.ProfileProtectedLocal, model.ProfileHosting} {
		config, err := NewConfigWithGatewayPort(profile, "0123456789abcdef", "/home/owner/.fased", 18789,
			Principal{UID: 1000, GID: 1000}, Principal{UID: 1001, GID: 1001}, Principal{UID: 1002, GID: 1002})
		if err != nil {
			t.Fatal(err)
		}
		data, err := RenderManagedCLIProjection(config)
		if err != nil {
			t.Fatal(err)
		}
		want := []byte("#!/usr/bin/env bash\nset -euo pipefail\nexec \"/home/owner/.fased/bin/fased\" \"$@\"\n")
		if !bytes.Equal(data, want) {
			t.Fatalf("%s projection differs:\n%s", profile, data)
		}
	}
}

func TestManagedCLIProjectionInstallationRejectsCollisionsAndRestoresExactPriorBytes(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "usr", "local", "bin", "fased")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	data := []byte("#!/usr/bin/env bash\nexec /home/owner/.fased/bin/fased \"$@\"\n")
	uid, gid := uint32(os.Getuid()), uint32(os.Getgid())
	replacement, err := installManagedCLIProjectionTransactional(path, root, data, uid, gid)
	if err != nil {
		t.Fatal(err)
	}
	if err := replacement.Rollback(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("new system CLI projection survived rollback: %v", err)
	}
	if err := os.WriteFile(path, []byte("unrelated\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := installManagedCLIProjectionTransactional(path, root, data, uid, gid); err == nil || !strings.Contains(err.Error(), "unrelated") {
		t.Fatalf("unrelated system CLI projection was accepted: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := installManagedCLIProjectionTransactional(path, root, data, uid, gid); err != nil {
		t.Fatal(err)
	}
	exact, err := installManagedCLIProjectionTransactional(path, root, data, uid, gid)
	if err != nil {
		t.Fatal(err)
	}
	if err := exact.Rollback(); err != nil {
		t.Fatal(err)
	}
	if restored, err := os.ReadFile(path); err != nil || !bytes.Equal(restored, data) {
		t.Fatalf("existing exact system CLI projection was not restored: %q err=%v", restored, err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/tmp/unrelated-fased", path); err != nil {
		t.Fatal(err)
	}
	if _, err := installManagedCLIProjectionTransactional(path, root, data, uid, gid); err == nil || !strings.Contains(err.Error(), "unsafe") {
		t.Fatalf("symlink system CLI projection was accepted: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(root, "usr", "local")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/tmp", filepath.Join(root, "usr", "local")); err != nil {
		t.Fatal(err)
	}
	if _, err := installManagedCLIProjectionTransactional(path, root, data, uid, gid); err == nil || !strings.Contains(err.Error(), "unsafe") {
		t.Fatalf("unsafe system CLI projection ancestry was accepted: %v", err)
	}
}

func TestDarwinCLILauncherUsesDarwinBootstrapAndPortableBindingProof(t *testing.T) {
	config, err := NewDarwinConfig(model.ProfileProtectedLocal, "0123456789abcdef", "/Users/owner/.fased", 18789,
		Principal{UID: 501, GID: 20}, Principal{UID: 401, GID: 401}, Principal{UID: 402, GID: 402})
	if err != nil {
		t.Fatal(err)
	}
	data, err := RenderCLILauncher(config)
	if err != nil {
		t.Fatal(err)
	}
	source := string(data)
	for _, required := range []string{`bootstrap="/Library/FasedLifecycle/bootstrap-v1/fased-bootstrap"`, `/usr/bin/stat -f '%u %Lp %l'`, `/usr/bin/readlink`, `fs.realpathSync`} {
		if !strings.Contains(source, required) {
			t.Fatalf("Darwin launcher omitted %q", required)
		}
	}
	for _, forbidden := range []string{"stat -Lc", "readlink -f", "/opt/fased/lifecycle"} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("Darwin launcher retained Linux-only assumption %q", forbidden)
		}
	}
}
