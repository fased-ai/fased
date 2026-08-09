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
		targets[0]: {Data: []byte("helper\n"), Mode: 0o755},
		targets[1]: {Data: []byte("wrapper\n"), Mode: 0o755},
	}
	if err := store.Prepare("transaction", files); err != nil {
		t.Fatal(err)
	}
	if err := store.Activate("transaction", targets); err != nil {
		t.Fatal(err)
	}
	for _, target := range targets {
		data, err := os.ReadFile(store.resolve(target))
		if err != nil || string(data) == "old\n" {
			t.Fatalf("lifecycle file was not activated: %s", target)
		}
	}
	if err := store.Restore("transaction", targets); err != nil {
		t.Fatal(err)
	}
	for _, target := range targets {
		data, err := os.ReadFile(store.resolve(target))
		if err != nil || string(data) != "old\n" {
			t.Fatalf("lifecycle file was not restored exactly: %s", target)
		}
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
