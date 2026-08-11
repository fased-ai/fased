package platform

import (
	"os"
	"path/filepath"
	"testing"

	"fased-lifecycled/model"
)

func TestTypedStateStorePreservesWALAndVerifiesLocalAndHostingTargetAccess(t *testing.T) {
	for _, profile := range []model.Profile{model.ProfileProtectedLocal, model.ProfileHosting} {
		t.Run(string(profile), func(t *testing.T) {
			operator := Principal{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}
			gateway := Principal{UID: operator.UID + 100, GID: operator.GID + 100}
			signer := Principal{UID: operator.UID + 200, GID: operator.GID + 200}
			instance := "example"
			ownerRoot := "/home/owner/.fased"
			if profile == model.ProfileHosting {
				instance, ownerRoot = "hosting", "/home/app/.fased"
			}
			config, err := NewConfig(profile, instance, ownerRoot, operator, gateway, signer)
			if err != nil {
				t.Fatal(err)
			}
			store, err := NewDiskTypedStateStore(config)
			if err != nil {
				t.Fatal(err)
			}
			store.rootPrefix = t.TempDir()
			owner := store.resolve(config.OwnerStateRoot)
			mining := filepath.Join(owner, "sat-mining")
			federation := filepath.Join(owner, "federation")
			wallet := filepath.Join(owner, "wallet")
			extensions := filepath.Join(owner, "extensions")
			for _, path := range []string{owner, mining, federation, wallet, extensions} {
				if err := os.MkdirAll(path, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(path, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			database := filepath.Join(mining, "mining.sqlite")
			wal := database + "-wal"
			registry := filepath.Join(wallet, "provider-registry.v1.json")
			configuration := filepath.Join(owner, "fased.json")
			extension := filepath.Join(extensions, "stable-plugin.json")
			original := map[string]string{database: "database-before\n", wal: "wal-before\n", registry: "wallet-before\n", configuration: "config-before\n", extension: "plugin-before\n"}
			for path, data := range original {
				if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := store.Prepare("transaction"); err != nil {
				t.Fatal(err)
			}
			if err := store.Activate("transaction"); err != nil {
				t.Fatal(err)
			}
			if err := store.VerifyAccess("transaction"); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(database, []byte("database-after\n"), 0o660); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(wal, []byte("wal-after\n"), 0o660); err != nil {
				t.Fatal(err)
			}
			newSidecar := database + "-shm"
			if err := os.WriteFile(newSidecar, []byte("new-sidecar\n"), 0o660); err != nil {
				t.Fatal(err)
			}
			if err := store.Restore("transaction"); err != nil {
				t.Fatal(err)
			}
			for path, want := range original {
				data, err := os.ReadFile(path)
				if err != nil || string(data) != want {
					t.Fatalf("state rollback mismatch for %s: data=%q err=%v", path, data, err)
				}
			}
			if _, err := os.Lstat(newSidecar); !os.IsNotExist(err) {
				t.Fatalf("new SQLite sidecar survived rollback: %v", err)
			}
			for _, path := range []string{mining, federation, wallet, extensions} {
				if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o700 {
					t.Fatalf("directory metadata was not restored: %s info=%v err=%v", path, info, err)
				}
			}
			if _, err := store.Prepare("retry"); err != nil {
				t.Fatal(err)
			}
			if err := store.Activate("retry"); err != nil {
				t.Fatalf("identical typed-state retry failed: %v", err)
			}
			if err := store.VerifyAccess("retry"); err != nil {
				t.Fatalf("target identity lost access on retry: %v", err)
			}
			if err := os.Chmod(mining, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := store.VerifyAccess("retry"); err == nil {
				t.Fatal("target access verification accepted inaccessible Mining state")
			}
		})
	}
}

func TestTypedStateStoreRejectsUnsafeAndInaccessibleState(t *testing.T) {
	operator := Principal{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/owner/.fased", operator, Principal{UID: operator.UID + 1, GID: operator.GID + 1}, Principal{UID: operator.UID + 2, GID: operator.GID + 2})
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewDiskTypedStateStore(config)
	if err != nil {
		t.Fatal(err)
	}
	store.rootPrefix = t.TempDir()
	owner := store.resolve(config.OwnerStateRoot)
	if err := os.MkdirAll(owner, 0o700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(store.rootPrefix, "outside")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(owner, "fased.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Prepare("transaction"); err == nil {
		t.Fatal("typed state accepted a symlink")
	}
}
