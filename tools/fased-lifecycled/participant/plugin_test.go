package participant

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func pluginFixture(t *testing.T) (PluginBoundary, string, string) {
	t.Helper()
	root := t.TempDir()
	uid, gid := uint32(os.Getuid()), uint32(os.Getgid())
	codeRoot := filepath.Join(root, "opt", "plugin-code")
	staged := filepath.Join(root, "staged")
	dataRoot := filepath.Join(root, "state", "plugin-data")
	for _, path := range []string{codeRoot, staged, dataRoot, filepath.Join(root, "state", "cache")} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(dataRoot, os.ModeSetgid|0o770); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staged, "index.js"), []byte("export default 1;\n"), 0o444); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(staged, 0o555); err != nil {
		t.Fatal(err)
	}
	codeDigest, err := immutablePluginTreeDigest(staged, uid)
	if err != nil {
		t.Fatal(err)
	}
	installed := filepath.Join(codeRoot, strings.TrimPrefix(codeDigest, "sha256:"))
	if err := os.Chmod(staged, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(staged, installed); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(installed, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(installed, 0o755) })
	lock := PluginLock{SchemaVersion: 1, Type: "fased-plugin-lock", Entries: []PluginLockEntry{
		{ID: "demo", Origin: "store", Digest: codeDigest, APICapability: "plugin.v1", Required: true},
	}}
	lockDigest, err := PluginLockDigest(lock)
	if err != nil {
		t.Fatal(err)
	}
	lockPath := filepath.Join(root, "state", "plugin.lock.json")
	lockJSON, _ := json.Marshal(lock)
	if err := os.WriteFile(lockPath, append(lockJSON, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	ready := PluginReadiness{SchemaVersion: 1, Type: "fased-plugin-readiness", GenerationID: "sha256:" + strings.Repeat("a", 64), LockDigest: lockDigest, Entries: []PluginReadinessEntry{
		{ID: "demo", Origin: "store", Digest: codeDigest, APICapability: "plugin.v1", Required: true, Status: "loaded"},
	}}
	readyPath := filepath.Join(root, "state", "cache", "plugin-status.json")
	readyJSON, _ := json.Marshal(ready)
	if err := os.WriteFile(readyPath, append(readyJSON, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	return PluginBoundary{CodeRoot: codeRoot, DataRoot: dataRoot, LockPath: lockPath, ReadinessPath: readyPath,
		CodeOwnerUID: uid, OperatorUID: uid, GatewayUID: uid, ConfigGID: gid}, lockDigest, ready.GenerationID
}

func TestPluginBoundaryAcceptsExactImmutableLockAndMandatoryReadiness(t *testing.T) {
	boundary, lockDigest, generationID := pluginFixture(t)
	if _, err := boundary.VerifyLock(lockDigest); err != nil {
		t.Fatal(err)
	}
	if digest, err := boundary.VerifyReadiness(lockDigest, generationID); err != nil || !pluginDigestPattern.MatchString(digest) {
		t.Fatal(err)
	}
}

func TestPluginBoundaryFailsClosedOnCodeDrift(t *testing.T) {
	boundary, lockDigest, _ := pluginFixture(t)
	entries, err := os.ReadDir(boundary.CodeRoot)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(boundary.CodeRoot, entries[0].Name(), "index.js")
	if err := os.Chmod(file, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("drift\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := boundary.VerifyLock(lockDigest); err == nil || (!strings.Contains(err.Error(), "integrity drift") && !strings.Contains(err.Error(), "mutable or untrusted")) {
		t.Fatalf("code drift was not rejected: %v", err)
	}
}

func TestPluginBoundaryRejectsMutableCodeStoreRoot(t *testing.T) {
	boundary, lockDigest, _ := pluginFixture(t)
	if err := os.Chmod(boundary.CodeRoot, 0o775); err != nil {
		t.Fatal(err)
	}
	if _, err := boundary.VerifyLock(lockDigest); err == nil || !strings.Contains(err.Error(), "code root identity") {
		t.Fatalf("mutable plugin code root was accepted: %v", err)
	}
}

func TestPluginBoundaryRejectsMissingMandatoryReadiness(t *testing.T) {
	boundary, lockDigest, generationID := pluginFixture(t)
	data, err := os.ReadFile(boundary.ReadinessPath)
	if err != nil {
		t.Fatal(err)
	}
	var readiness PluginReadiness
	if err := json.Unmarshal(data, &readiness); err != nil {
		t.Fatal(err)
	}
	readiness.Entries[0].Status = "error"
	data, _ = json.Marshal(readiness)
	if err := os.WriteFile(boundary.ReadinessPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := boundary.VerifyReadiness(lockDigest, generationID); err == nil || !strings.Contains(err.Error(), "mandatory plugin") {
		t.Fatalf("mandatory readiness failure was accepted: %v", err)
	}
}

func TestPluginBoundaryRejectsMixedCodeAndDataRoots(t *testing.T) {
	boundary, lockDigest, _ := pluginFixture(t)
	boundary.DataRoot = filepath.Join(boundary.CodeRoot, "data")
	if _, err := boundary.VerifyLock(lockDigest); err == nil || !strings.Contains(err.Error(), "separate") {
		t.Fatalf("mixed plugin code/data roots were accepted: %v", err)
	}
}

func TestPluginLockRejectsDuplicateOrUnsortedEntries(t *testing.T) {
	lock := PluginLock{SchemaVersion: 1, Type: "fased-plugin-lock", Entries: []PluginLockEntry{
		{ID: "z", Origin: "bundled", Digest: "sha256:" + strings.Repeat("a", 64), APICapability: "plugin.v1", Required: true},
		{ID: "a", Origin: "bundled", Digest: "sha256:" + strings.Repeat("b", 64), APICapability: "plugin.v1", Required: true},
	}}
	data, _ := json.Marshal(lock)
	if _, err := DecodePluginLock(data); err == nil {
		t.Fatal("unsorted plugin lock was accepted")
	}
}

func TestMergeCorePluginLockRetainsOnlyPreviouslyApprovedStoreCode(t *testing.T) {
	oldStore := PluginLockEntry{ID: "demo", Origin: "store", Digest: "sha256:" + strings.Repeat("a", 64), APICapability: "plugin.v1", Required: true}
	installed := PluginLock{SchemaVersion: 1, Type: "fased-plugin-lock", Entries: []PluginLockEntry{
		{ID: "bundled-old", Origin: "bundled", Digest: "sha256:" + strings.Repeat("b", 64), APICapability: "plugin.v1", Required: true},
		oldStore,
	}}
	target := PluginLock{SchemaVersion: 1, Type: "fased-plugin-lock", Entries: []PluginLockEntry{
		{ID: "bundled-new", Origin: "bundled", Digest: "sha256:" + strings.Repeat("c", 64), APICapability: "plugin.v1", Required: true},
	}}
	merged, err := MergeCorePluginLock(target, installed)
	if err != nil {
		t.Fatal(err)
	}
	if len(merged.Entries) != 2 || merged.Entries[0].ID != "bundled-new" || merged.Entries[1] != oldStore {
		t.Fatalf("core update changed the approved store entry: %+v", merged)
	}
	target.Entries = append(target.Entries, PluginLockEntry{ID: "injected", Origin: "store", Digest: "sha256:" + strings.Repeat("d", 64), APICapability: "plugin.v1", Required: false})
	if _, err := MergeCorePluginLock(target, installed); err == nil {
		t.Fatal("core generation introduced third-party plugin code")
	}
}

func TestMergeCorePluginLockRejectsStoreShadowOfBundledIdentity(t *testing.T) {
	entry := PluginLockEntry{ID: "demo", Digest: "sha256:" + strings.Repeat("a", 64), APICapability: "plugin.v1", Required: true}
	target := PluginLock{SchemaVersion: 1, Type: "fased-plugin-lock", Entries: []PluginLockEntry{entry}}
	target.Entries[0].Origin = "bundled"
	installed := PluginLock{SchemaVersion: 1, Type: "fased-plugin-lock", Entries: []PluginLockEntry{entry}}
	installed.Entries[0].Origin = "store"
	if _, err := MergeCorePluginLock(target, installed); err == nil {
		t.Fatal("store plugin shadowed a bundled plugin identity")
	}
}
