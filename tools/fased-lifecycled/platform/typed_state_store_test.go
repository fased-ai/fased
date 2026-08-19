package platform

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"fased-lifecycled/model"
)

type modeAccessVerifier struct {
	calls int
	paths []string
	stop  string
}

func (verifier *modeAccessVerifier) Verify(_ context.Context, path string, directory bool, principal Principal, groups []uint32) error {
	verifier.calls++
	verifier.paths = append(verifier.paths, path)
	info, err := os.Stat(path)
	if err != nil || info.IsDir() != directory {
		return os.ErrPermission
	}
	stat := info.Sys().(*syscall.Stat_t)
	accessible := principalCanAccess(info.Mode(), stat.Uid, stat.Gid, principal.UID, principal.GID)
	for _, gid := range groups {
		accessible = accessible || principalCanAccess(info.Mode(), stat.Uid, stat.Gid, principal.UID, gid)
	}
	if !accessible {
		return os.ErrPermission
	}
	for ancestor := filepath.Dir(path); verifier.stop != "" && pathWithin(verifier.stop, ancestor); ancestor = filepath.Dir(ancestor) {
		info, err := os.Stat(ancestor)
		if err != nil || !info.IsDir() {
			return os.ErrPermission
		}
		stat := info.Sys().(*syscall.Stat_t)
		accessible = principalCanTraverse(info.Mode(), stat.Uid, stat.Gid, principal.UID, principal.GID)
		for _, gid := range groups {
			accessible = accessible || principalCanTraverse(info.Mode(), stat.Uid, stat.Gid, principal.UID, gid)
		}
		if !accessible {
			return os.ErrPermission
		}
		if ancestor == verifier.stop {
			break
		}
	}
	return nil
}

func principalCanTraverse(mode os.FileMode, ownerUID, ownerGID, uid, gid uint32) bool {
	bits := mode.Perm() & 0o001
	if uid == ownerUID {
		bits = (mode.Perm() >> 6) & 0o1
	} else if gid == ownerGID {
		bits = (mode.Perm() >> 3) & 0o1
	}
	return bits != 0
}

func sqliteBytes(suffix string) []byte {
	return append([]byte("SQLite format 3\x00"), []byte(suffix)...)
}

func TestTypedStateStorePreservesWALAndVerifiesLocalAndHostingTargetAccess(t *testing.T) {
	for _, profile := range []model.Profile{model.ProfileProtectedLocal, model.ProfileHosting} {
		t.Run(string(profile), func(t *testing.T) {
			operator := Principal{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}
			gateway := Principal{UID: operator.UID + 100, GID: operator.GID + 100}
			signer := Principal{UID: operator.UID + 200, GID: operator.GID + 200}
			instance := "example"
			ownerRoot := "/home/owner/.fased"
			if profile == model.ProfileHosting {
				instance, ownerRoot = "hosting", "/home/app/.fased"
			}
			config, err := NewConfig(profile, instance, ownerRoot, operator, gateway, signer)
			if err != nil {
				t.Fatal(err)
			}
			access := &modeAccessVerifier{}
			store, err := NewDiskTypedStateStore(config, access)
			if err != nil {
				t.Fatal(err)
			}
			store.rootPrefix = t.TempDir()
			owner := store.resolve(config.OwnerStateRoot)
			access.stop = owner
			mining := filepath.Join(owner, "sat-mining")
			federation := filepath.Join(owner, "federation")
			wallet := filepath.Join(owner, "wallet")
			application := filepath.Join(owner, "tasks")
			pluginData := filepath.Join(owner, "plugin-data")
			for _, path := range []string{owner, mining, federation, wallet, application, pluginData} {
				if err := os.MkdirAll(path, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(path, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Chmod(owner, os.ModeSetgid|0o770); err != nil {
				t.Fatal(err)
			}
			database := filepath.Join(mining, "mining.sqlite")
			wal := database + "-wal"
			federationDatabase := filepath.Join(federation, "network.sqlite")
			federationWAL := federationDatabase + "-wal"
			registry := filepath.Join(wallet, "provider-registry.v1.json")
			configuration := filepath.Join(owner, "fased.json")
			installProjection := filepath.Join(owner, "install.json")
			lifecycleProjection := filepath.Join(owner, "lifecycle.json")
			applicationState := filepath.Join(application, "task.json")
			taskLedger := filepath.Join(application, "task-ledger.sqlite")
			taskLedgerWAL := taskLedger + "-wal"
			pluginState := filepath.Join(pluginData, "memory-core.json")
			original := map[string][]byte{
				database: sqliteBytes("database-before\n"), wal: []byte("wal-before\n"),
				federationDatabase: sqliteBytes("federation-before\n"), federationWAL: []byte("federation-wal-before\n"),
				registry: []byte("wallet-before\n"), configuration: []byte("config-before\n"), installProjection: []byte("install-before\n"), lifecycleProjection: []byte("lifecycle-before\n"), applicationState: []byte("task-before\n"), taskLedger: sqliteBytes("task-ledger-before\n"), taskLedgerWAL: []byte("task-ledger-wal-before\n"), pluginState: []byte("plugin-data-before\n"),
			}
			for path, data := range original {
				if err := os.WriteFile(path, data, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			prepared, err := store.Prepare("transaction", nil)
			if err != nil {
				t.Fatal(err)
			}
			if len(prepared.ParticipantDigests) != 7 || prepared.ParticipantDigests["mining"] == "" || prepared.ParticipantDigests["wallet"] == "" || prepared.ParticipantDigests["application-state"] == "" {
				t.Fatalf("typed participant receipts are incomplete: %+v", prepared)
			}
			records, err := store.read("transaction")
			if err != nil {
				t.Fatal(err)
			}
			familyMembers := 0
			taskLedgerFamilyMembers := 0
			projectionBound := false
			for _, record := range records {
				if strings.Contains(record.Path, "/extensions/") || strings.HasSuffix(record.Path, "/extensions") {
					t.Fatalf("executable plugin code entered mutable state rollback: %+v", record)
				}
				if record.SQLiteFamily == store.unresolve(database) {
					familyMembers++
				}
				if record.SQLiteFamily == store.unresolve(taskLedger) {
					taskLedgerFamilyMembers++
				}
				if record.Path == store.unresolve(configuration) {
					projectionBound = record.ProjectionOwned && record.Backup == "" && record.Digest != ""
				}
			}
			if familyMembers != 2 {
				t.Fatalf("SQLite main/WAL were not bound as one family: %+v", records)
			}
			if taskLedgerFamilyMembers != 2 {
				t.Fatalf("task SQLite main/WAL were not bound as one application-state family: %+v", records)
			}
			if !projectionBound {
				t.Fatal("configuration was not digest-bound as a lifecycle-file-owned projection")
			}
			if err := store.Activate("transaction"); err != nil {
				t.Fatal(err)
			}
			// The lifecycle-file transaction owns configuration projection
			// activation and runs immediately before the typed access check.
			if err := os.Chmod(configuration, 0o660); err != nil {
				t.Fatal(err)
			}
			if err := store.VerifyAccess(context.Background(), "transaction"); err != nil {
				t.Fatal(err)
			}
			for _, path := range access.paths {
				if path == installProjection || path == lifecycleProjection {
					t.Fatalf("pre-start verification exposed commit-only projection %s", path)
				}
			}
			if err := os.WriteFile(database, sqliteBytes("database-after\n"), 0o660); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(wal, []byte("wal-after\n"), 0o660); err != nil {
				t.Fatal(err)
			}
			newSidecar := database + "-shm"
			if err := os.WriteFile(newSidecar, []byte("new-sidecar\n"), 0o660); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(applicationState, []byte("task-after\n"), 0o660); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(taskLedger, sqliteBytes("task-ledger-after\n"), 0o660); err != nil {
				t.Fatal(err)
			}
			taskLedgerSHM := taskLedger + "-shm"
			if err := os.WriteFile(taskLedgerSHM, []byte("task-ledger-shm-after\n"), 0o660); err != nil {
				t.Fatal(err)
			}
			unexpected := filepath.Join(application, "created-by-failed-target.json")
			if err := os.WriteFile(unexpected, []byte("new\n"), 0o660); err != nil {
				t.Fatal(err)
			}
			if err := store.Restore("transaction"); err != nil {
				t.Fatal(err)
			}
			for path, want := range original {
				data, err := os.ReadFile(path)
				if err != nil || string(data) != string(want) {
					t.Fatalf("state rollback mismatch for %s: data=%q err=%v", path, data, err)
				}
			}
			if _, err := os.Lstat(newSidecar); !os.IsNotExist(err) {
				t.Fatalf("new SQLite sidecar survived rollback: %v", err)
			}
			if _, err := os.Lstat(taskLedgerSHM); !os.IsNotExist(err) {
				t.Fatalf("new task SQLite sidecar survived rollback: %v", err)
			}
			if _, err := os.Lstat(unexpected); !os.IsNotExist(err) {
				t.Fatalf("new application state survived rollback: %v", err)
			}
			for _, path := range []string{mining, federation, wallet, application, pluginData} {
				if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o700 {
					t.Fatalf("directory metadata was not restored: %s info=%v err=%v", path, info, err)
				}
			}
			if _, err := store.Prepare("retry", nil); err != nil {
				t.Fatal(err)
			}
			if err := store.Activate("retry"); err != nil {
				t.Fatalf("identical typed-state retry failed: %v", err)
			}
			if err := store.VerifyAccess(context.Background(), "retry"); err != nil {
				t.Fatalf("target identity lost access on retry: %v", err)
			}
			if err := os.Chmod(mining, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := store.VerifyAccess(context.Background(), "retry"); err == nil {
				t.Fatal("target access verification accepted inaccessible Mining state")
			}
			if access.calls == 0 {
				t.Fatal("typed state never invoked its target-identity access verifier")
			}
		})
	}
}

func TestTypedStateStoreBindsButDoesNotCompeteWithHostedSignerRegistryOwner(t *testing.T) {
	current := Principal{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}
	config, err := NewConfig(model.ProfileHosting, "hosting", "/home/app/.fased", current,
		Principal{UID: current.UID + 1, GID: current.GID + 1}, Principal{UID: current.UID + 2, GID: current.GID + 2})
	if err != nil {
		t.Fatal(err)
	}
	access := &modeAccessVerifier{}
	store, err := NewDiskTypedStateStore(config, access)
	if err != nil {
		t.Fatal(err)
	}
	store.rootPrefix = t.TempDir()
	owner := store.resolve(config.OwnerStateRoot)
	access.stop = owner
	wallet := filepath.Join(owner, "wallet")
	if err := os.MkdirAll(wallet, 0o700); err != nil {
		t.Fatal(err)
	}
	registry := filepath.Join(wallet, "provider-registry.v1.json")
	before := []byte("registry-before\n")
	after := []byte("registry-after\n")
	if err := os.WriteFile(registry, before, 0o600); err != nil {
		t.Fatal(err)
	}
	logicalRegistry := filepath.Join(config.OwnerStateRoot, "wallet", "provider-registry.v1.json")
	if _, err := store.Prepare("owned", []string{logicalRegistry}); err != nil {
		t.Fatal(err)
	}
	records, err := store.read("owned")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, record := range records {
		if record.Path == logicalRegistry {
			found = record.MutationOwner == "migrator" && record.Digest != "" && record.Backup == ""
		}
	}
	if !found {
		t.Fatalf("hosted signer registry did not receive exclusive mutation ownership: %+v", records)
	}
	if err := os.WriteFile(registry, after, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.Activate("owned"); err != nil {
		t.Fatalf("declared signer registry mutation was rejected: %v", err)
	}
	if info, err := os.Stat(wallet); err != nil || info.Mode().Perm() != 0o710 || info.Mode()&os.ModeSetgid == 0 {
		t.Fatalf("legacy wallet directory was writable before custody commit: info=%v err=%v", info, err)
	}
	if err := store.VerifyAccess(context.Background(), "owned"); err != nil {
		t.Fatalf("target could not traverse to the exact migration-owned registry: %v", err)
	}
	if err := store.Restore("owned"); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(registry); string(got) != string(after) {
		t.Fatalf("typed state overwrote migrator-owned rollback state: %q", got)
	}
	if _, err := store.Prepare("unowned", nil); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(registry, before, 0o660); err != nil {
		t.Fatal(err)
	}
	if err := store.Activate("unowned"); err == nil || !strings.Contains(err.Error(), "content changed") {
		t.Fatalf("undeclared registry mutation was accepted: %v", err)
	}
	if _, err := store.Prepare("invalid-owner", []string{filepath.Join(config.OwnerStateRoot, "fased.json")}); err == nil {
		t.Fatal("typed state accepted a noncanonical mutation owner")
	}
}

func TestTypedStateStoreRejectsUnsafeAndInaccessibleState(t *testing.T) {
	operator := Principal{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}
	config, err := NewConfig(model.ProfileProtectedLocal, "example", "/home/owner/.fased", operator, Principal{UID: operator.UID + 1, GID: operator.GID + 1}, Principal{UID: operator.UID + 2, GID: operator.GID + 2})
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewDiskTypedStateStore(config, &modeAccessVerifier{})
	if err != nil {
		t.Fatal(err)
	}
	store.rootPrefix = t.TempDir()
	owner := store.resolve(config.OwnerStateRoot)
	if err := os.MkdirAll(owner, 0o700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(store.rootPrefix, "outside")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(owner, "fased.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Prepare("transaction", nil); err == nil {
		t.Fatal("typed state accepted a symlink")
	}
}

func TestTypedStateStoreAcceptsJSONOnlyTaskPredecessorWithoutSQLiteFamily(t *testing.T) {
	operator := Principal{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}
	config, err := NewConfig(
		model.ProfileProtectedLocal,
		"json-only-tasks",
		"/home/owner/.fased",
		operator,
		Principal{UID: operator.UID + 1, GID: operator.GID + 1},
		Principal{UID: operator.UID + 2, GID: operator.GID + 2},
	)
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewDiskTypedStateStore(config, &modeAccessVerifier{})
	if err != nil {
		t.Fatal(err)
	}
	store.rootPrefix = t.TempDir()
	tasks := filepath.Join(store.resolve(config.OwnerStateRoot), "tasks")
	if err := os.MkdirAll(tasks, 0o700); err != nil {
		t.Fatal(err)
	}
	jsonOnly := filepath.Join(tasks, "tasks.json")
	if err := os.WriteFile(jsonOnly, []byte(`{"version":1,"tasks":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	prepared, err := store.Prepare("json-only", nil)
	if err != nil {
		t.Fatalf("JSON-only predecessor preparation failed: %v", err)
	}
	if prepared.ParticipantDigests["application-state"] == "" {
		t.Fatalf("JSON-only task state was absent from application receipt: %+v", prepared)
	}
	records, err := store.read("json-only")
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range records {
		if record.Path == store.unresolve(jsonOnly) && record.SQLite {
			t.Fatalf("legacy JSON-only task state was misclassified as SQLite: %+v", record)
		}
	}
}

func TestTypedStateStoreTreatsSignerAsOpaqueAndNeverReadsMasterKey(t *testing.T) {
	current := Principal{UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}
	operator := Principal{UID: current.UID + 10, GID: current.GID + 10}
	gateway := Principal{UID: current.UID + 20, GID: current.GID + 20}
	config, err := NewConfig(model.ProfileHosting, "hosting", "/home/app/.fased", operator, gateway, current)
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewDiskTypedStateStore(config, &modeAccessVerifier{})
	if err != nil {
		t.Fatal(err)
	}
	store.rootPrefix = t.TempDir()
	signerRoot := store.resolve(config.SignerStateRoot())
	if err := os.MkdirAll(signerRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	masterKey := filepath.Join(signerRoot, "master.key")
	if err := os.WriteFile(masterKey, []byte("must-not-be-read"), 0o000); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Prepare("opaque-signer", nil); err != nil {
		t.Fatalf("lifecycle tried to read signer-owned key material: %v", err)
	}
	if err := os.Chmod(signerRoot, 0o710); err != nil {
		t.Fatal(err)
	}
	if err := store.Restore("opaque-signer"); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(signerRoot); err != nil || info.Mode().Perm() != 0o710 {
		t.Fatalf("typed state rollback mutated signer-owned root metadata: info=%v err=%v", info, err)
	}
	records, err := store.read("opaque-signer")
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range records {
		if pathWithin(config.SignerStateRoot(), record.Path) && record.Path != config.SignerStateRoot() {
			t.Fatalf("signer-owned content leaked into lifecycle snapshot: %+v", record)
		}
	}
}
