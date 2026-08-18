package custody

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadOrCreateMasterKeyCreatesAndReopens(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keys", "master.key")

	created, err := LoadOrCreateMasterKey(path)
	if err != nil {
		t.Fatalf("LoadOrCreateMasterKey() create: %v", err)
	}
	defer ZeroBytes(created)
	if len(created) != 32 {
		t.Fatalf("created key length = %d, want 32", len(created))
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat() persisted key: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("persisted key mode = %04o, want 0600", got)
	}

	reopened, err := LoadOrCreateMasterKey(path)
	if err != nil {
		t.Fatalf("LoadOrCreateMasterKey() reopen: %v", err)
	}
	defer ZeroBytes(reopened)
	if !bytes.Equal(reopened, created) {
		t.Fatal("reopened key does not match persisted key")
	}
}

func TestLoadOrCreateMasterKeyRejectsInvalidLengthWithoutReturningKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "master.key")
	if err := os.WriteFile(path, bytes.Repeat([]byte{0xA5}, 31), 0o600); err != nil {
		t.Fatalf("WriteFile() invalid key: %v", err)
	}

	key, err := LoadOrCreateMasterKey(path)
	if err == nil || err.Error() != "signer master key has invalid length" {
		t.Fatalf("LoadOrCreateMasterKey() error = %v, want invalid-length error", err)
	}
	if key != nil {
		ZeroBytes(key)
		t.Fatal("LoadOrCreateMasterKey() returned key bytes for invalid key")
	}
}

func TestLoadOrCreateMasterKeyRejectsGroupWorldAccessibleFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "master.key")
	if err := os.WriteFile(path, make([]byte, 32), 0o600); err != nil {
		t.Fatalf("WriteFile() key: %v", err)
	}
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatalf("Chmod() key: %v", err)
	}

	key, err := LoadOrCreateMasterKey(path)
	if err == nil || err.Error() != "signer master key must not be group/world accessible" {
		t.Fatalf("LoadOrCreateMasterKey() error = %v, want group/world-access error", err)
	}
	if key != nil {
		ZeroBytes(key)
		t.Fatal("LoadOrCreateMasterKey() returned key bytes for accessible key")
	}
}

func TestLoadOrCreateMasterKeyRejectsSymlinkAndNonRegularFile(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target.key")
	if err := os.WriteFile(target, make([]byte, 32), 0o600); err != nil {
		t.Fatalf("WriteFile() target key: %v", err)
	}
	symlink := filepath.Join(dir, "master.key")
	if err := os.Symlink(target, symlink); err != nil {
		t.Fatalf("Symlink() key: %v", err)
	}
	assertNonRegularMasterKey(t, symlink)

	directory := filepath.Join(dir, "master-dir")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatalf("Mkdir() key directory: %v", err)
	}
	assertNonRegularMasterKey(t, directory)
}

func assertNonRegularMasterKey(t *testing.T, path string) {
	t.Helper()
	key, err := LoadOrCreateMasterKey(path)
	if err == nil || err.Error() != "signer master key must be a regular non-symlink file" {
		t.Fatalf("LoadOrCreateMasterKey(%q) error = %v, want non-regular error", path, err)
	}
	if key != nil {
		ZeroBytes(key)
		t.Fatalf("LoadOrCreateMasterKey(%q) returned key bytes", path)
	}
}

func TestZeroBytesClearsEveryByte(t *testing.T) {
	buf := []byte{1, 2, 3, 4}
	ZeroBytes(buf)
	if !bytes.Equal(buf, make([]byte, len(buf))) {
		t.Fatalf("ZeroBytes() left bytes behind: %x", buf)
	}
}
