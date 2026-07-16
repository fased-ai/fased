package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	bolt "go.etcd.io/bbolt"
)

func createSignerSchemaFixtureV2(t *testing.T, path string, version uint64, complete bool) {
	t.Helper()
	db, err := bolt.Open(path, 0o600, nil)
	if err != nil {
		t.Fatalf("open schema fixture: %v", err)
	}
	err = db.Update(func(tx *bolt.Tx) error {
		meta, err := tx.CreateBucketIfNotExists(bucketSignerMetaV2)
		if err != nil {
			return err
		}
		if err := meta.Put([]byte("schemaVersion"), []byte(strconv.FormatUint(version, 10))); err != nil {
			return err
		}
		if err := meta.Put([]byte("fixture"), []byte("preserve-me")); err != nil {
			return err
		}
		if !complete {
			return nil
		}
		for _, bucket := range [][]byte{
			bucketSignerPoliciesV2,
			bucketSignerOperationsV2,
			bucketSignerUsageV2,
			bucketSignerWalletsV2,
			bucketSignerWebAuthnCredentialsV2,
			bucketSignerWebAuthnChallengesV2,
			bucketSignerReviewProofsV2,
			bucketSignerReviewsV2,
		} {
			if _, err := tx.CreateBucketIfNotExists(bucket); err != nil {
				return err
			}
		}
		return tx.Bucket(bucketSignerWalletsV2).Put([]byte("legacy-wallet"), []byte(`{"walletId":"legacy-wallet"}`))
	})
	if closeErr := db.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		t.Fatalf("write schema fixture: %v", err)
	}
}

func TestSignerSchemaMigrationCreatesDurablePreMigrationBackup(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "state.db")
	createSignerSchemaFixtureV2(t, path, 2, true)

	store, err := openSignerStoreV2(path)
	if err != nil {
		t.Fatalf("migrate schema 2 to current: %v", err)
	}
	if store.schemaVersion != signerStateSchemaVersionV2 || !store.schemaHealth().Ready {
		t.Fatalf("unexpected migrated schema health: %#v", store.schemaHealth())
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close migrated store: %v", err)
	}

	backups, err := filepath.Glob(path + ".pre-v3-*.bak")
	if err != nil || len(backups) != 1 {
		t.Fatalf("expected one pre-v3 backup, backups=%#v err=%v", backups, err)
	}
	backupInfo, err := os.Stat(backups[0])
	if err != nil || backupInfo.Mode().Perm() != 0o600 || backupInfo.Size() == 0 {
		t.Fatalf("backup is not an fsyncable 0600 database: info=%#v err=%v", backupInfo, err)
	}
	backup, err := bolt.Open(backups[0], 0o600, &bolt.Options{ReadOnly: true})
	if err != nil {
		t.Fatalf("open migration backup: %v", err)
	}
	if err := backup.View(func(tx *bolt.Tx) error {
		version, err := readSignerSchemaVersionFromTxV2(tx)
		if err != nil {
			return err
		}
		if version != 2 || tx.Bucket(bucketSignerNetworksV2) != nil || string(tx.Bucket(bucketSignerMetaV2).Get([]byte("fixture"))) != "preserve-me" {
			t.Fatalf("backup is not the exact pre-migration schema: version=%d", version)
		}
		return nil
	}); err != nil {
		t.Fatalf("inspect migration backup: %v", err)
	}
	_ = backup.Close()

	migrated, err := bolt.Open(path, 0o600, &bolt.Options{ReadOnly: true})
	if err != nil {
		t.Fatalf("open migrated database: %v", err)
	}
	if err := migrated.View(func(tx *bolt.Tx) error {
		version, err := readSignerSchemaVersionFromTxV2(tx)
		if err != nil {
			return err
		}
		if version != signerStateSchemaVersionV2 || tx.Bucket(bucketSignerNetworksV2) == nil || string(tx.Bucket(bucketSignerMetaV2).Get([]byte("fixture"))) != "preserve-me" {
			t.Fatalf("migration did not atomically preserve state and add networks: version=%d", version)
		}
		return nil
	}); err != nil {
		t.Fatalf("inspect migrated database: %v", err)
	}
	_ = migrated.Close()

	reopened, err := openSignerStoreV2(path)
	if err != nil {
		t.Fatalf("reopen current schema: %v", err)
	}
	_ = reopened.Close()
	backupsAfterReopen, _ := filepath.Glob(path + ".pre-v3-*.bak")
	if len(backupsAfterReopen) != 1 {
		t.Fatalf("current schema was migrated or backed up twice: %#v", backupsAfterReopen)
	}
}

func TestSignerSchemaRefusesTooNewDatabaseWithoutMutation(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "state.db")
	createSignerSchemaFixtureV2(t, path, signerStateSchemaVersionV2+7, true)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	store, err := openSignerStoreV2(path)
	if store != nil || err == nil || !strings.Contains(err.Error(), "newer than supported") || !strings.Contains(err.Error(), "refusing to mutate") {
		t.Fatalf("expected too-new schema refusal, store=%#v err=%v", store, err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("too-new signer schema was mutated")
	}
	backups, _ := filepath.Glob(path + ".pre-v*-*.bak")
	if len(backups) != 0 {
		t.Fatalf("too-new schema unexpectedly created a migration backup: %#v", backups)
	}
}

func TestSignerSchemaDoesNotRepairIncompleteCurrentVersion(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "state.db")
	createSignerSchemaFixtureV2(t, path, signerStateSchemaVersionV2, false)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	store, err := openSignerStoreV2(path)
	if store != nil || err == nil || !strings.Contains(err.Error(), "missing required bucket") {
		t.Fatalf("expected incomplete-current schema refusal, store=%#v err=%v", store, err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("incomplete current signer schema was mutated instead of refused")
	}
}
