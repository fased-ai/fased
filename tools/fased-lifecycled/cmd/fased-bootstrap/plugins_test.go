package main

import (
	"fased-lifecycled/hostsecurity"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestManagedPluginAndCoreUseOneMutationLease(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lifecycle.lock")
	uid := uint32(os.Getuid())
	plugin, err := acquireManagedPluginMutationLock(path, uid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := acquireManagedPluginMutationLock(path, uid); err == nil {
		t.Fatal("second managed plugin mutation acquired while a plugin lease was active")
	}
	if err := plugin.Release(); err != nil {
		t.Fatal(err)
	}
	core, err := hostsecurity.AcquireMutationLock(path, uid)
	if err != nil {
		t.Fatal(err)
	}
	defer core.Release()
	if _, err := acquireManagedPluginMutationLock(path, uid); err == nil {
		t.Fatal("managed plugin mutation acquired while core lifecycle lease was active")
	}
	if err := core.Release(); err != nil {
		t.Fatal(err)
	}
	plugin, err = acquireManagedPluginMutationLock(path, uid)
	if err != nil {
		t.Fatalf("managed plugin mutation could not acquire released core lease: %v", err)
	}
	if err := plugin.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestManagedPluginParserRejectsLegacyAndAcceptsExactCatalog(t *testing.T) {
	root := t.TempDir()
	catalog := filepath.Join(root, "catalog.json")
	if err := os.WriteFile(catalog, []byte(`{"schemaVersion":1,"type":"fased-managed-plugin-catalog","entries":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(root, "plugin.tar.gz")
	if err := os.WriteFile(archive, []byte("archive"), 0o600); err != nil {
		t.Fatal(err)
	}
	arguments := []string{"--profile", "protected-local", "install", "--catalog", catalog, "--catalog-digest", "sha256:" + strings.Repeat("a", 64), "--archive", "demo=" + archive}
	command, err := parseManagedPluginCommand(arguments)
	if err != nil {
		t.Fatal(err)
	}
	if command.operation != "install" || command.profile != "protected-local" || command.catalog != catalog || command.archives["demo"] != archive {
		t.Fatalf("unexpected parsed command: %+v", command)
	}
	for _, invalid := range [][]string{{"install", "--profile", "protected-local"}, {"--profile", "protected-local", "install", "demo"}, {"--profile", "protected-local", "install", "--profile", "hosting"}, {"--profile", "protected-local", "install", "--catalog", "https://example.invalid/a"}, {"--profile", "protected-local", "list", "--catalog", catalog}} {
		if _, err := parseManagedPluginCommand(invalid); err == nil {
			t.Fatalf("legacy plugin input was accepted: %v", invalid)
		}
	}
}

func TestManagedPluginCatalogPinnedReaderRejectsUnsafeInputs(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "catalog.json")
	if err := os.WriteFile(path, []byte(`{"x":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readManagedPluginCatalog(path, uint32(os.Getuid())); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o622); err != nil {
		t.Fatal(err)
	}
	if _, err := readManagedPluginCatalog(path, uint32(os.Getuid())); err == nil {
		t.Fatal("group-writable catalog was accepted")
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "catalog-link.json")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readManagedPluginCatalog(link, uint32(os.Getuid())); err == nil {
		t.Fatal("catalog symlink was accepted")
	}
}
