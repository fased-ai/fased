package migrator

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"fased-lifecycled/model"
	"fased-lifecycled/platform"
)

func migrationTransaction(state string, from, to uint32) model.Transaction {
	tx := transaction()
	tx.Migrations = []model.Migration{{State: state, From: from, To: to}}
	tx.TargetStateSchemas = map[string]uint32{state: to}
	return tx
}

func TestDirectoryAdapterFreshCreateVerifyAndExactRollback(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "state")
	adapter := DirectoryAdapter{Path: path, LifecycleRoot: filepath.Join(root, "lifecycle")}
	tx := migrationTransaction("walletRegistry", 0, 1)
	migration := tx.Migrations[0]
	if err := adapter.Prepare(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Activate(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Verify(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Abort(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("fresh rollback left state: %v", err)
	}
}

func TestDirectoryAdapterRefusesMissingInstalledStateAndNonemptyFreshDeletion(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "state")
	adapter := DirectoryAdapter{Path: path, LifecycleRoot: filepath.Join(root, "lifecycle")}
	update := migrationTransaction("managedInstall", 1, 2)
	if err := adapter.Prepare(context.Background(), update, update.Migrations[0]); err == nil {
		t.Fatal("missing installed state was accepted")
	}
	fresh := migrationTransaction("walletRegistry", 0, 1)
	if err := adapter.Prepare(context.Background(), fresh, fresh.Migrations[0]); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Activate(context.Background(), fresh, fresh.Migrations[0]); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "user-state"), []byte("preserve"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Abort(context.Background(), fresh, fresh.Migrations[0]); err == nil {
		t.Fatal("rollback deleted or ignored newly written user state")
	}
}

func TestRegistryIsSchemaBasedAndVersionNeutral(t *testing.T) {
	operator := platform.Principal{UID: 1000, GID: 1000}
	gateway := platform.Principal{UID: 997, GID: 997}
	signer := platform.Principal{UID: 996, GID: 996}
	config, err := platform.NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := RegistryFor(config)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []Key{
		{State: "managedInstall", From: 1, To: 2}, {State: "walletRegistry", From: 0, To: 1},
		{State: "signer", From: 1, To: 2}, {State: "federation", From: 1, To: 2},
	} {
		if registry[key] == nil {
			t.Fatalf("missing explicit public schema adapter: %+v", key)
		}
	}
}
