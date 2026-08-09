package main

import (
	"os"
	"path/filepath"
	"reflect"
	"syscall"
	"testing"
)

func TestInitializationApplyArgumentsSelectsOneVerifiedInput(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "generation.tar.gz")
	topology := "local-user-systemd-v1"
	dependency := filepath.Join(t.TempDir(), "dependencies.tar.gz")
	got, err := initializationApplyArguments("/platform.json", "", archive, dependency, topology)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--config", "/platform.json", "--generation-archive", archive, "--dependency-archive", dependency, "--source-topology", topology}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("arguments = %#v, want %#v", got, want)
	}
	for _, input := range [][2]string{{"", ""}, {"/generation", archive}, {"relative", ""}} {
		if _, err := initializationApplyArguments("/platform.json", input[0], input[1], "", ""); err == nil {
			t.Fatalf("expected generation inputs %#v to be rejected", input)
		}
	}
}

func TestBootstrapUnitReplacementRestoresPreviousUnit(t *testing.T) {
	root := t.TempDir()
	unit := filepath.Join(root, "fased-local-controller.service")
	if err := os.WriteFile(unit, []byte("legacy\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	replacement, err := replaceBootstrapUnit(unit, []byte("generation\n"))
	if err != nil {
		t.Fatal(err)
	}
	if !replacement.Existed {
		t.Fatal("expected existing unit to be captured")
	}
	if data, err := os.ReadFile(unit); err != nil || string(data) != "generation\n" {
		t.Fatalf("replacement mismatch: %q %v", data, err)
	}
	if err := replacement.Restore(); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(unit); err != nil || string(data) != "legacy\n" {
		t.Fatalf("restore mismatch: %q %v", data, err)
	}
}

func TestBootstrapUnitReplacementRejectsUnsafeExistingUnit(t *testing.T) {
	root := t.TempDir()
	unit := filepath.Join(root, "fased-local-controller.service")
	if err := os.WriteFile(unit, []byte("legacy\n"), 0o666); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(unit, 0o666); err != nil {
		t.Fatal(err)
	}
	if _, err := replaceBootstrapUnit(unit, []byte("generation\n")); err == nil {
		t.Fatal("expected unsafe existing unit to be rejected")
	}
}

func TestStableBinaryDirectoryRemainsInspectableUnderRestrictiveUmask(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "lifecycle", "supervisor-v1")
	previous := syscall.Umask(0o077)
	err := ensureStableBinaryDirectory(directory)
	syscall.Umask(previous)
	if err != nil {
		t.Fatal(err)
	}
	for _, current := range []string{filepath.Dir(directory), directory} {
		info, statErr := os.Lstat(current)
		if statErr != nil {
			t.Fatal(statErr)
		}
		if info.Mode().Perm() != 0o755 {
			t.Fatalf("%s mode = %o, want 755", current, info.Mode().Perm())
		}
	}
}

func TestStableBinaryDirectoryRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	lifecycle := filepath.Join(root, "lifecycle")
	if err := os.Symlink(target, lifecycle); err != nil {
		t.Fatal(err)
	}
	if err := ensureStableBinaryDirectory(filepath.Join(lifecycle, "supervisor-v1")); err == nil {
		t.Fatal("expected symlinked stable binary directory to be rejected")
	}
}
