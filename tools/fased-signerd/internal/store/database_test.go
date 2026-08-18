package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	bolt "go.etcd.io/bbolt"
)

func TestInspectRejectsBlankPath(t *testing.T) {
	_, err := Inspect(" \t\n")
	if err == nil || err.Error() != "signer state database path is required" {
		t.Fatalf("Inspect blank path error = %v", err)
	}
}

func TestInspectReportsAbsentEmptyAndNonemptyState(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "state.db")

	inspected, err := Inspect(path)
	if err != nil || inspected.Path() != path || inspected.Existed() || inspected.HadState() {
		t.Fatalf("absent inspection = %#v, %v", inspected, err)
	}
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	inspected, err = Inspect(path)
	if err != nil || !inspected.Existed() || inspected.HadState() {
		t.Fatalf("empty inspection = %#v, %v", inspected, err)
	}
	if err := os.WriteFile(path, []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}
	inspected, err = Inspect(path)
	if err != nil || !inspected.Existed() || !inspected.HadState() {
		t.Fatalf("nonempty inspection = %#v, %v", inspected, err)
	}
}

func TestOpenCreatesSecureParentAndDatabaseAndSupportsTransactions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "new", "signer", "state.db")
	inspected, err := Inspect(path)
	if err != nil {
		t.Fatal(err)
	}
	db, err := Open(inspected)
	if err != nil {
		t.Fatal(err)
	}
	if db.Path() != path {
		t.Fatalf("database path = %q, want %q", db.Path(), path)
	}
	if err := db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists([]byte("test"))
		if err != nil {
			return err
		}
		return bucket.Put([]byte("key"), []byte("value"))
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.View(func(tx *bolt.Tx) error {
		if got := string(tx.Bucket([]byte("test")).Get([]byte("key"))); got != "value" {
			t.Fatalf("stored value = %q", got)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	parent, err := os.Stat(filepath.Dir(path))
	if err != nil || parent.Mode().Perm() != 0o700 {
		t.Fatalf("parent permissions = %#v, %v", parent, err)
	}
	file, err := os.Stat(path)
	if err != nil || file.Mode().Perm() != 0o600 {
		t.Fatalf("database permissions = %#v, %v", file, err)
	}

	reopenedInspection, err := Inspect(path)
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(reopenedInspection)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if err := reopened.View(func(tx *bolt.Tx) error {
		if got := string(tx.Bucket([]byte("test")).Get([]byte("key"))); got != "value" {
			t.Fatalf("reopened stored value = %q", got)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestOpenReadOnlyUsesExistingInspectionWithoutCreatingMissingState(t *testing.T) {
	missingPath := filepath.Join(t.TempDir(), "missing", "state.db")
	missing, err := Inspect(missingPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenReadOnly(missing); err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("OpenReadOnly missing error = %v", err)
	}
	if _, err := os.Stat(missingPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read-only missing open created state: %v", err)
	}

	path := filepath.Join(t.TempDir(), "state.db")
	inspected, err := Inspect(path)
	if err != nil {
		t.Fatal(err)
	}
	writable, err := Open(inspected)
	if err != nil {
		t.Fatal(err)
	}
	if err := writable.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucket([]byte("test"))
		if err != nil {
			return err
		}
		return bucket.Put([]byte("key"), []byte("value"))
	}); err != nil {
		t.Fatal(err)
	}
	if err := writable.Close(); err != nil {
		t.Fatal(err)
	}

	inspected, err = Inspect(path)
	if err != nil {
		t.Fatal(err)
	}
	readOnly, err := OpenReadOnly(inspected)
	if err != nil {
		t.Fatal(err)
	}
	defer readOnly.Close()
	if err := readOnly.View(func(tx *bolt.Tx) error {
		if got := string(tx.Bucket([]byte("test")).Get([]byte("key"))); got != "value" {
			t.Fatalf("read-only value = %q", got)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := readOnly.Update(func(*bolt.Tx) error { return nil }); err == nil {
		t.Fatal("read-only Update succeeded")
	}
}

func TestInspectRejectsUnsafeFiles(t *testing.T) {
	directory := t.TempDir()
	unsafe := filepath.Join(directory, "unsafe.db")
	if err := os.WriteFile(unsafe, []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(unsafe, 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := Inspect(unsafe); err == nil || err.Error() != "signer state database must not be group/world accessible" {
		t.Fatalf("unsafe permissions error = %v", err)
	}

	target := filepath.Join(directory, "target.db")
	if err := os.WriteFile(target, []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}
	symlink := filepath.Join(directory, "symlink.db")
	if err := os.Symlink(target, symlink); err != nil {
		t.Fatal(err)
	}
	if _, err := Inspect(symlink); err == nil || err.Error() != "signer state database must be a regular non-symlink file" {
		t.Fatalf("symlink error = %v", err)
	}

	nonregular := filepath.Join(directory, "not-a-file")
	if err := os.Mkdir(nonregular, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := Inspect(nonregular); err == nil || err.Error() != "signer state database must be a regular non-symlink file" {
		t.Fatalf("nonregular error = %v", err)
	}
}

func TestNilDatabaseFailsClosed(t *testing.T) {
	var db *DB
	if got := db.Path(); got != "" {
		t.Fatalf("nil Path = %q", got)
	}
	for name, err := range map[string]error{
		"View":   db.View(func(*bolt.Tx) error { return nil }),
		"Update": db.Update(func(*bolt.Tx) error { return nil }),
		"Close":  db.Close(),
	} {
		if err == nil || err.Error() != "signer state database is unavailable" {
			t.Fatalf("nil %s error = %v", name, err)
		}
	}
}
