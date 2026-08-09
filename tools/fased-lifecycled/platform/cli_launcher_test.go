package platform

import (
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
	for _, required := range []string{`install_root="` + config.InstallRoot + `"`, `FASED_RUNTIME_SOURCE="go-lifecycle"`, `FASED_MANAGED_RUNTIME_ROOT="` + filepath.Join(config.InstallRoot, "current", "payload", "runtime") + `"`, `FASED_LIFECYCLE_PROFILE="protected-local"`, `FASED_LIFECYCLE_INSTANCE="0123456789abcdef"`, `FASED_LIFECYCLE_CONFIG="` + filepath.Join(config.LifecycleRoot, "platform.json") + `"`, `FASED_LIFECYCLE_INSTALL_ROOT="` + config.InstallRoot + `"`, `FASED_WALLET_LOCAL_SIGNER_BIN="` + filepath.Join(config.InstallRoot, "current", "payload", "bin", "fased-signerd") + `"`, `FASED_PROTECTED_LOCAL="1"`, `current="$install_root/current"`, "inventory.json", "dependency?.hash", "dependencies/$dependency_hash/node_modules", `exec "$node_bin" "$runtime" "$@"`} {
		if !strings.Contains(source, required) {
			t.Fatalf("launcher omitted %q", required)
		}
	}
	for _, forbidden := range []string{"npm view", "curl ", "github.com", "systemctl", "sudo "} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("launcher contains forbidden authority %q", forbidden)
		}
	}
}
