package main

import (
	"os"
	"path/filepath"
	"testing"

	"fased-lifecycled/platform"
	"fased-lifecycled/trust"
)

func TestCopyManagedComponentAssetBindsExactBytesAndOwnerMode(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "source")
	destination := filepath.Join(directory, "destination")
	contents := []byte("exact managed component bytes")
	if err := os.WriteFile(source, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	config := platform.Config{Operator: platform.Principal{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}}
	asset := trust.Asset{Name: "component.tar.gz", Size: uint64(len(contents))}
	if err := copyManagedComponentAsset(source, destination, asset, config); err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(actual) != string(contents) {
		t.Fatalf("copied bytes differ: got %q", actual)
	}
	info, err := os.Stat(destination)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("copied mode = %04o, want 0600", info.Mode().Perm())
	}
}

func TestCopyManagedComponentAssetRejectsTrailingBytesWithoutResidue(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "source")
	destination := filepath.Join(directory, "destination")
	if err := os.WriteFile(source, []byte("declared plus trailing"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := platform.Config{Operator: platform.Principal{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}}
	asset := trust.Asset{Name: "component.tar.gz", Size: uint64(len("declared"))}
	if err := copyManagedComponentAsset(source, destination, asset, config); err == nil {
		t.Fatal("expected trailing-byte rejection")
	}
	if _, err := os.Lstat(destination); !os.IsNotExist(err) {
		t.Fatalf("destination residue after rejection: %v", err)
	}
}
