package platform

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fased-lifecycled/bundle"
	"fased-lifecycled/model"
	stateparticipant "fased-lifecycled/participant"
)

type schemaOnePluginLockFixtureResolver struct {
	inventory  bundle.Inventory
	generation model.Generation
	manifest   model.Manifest
	payload    string
}

func (resolver schemaOnePluginLockFixtureResolver) ReadManifest() (model.Manifest, string, error) {
	return resolver.manifest, "sha256:" + strings.Repeat("c", 64), nil
}

func (resolver schemaOnePluginLockFixtureResolver) ReadLegacySchemaOneGenerationContract(string) (bundle.Inventory, model.Generation, error) {
	return resolver.inventory, resolver.generation, nil
}

func (resolver schemaOnePluginLockFixtureResolver) GenerationPayloadPath(string) (string, error) {
	return resolver.payload, nil
}

func TestManagedPluginProductionBoundaryUsesCanonicalConfigGroup(t *testing.T) {
	uid, canonicalGID := uint32(os.Getuid()), uint32(os.Getgid())
	if uid == 0 || canonicalGID == 0 {
		t.Skip("canonical config group proof requires an unprivileged filesystem owner")
	}
	ownerRoot := filepath.Join(t.TempDir(), "owner")
	if err := os.Mkdir(ownerRoot, 0o770); err != nil {
		t.Fatal(err)
	}
	operatorGID := canonicalGID + 1
	config := Config{OwnerStateRoot: ownerRoot, Operator: Principal{UID: uid, GID: operatorGID}, Gateway: Principal{UID: uid + 1, GID: canonicalGID + 2}}
	derivedGID, err := canonicalConfigGroupGID(ownerRoot, uid)
	if err != nil {
		t.Fatal(err)
	}
	tx := ManagedPluginTransaction{CodeRoot: filepath.Join(t.TempDir(), "code"), CodeOwnerUID: uid}
	boundary := managedPluginProductionBoundary(config, tx, derivedGID)
	if boundary.ConfigGID != canonicalGID || boundary.ConfigGID == config.Operator.GID {
		t.Fatalf("plugin boundary config GID = %d, want canonical %d and not operator primary %d", boundary.ConfigGID, canonicalGID, config.Operator.GID)
	}
}

func TestRC80SchemaOneCoreTransitionImportsOnlyExactVerifiedGenerationPluginLock(t *testing.T) {
	uid, gid := uint32(os.Getuid()), uint32(os.Getgid())
	if uid == 0 || gid == 0 {
		t.Skip("schema-one plugin lock ownership proof requires an unprivileged test identity")
	}
	root := t.TempDir()
	ownerRoot := filepath.Join(root, "owner")
	lifecycleRoot := filepath.Join(root, "lifecycle")
	installRoot := filepath.Join(root, "install")
	payload := filepath.Join(root, "generation", "payload")
	for _, directory := range []string{ownerRoot, lifecycleRoot, installRoot, filepath.Join(payload, "runtime")} {
		if err := os.MkdirAll(directory, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	lock := stateparticipant.PluginLock{SchemaVersion: stateparticipant.PluginLockSchemaVersion, Type: "fased-plugin-lock"}
	lockData, err := json.Marshal(lock)
	if err != nil {
		t.Fatal(err)
	}
	lockData = append(lockData, '\n')
	digest, err := stateparticipant.PluginLockDigest(lock)
	if err != nil {
		t.Fatal(err)
	}
	generationLock := filepath.Join(payload, "runtime", "plugin.lock.json")
	if err := os.WriteFile(generationLock, lockData, 0o644); err != nil {
		t.Fatal(err)
	}
	generationID := "sha256:720f0837856f8dfa05225e61fa0fc0cdbe921523d28686f1091e7831d63dc10b"
	resolver := schemaOnePluginLockFixtureResolver{
		inventory:  bundle.Inventory{PluginLockDigest: digest},
		generation: model.Generation{ID: generationID, Version: "0.1.76-rc.80", Commit: "ceb0e98275fc00aebbbb8200207012080313e51c", Tree: "3c264f16995f04629a13c73bc1c0899221b8a195"}, // pragma: allowlist secret
		manifest:   model.Manifest{SchemaVersion: 1, ActiveGeneration: &model.Generation{ID: generationID}},
		payload:    payload,
	}
	config := Config{OwnerStateRoot: ownerRoot, LifecycleRoot: lifecycleRoot, InstallRoot: installRoot, Operator: Principal{UID: uid, GID: gid}}
	if err := prepareSchemaOneManagedPluginCoreTransition(config, generationID, gid, uid, gid, resolver); err != nil {
		t.Fatalf("exact schema-one plugin lock was not imported: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(installRoot, "plugin-code")); !os.IsNotExist(err) {
		t.Fatalf("pre-P6 bridge created code-store state outside core bootstrap: %v", err)
	}
	installed := CanonicalPluginLockPath(config)
	installedData, err := os.ReadFile(installed)
	if err != nil || string(installedData) != string(lockData) {
		t.Fatalf("installed plugin lock differs: data=%q err=%v", installedData, err)
	}
	info, err := os.Lstat(installed)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o640 {
		t.Fatalf("installed plugin lock mode = %04o, want 0640", info.Mode().Perm())
	}
	if err := prepareSchemaOneManagedPluginCoreTransition(config, generationID, gid, uid, gid, resolver); err != nil {
		t.Fatalf("schema-one plugin lock bridge retry was not idempotent: %v", err)
	}
	if err := os.WriteFile(installed, []byte("{}\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := prepareSchemaOneManagedPluginCoreTransition(config, generationID, gid, uid, gid, resolver); err == nil || !strings.Contains(err.Error(), "differs from the verified active generation") {
		t.Fatalf("changed installed schema-one plugin lock was accepted: %v", err)
	}

	if err := os.Remove(installed); err != nil {
		t.Fatal(err)
	}
	resolver.manifest.SchemaVersion = model.CurrentManifestSchemaVersion
	if err := prepareSchemaOneManagedPluginCoreTransition(config, generationID, gid, uid, gid, resolver); err == nil || !strings.Contains(err.Error(), "exact active schema-one generation") {
		t.Fatalf("missing lock in a newer durable manifest was bridged: %v", err)
	}
	if _, err := os.Lstat(installed); !os.IsNotExist(err) {
		t.Fatalf("newer-manifest refusal left an owner plugin lock: %v", err)
	}

	resolver.manifest.SchemaVersion = 1
	resolver.inventory.PluginLockDigest = "sha256:" + strings.Repeat("b", 64)
	if _, err := verifiedSchemaOneGenerationPluginLock(generationID, uid, resolver); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("inventory-mismatched schema-one plugin lock was accepted: %v", err)
	}
	if _, err := os.Lstat(installed); !os.IsNotExist(err) {
		t.Fatalf("failed bridge left an owner plugin lock: %v", err)
	}
}

func TestRC80SchemaOneCoreTransitionRejectsSubstitutedGenerationPluginLock(t *testing.T) {
	uid := uint32(os.Getuid())
	if uid == 0 {
		t.Skip("schema-one plugin lock ownership proof requires an unprivileged test identity")
	}
	root := t.TempDir()
	target := filepath.Join(root, "target.json")
	if err := os.WriteFile(target, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "plugin.lock.json")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readSchemaOneGenerationPluginLock(link, uid); err == nil || !strings.Contains(err.Error(), "unsafe") {
		t.Fatalf("substituted schema-one generation lock was accepted: %v", err)
	}
}

func TestSchemaOnePluginLockBridgeNeverReplacesAConcurrentOwnerFile(t *testing.T) {
	uid, gid := uint32(os.Getuid()), uint32(os.Getgid())
	if uid == 0 || gid == 0 {
		t.Skip("schema-one plugin lock ownership proof requires an unprivileged test identity")
	}
	path := filepath.Join(t.TempDir(), "plugin.lock.json")
	existing := []byte("operator collision\n")
	if err := os.WriteFile(path, existing, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := installSchemaOneManagedPluginLock(path, []byte("verified generation lock\n"), uid, gid); err == nil {
		t.Fatal("schema-one bridge replaced a concurrent owner file")
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != string(existing) {
		t.Fatalf("schema-one collision changed owner bytes: data=%q err=%v", after, err)
	}
}

func TestPreP6ManagedPluginBridgeRequiresAnEmptySafeTransactionNamespace(t *testing.T) {
	uid, gid := uint32(os.Getuid()), uint32(os.Getgid())
	root := filepath.Join(t.TempDir(), "plugin-transactions")
	if err := verifyEmptyPreP6ManagedPluginNamespace(root, uid, gid); err != nil {
		t.Fatalf("absent pre-P6 namespace was rejected: %v", err)
	}
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := verifyEmptyPreP6ManagedPluginNamespace(root, uid, gid); err != nil {
		t.Fatalf("empty safe pre-P6 namespace was rejected: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "unexpected"), []byte("journal\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := verifyEmptyPreP6ManagedPluginNamespace(root, uid, gid); err == nil || !strings.Contains(err.Error(), "existing plugin transaction") {
		t.Fatalf("pre-P6 namespace residue was accepted: %v", err)
	}
}
