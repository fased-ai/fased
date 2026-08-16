package platform

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fased-lifecycled/model"
)

func managedUninstallFixture(t *testing.T) (*ManagedUninstaller, string, *[]string) {
	t.Helper()
	root := t.TempDir()
	operator, gateway, signer := filesystemPrincipals()
	config, err := NewConfig(model.ProfileProtectedLocal, "uninstall", "/home/owner/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	tx, _ := manifestTransaction(t, false)
	identity, err := config.Identity()
	if err != nil {
		t.Fatal(err)
	}
	manifest := repairManifest(tx, identity)
	manifest.Profile = config.Profile
	manifest.Platform = identity
	manifestDigest, err := ManagedManifestDigest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	payload := filepath.Join(config.InstallRoot, "generations", strings.TrimPrefix(manifest.ActiveGeneration.ID, "sha256:"), "payload")
	dependency := filepath.Join(config.InstallRoot, "dependencies", strings.Repeat("c", 64)+"-"+strings.Repeat("d", 64), "node_modules")
	pluginLock := []byte("{\"schemaVersion\":1,\"type\":\"fased-plugin-lock\",\"entries\":[]}\n")
	calls := []string{}
	uninstaller := &ManagedUninstaller{Config: config, Manifest: manifest, ManifestDigest: manifestDigest,
		Systemd: fakeSystemd{calls: &calls}, OperatorUser: "owner", PayloadPath: payload,
		DependencyPath: dependency, PluginLockData: pluginLock, RootPrefix: root, ExpectedUID: uint32(os.Getuid())}

	write := func(path string, data []byte, mode os.FileMode, uid uint32) {
		t.Helper()
		resolved := filepath.Join(root, filepath.Clean(path))
		if err := os.MkdirAll(filepath.Dir(resolved), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := writeAtomicRootOwnedFile(resolved, data, mode, uid); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{config.InstallRoot, filepath.Join(config.ProductStateRoot, "controller"), config.SignerStateRoot(), config.RuntimeRoot, config.LifecycleRoot, config.OwnerStateRoot} {
		if err := os.MkdirAll(filepath.Join(root, filepath.Clean(path)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, filepath.Clean(config.SignerStateRoot()), "state.db"), []byte("preserve"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, filepath.Clean(config.OwnerStateRoot), "fased.json"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, filepath.Clean(config.LifecycleRoot), "transactions", "old"), 0o700); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(config.LifecycleRoot, "platform.json"), []byte("platform\n"), 0o600, uint32(os.Getuid()))
	write(filepath.Join(config.LifecycleRoot, "update-policy.json"), []byte("policy\n"), 0o600, uint32(os.Getuid()))
	write(filepath.Join(config.LifecycleRoot, "installation-manifest.json"), []byte("manifest\n"), 0o600, uint32(os.Getuid()))

	units, err := uninstaller.expectedUnits(identity)
	if err != nil {
		t.Fatal(err)
	}
	for unit, data := range units {
		write(filepath.Join(config.UnitRoot, unit), data, 0o644, uint32(os.Getuid()))
	}
	authority, _ := RenderUpdateAuthority(config, "owner")
	write(config.UpdateAuthorityPath(), authority, 0o440, uint32(os.Getuid()))
	cli, _ := CanonicalCLIProjectionJSON(config)
	install, _ := CanonicalInstallProjectionForManifestJSON(config, manifest)
	wrapper, _ := RenderSignerOwnerWrapper(config)
	launcher, _ := RenderCLILauncher(config)
	write(CanonicalCLIProjectionPath(config), cli, 0o640, operator.UID)
	write(CanonicalInstallProjectionPath(config), install, 0o640, operator.UID)
	write(CanonicalPluginLockPath(config), pluginLock, 0o640, operator.UID)
	write(CanonicalSignerOwnerFiles(config)[1], wrapper, 0o755, uint32(os.Getuid()))
	write(filepath.Join(config.OwnerStateRoot, "bin", "fased"), launcher, 0o755, uint32(os.Getuid()))
	return uninstaller, root, &calls
}

func TestManagedUninstallRemovesCodeAndServicesButPreservesOwnerAndSignerState(t *testing.T) {
	uninstaller, root, calls := managedUninstallFixture(t)
	record, err := uninstaller.Run(context.Background())
	if err != nil || !record.Completed {
		t.Fatalf("managed uninstall: record=%+v err=%v", record, err)
	}
	for _, preserved := range []string{
		filepath.Join(uninstaller.Config.OwnerStateRoot, "fased.json"),
		filepath.Join(uninstaller.Config.SignerStateRoot(), "state.db"),
		filepath.Join(uninstaller.Config.LifecycleRoot, "platform.json"),
		filepath.Join(uninstaller.Config.LifecycleRoot, "update-policy.json"),
		filepath.Join(uninstaller.Config.LifecycleRoot, "uninstalled.json"),
	} {
		if _, err := os.Stat(filepath.Join(root, filepath.Clean(preserved))); err != nil {
			t.Fatalf("preserved state %s is missing: %v", preserved, err)
		}
	}
	for _, removed := range []string{
		uninstaller.Config.InstallRoot,
		filepath.Join(uninstaller.Config.ProductStateRoot, "controller"),
		filepath.Join(uninstaller.Config.OwnerStateRoot, "bin", "fased"),
		filepath.Join(uninstaller.Config.LifecycleRoot, "installation-manifest.json"),
		filepath.Join(uninstaller.Config.LifecycleRoot, "transactions"),
	} {
		if _, err := os.Lstat(filepath.Join(root, filepath.Clean(removed))); !os.IsNotExist(err) {
			t.Fatalf("managed path %s survived uninstall: %v", removed, err)
		}
	}
	joined := strings.Join(*calls, ",")
	for _, required := range []string{"systemd.stop:fased-gateway-uninstall.service", "systemd.stop:fased-signerd-uninstall.service", "systemd.stop:fased-local-controller-uninstall.service", "systemd.reload"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("managed uninstall omitted %s: %s", required, joined)
		}
	}
	before := len(*calls)
	if replay, err := uninstaller.Run(context.Background()); err != nil || !replay.Completed || len(*calls) != before {
		t.Fatalf("completed uninstall was not a no-op: record=%+v calls=%v err=%v", replay, *calls, err)
	}
}

func TestManagedUninstallRefusesModifiedOwnedUnit(t *testing.T) {
	uninstaller, root, _ := managedUninstallFixture(t)
	identity, _ := uninstaller.Config.Identity()
	path := filepath.Join(root, filepath.Clean(uninstaller.Config.UnitRoot), identity.Services["gateway"])
	if err := os.WriteFile(path, []byte("modified\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := uninstaller.Run(context.Background()); err == nil || !strings.Contains(err.Error(), "refused modified file") {
		t.Fatalf("modified managed unit was removed: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("modified unit did not fail closed: %v", err)
	}
}

func TestManagedUninstallPreservesOwnerModifiedPluginLock(t *testing.T) {
	uninstaller, root, _ := managedUninstallFixture(t)
	path := filepath.Join(root, filepath.Clean(CanonicalPluginLockPath(uninstaller.Config)))
	ownerLock := []byte("{\"schemaVersion\":1,\"type\":\"fased-plugin-lock\",\"entries\":[],\"migratedPluginState\":{\"stable-bridge\":7}}\n")
	if err := writeAtomicRootOwnedFile(path, ownerLock, 0o640, uninstaller.Config.Operator.UID); err != nil {
		t.Fatal(err)
	}

	record, err := uninstaller.Run(context.Background())
	if err != nil || !record.Completed || !record.ProjectionsRemoved {
		t.Fatalf("managed uninstall did not preserve owner plugin lock: record=%+v err=%v", record, err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != string(ownerLock) {
		t.Fatalf("owner plugin lock was not preserved byte-for-byte: %q err=%v", data, err)
	}
}

func TestManagedUninstallRemovesExactPluginLockProjection(t *testing.T) {
	uninstaller, root, _ := managedUninstallFixture(t)
	path := filepath.Join(root, filepath.Clean(CanonicalPluginLockPath(uninstaller.Config)))

	if _, err := uninstaller.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("exact lifecycle plugin lock survived uninstall: %v", err)
	}
}

func TestManagedUninstallRefusesUnsafeOwnerPluginLock(t *testing.T) {
	uninstaller, root, _ := managedUninstallFixture(t)
	path := filepath.Join(root, filepath.Clean(CanonicalPluginLockPath(uninstaller.Config)))
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/tmp/owner-plugin-lock", path); err != nil {
		t.Fatal(err)
	}

	if _, err := uninstaller.Run(context.Background()); err == nil || !strings.Contains(err.Error(), "unsafe") {
		t.Fatalf("unsafe owner plugin lock did not fail closed: %v", err)
	}
	if info, err := os.Lstat(path); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("unsafe owner plugin lock was deleted: info=%+v err=%v", info, err)
	}
}

func TestManagedUninstallResumesAfterManagedRootDirectorySyncFailure(t *testing.T) {
	uninstaller, _, _ := managedUninstallFixture(t)
	installRoot := uninstaller.resolve(uninstaller.Config.InstallRoot)
	failParent := filepath.Dir(installRoot)
	failed := false
	uninstaller.syncDir = func(path string) error {
		if path == failParent && !failed {
			failed = true
			return errors.New("injected managed-root directory sync failure")
		}
		return syncDirectory(path)
	}

	if record, err := uninstaller.Run(context.Background()); err == nil || record.Completed || !failed {
		t.Fatalf("managed uninstall did not stop at durable managed-root boundary: record=%+v err=%v failed=%t", record, err, failed)
	}
	if _, err := os.Lstat(installRoot); !os.IsNotExist(err) {
		t.Fatalf("injected failure did not occur after managed-root deletion: %v", err)
	}
	persisted, err := readManagedUninstallRecord(uninstaller.resolve(uninstaller.recordPath()), uninstaller.ExpectedUID)
	if err != nil || persisted.Completed || persisted.ManagedRootsRemoved {
		t.Fatalf("interrupted uninstall journal could short-circuit recovery: record=%+v err=%v", persisted, err)
	}

	resumed := *uninstaller
	resumed.syncDir = nil
	record, err := resumed.Run(context.Background())
	if err != nil || !record.Completed || !record.ManagedRootsRemoved {
		t.Fatalf("managed uninstall did not resume after directory sync failure: record=%+v err=%v", record, err)
	}
	for _, removed := range []string{
		installRoot,
		resumed.resolve(filepath.Join(resumed.Config.ProductStateRoot, "controller")),
		resumed.resolve(resumed.Config.RuntimeRoot),
	} {
		if _, err := os.Lstat(removed); !os.IsNotExist(err) {
			t.Fatalf("managed residue survived resumed uninstall at %s: %v", removed, err)
		}
	}
}

func TestManagedUninstallStopsBeforeMutationWhenJournalDirectorySyncFails(t *testing.T) {
	uninstaller, _, calls := managedUninstallFixture(t)
	journalDirectory := filepath.Dir(uninstaller.resolve(uninstaller.recordPath()))
	uninstaller.syncDir = func(path string) error {
		if path == journalDirectory {
			return errors.New("injected uninstall journal directory sync failure")
		}
		return syncManagedUninstallDirectory(path)
	}

	if record, err := uninstaller.Run(context.Background()); err == nil || record.Completed {
		t.Fatalf("managed uninstall continued without a durable initial journal: record=%+v err=%v", record, err)
	}
	if len(*calls) != 0 {
		t.Fatalf("managed uninstall mutated services before durable journal confirmation: %v", *calls)
	}
	if _, err := os.Lstat(uninstaller.resolve(uninstaller.Config.InstallRoot)); err != nil {
		t.Fatalf("managed root changed before durable journal confirmation: %v", err)
	}
}
