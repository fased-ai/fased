package platform

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"fased-lifecycled/model"
)

func TestCanonicalProductProjectionPathsAreProfileBound(t *testing.T) {
	operator, gateway, signer := principals()
	local, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	hosting, err := NewConfig(model.ProfileHosting, "hosting", "/home/app/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	if CanonicalProductVersionPath(local) != "/var/lib/fased-local/example/controller/signer-version" ||
		CanonicalControllerIdentityPath(local) != "/var/lib/fased-local/example/controller/controller-version.json" ||
		CanonicalProductVersionPath(hosting) != "/var/lib/fased-host-updater/signer-version" ||
		CanonicalControllerIdentityPath(hosting) != "/var/lib/fased-host-updater/controller-version.json" {
		t.Fatal("product projection paths are not bound to their canonical profiles")
	}
}

func TestCanonicalControllerIdentityBindsActualServerAndClientBinaries(t *testing.T) {
	payload := t.TempDir()
	server := filepath.Join(payload, "bin", "fased-lifecycled")
	if err := os.MkdirAll(filepath.Dir(server), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(server, []byte("server"), 0o755); err != nil {
		t.Fatal(err)
	}
	client := filepath.Join(t.TempDir(), "fased-lifecycled")
	if err := os.WriteFile(client, []byte("client"), 0o755); err != nil {
		t.Fatal(err)
	}
	target := model.Generation{ID: digestB, Version: "0.1.76", Commit: commitB, Tree: commitB, ArtifactSetDigest: digestB}
	data, err := CanonicalControllerIdentityJSON(payload, client, target)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(data, &fields); err != nil || len(fields) != 4 || fields["schemaVersion"] != float64(1) || fields["version"] != target.Version || fields["serverSha256"] == fields["clientSha256"] {
		t.Fatalf("controller identity is not exact or role-bound: fields=%+v err=%v", fields, err)
	}
	realClient := filepath.Join(t.TempDir(), "real")
	if err := os.WriteFile(realClient, []byte("client"), 0o755); err != nil {
		t.Fatal(err)
	}
	linkedClient := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(realClient, linkedClient); err != nil {
		t.Fatal(err)
	}
	if _, err := CanonicalControllerIdentityJSON(payload, linkedClient, target); err == nil {
		t.Fatal("symlinked stable client binary was accepted")
	}
}
