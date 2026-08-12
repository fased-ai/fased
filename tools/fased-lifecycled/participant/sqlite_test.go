package participant

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSQLiteFamilySnapshotRestoreAndUnexpectedSidecarRemoval(t *testing.T) {
	root := t.TempDir()
	database := filepath.Join(root, "mining.sqlite")
	backup := filepath.Join(root, "undo", "database")
	if err := os.WriteFile(database, []byte("before\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	digest, err := SnapshotSQLiteFile(database, backup)
	if err != nil {
		t.Fatal(err)
	}
	if !ValidDigest(digest) || !IsSQLiteFamilyName(database+"-wal") {
		t.Fatal("SQLite family identity is invalid")
	}
	if err := os.WriteFile(database, []byte("after\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RestoreSQLiteFile(backup, database, digest, 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(database)
	if err != nil || string(data) != "before\n" {
		t.Fatalf("SQLite restore mismatch: %q %v", data, err)
	}
	newSidecar := database + "-shm"
	if err := os.WriteFile(newSidecar, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RemoveUnexpectedSQLiteFile(newSidecar); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(newSidecar); !os.IsNotExist(err) {
		t.Fatalf("unexpected sidecar survived removal: %v", err)
	}
}
