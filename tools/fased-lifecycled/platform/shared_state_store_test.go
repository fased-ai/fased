package platform

import (
	"os"
	"path/filepath"
	"testing"

	"fased-lifecycled/model"
)

func TestSharedStateStoreActivatesAndRestoresOnlyDeclaredGatewayState(t *testing.T) {
	operator := Principal{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}
	gateway := Principal{UID: operator.UID + 1, GID: operator.GID + 1}
	signer := Principal{UID: operator.UID + 2, GID: operator.GID + 2}
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/owner/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewDiskSharedStateStore(config)
	if err != nil {
		t.Fatal(err)
	}
	store.rootPrefix = t.TempDir()
	stateRoot := store.resolve(config.OwnerStateRoot)
	cache := filepath.Join(stateRoot, "cache")
	wallet := filepath.Join(stateRoot, "wallet")
	for _, path := range []string{stateRoot, cache, wallet} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	cacheFile := filepath.Join(cache, "status.json")
	registry := filepath.Join(wallet, "provider-registry.v1.json")
	masterKey := filepath.Join(wallet, "signerd-v2.master.key")
	for _, path := range []string{cacheFile, registry, masterKey} {
		if err := os.WriteFile(path, []byte("state\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Prepare("transaction"); err != nil {
		t.Fatal(err)
	}
	if err := store.Activate("transaction"); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{cache, wallet} {
		if info, err := os.Stat(path); err != nil || info.Mode()&os.ModeSetgid == 0 || info.Mode().Perm() != 0o770 {
			t.Fatalf("shared directory was not activated: %s info=%v err=%v", path, info, err)
		}
	}
	for _, path := range []string{cacheFile, registry} {
		if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o660 {
			t.Fatalf("shared file was not activated: %s info=%v err=%v", path, info, err)
		}
	}
	if info, err := os.Stat(masterKey); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("private signer material was exposed: info=%v err=%v", info, err)
	}
	if err := store.Restore("transaction"); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{cache, wallet} {
		if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o700 {
			t.Fatalf("shared directory metadata was not restored: %s info=%v err=%v", path, info, err)
		}
	}
	for _, path := range []string{cacheFile, registry, masterKey} {
		if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("shared file metadata was not restored: %s info=%v err=%v", path, info, err)
		}
	}
}
