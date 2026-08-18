// Package store owns signer state-file inspection and Bolt handle lifetime.
package store

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	bolt "go.etcd.io/bbolt"
)

var errDatabaseUnavailable = errors.New("signer state database is unavailable")

// InspectedPath is a state database path that has passed Inspect. Its state is
// intentionally package-private so callers cannot fabricate an inspection.
type InspectedPath struct {
	path     string
	existed  bool
	hadState bool
	valid    bool
}

// Path returns the cleaned state database path.
func (p InspectedPath) Path() string { return p.path }

// Existed reports whether the database existed when it was inspected.
func (p InspectedPath) Existed() bool { return p.existed }

// HadState reports whether the inspected database had non-empty contents.
func (p InspectedPath) HadState() bool { return p.hadState }

// Inspect cleans path and verifies an existing signer state database is safe
// to use. A missing database is accepted for first-open creation.
func Inspect(path string) (InspectedPath, error) {
	if strings.TrimSpace(path) == "" {
		return InspectedPath{}, errors.New("signer state database path is required")
	}
	path = filepath.Clean(path)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return InspectedPath{path: path, valid: true}, nil
	}
	if err != nil {
		return InspectedPath{}, fmt.Errorf("inspect signer state database: %w", err)
	}
	if err := validateStateFile(info); err != nil {
		return InspectedPath{}, err
	}
	return InspectedPath{path: path, existed: true, hadState: info.Size() > 0, valid: true}, nil
}

func validateStateFile(info os.FileInfo) error {
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errors.New("signer state database must be a regular non-symlink file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return errors.New("signer state database must not be group/world accessible")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
		return fmt.Errorf("signer state database must be owned by uid %d", os.Geteuid())
	}
	return nil
}

// DB is the signer-owned Bolt database handle. The raw Bolt handle does not
// escape this package.
type DB struct {
	db *bolt.DB
}

// Open creates the inspected database's parent and opens it read/write.
func Open(inspected InspectedPath) (*DB, error) {
	if !inspected.valid {
		return nil, errors.New("signer state database path inspection is unavailable")
	}
	if err := os.MkdirAll(filepath.Dir(inspected.path), 0o700); err != nil {
		return nil, fmt.Errorf("create signer state directory: %w", err)
	}
	db, err := bolt.Open(inspected.path, 0o600, &bolt.Options{Timeout: 2 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("open signer state database: %w", err)
	}
	return &DB{db: db}, nil
}

// OpenReadOnly opens an existing inspected database without creating paths or
// files. It is intentionally unavailable for an absent state file.
func OpenReadOnly(inspected InspectedPath) (*DB, error) {
	if !inspected.valid {
		return nil, errors.New("inspect signer state schema: signer state database path inspection is unavailable")
	}
	if !inspected.existed {
		return nil, errors.New("inspect signer state schema: signer state database does not exist")
	}
	db, err := bolt.Open(inspected.path, 0o600, &bolt.Options{ReadOnly: true, Timeout: 2 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("inspect signer state schema: %w", err)
	}
	return &DB{db: db}, nil
}

// View executes a read-only transaction.
func (db *DB) View(fn func(*bolt.Tx) error) error {
	if db == nil || db.db == nil {
		return errDatabaseUnavailable
	}
	return db.db.View(fn)
}

// Update executes a read/write transaction.
func (db *DB) Update(fn func(*bolt.Tx) error) error {
	if db == nil || db.db == nil {
		return errDatabaseUnavailable
	}
	return db.db.Update(fn)
}

// Path returns the database path, or an empty string for an unavailable handle.
func (db *DB) Path() string {
	if db == nil || db.db == nil {
		return ""
	}
	return db.db.Path()
}

// Close releases the underlying Bolt database handle.
func (db *DB) Close() error {
	if db == nil || db.db == nil {
		return errDatabaseUnavailable
	}
	return db.db.Close()
}
