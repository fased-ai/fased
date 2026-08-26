package migration

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	signerstore "fased-signerd/internal/store"
	bolt "go.etcd.io/bbolt"
)

var testBuckets = [][]byte{
	[]byte("meta"), []byte("policies"), []byte("operations"), []byte("operation-replay-archive"),
	[]byte("daily-usage"), []byte("wallets"), []byte("networks"), []byte("webauthn-credentials"),
	[]byte("webauthn-challenges"), []byte("review-authorization-proofs"), []byte("reviews"),
	[]byte("jupiter-trigger-workflows"), []byte("wallet-rotations"), []byte("operator-nonces"),
}

func testContract() Contract {
	return NewContract(testBuckets, []byte("meta"), []byte("schemaVersion"), []byte("webauthn-credentials"), []byte("webauthnCredentialsVersion"), []byte("capabilities"))
}

func openTestStore(t *testing.T, path string) *signerstore.DB {
	t.Helper()
	inspected, err := signerstore.Inspect(path)
	if err != nil {
		t.Fatalf("inspect fixture: %v", err)
	}
	db, err := signerstore.Open(inspected)
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	return db
}

func writeFixture(t *testing.T, path string, version uint64, includeVersion bool) {
	t.Helper()
	db, err := bolt.Open(path, 0o600, nil)
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	err = db.Update(func(tx *bolt.Tx) error {
		meta, err := tx.CreateBucketIfNotExists([]byte("meta"))
		if err != nil {
			return err
		}
		if includeVersion {
			return meta.Put([]byte("schemaVersion"), []byte(strconv.FormatUint(version, 10)))
		}
		return nil
	})
	if closeErr := db.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		t.Fatalf("write fixture: %v", err)
	}
}

func TestReadVersionMissingAndInvalid(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	writeFixture(t, path, 0, false)
	db := openTestStore(t, path)
	defer db.Close()
	version, err := ReadVersion(db, testContract())
	if err != nil || version != 0 {
		t.Fatalf("missing schema version = %d, %v; want 0, nil", version, err)
	}
	if err := db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket([]byte("meta")).Put([]byte("schemaVersion"), []byte("0"))
	}); err != nil {
		t.Fatal(err)
	}
	_, err = ReadVersion(db, testContract())
	if err == nil || err.Error() != "read signer state schema: signer state schema version is invalid" {
		t.Fatalf("invalid schema version error = %v", err)
	}
}

func TestMigrateAcceptsAllHistoricVersionsAndPreservesState(t *testing.T) {
	capabilities := []byte(`{"protocol":{"current":2}}`)
	for source := uint64(0); source < SignerStateSchemaVersion; source++ {
		t.Run(fmt.Sprintf("v%d", source), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "state.db")
			writeFixture(t, path, source, source != 0)
			db := openTestStore(t, path)
			defer db.Close()
			if err := db.Update(func(tx *bolt.Tx) error {
				if err := tx.Bucket([]byte("meta")).Put([]byte("unrelated"), []byte("preserved")); err != nil {
					return err
				}
				credentials, err := tx.CreateBucketIfNotExists([]byte("webauthn-credentials"))
				if err != nil {
					return err
				}
				if err := credentials.Put([]byte("credential"), []byte("value")); err != nil {
					return err
				}
				_, err = tx.CreateBucketIfNotExists([]byte("unrelated-bucket"))
				return err
			}); err != nil {
				t.Fatal(err)
			}
			if err := Migrate(db, source, testContract().WithCapabilities(capabilities)); err != nil {
				t.Fatalf("migrate v%d: %v", source, err)
			}
			if err := db.View(func(tx *bolt.Tx) error {
				version, err := ReadVersionFromTx(tx, testContract())
				if err != nil {
					return err
				}
				if version != SignerStateSchemaVersion || tx.Bucket([]byte("unrelated-bucket")) == nil || string(tx.Bucket([]byte("meta")).Get([]byte("unrelated"))) != "preserved" || !bytes.Equal(tx.Bucket([]byte("meta")).Get([]byte("capabilities")), capabilities) || string(tx.Bucket([]byte("meta")).Get([]byte("webauthnCredentialsVersion"))) != "1" {
					return fmt.Errorf("migration state was not atomically completed for v%d", source)
				}
				for _, bucket := range testBuckets {
					if tx.Bucket(bucket) == nil {
						return fmt.Errorf("missing required bucket %q", bucket)
					}
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMigrateRefusesTooNewAndIncompleteCurrentWithoutMutation(t *testing.T) {
	for _, fixture := range []struct {
		name    string
		version uint64
		migrate bool
		want    string
	}{
		{name: "too-new", version: SignerStateSchemaVersion + 1, migrate: true, want: "newer than supported"},
		{name: "incomplete-current", version: SignerStateSchemaVersion, want: "missing required bucket"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "state.db")
			writeFixture(t, path, fixture.version, true)
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			db := openTestStore(t, path)
			var migrationErr error
			if fixture.migrate {
				migrationErr = Migrate(db, fixture.version, testContract().WithCapabilities([]byte(`{}`)))
			} else {
				migrationErr = ValidateBuckets(db, testContract())
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			if migrationErr == nil || !strings.Contains(migrationErr.Error(), fixture.want) {
				t.Fatalf("refusal error = %v; want %q", migrationErr, fixture.want)
			}
			after, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(before, after) {
				t.Fatalf("%s state was mutated", fixture.name)
			}
		})
	}
}

func TestBackupIsExclusiveDurableAndCleansUpAfterSnapshotFailure(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "state.db")
	writeFixture(t, path, 2, true)
	db := openTestStore(t, path)
	backupPath, err := BackupBeforeMigration(db, path)
	if err != nil {
		t.Fatalf("backup state: %v", err)
	}
	info, err := os.Stat(backupPath)
	if err != nil || info.Mode().Perm() != 0o600 || info.Size() == 0 {
		t.Fatalf("backup metadata = %#v, %v", info, err)
	}
	backup, err := bolt.Open(backupPath, 0o600, &bolt.Options{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := backup.View(func(tx *bolt.Tx) error {
		version, err := ReadVersionFromTx(tx, testContract())
		if err != nil || version != 2 {
			return fmt.Errorf("backup schema = %d, %v", version, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := backup.Close(); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := BackupBeforeMigration(db, path); err == nil || !strings.Contains(err.Error(), "write pre-migration signer state backup") {
		t.Fatalf("closed-store backup error = %v", err)
	}
	backups, err := filepath.Glob(fmt.Sprintf("%s.pre-v%d-*.bak", path, SignerStateSchemaVersion))
	if err != nil {
		t.Fatal(err)
	}
	if len(backups) != 1 || backups[0] != backupPath {
		t.Fatalf("failure cleanup retained a partial backup: %#v", backups)
	}
}

func TestContractClonesSchemaBytes(t *testing.T) {
	buckets := [][]byte{[]byte("meta"), []byte("credentials")}
	meta := []byte("meta")
	contract := NewContract(buckets, meta, []byte("schemaVersion"), []byte("credentials"), []byte("credentialsVersion"), []byte("capabilities"))
	buckets[0][0], meta[0] = 'X', 'X'
	path := filepath.Join(t.TempDir(), "state.db")
	writeFixture(t, path, 0, false)
	db := openTestStore(t, path)
	defer db.Close()
	if err := Migrate(db, 0, contract.WithCapabilities([]byte(`{}`))); err != nil {
		t.Fatalf("migration used caller-mutated contract bytes: %v", err)
	}
}
