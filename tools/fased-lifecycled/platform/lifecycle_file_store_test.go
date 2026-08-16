package platform

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fased-lifecycled/model"
)

func TestDiskLifecycleFileStoreActivatesAndRestoresExactSignerOwnerFiles(t *testing.T) {
	operator, gateway, signer := filesystemPrincipals()
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewDiskLifecycleFileStore(config)
	if err != nil {
		t.Fatal(err)
	}
	store.rootPrefix = t.TempDir()
	store.expectedUID = uint32(os.Getuid())
	stateRoot := store.resolve(config.OwnerStateRoot)
	prepareFilesystemOwnerStateRoot(t, stateRoot, operator)
	configPath := store.resolve(CanonicalGatewayConfigPath(config))
	if err := os.WriteFile(configPath, []byte("old-config\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	productVersionPath := store.resolve(CanonicalProductVersionPath(config))
	if err := os.MkdirAll(filepath.Dir(productVersionPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(productVersionPath, []byte("0.1.75\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	targets := CanonicalSignerOwnerFiles(config)
	for _, target := range targets {
		resolved := store.resolve(target)
		if err := os.MkdirAll(filepath.Dir(resolved), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(resolved, []byte("old\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]LifecycleFile{
		targets[0]:                             {Data: []byte("helper\n"), Mode: 0o755, UID: uint32(os.Getuid()), GID: uint32(os.Getuid())},
		targets[1]:                             {Data: []byte("wrapper\n"), Mode: 0o755, UID: uint32(os.Getuid()), GID: uint32(os.Getuid())},
		CanonicalInstallProjectionPath(config): {Data: []byte("{}\n"), Mode: 0o640, UID: config.Operator.UID, GID: config.Operator.GID},
		CanonicalCLIProjectionPath(config):     {Data: []byte("{\"schemaVersion\":1}\n"), Mode: 0o640, UID: config.Operator.UID, GID: uint32(os.Getgid())},
		CanonicalPluginLockPath(config):        {Data: []byte("{\"schemaVersion\":1,\"type\":\"fased-plugin-lock\",\"entries\":[]}\n"), Mode: 0o640, UID: config.Operator.UID, GID: uint32(os.Getgid())},
		CanonicalGatewayConfigPath(config):     {Data: []byte("new-config\n"), Mode: 0o660, UID: config.Operator.UID, GID: uint32(os.Getgid())},
		CanonicalProductVersionPath(config):    {Data: []byte("0.1.76\n"), Mode: 0o600, UID: uint32(os.Getuid()), GID: uint32(os.Getuid())},
	}
	if err := store.Prepare("transaction", files); err != nil {
		t.Fatal(err)
	}
	for target, want := range map[string]string{targets[0]: "helper\n", targets[1]: "wrapper\n"} {
		staged, err := os.ReadFile(filepath.Join(store.workspace("transaction"), "staged", store.recordName(target)))
		if err != nil || string(staged) != want {
			t.Fatalf("signer-owner staging record is not unique and exact: target=%s got=%q want=%q err=%v", target, staged, want, err)
		}
	}
	cliProjectionPath := store.resolve(CanonicalCLIProjectionPath(config))
	if _, err := os.Lstat(cliProjectionPath); !os.IsNotExist(err) {
		t.Fatalf("CLI projection became visible before commit: %v", err)
	}
	allTargets := append(targets, CanonicalGatewayConfigPath(config), CanonicalProductVersionPath(config), CanonicalCLIProjectionPath(config), CanonicalInstallProjectionPath(config), CanonicalPluginLockPath(config))
	if err := store.Activate("transaction", allTargets); err != nil {
		t.Fatal(err)
	}
	for target, want := range map[string]string{targets[0]: "helper\n", targets[1]: "wrapper\n"} {
		data, err := os.ReadFile(store.resolve(target))
		if err != nil || string(data) != want {
			t.Fatalf("lifecycle file was not activated exactly: target=%s got=%q want=%q err=%v", target, data, want, err)
		}
	}
	projectionPath := store.resolve(CanonicalInstallProjectionPath(config))
	projection, err := os.ReadFile(projectionPath)
	if err != nil || string(projection) != "{}\n" {
		t.Fatalf("install projection was not activated: %q err=%v", projection, err)
	}
	if info, err := os.Stat(projectionPath); err != nil || info.Mode().Perm() != 0o640 {
		t.Fatalf("install projection mode changed: info=%v err=%v", info, err)
	}
	if projection, err := os.ReadFile(cliProjectionPath); err != nil || string(projection) != "{\"schemaVersion\":1}\n" {
		t.Fatalf("CLI projection was not activated: %q err=%v", projection, err)
	}
	if data, err := os.ReadFile(configPath); err != nil || string(data) != "new-config\n" {
		t.Fatalf("Gateway config was not activated: %q err=%v", data, err)
	}
	if info, err := os.Stat(configPath); err != nil || info.Mode().Perm() != 0o660 {
		t.Fatalf("Gateway config mode changed: info=%v err=%v", info, err)
	}
	if err := store.Restore("transaction", allTargets); err != nil {
		t.Fatal(err)
	}
	for _, target := range targets {
		data, err := os.ReadFile(store.resolve(target))
		if err != nil || string(data) != "old\n" {
			t.Fatalf("lifecycle file was not restored exactly: %s", target)
		}
	}
	if _, err := os.Lstat(projectionPath); !os.IsNotExist(err) {
		t.Fatalf("absent install projection was not removed on rollback: %v", err)
	}
	if _, err := os.Lstat(cliProjectionPath); !os.IsNotExist(err) {
		t.Fatalf("absent CLI projection was not removed on rollback: %v", err)
	}
	if _, err := os.Lstat(store.resolve(CanonicalPluginLockPath(config))); !os.IsNotExist(err) {
		t.Fatalf("absent plugin lock was not removed on rollback: %v", err)
	}
	if data, err := os.ReadFile(productVersionPath); err != nil || string(data) != "0.1.75\n" {
		t.Fatalf("preexisting product version was not restored: %q err=%v", data, err)
	}
	if info, err := os.Stat(productVersionPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("preexisting product version metadata changed: info=%v err=%v", info, err)
	}
	if data, err := os.ReadFile(configPath); err != nil || string(data) != "old-config\n" {
		t.Fatalf("Gateway config was not restored exactly: %q err=%v", data, err)
	}
	if info, err := os.Stat(configPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("Gateway config metadata was not restored: info=%v err=%v", info, err)
	}
}

func TestDiskLifecycleFileStoreRejectsUnexpectedRootFiles(t *testing.T) {
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileHosting, "hosting", "/home/app/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewDiskLifecycleFileStore(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Prepare("transaction", map[string]LifecycleFile{"/usr/local/sbin/unrelated": {Data: []byte("bad"), Mode: 0o755}}); err == nil {
		t.Fatal("unexpected root lifecycle file was accepted")
	}
}

func TestDiskLifecycleFileStoreRejectsStagingNameCollisions(t *testing.T) {
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewDiskLifecycleFileStore(config)
	if err != nil {
		t.Fatal(err)
	}
	err = store.validateStagingNames(map[string]LifecycleFile{
		"/unrecognized/first":  {},
		"/unrecognized/second": {},
	})
	if err == nil || !strings.Contains(err.Error(), "staging name \"wrapper\" collides") {
		t.Fatalf("staging name collision did not fail closed: %v", err)
	}
}

func TestCanonicalInstallProjectionIsDerivedFromTransaction(t *testing.T) {
	tx, _ := manifestTransaction(t, false)
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	projection, err := CanonicalInstallProjection(config, tx)
	if err != nil {
		t.Fatal(err)
	}
	if projection.Profile != model.ProfileProtectedLocal || projection.Source != "go-lifecycle" || projection.Runtime.ActiveVersion != tx.Target.Version || projection.Runtime.PreviousVersion == nil || *projection.Runtime.PreviousVersion != tx.Previous.Version {
		t.Fatalf("install projection does not match transaction: %+v", projection)
	}
	if projection.Runtime.CurrentLink != filepath.Join(config.InstallRoot, "current") || projection.Service.Name != "fased-gateway-example.service" {
		t.Fatalf("install projection does not match canonical platform: %+v", projection)
	}
}

func TestCanonicalInstallProjectionRetainsPublicStablePredecessorVersion(t *testing.T) {
	tx, _ := manifestTransaction(t, false)
	tx.PlanAction = "BRIDGE_PUBLIC_STABLE"
	tx.SourceTopology = "local-user-systemd-v2"
	tx.PublicPredecessorVersion = "0.1.75"
	tx.Previous = nil
	tx.PredecessorManifestSchema = 0
	tx.PredecessorPlatform = nil
	tx.ManifestDigest = absentManifestDigest
	operator, gateway, signer := principals()
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/example/.fased", operator, gateway, signer)
	if err != nil {
		t.Fatal(err)
	}
	projection, err := CanonicalInstallProjection(config, tx)
	if err != nil {
		t.Fatal(err)
	}
	if projection.Runtime.PreviousVersion == nil || *projection.Runtime.PreviousVersion != "0.1.75" {
		t.Fatalf("public stable predecessor provenance was lost: %+v", projection.Runtime)
	}
}
