package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestSignerSocketDirectorySupportsDistinctSocketGroups(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "signer")
	socketPath := filepath.Join(directory, "app.sock")

	if err := prepareSocketDirectoryV2(socketPath, os.Getgid()); err != nil {
		t.Fatalf("prepare application socket directory: %v", err)
	}
	info, err := os.Lstat(directory)
	if err != nil {
		t.Fatalf("inspect application socket directory: %v", err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatal("socket directory stat does not expose ownership")
	}
	originalGID := stat.Gid

	if err := prepareSocketDirectoryV2(socketPath, os.Getgid()+1); err != nil {
		t.Fatalf("prepare second socket group in shared directory: %v", err)
	}
	info, err = os.Lstat(directory)
	if err != nil {
		t.Fatalf("inspect shared socket directory: %v", err)
	}
	stat, ok = info.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatal("shared socket directory stat does not expose ownership")
	}
	if got := info.Mode().Perm(); got != 0o711 {
		t.Fatalf("shared socket directory mode = %04o, want 0711", got)
	}
	if stat.Gid != originalGID {
		t.Fatalf("shared socket directory group changed from %d to %d", originalGID, stat.Gid)
	}
}
