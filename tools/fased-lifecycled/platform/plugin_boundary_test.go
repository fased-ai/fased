package platform

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"fased-lifecycled/model"
	"fased-lifecycled/participant"
)

type pluginLockFixtureResolver struct {
	digest  string
	payload string
}

func (resolver pluginLockFixtureResolver) PluginLockDigest(string) (string, error) {
	return resolver.digest, nil
}

func (resolver pluginLockFixtureResolver) GenerationPayloadPath(string) (string, error) {
	return resolver.payload, nil
}

func TestDiskPluginBoundaryPreparesOnlyFromGenerationBoundLock(t *testing.T) {
	operator, gateway, signer := filesystemPrincipals()
	stateRoot := filepath.Join(t.TempDir(), ".fased")
	prepareFilesystemOwnerStateRoot(t, stateRoot, operator)
	config, err := NewConfig(model.ProfileProtectedLocal, "example", stateRoot, operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	lock := participant.PluginLock{SchemaVersion: 1, Type: "fased-plugin-lock", Entries: []participant.PluginLockEntry{}}
	digest, err := participant.PluginLockDigest(lock)
	if err != nil {
		t.Fatal(err)
	}
	payload := t.TempDir()
	lockPath := filepath.Join(payload, "runtime", "plugin.lock.json")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lockPath, []byte("{\"schemaVersion\":1,\"type\":\"fased-plugin-lock\",\"entries\":[]}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	boundary := DiskPluginBoundary{
		Config: config, Resolver: pluginLockFixtureResolver{digest: digest, payload: payload}, SourceOwnerUID: uint32(os.Getuid()),
	}
	target := model.Generation{ID: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	if err := boundary.Prepare(context.Background(), target); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lockPath, []byte("{\"schemaVersion\":1,\"type\":\"fased-plugin-lock\",\"entries\":[{\"id\":\"changed\",\"origin\":\"bundled\",\"digest\":\"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"apiCapability\":\"fased.plugin.v1\",\"required\":false}]}\n"), 0o444); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(lockPath, 0o444); err != nil {
		t.Fatal(err)
	}
	if err := boundary.Prepare(context.Background(), target); err == nil {
		t.Fatal("generation plugin lock substitution was accepted")
	}
	if err := os.Chmod(lockPath, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lockPath, []byte("{\"schemaVersion\":1,\"type\":\"fased-plugin-lock\",\"entries\":[]}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(lockPath, 0o664); err != nil {
		t.Fatal(err)
	}
	if err := boundary.Prepare(context.Background(), target); err == nil {
		t.Fatal("group-writable generation plugin lock was accepted")
	}
}
