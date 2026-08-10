package platform

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"fased-lifecycled/model"
)

func TestLocalPredecessorFenceIsMonotonicAndIdempotent(t *testing.T) {
	root := filepath.Join(t.TempDir(), "user")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	uid := uint32(os.Getuid())
	if err := ensureLocalPredecessorFenceAt(root, uid); err != nil {
		t.Fatal(err)
	}
	if err := ensureLocalPredecessorFenceAt(root, uid); err != nil {
		t.Fatalf("canonical predecessor fence was not idempotent: %v", err)
	}
	if err := verifyLocalPredecessorFenceAt(root, uid); err != nil {
		t.Fatalf("canonical predecessor fence did not pass read-only verification: %v", err)
	}
	path := filepath.Join(root, "fased-gateway.service.d", filepath.Base(LocalPredecessorDropInPath))
	if data, err := os.ReadFile(path); err != nil || string(data) != string(localPredecessorDropIn) {
		t.Fatalf("canonical predecessor fence was not retained: %q err=%v", data, err)
	}
}

func TestLocalPredecessorFenceOverridesRestrictiveUmask(t *testing.T) {
	root := filepath.Join(t.TempDir(), "user")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	previousUmask := syscall.Umask(0o077)
	err := ensureLocalPredecessorFenceAt(root, uint32(os.Getuid()))
	syscall.Umask(previousUmask)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(root, "fased-gateway.service.d"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("drop-in directory is not readable and traversable by user managers: %04o", info.Mode().Perm())
	}
}

func TestLocalPredecessorFenceVerificationDoesNotCreateMissingPolicy(t *testing.T) {
	root := filepath.Join(t.TempDir(), "user")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := verifyLocalPredecessorFenceAt(root, uint32(os.Getuid())); err == nil {
		t.Fatal("missing predecessor fence passed read-only verification")
	}
	if _, err := os.Lstat(filepath.Join(root, "fased-gateway.service.d")); !os.IsNotExist(err) {
		t.Fatalf("read-only verification mutated the unit root: %v", err)
	}
}

func TestLocalPredecessorFenceVerificationRejectsTampering(t *testing.T) {
	root := filepath.Join(t.TempDir(), "user")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	uid := uint32(os.Getuid())
	if err := ensureLocalPredecessorFenceAt(root, uid); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "fased-gateway.service.d", filepath.Base(LocalPredecessorDropInPath))
	if err := os.WriteFile(path, []byte("[Unit]\nConditionPathExists=/tampered\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := verifyLocalPredecessorFenceAt(root, uid); err == nil {
		t.Fatal("tampered predecessor fence passed read-only verification")
	}
}

func TestLocalPredecessorFenceConfigRequiresCanonicalOwnerState(t *testing.T) {
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/owner/custom", Principal{UID: 1000, GID: 1000}, Principal{UID: 1001, GID: 1001}, Principal{UID: 1002, GID: 1002})
	if err != nil {
		t.Fatal(err)
	}
	if err := validateLocalPredecessorFenceConfig(config); err == nil {
		t.Fatal("predecessor fence accepted a transaction with a noncanonical owner state root")
	}
}

func TestLocalPredecessorFenceRejectsConflictingPolicy(t *testing.T) {
	root := filepath.Join(t.TempDir(), "user")
	directory := filepath.Join(root, "fased-gateway.service.d")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, filepath.Base(LocalPredecessorDropInPath))
	if err := os.WriteFile(path, []byte("[Unit]\nConditionPathExists=/conflict\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ensureLocalPredecessorFenceAt(root, uint32(os.Getuid())); err == nil {
		t.Fatal("conflicting global predecessor policy was overwritten")
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "[Unit]\nConditionPathExists=/conflict\n" {
		t.Fatalf("conflicting policy was modified: %q err=%v", data, err)
	}
}

func TestLocalPredecessorFenceRejectsSymlinkedDirectory(t *testing.T) {
	root := filepath.Join(t.TempDir(), "user")
	outside := t.TempDir()
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "fased-gateway.service.d")); err != nil {
		t.Fatal(err)
	}
	if err := ensureLocalPredecessorFenceAt(root, uint32(os.Getuid())); err == nil {
		t.Fatal("symlinked predecessor fence directory was accepted")
	}
	if entries, err := os.ReadDir(outside); err != nil || len(entries) != 0 {
		t.Fatalf("symlink target was mutated: entries=%v err=%v", entries, err)
	}
}
