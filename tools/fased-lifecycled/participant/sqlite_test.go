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
	before := append([]byte("SQLite format 3\x00"), []byte("before\n")...)
	if err := os.WriteFile(database, before, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ValidateSQLiteMain(database); err != nil {
		t.Fatal(err)
	}
	digest, err := SnapshotSQLiteFile(database, backup)
	if err != nil {
		t.Fatal(err)
	}
	if !ValidDigest(digest) || !IsSQLiteFamilyName(database+"-wal") {
		t.Fatal("SQLite family identity is invalid")
	}
	if err := os.WriteFile(database, append([]byte("SQLite format 3\x00"), []byte("after\n")...), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RestoreSQLiteFile(backup, database, digest, 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(database)
	if err != nil || string(data) != string(before) {
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

func TestSQLiteFamilyClassificationRequiresDatabaseMainAndValidHeader(t *testing.T) {
	for path, want := range map[string]string{
		"mining.sqlite": "mining.sqlite", "mining.sqlite-wal": "mining.sqlite", "state.db-shm": "state.db",
	} {
		main, ok := SQLiteFamilyMain(path)
		if !ok || main != want {
			t.Fatalf("SQLite family %s = %q/%v, want %q/true", path, main, ok, want)
		}
	}
	for _, path := range []string{"audit-wal", "notes-journal", "database.txt"} {
		if _, ok := SQLiteFamilyMain(path); ok {
			t.Fatalf("non-SQLite path was classified as a database family: %s", path)
		}
	}
	invalid := filepath.Join(t.TempDir(), "invalid.sqlite")
	if err := os.WriteFile(invalid, []byte("not sqlite"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ValidateSQLiteMain(invalid); err == nil {
		t.Fatal("invalid SQLite main header was accepted")
	}
}

func TestRestoreRejectsChangedSnapshotBeforeReplacingDestination(t *testing.T) {
	root := t.TempDir()
	backup := filepath.Join(root, "backup")
	destination := filepath.Join(root, "destination")
	if err := os.WriteFile(backup, []byte("trusted"), 0o600); err != nil {
		t.Fatal(err)
	}
	digest, err := DigestRegularFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backup, []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, []byte("active"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RestoreRegularFile(backup, destination, digest, 0o600); err == nil {
		t.Fatal("tampered rollback snapshot was accepted")
	}
	data, err := os.ReadFile(destination)
	if err != nil || string(data) != "active" {
		t.Fatalf("failed restore mutated active state: %q %v", data, err)
	}
}
