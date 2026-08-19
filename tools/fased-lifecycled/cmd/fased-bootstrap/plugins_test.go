package main

import (
	"context"
	"errors"
	"fased-lifecycled/hostsecurity"
	"fased-lifecycled/model"
	"fased-lifecycled/participant"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
)

func TestManagedPluginTransactionIdentityBindsCatalogGenerationAndBase(t *testing.T) {
	base := participant.PluginLock{SchemaVersion: participant.PluginLockSchemaVersion, Type: "fased-plugin-lock"}
	catalog := "sha256:" + strings.Repeat("a", 64)
	generationA := "sha256:" + strings.Repeat("b", 64)
	first, err := managedPluginTransactionIdentity(catalog, generationA, base)
	if err != nil {
		t.Fatal(err)
	}
	if repeated, err := managedPluginTransactionIdentity(catalog, generationA, base); err != nil || repeated != first {
		t.Fatalf("transaction identity is not deterministic: %q %v", repeated, err)
	}
	if generationB, err := managedPluginTransactionIdentity(catalog, "sha256:"+strings.Repeat("c", 64), base); err != nil || generationB == first {
		t.Fatalf("generation did not change transaction identity: %q %v", generationB, err)
	}
	base.Entries = []participant.PluginLockEntry{{ID: "demo", Origin: "store", Digest: "sha256:" + strings.Repeat("d", 64), APICapability: "fased.plugin.v1", Required: true}}
	if nextBase, err := managedPluginTransactionIdentity(catalog, generationA, base); err != nil || nextBase == first {
		t.Fatalf("base lock did not change transaction identity: %q %v", nextBase, err)
	}
}

func TestManagedPluginTransactionsAreLinuxOnly(t *testing.T) {
	if !managedPluginsSupported("linux") {
		t.Fatal("Linux managed plugin transaction was disabled")
	}
	for _, goos := range []string{"darwin", "windows", "freebsd"} {
		if managedPluginsSupported(goos) {
			t.Fatalf("managed plugin transaction was exposed on %s without runtime acceptance", goos)
		}
	}
}

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

func TestPublicLifecycleRouteHoldsSharedLeaseBeforeVerifiedAcquisition(t *testing.T) {
	operator, err := user.Current()
	if err != nil || operator.Uid == "0" || operator.Username == "" {
		t.Skip("real public-route lease test requires a discoverable unprivileged operator")
	}
	leasePath := filepath.Join(t.TempDir(), "lifecycle.lock")
	originalPath := publicLifecycleMutationLockPath
	originalAcquire := acquirePublicLifecycleMutationLock
	originalPreflight := verifyPublicLifecycleHost
	originalExecute := executePublicLifecycleBootstrap
	originalRootAuthorized := publicLifecycleRootAuthorized
	t.Cleanup(func() {
		publicLifecycleMutationLockPath = originalPath
		acquirePublicLifecycleMutationLock = originalAcquire
		verifyPublicLifecycleHost = originalPreflight
		executePublicLifecycleBootstrap = originalExecute
		publicLifecycleRootAuthorized = originalRootAuthorized
	})
	publicLifecycleMutationLockPath = func(model.Profile) (string, error) { return leasePath, nil }
	publicLifecycleRootAuthorized = func() bool { return true }
	verifyPublicLifecycleHost = func(context.Context) error { return nil }
	acquirePublicLifecycleMutationLock = func(path string, _ uint32) (*hostsecurity.MutationLock, error) {
		return acquireManagedPluginMutationLock(path, uint32(os.Getuid()))
	}
	const stoppedAfterLease = "stop after shared lifecycle lease assertion"
	executePublicLifecycleBootstrap = func(context.Context, bootstrapRequest) (bootstrapResult, error) {
		plugin, lockErr := acquireManagedPluginMutationLock(leasePath, uint32(os.Getuid()))
		if lockErr == nil {
			_ = plugin.Release()
			return bootstrapResult{}, errors.New("managed plugin acquired the public lifecycle lease during verified acquisition")
		}
		if !strings.Contains(lockErr.Error(), "active") {
			return bootstrapResult{}, lockErr
		}
		return bootstrapResult{}, errors.New(stoppedAfterLease)
	}
	err = runPublicLifecycle("install", []string{
		"--profile", "protected-local", "--operator-user", operator.Username,
		"--version", "0.1.76-rc.102", "--channel", "beta", "--no-onboard",
	}, io.Discard)
	if err == nil || !strings.Contains(err.Error(), stoppedAfterLease) {
		t.Fatalf("public lifecycle route did not retain the shared lease through verified acquisition: %v", err)
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
