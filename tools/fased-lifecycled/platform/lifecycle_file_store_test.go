package platform

import (
	"os"
	"path/filepath"
	"testing"

	"fased-lifecycled/model"
)

func TestDiskLifecycleFileStoreActivatesAndRestoresExactSignerOwnerFiles(t *testing.T) {
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewDiskLifecycleFileStore(config)
	if err != nil {
		t.Fatal(err)
	}
	store.rootPrefix = t.TempDir()
	store.expectedUID = uint32(os.Getuid())
	targets := CanonicalSignerOwnerFiles(config)
	for _, target := range targets {
		resolved := store.resolve(target)
		if err := os.MkdirAll(filepath.Dir(resolved), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(resolved, []byte("old\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]LifecycleFile{
		targets[0]:                             {Data: []byte("helper\n"), Mode: 0o755, UID: uint32(os.Getuid()), GID: uint32(os.Getuid())},
		targets[1]:                             {Data: []byte("wrapper\n"), Mode: 0o755, UID: uint32(os.Getuid()), GID: uint32(os.Getuid())},
		CanonicalInstallProjectionPath(config): {Data: []byte("{}\n"), Mode: 0o640, UID: config.Operator.UID, GID: config.Operator.GID},
	}
	if err := store.Prepare("transaction", files); err != nil {
		t.Fatal(err)
	}
	allTargets := append(targets, CanonicalInstallProjectionPath(config))
	if err := store.Activate("transaction", allTargets); err != nil {
		t.Fatal(err)
	}
	for _, target := range targets {
		data, err := os.ReadFile(store.resolve(target))
		if err != nil || string(data) == "old\n" {
			t.Fatalf("lifecycle file was not activated: %s", target)
		}
	}
	projectionPath := store.resolve(CanonicalInstallProjectionPath(config))
	projection, err := os.ReadFile(projectionPath)
	if err != nil || string(projection) != "{}\n" {
		t.Fatalf("install projection was not activated: %q err=%v", projection, err)
	}
	if info, err := os.Stat(projectionPath); err != nil || info.Mode().Perm() != 0o640 {
		t.Fatalf("install projection mode changed: info=%v err=%v", info, err)
	}
	if err := store.Restore("transaction", allTargets); err != nil {
		t.Fatal(err)
	}
	for _, target := range targets {
		data, err := os.ReadFile(store.resolve(target))
		if err != nil || string(data) != "old\n" {
			t.Fatalf("lifecycle file was not restored exactly: %s", target)
		}
	}
	if _, err := os.Lstat(projectionPath); !os.IsNotExist(err) {
		t.Fatalf("absent install projection was not removed on rollback: %v", err)
	}
}

func TestDiskLifecycleFileStoreRejectsUnexpectedRootFiles(t *testing.T) {
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileHosting, "hosting", "/home/app/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewDiskLifecycleFileStore(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Prepare("transaction", map[string]LifecycleFile{"/usr/local/sbin/unrelated": {Data: []byte("bad"), Mode: 0o755}}); err == nil {
		t.Fatal("unexpected root lifecycle file was accepted")
	}
}

func TestCanonicalInstallProjectionIsDerivedFromTransaction(t *testing.T) {
	tx, _ := manifestTransaction(t, false)
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	projection, err := CanonicalInstallProjection(config, tx)
	if err != nil {
		t.Fatal(err)
	}
	if projection.Profile != model.ProfileProtectedLocal || projection.Source != "go-lifecycle" || projection.Runtime.ActiveVersion != tx.Target.Version || projection.Runtime.PreviousVersion == nil || *projection.Runtime.PreviousVersion != tx.Previous.Version {
		t.Fatalf("install projection does not match transaction: %+v", projection)
	}
	if projection.Runtime.CurrentLink != filepath.Join(config.InstallRoot, "current") || projection.Service.Name != "fased-gateway-example.service" {
		t.Fatalf("install projection does not match canonical platform: %+v", projection)
	}
}
