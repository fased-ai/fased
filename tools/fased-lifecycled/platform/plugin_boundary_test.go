package platform

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fased-lifecycled/model"
	"fased-lifecycled/participant"
)

type pluginLockFixtureResolver struct {
	digest  string
	payload string
}

func legacyPluginBoundaryFixture(t *testing.T) (DiskPluginBoundary, model.Transaction, string) {
	t.Helper()
	operator, gateway, signer := filesystemPrincipals()
	stateRoot := filepath.Join(t.TempDir(), ".fased")
	prepareFilesystemOwnerStateRoot(t, stateRoot, operator)
	config, err := NewConfig(model.ProfileProtectedLocal, "example", stateRoot, operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	targetLock := participant.PluginLock{SchemaVersion: 1, Type: "fased-plugin-lock", Entries: []participant.PluginLockEntry{}}
	digest, err := participant.PluginLockDigest(targetLock)
	if err != nil {
		t.Fatal(err)
	}
	payload := t.TempDir()
	if err := os.MkdirAll(filepath.Join(payload, "runtime"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(payload, "runtime", "plugin.lock.json"), []byte("{\"schemaVersion\":1,\"type\":\"fased-plugin-lock\",\"entries\":[]}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	codeRoot := filepath.Join(t.TempDir(), "plugin-code")
	if err := os.Mkdir(codeRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	legacyRoot := filepath.Join(stateRoot, "extensions")
	if err := os.Mkdir(legacyRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	boundary := DiskPluginBoundary{
		Config: config, Resolver: pluginLockFixtureResolver{digest: digest, payload: payload}, SourceOwnerUID: uint32(os.Getuid()),
		CodeRoot: codeRoot, TransactionRoot: filepath.Join(t.TempDir(), "transactions"), LegacyRoot: legacyRoot,
	}
	tx := model.Transaction{ID: "plugin-import", PlanAction: "BRIDGE_PUBLIC_STABLE", Target: model.Generation{ID: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}
	return boundary, tx, legacyRoot
}

func TestDiskPluginBoundaryImportsLegacyCodeTransactionally(t *testing.T) {
	boundary, tx, legacyRoot := legacyPluginBoundaryFixture(t)
	pluginRoot := filepath.Join(legacyRoot, "demo")
	if err := os.Mkdir(pluginRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pluginRoot, "fased.plugin.json"), []byte(`{"id":"demo","configSchema":{"type":"object"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pluginRoot, "index.js"), []byte(`export default { id: "demo", register() {} };`), 0o700); err != nil {
		t.Fatal(err)
	}
	prepared, err := boundary.Prepare(context.Background(), tx)
	if err != nil {
		t.Fatal(err)
	}
	var lock participant.PluginLock
	if err := json.Unmarshal(prepared.Data, &lock); err != nil {
		t.Fatal(err)
	}
	if len(lock.Entries) != 1 || lock.Entries[0].ID != "demo" || lock.Entries[0].Origin != "store" || !lock.Entries[0].Required {
		t.Fatalf("legacy plugin was not bound into the immutable lock: %+v", lock)
	}
	object := filepath.Join(boundary.CodeRoot, lock.Entries[0].Digest[len("sha256:"):])
	if _, err := os.Lstat(object); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("plugin code became visible before activation: %v", err)
	}
	if err := boundary.Activate(tx); err != nil {
		t.Fatal(err)
	}
	if digest, err := participant.ImmutablePluginTreeDigest(object, uint32(os.Getuid())); err != nil || digest != lock.Entries[0].Digest {
		t.Fatalf("activated plugin object is not immutable: digest=%s err=%v", digest, err)
	}
	if err := boundary.Restore(tx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(object); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rollback retained a transaction-created plugin object: %v", err)
	}
	if _, err := os.Lstat(pluginRoot); err != nil {
		t.Fatalf("legacy predecessor plugin was mutated: %v", err)
	}
	if err := boundary.Discard(tx); err != nil {
		t.Fatal(err)
	}
}

func TestDiskPluginBoundaryRejectsAmbiguousLegacyExtensionState(t *testing.T) {
	boundary, tx, legacyRoot := legacyPluginBoundaryFixture(t)
	if err := os.WriteFile(filepath.Join(legacyRoot, "state.json"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := boundary.Prepare(context.Background(), tx); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("ambiguous legacy extension state was accepted: %v", err)
	}
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
	tx := model.Transaction{Target: target}
	if _, err := boundary.Prepare(context.Background(), tx); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lockPath, []byte("{\"schemaVersion\":1,\"type\":\"fased-plugin-lock\",\"entries\":[{\"id\":\"changed\",\"origin\":\"bundled\",\"digest\":\"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"apiCapability\":\"fased.plugin.v1\",\"required\":false}]}\n"), 0o444); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(lockPath, 0o444); err != nil {
		t.Fatal(err)
	}
	if _, err := boundary.Prepare(context.Background(), tx); err == nil {
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
	if _, err := boundary.Prepare(context.Background(), tx); err == nil {
		t.Fatal("group-writable generation plugin lock was accepted")
	}
}
