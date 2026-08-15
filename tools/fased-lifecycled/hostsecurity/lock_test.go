package hostsecurity

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMutationLockIsExclusiveAndReacquirable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host-security.lock")
	uid := uint32(os.Getuid())
	first, err := AcquireMutationLock(path, uid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireMutationLock(path, uid); err == nil || !strings.Contains(err.Error(), "active") {
		t.Fatalf("second mutation lock was not refused: %v", err)
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	second, err := AcquireMutationLock(path, uid)
	if err != nil {
		t.Fatalf("released lock could not be reacquired: %v", err)
	}
	if err := second.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestMutationLockRejectsSymlinkAndLooseMode(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.WriteFile(target, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireMutationLock(filepath.Join(root, "link"), uint32(os.Getuid())); err == nil {
		t.Fatal("symlink lock was accepted")
	}
	loose := filepath.Join(root, "loose")
	if err := os.WriteFile(loose, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireMutationLock(loose, uint32(os.Getuid())); err == nil {
		t.Fatal("loosely permissioned lock was accepted")
	}
}
