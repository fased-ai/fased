package migrator

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"fased-lifecycled/model"
	"fased-lifecycled/platform"
)

func localSignerBridgeFixture(t *testing.T) (LocalSignerBridgeAdapter, model.Transaction, model.Migration, string, string) {
	t.Helper()
	ownerState := t.TempDir()
	uid, gid := uint32(os.Geteuid()), uint32(os.Getegid())
	config, err := platform.NewConfig(
		model.ProfileProtectedLocal, "bridge-test", ownerState,
		platform.Principal{UID: uid, GID: gid},
		platform.Principal{UID: uid + 1, GID: gid + 1},
		platform.Principal{UID: uid + 2, GID: gid + 2},
	)
	if err != nil {
		t.Fatal(err)
	}
	material := filepath.Join(ownerState, "wallet")
	if err := os.MkdirAll(material, 0o700); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(material, "signerd-v2.db")
	keyPath := filepath.Join(material, "signerd-v2.master.key")
	if err := os.WriteFile(statePath, []byte("legacy-state"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, []byte("legacy-key"), 0o600); err != nil {
		t.Fatal(err)
	}
	tx := migrationTransaction("signer", 1, 2)
	tx.PlanAction = "BRIDGE_PUBLIC_STABLE"
	tx.SourceTopology = "local-user-systemd-v2"
	tx.PublicPredecessorVersion = "0.1.75"
	tx.Previous = nil
	tx.ManifestDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	tx.Previous = nil
	adapter := LocalSignerBridgeAdapter{Config: config, rootPrefix: t.TempDir(), skipChown: true}
	return adapter, tx, tx.Migrations[0], statePath, keyPath
}

func TestLocalSignerBridgeRejectsReboundMarker(t *testing.T) {
	adapter, tx, migration, _, _ := localSignerBridgeFixture(t)
	if err := adapter.Prepare(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(adapter.markerPath(tx))
	if err != nil {
		t.Fatal(err)
	}
	var record localSignerBridgeRecord
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatal(err)
	}
	record.Staged["state.db"] = filepath.Join(t.TempDir(), "state.db")
	tampered, _ := json.Marshal(record)
	if err := os.WriteFile(adapter.markerPath(tx), tampered, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Activate(context.Background(), tx, migration); err == nil {
		t.Fatal("rebound signer migration marker was accepted")
	}
}

func TestLocalSignerBridgeRollsBackWithoutMovingLegacyCustody(t *testing.T) {
	adapter, tx, migration, statePath, keyPath := localSignerBridgeFixture(t)
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
	for _, source := range []string{statePath, keyPath} {
		if _, err := os.Stat(source); err != nil {
			t.Fatalf("rollback removed legacy custody %s: %v", source, err)
		}
	}
	if _, err := os.Stat(filepath.Join(adapter.resolve(adapter.Config.SignerStateRoot()), "state.db")); !os.IsNotExist(err) {
		t.Fatalf("rollback left canonical signer state: %v", err)
	}
}

func TestLocalSignerBridgeCommitsExactStateAndRemovesLegacyCopy(t *testing.T) {
	adapter, tx, migration, statePath, keyPath := localSignerBridgeFixture(t)
	if err := adapter.Prepare(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Activate(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Verify(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Commit(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{statePath, keyPath} {
		if _, err := os.Stat(source); !os.IsNotExist(err) {
			t.Fatalf("commit retained legacy custody %s: %v", source, err)
		}
	}
	destination := adapter.resolve(adapter.Config.SignerStateRoot())
	if data, err := os.ReadFile(filepath.Join(destination, "state.db")); err != nil || string(data) != "legacy-state" {
		t.Fatalf("canonical signer state mismatch: %q %v", data, err)
	}
	if data, err := os.ReadFile(filepath.Join(destination, "master.key")); err != nil || string(data) != "legacy-key" {
		t.Fatalf("canonical signer key mismatch: %q %v", data, err)
	}
}

func TestLocalSignerBridgeAcceptsAttestedSignerDatabaseMigrationButNotKeyChange(t *testing.T) {
	adapter, tx, migration, _, _ := localSignerBridgeFixture(t)
	if err := adapter.Prepare(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Activate(context.Background(), tx, migration); err != nil {
		t.Fatal(err)
	}
	destination := adapter.resolve(adapter.Config.SignerStateRoot())
	if err := os.WriteFile(filepath.Join(destination, "state.db"), []byte("migrated-signer-state"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Verify(context.Background(), tx, migration); err != nil {
		t.Fatalf("legitimate signer database migration was rejected: %v", err)
	}
	if err := os.WriteFile(filepath.Join(destination, "master.key"), []byte("substituted-key"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Verify(context.Background(), tx, migration); err == nil {
		t.Fatal("signer key substitution was accepted")
	}
}

func TestLocalSignerBridgeRejectsPartialCustody(t *testing.T) {
	adapter, tx, migration, _, keyPath := localSignerBridgeFixture(t)
	if err := os.Remove(keyPath); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Prepare(context.Background(), tx, migration); err == nil {
		t.Fatal("partial legacy signer custody was accepted")
	}
}
