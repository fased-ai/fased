package platform

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"fased-lifecycled/model"
	stateparticipant "fased-lifecycled/participant"
)

type fakeManagedPluginGateway struct {
	calls      []string
	stopErr    error
	startErrAt int
	starts     int
	onStart    func(int) error
}

type fakeManagedPluginReadinessClock struct {
	now    time.Time
	onWait func()
}

func (clock *fakeManagedPluginReadinessClock) Now() time.Time { return clock.now }
func (clock *fakeManagedPluginReadinessClock) Wait(_ context.Context, delay time.Duration) error {
	clock.now = clock.now.Add(delay)
	if clock.onWait != nil {
		clock.onWait()
	}
	return nil
}

func (gateway *fakeManagedPluginGateway) Stop(_ context.Context, unit string) error {
	gateway.calls = append(gateway.calls, "stop:"+unit)
	return gateway.stopErr
}

func (gateway *fakeManagedPluginGateway) Start(_ context.Context, unit string) error {
	gateway.calls = append(gateway.calls, "start:"+unit)
	gateway.starts++
	if gateway.startErrAt == gateway.starts {
		return errors.New("injected Gateway start failure")
	}
	if gateway.onStart != nil {
		return gateway.onStart(gateway.starts)
	}
	return nil
}

func managedPluginActivationFixture(t *testing.T) (ManagedPluginActivation, ManagedPluginStageRequest, *fakeManagedPluginGateway, []byte, string, string) {
	t.Helper()
	transaction, request, root, _ := managedTransactionFixture(t, []managedArchiveMember{{header: tar.Header{Name: "index.js", Typeflag: tar.TypeReg, Mode: 0o644}, data: "export default 1\n"}})
	t.Cleanup(func() { _ = makePluginTreeRemovable(transaction.CodeRoot) })
	ownerRoot := filepath.Join(root, "owner")
	dataRoot := filepath.Join(ownerRoot, "plugin-data")
	cacheRoot := filepath.Join(ownerRoot, "cache")
	for _, directory := range []string{ownerRoot, dataRoot, cacheRoot} {
		if err := os.MkdirAll(directory, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(ownerRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dataRoot, os.ModeSetgid|0o770); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "preserved"), []byte("plugin data"), 0o600); err != nil {
		t.Fatal(err)
	}
	uid, gid := uint32(os.Getuid()), uint32(os.Getgid())
	config := Config{InstanceID: "plugin-fixture", OwnerStateRoot: ownerRoot, Operator: Principal{UID: uid, GID: gid}, Gateway: Principal{UID: uid, GID: gid}, InstallRoot: root}
	previous := stateparticipant.PluginLock{SchemaVersion: stateparticipant.PluginLockSchemaVersion, Type: "fased-plugin-lock"}
	previousData, err := json.Marshal(previous)
	if err != nil {
		t.Fatal(err)
	}
	previousData = append(previousData, '\n')
	if err := os.WriteFile(CanonicalPluginLockPath(config), previousData, 0o640); err != nil {
		t.Fatal(err)
	}
	generationID := "sha256:" + strings.Repeat("a", 64)
	writeManagedPluginReadiness(t, filepath.Join(cacheRoot, "plugin-readiness.json"), previous, generationID)
	service := &fakeManagedPluginGateway{}
	activation := ManagedPluginActivation{Config: config, Identity: model.PlatformIdentity{InstanceID: config.InstanceID, Services: map[string]string{"gateway": "fased-gateway.service"}}, Transaction: transaction, Gateway: service, GenerationID: generationID, ReadinessClock: &fakeManagedPluginReadinessClock{now: time.Unix(0, 0)}}
	service.onStart = func(_ int) error {
		data, err := os.ReadFile(CanonicalPluginLockPath(config))
		if err != nil {
			return err
		}
		lock, err := stateparticipant.DecodePluginLock(data)
		if err != nil {
			return err
		}
		writeManagedPluginReadiness(t, filepath.Join(cacheRoot, "plugin-readiness.json"), lock, generationID)
		return nil
	}
	return activation, request, service, previousData, filepath.Join(dataRoot, "preserved"), generationID
}

func writeManagedPluginReadiness(t *testing.T, path string, lock stateparticipant.PluginLock, generationID string) {
	t.Helper()
	digest, err := stateparticipant.PluginLockDigest(lock)
	if err != nil {
		t.Fatal(err)
	}
	readiness := stateparticipant.PluginReadiness{SchemaVersion: stateparticipant.PluginReadinessSchemaVersion, Type: "fased-plugin-readiness", GenerationID: generationID, LockDigest: digest}
	for _, entry := range lock.Entries {
		readiness.Entries = append(readiness.Entries, stateparticipant.PluginReadinessEntry{ID: entry.ID, Origin: entry.Origin, Digest: entry.Digest, APICapability: entry.APICapability, Required: entry.Required, Status: "loaded"})
	}
	data, err := json.Marshal(readiness)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

func applyManagedPluginFixture(t *testing.T, activation ManagedPluginActivation, transactionID string) (string, error) {
	t.Helper()
	guard := stateparticipant.PluginBoundary{CodeRoot: activation.Transaction.CodeRoot, DataRoot: filepath.Join(activation.Config.OwnerStateRoot, "plugin-data"), LockPath: CanonicalPluginLockPath(activation.Config), ReadinessPath: filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"), CodeOwnerUID: activation.Transaction.CodeOwnerUID, OperatorUID: activation.Config.Operator.UID, GatewayUID: activation.Config.Gateway.UID, ConfigGID: activation.Config.Operator.GID}
	return activation.applyBound(context.Background(), transactionID, guard, activation.Config.Operator.GID, activation.Identity.Services["gateway"])
}

func TestManagedPluginActivationCommitsAndIsIdempotent(t *testing.T) {
	activation, request, service, _, dataPath, _ := managedPluginActivationFixture(t)
	result, err := activation.Transaction.Stage(request)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := applyManagedPluginFixture(t, activation, request.TransactionID)
	if err != nil || receipt == "" {
		t.Fatalf("activation did not commit: %q %v", receipt, err)
	}
	if got, want := strings.Join(service.calls, ","), "stop:fased-gateway.service,start:fased-gateway.service"; got != want {
		t.Fatalf("activation service order = %q, want %q", got, want)
	}
	if data, err := os.ReadFile(CanonicalPluginLockPath(activation.Config)); err != nil || string(data) != string(result.CandidateLockData) {
		t.Fatalf("candidate lock was not atomically installed: %q %v", data, err)
	}
	info, err := os.Lstat(CanonicalPluginLockPath(activation.Config))
	stat, ok := info.Sys().(*syscall.Stat_t)
	if err != nil || !ok || info.Mode().Perm() != 0o640 || stat.Uid != activation.Config.Operator.UID || stat.Gid != activation.Config.Operator.GID {
		t.Fatalf("candidate lock metadata is unsafe: %+v %v", info, err)
	}
	if data, err := os.ReadFile(dataPath); err != nil || string(data) != "plugin data" {
		t.Fatalf("plugin data changed: %q %v", data, err)
	}
	if _, err := os.Lstat(activation.Transaction.stagingRoot(request.TransactionID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("committed activation retained staging: %v", err)
	}
	if _, err := applyManagedPluginFixture(t, activation, request.TransactionID); err != nil {
		t.Fatalf("completed activation was not idempotent: %v", err)
	}
	if got := len(service.calls); got != 2 {
		t.Fatalf("completed activation restarted Gateway: %v", service.calls)
	}
}

func TestManagedPluginActivationConvergesDifferentUnfinishedBeforeNewStage(t *testing.T) {
	activation, first, service, _, _, _ := managedPluginActivationFixture(t)
	if _, err := activation.Transaction.Stage(first); err != nil {
		t.Fatal(err)
	}
	second := first
	second.TransactionID = "plugin-transaction-2"
	guard := stateparticipant.PluginBoundary{CodeRoot: activation.Transaction.CodeRoot, DataRoot: filepath.Join(activation.Config.OwnerStateRoot, "plugin-data"), LockPath: CanonicalPluginLockPath(activation.Config), ReadinessPath: filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"), CodeOwnerUID: activation.Transaction.CodeOwnerUID, OperatorUID: activation.Config.Operator.UID, GatewayUID: activation.Config.Gateway.UID, ConfigGID: activation.Config.Operator.GID}
	if err := activation.convergeOtherUnfinishedBound(context.Background(), second.TransactionID, guard, activation.Config.Operator.GID, activation.Identity.Services["gateway"]); err != nil {
		t.Fatalf("unfinished prior transaction was not converged: %v", err)
	}
	journal, err := activation.openJournal(first.TransactionID, guard, activation.Config.Operator.GID, activation.Identity.Services["gateway"])
	if err != nil || journal.Phase != managedPluginCommitted {
		t.Fatalf("prior transaction did not become committed provenance: phase=%s err=%v", journal.Phase, err)
	}
	live, _, err := guard.VerifyInstalledLock()
	if err != nil {
		t.Fatal(err)
	}
	second = additionalManagedPluginRequest(t, activation, second.TransactionID, live)
	result, err := activation.Transaction.Stage(second)
	if err != nil {
		t.Fatalf("new stage remained blocked after convergence: %v", err)
	}
	if len(result.CandidateLock.Entries) != 2 || result.CandidateLock.Entries[0].ID != "demo" || result.CandidateLock.Entries[1].ID != "extra" {
		t.Fatalf("new candidate did not retain converged catalog: %+v", result.CandidateLock.Entries)
	}
	if got, want := strings.Join(service.calls, ","), "stop:fased-gateway.service,start:fased-gateway.service"; got != want {
		t.Fatalf("convergence service order = %q, want %q", got, want)
	}
}

func TestManagedPluginActivationRefusesUnfinishedJournalAgainstNewerLiveLock(t *testing.T) {
	activation, first, service, _, _, _ := managedPluginActivationFixture(t)
	if _, err := activation.Transaction.Stage(first); err != nil {
		t.Fatal(err)
	}
	guard := stateparticipant.PluginBoundary{CodeRoot: activation.Transaction.CodeRoot, DataRoot: filepath.Join(activation.Config.OwnerStateRoot, "plugin-data"), LockPath: CanonicalPluginLockPath(activation.Config), ReadinessPath: filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"), CodeOwnerUID: activation.Transaction.CodeOwnerUID, OperatorUID: activation.Config.Operator.UID, GatewayUID: activation.Config.Gateway.UID, ConfigGID: activation.Config.Operator.GID}
	if _, err := activation.openJournal(first.TransactionID, guard, activation.Config.Operator.GID, activation.Identity.Services["gateway"]); err != nil {
		t.Fatal(err)
	}
	newer := stateparticipant.PluginLock{SchemaVersion: stateparticipant.PluginLockSchemaVersion, Type: "fased-plugin-lock", Entries: []stateparticipant.PluginLockEntry{{ID: "newer", Origin: "store", Digest: "sha256:" + strings.Repeat("b", 64), APICapability: "fased.plugin.v1", Required: true}}}
	newerData, err := json.Marshal(newer)
	if err != nil {
		t.Fatal(err)
	}
	if err := activation.writeLiveLock(newerData, 0o640, activation.Config.Operator.UID, activation.Config.Operator.GID); err != nil {
		t.Fatal(err)
	}
	if err := activation.convergeOtherUnfinishedBound(context.Background(), "plugin-transaction-2", guard, activation.Config.Operator.GID, activation.Identity.Services["gateway"]); err == nil || !strings.Contains(err.Error(), "conflicts with the current live lock") {
		t.Fatalf("old journal did not fail closed against newer live lock: %v", err)
	}
	if data, err := os.ReadFile(CanonicalPluginLockPath(activation.Config)); err != nil || string(data) != string(newerData) {
		t.Fatalf("old journal overwrote newer live lock: %q %v", data, err)
	}
	if len(service.calls) != 0 {
		t.Fatalf("old journal touched Gateway before conflict refusal: %v", service.calls)
	}
}

func TestManagedPluginActivationRefusesStagedCandidateAgainstNewerLiveLockBeforeJournal(t *testing.T) {
	activation, first, service, _, _, _ := managedPluginActivationFixture(t)
	base := stateparticipant.PluginLock{SchemaVersion: stateparticipant.PluginLockSchemaVersion, Type: "fased-plugin-lock", Entries: []stateparticipant.PluginLockEntry{{ID: "base", Origin: "store", Digest: "sha256:" + strings.Repeat("a", 64), APICapability: "fased.plugin.v1", Required: true}}}
	first.BaseLock = base
	if _, err := activation.Transaction.Stage(first); err != nil {
		t.Fatal(err)
	}
	newer := base
	newer.Entries = append(newer.Entries, stateparticipant.PluginLockEntry{ID: "newer", Origin: "store", Digest: "sha256:" + strings.Repeat("b", 64), APICapability: "fased.plugin.v1", Required: true})
	newerData, err := json.Marshal(newer)
	if err != nil {
		t.Fatal(err)
	}
	if err := activation.writeLiveLock(newerData, 0o640, activation.Config.Operator.UID, activation.Config.Operator.GID); err != nil {
		t.Fatal(err)
	}
	guard := stateparticipant.PluginBoundary{CodeRoot: activation.Transaction.CodeRoot, DataRoot: filepath.Join(activation.Config.OwnerStateRoot, "plugin-data"), LockPath: CanonicalPluginLockPath(activation.Config), ReadinessPath: filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"), CodeOwnerUID: activation.Transaction.CodeOwnerUID, OperatorUID: activation.Config.Operator.UID, GatewayUID: activation.Config.Gateway.UID, ConfigGID: activation.Config.Operator.GID}
	if err := activation.convergeOtherUnfinishedBound(context.Background(), "plugin-transaction-2", guard, activation.Config.Operator.GID, activation.Identity.Services["gateway"]); err == nil || !strings.Contains(err.Error(), "candidate conflicts with the current live lock") {
		t.Fatalf("staged old candidate did not fail closed before journal creation: %v", err)
	}
	if _, err := os.Lstat(activation.journalPath(first.TransactionID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale staged candidate created an activation journal: %v", err)
	}
	if data, err := os.ReadFile(CanonicalPluginLockPath(activation.Config)); err != nil || string(data) != string(newerData) {
		t.Fatalf("staged old candidate overwrote newer live lock: %q %v", data, err)
	}
	if len(service.calls) != 0 {
		t.Fatalf("staged old candidate touched Gateway before refusal: %v", service.calls)
	}
}

func additionalManagedPluginRequest(t *testing.T, activation ManagedPluginActivation, transactionID string, base stateparticipant.PluginLock) ManagedPluginStageRequest {
	t.Helper()
	archiveData := managedPluginArchive(t, []managedArchiveMember{{header: tar.Header{Name: "index.js", Typeflag: tar.TypeReg, Mode: 0o644}, data: "export default 2\n"}})
	archivePath := filepath.Join(t.TempDir(), "extra.tar.gz")
	if err := os.WriteFile(archivePath, archiveData, 0o400); err != nil {
		t.Fatal(err)
	}
	expected := filepath.Join(t.TempDir(), "expected")
	if err := os.Mkdir(expected, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(expected, "index.js"), []byte("export default 2\n"), 0o444); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(expected, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = makePluginTreeRemovable(expected) })
	digest, err := stateparticipant.ImmutablePluginTreeDigest(expected, activation.Transaction.CodeOwnerUID)
	if err != nil {
		t.Fatal(err)
	}
	archiveSum := sha256.Sum256(archiveData)
	archiveDigest := fmt.Sprintf("sha256:%x", archiveSum)
	catalog := stateparticipant.ManagedPluginCatalog{SchemaVersion: stateparticipant.ManagedPluginCatalogSchemaVersion, Type: "fased-managed-plugin-catalog", Entries: []stateparticipant.ManagedPluginCatalogEntry{{ID: "extra", Digest: digest, ArchiveDigest: archiveDigest, APICapability: "fased.plugin.v1", Required: true}}}
	catalogData, err := json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	catalogDigest, err := stateparticipant.ManagedPluginCatalogDigest(catalog)
	if err != nil {
		t.Fatal(err)
	}
	return ManagedPluginStageRequest{TransactionID: transactionID, CatalogData: catalogData, ExpectedCatalogDigest: catalogDigest, BaseLock: base, Archives: []ManagedPluginArchiveSource{{ID: "extra", Path: archivePath, SHA256: archiveDigest}}}
}

func TestManagedPluginActivationCommittedJournalDoesNotBlockLaterCatalogWork(t *testing.T) {
	activation, first, service, _, _, _ := managedPluginActivationFixture(t)
	if _, err := activation.Transaction.Stage(first); err != nil {
		t.Fatal(err)
	}
	if _, err := applyManagedPluginFixture(t, activation, first.TransactionID); err != nil {
		t.Fatal(err)
	}
	second := first
	second.TransactionID = "plugin-transaction-2"
	guard := stateparticipant.PluginBoundary{CodeRoot: activation.Transaction.CodeRoot, DataRoot: filepath.Join(activation.Config.OwnerStateRoot, "plugin-data"), LockPath: CanonicalPluginLockPath(activation.Config), ReadinessPath: filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"), CodeOwnerUID: activation.Transaction.CodeOwnerUID, OperatorUID: activation.Config.Operator.UID, GatewayUID: activation.Config.Gateway.UID, ConfigGID: activation.Config.Operator.GID}
	if err := activation.convergeOtherUnfinishedBound(context.Background(), second.TransactionID, guard, activation.Config.Operator.GID, activation.Identity.Services["gateway"]); err != nil {
		t.Fatal(err)
	}
	if _, err := activation.Transaction.Stage(second); err != nil {
		t.Fatalf("committed provenance blocked new stage: %v", err)
	}
	if got := len(service.calls); got != 2 {
		t.Fatalf("committed provenance was replayed: %v", service.calls)
	}
}

func TestManagedPluginActivationSurvivesCoreGenerationTransition(t *testing.T) {
	activation, first, service, _, _, _ := managedPluginActivationFixture(t)
	if _, err := activation.Transaction.Stage(first); err != nil {
		t.Fatal(err)
	}
	if _, err := applyManagedPluginFixture(t, activation, first.TransactionID); err != nil {
		t.Fatal(err)
	}

	generationB := "sha256:" + strings.Repeat("b", 64)
	activationB := activation
	activationB.GenerationID = generationB
	service.calls = nil
	service.onStart = func(_ int) error {
		data, err := os.ReadFile(CanonicalPluginLockPath(activation.Config))
		if err != nil {
			return err
		}
		lock, err := stateparticipant.DecodePluginLock(data)
		if err != nil {
			return err
		}
		writeManagedPluginReadiness(t, filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"), lock, generationB)
		return nil
	}
	guard := stateparticipant.PluginBoundary{
		CodeRoot:      activation.Transaction.CodeRoot,
		DataRoot:      filepath.Join(activation.Config.OwnerStateRoot, "plugin-data"),
		LockPath:      CanonicalPluginLockPath(activation.Config),
		ReadinessPath: filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"),
		CodeOwnerUID:  activation.Transaction.CodeOwnerUID,
		OperatorUID:   activation.Config.Operator.UID,
		GatewayUID:    activation.Config.Gateway.UID,
		ConfigGID:     activation.Config.Operator.GID,
	}
	live, _, err := guard.VerifyInstalledLock()
	if err != nil {
		t.Fatal(err)
	}
	writeManagedPluginReadiness(t, filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"), live, generationB)

	catalog, err := stateparticipant.DecodeManagedPluginCatalog(first.CatalogData)
	if err != nil {
		t.Fatal(err)
	}
	if exists, err := activationB.Transaction.RecordExists("plugin-generation-b-same"); err != nil || exists {
		t.Fatalf("new generation transaction unexpectedly exists: %v %v", exists, err)
	}
	current, receipt, currentDigest, err := activationB.catalogAlreadyCurrentBound(catalog, guard, activation.Config.Operator.GID)
	if err != nil || !current || receipt == "" || currentDigest == "" {
		t.Fatalf("same catalog was not current after core transition: current=%v receipt=%q digest=%q err=%v", current, receipt, currentDigest, err)
	}
	if len(service.calls) != 0 {
		t.Fatalf("same catalog restarted Gateway after core transition: %v", service.calls)
	}

	const secondID = "plugin-generation-b-different"
	if err := activationB.convergeOtherUnfinishedBound(context.Background(), secondID, guard, activation.Config.Operator.GID, activation.Identity.Services["gateway"]); err != nil {
		t.Fatalf("prior generation terminal journal blocked a new catalog: %v", err)
	}
	second := additionalManagedPluginRequest(t, activationB, secondID, live)
	if _, err := activationB.Transaction.Stage(second); err != nil {
		t.Fatalf("different catalog could not stage after core transition: %v", err)
	}
	if _, err := applyManagedPluginFixture(t, activationB, secondID); err != nil {
		t.Fatalf("different catalog could not commit after core transition: %v", err)
	}
	if got, want := strings.Join(service.calls, ","), "stop:fased-gateway.service,start:fased-gateway.service"; got != want {
		t.Fatalf("new catalog service order = %q, want %q", got, want)
	}
}

func TestManagedPluginLiveLockPublishesOnlyAfterFinalMetadata(t *testing.T) {
	activation, request, _, previous, _, _ := managedPluginActivationFixture(t)
	result, err := activation.Transaction.Stage(request)
	if err != nil {
		t.Fatal(err)
	}
	managedPluginLiveLockBeforeRename = func() error { return errors.New("injected interruption") }
	t.Cleanup(func() { managedPluginLiveLockBeforeRename = nil })
	if err := activation.writeLiveLock(result.CandidateLockData, 0o640, activation.Config.Operator.UID, activation.Config.Operator.GID); err == nil {
		t.Fatal("interrupted live-lock publication succeeded")
	}
	path := CanonicalPluginLockPath(activation.Config)
	if data, err := os.ReadFile(path); err != nil || string(data) != string(previous) {
		t.Fatalf("interruption published a replacement lock: %q %v", data, err)
	}
	info, err := os.Lstat(path)
	stat, ok := info.Sys().(*syscall.Stat_t)
	if err != nil || !ok || info.Mode().Perm() != 0o640 || stat.Uid != activation.Config.Operator.UID || stat.Gid != activation.Config.Operator.GID {
		t.Fatalf("interruption left invalid live-lock metadata: %+v %v", info, err)
	}
}

func TestManagedPluginActivationReadinessFailureRestoresPreviousLockAndCode(t *testing.T) {
	activation, request, service, previous, dataPath, _ := managedPluginActivationFixture(t)
	if _, err := activation.Transaction.Stage(request); err != nil {
		t.Fatal(err)
	}
	service.onStart = func(start int) error {
		if start == 1 { // Candidate readiness intentionally remains previous.
			return nil
		}
		data, err := os.ReadFile(CanonicalPluginLockPath(activation.Config))
		if err != nil {
			return err
		}
		lock, err := stateparticipant.DecodePluginLock(data)
		if err != nil {
			return err
		}
		writeManagedPluginReadiness(t, filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"), lock, activation.GenerationID)
		return nil
	}
	if _, err := applyManagedPluginFixture(t, activation, request.TransactionID); err == nil {
		t.Fatal("candidate readiness failure was accepted")
	}
	if data, err := os.ReadFile(CanonicalPluginLockPath(activation.Config)); err != nil || string(data) != string(previous) {
		t.Fatalf("previous lock was not restored byte-for-byte: %q %v", data, err)
	}
	if data, err := os.ReadFile(dataPath); err != nil || string(data) != "plugin data" {
		t.Fatalf("plugin data changed during rollback: %q %v", data, err)
	}
	if got, want := strings.Join(service.calls, ","), "stop:fased-gateway.service,start:fased-gateway.service,stop:fased-gateway.service,start:fased-gateway.service"; got != want {
		t.Fatalf("rollback service order = %q, want %q", got, want)
	}
}

func TestManagedPluginActivationStartFailureAndCrashResume(t *testing.T) {
	t.Run("start failure", func(t *testing.T) {
		activation, request, service, previous, _, _ := managedPluginActivationFixture(t)
		if _, err := activation.Transaction.Stage(request); err != nil {
			t.Fatal(err)
		}
		service.startErrAt = 1
		if _, err := applyManagedPluginFixture(t, activation, request.TransactionID); err == nil {
			t.Fatal("Gateway start failure was accepted")
		}
		if data, err := os.ReadFile(CanonicalPluginLockPath(activation.Config)); err != nil || string(data) != string(previous) {
			t.Fatalf("previous lock was not restored after start failure: %q %v", data, err)
		}
	})
	t.Run("candidate lock boundary", func(t *testing.T) {
		activation, request, service, _, _, _ := managedPluginActivationFixture(t)
		if _, err := activation.Transaction.Stage(request); err != nil {
			t.Fatal(err)
		}
		gid, unit := activation.Config.Operator.GID, activation.Identity.Services["gateway"]
		guard := stateparticipant.PluginBoundary{CodeRoot: activation.Transaction.CodeRoot, DataRoot: filepath.Join(activation.Config.OwnerStateRoot, "plugin-data"), LockPath: CanonicalPluginLockPath(activation.Config), ReadinessPath: filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"), CodeOwnerUID: activation.Transaction.CodeOwnerUID, OperatorUID: activation.Config.Operator.UID, GatewayUID: activation.Config.Gateway.UID, ConfigGID: gid}
		journal, err := activation.openJournal(request.TransactionID, guard, gid, unit)
		if err != nil {
			t.Fatal(err)
		}
		result, err := activation.Transaction.Activate(request.TransactionID)
		if err != nil {
			t.Fatal(err)
		}
		if err := activation.writeLiveLock(result.CandidateLockData, 0o640, activation.Config.Operator.UID, gid); err != nil {
			t.Fatal(err)
		}
		journal.Phase = managedPluginCandidateLockWritten
		if err := activation.writeJournal(journal); err != nil {
			t.Fatal(err)
		}
		if _, err := activation.applyBound(context.Background(), request.TransactionID, guard, gid, unit); err != nil {
			t.Fatalf("crash-resume at candidate-lock boundary failed: %v", err)
		}
		if got, want := strings.Join(service.calls, ","), "start:fased-gateway.service"; got != want {
			t.Fatalf("resume service order = %q, want %q", got, want)
		}
	})
}

func TestManagedPluginActivationResetsOnlyExactRolledBackTransactionForRetry(t *testing.T) {
	activation, request, service, previous, _, _ := managedPluginActivationFixture(t)
	if _, err := activation.Transaction.Stage(request); err != nil {
		t.Fatal(err)
	}
	service.startErrAt = 1
	if _, err := applyManagedPluginFixture(t, activation, request.TransactionID); err == nil {
		t.Fatal("candidate failure was accepted")
	}
	guard := stateparticipant.PluginBoundary{CodeRoot: activation.Transaction.CodeRoot, DataRoot: filepath.Join(activation.Config.OwnerStateRoot, "plugin-data"), LockPath: CanonicalPluginLockPath(activation.Config), ReadinessPath: filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"), CodeOwnerUID: activation.Transaction.CodeOwnerUID, OperatorUID: activation.Config.Operator.UID, GatewayUID: activation.Config.Gateway.UID, ConfigGID: activation.Config.Operator.GID}
	if reset, err := activation.resetRolledBackBound(request.TransactionID, request.ExpectedCatalogDigest, guard, activation.Config.Operator.GID, activation.Identity.Services["gateway"]); err != nil || !reset {
		t.Fatalf("exact rolled-back transaction was not reset: reset=%v err=%v", reset, err)
	}
	if _, err := os.Lstat(activation.journalPath(request.TransactionID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("retry reset retained a terminal journal: %v", err)
	}
	if data, err := os.ReadFile(CanonicalPluginLockPath(activation.Config)); err != nil || string(data) != string(previous) {
		t.Fatalf("retry reset changed restored live lock: %q %v", data, err)
	}
	if _, err := activation.Transaction.Stage(request); err != nil {
		t.Fatalf("exact retry could not reuse staged candidate: %v", err)
	}
	if _, err := applyManagedPluginFixture(t, activation, request.TransactionID); err != nil {
		t.Fatalf("exact retry did not apply after terminal reset: %v", err)
	}
	if reset, err := activation.resetRolledBackBound(request.TransactionID, request.ExpectedCatalogDigest, guard, activation.Config.Operator.GID, activation.Identity.Services["gateway"]); err == nil || reset {
		t.Fatalf("committed transaction was incorrectly reset: reset=%v err=%v", reset, err)
	}
}

func TestManagedPluginActivationPreflightBoundsMaximumJournalShape(t *testing.T) {
	var prepared, maximum managedPluginActivationJournal
	low, high := 0, 500_000
	for low < high {
		size := (low + high + 1) / 2
		prepared = managedPluginActivationJournal{Phase: managedPluginPrepared, PreviousLock: make([]byte, size), CandidateLock: make([]byte, size)}
		preparedData, err := json.Marshal(prepared)
		if err != nil {
			t.Fatal(err)
		}
		if len(preparedData) <= maxManagedPluginRecordBytes {
			low = size
		} else {
			high = size - 1
		}
	}
	found := false
	for size := low - 8; size <= low; size++ {
		prepared = managedPluginActivationJournal{Phase: managedPluginPrepared, PreviousLock: make([]byte, size), CandidateLock: make([]byte, size)}
		maximum = maximumManagedPluginActivationJournal(prepared)
		preparedData, preparedErr := json.Marshal(prepared)
		maximumData, maximumErr := json.Marshal(maximum)
		if preparedErr == nil && maximumErr == nil && len(preparedData) <= maxManagedPluginRecordBytes && len(maximumData) > maxManagedPluginRecordBytes {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("could not construct prepared-fit/max-overflow journal boundary")
	}
	if _, err := marshalManagedPluginActivationJournal(prepared); err != nil {
		t.Fatalf("prepared journal should fit: %v", err)
	}
	if _, err := marshalManagedPluginActivationJournal(maximum); err == nil || !strings.Contains(err.Error(), "byte budget") {
		t.Fatalf("maximum activation journal was accepted: %v", err)
	}
}

func TestManagedPluginActivationPreflightRejectsMaximumJournalBeforeRoots(t *testing.T) {
	activation, request, _, _, _, _ := managedPluginActivationFixture(t)
	entries := make([]stateparticipant.PluginLockEntry, 0, 4095)
	for index := 0; index < 4095; index++ {
		entries = append(entries, stateparticipant.PluginLockEntry{ID: fmt.Sprintf("base-%04d", index), Origin: "bundled", Digest: "sha256:" + strings.Repeat("a", 64), APICapability: "fased.plugin.v1", Required: true})
	}
	base := stateparticipant.PluginLock{SchemaVersion: stateparticipant.PluginLockSchemaVersion, Type: "fased-plugin-lock", Entries: entries}
	baseData, err := json.Marshal(base)
	if err != nil {
		t.Fatal(err)
	}
	if len(baseData) >= maxManagedPluginRecordBytes {
		t.Fatalf("fixture base lock unexpectedly exceeds readable bound: %d", len(baseData))
	}
	if err := activation.writeLiveLock(baseData, 0o640, activation.Config.Operator.UID, activation.Config.Operator.GID); err != nil {
		t.Fatal(err)
	}
	request.BaseLock = base
	guard := stateparticipant.PluginBoundary{CodeRoot: activation.Transaction.CodeRoot, DataRoot: filepath.Join(activation.Config.OwnerStateRoot, "plugin-data"), LockPath: CanonicalPluginLockPath(activation.Config), ReadinessPath: filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"), CodeOwnerUID: activation.Transaction.CodeOwnerUID, OperatorUID: activation.Config.Operator.UID, GatewayUID: activation.Config.Gateway.UID, ConfigGID: activation.Config.Operator.GID}
	if err := activation.preflightBound(request, guard, activation.Config.Operator.GID, activation.Identity.Services["gateway"]); err == nil || !strings.Contains(err.Error(), "byte budget") {
		t.Fatalf("maximum activation journal was accepted before stage: %v", err)
	}
	if _, err := os.Lstat(activation.Transaction.recordRoot(request.TransactionID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("maximum journal preflight created record root: %v", err)
	}
	if _, err := os.Lstat(activation.Transaction.stagingRoot(request.TransactionID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("maximum journal preflight created staging root: %v", err)
	}
}

func TestManagedPluginActivationConvergesDifferentPreRecordResidue(t *testing.T) {
	activation, first, _, _, _, _ := managedPluginActivationFixture(t)
	managedPluginPreRecordInterruption = func() error { return errors.New("injected pre-record interruption") }
	t.Cleanup(func() { managedPluginPreRecordInterruption = nil })
	if _, err := activation.Transaction.Stage(first); err == nil {
		t.Fatal("pre-record interruption was accepted")
	}
	managedPluginPreRecordInterruption = nil
	guard := stateparticipant.PluginBoundary{CodeRoot: activation.Transaction.CodeRoot, DataRoot: filepath.Join(activation.Config.OwnerStateRoot, "plugin-data"), LockPath: CanonicalPluginLockPath(activation.Config), ReadinessPath: filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"), CodeOwnerUID: activation.Transaction.CodeOwnerUID, OperatorUID: activation.Config.Operator.UID, GatewayUID: activation.Config.Gateway.UID, ConfigGID: activation.Config.Operator.GID}
	if err := activation.convergeOtherUnfinishedBound(context.Background(), "plugin-transaction-2", guard, activation.Config.Operator.GID, activation.Identity.Services["gateway"]); err != nil {
		t.Fatalf("different transaction did not remove exact pre-record residue: %v", err)
	}
	if _, err := os.Lstat(activation.Transaction.recordRoot(first.TransactionID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("convergence retained pre-record directory: %v", err)
	}
	second := first
	second.TransactionID = "plugin-transaction-2"
	if _, err := activation.Transaction.Stage(second); err != nil {
		t.Fatalf("new transaction remained blocked after residue recovery: %v", err)
	}
	t.Cleanup(func() { _ = activation.Transaction.Discard(second.TransactionID) })
}

func TestManagedPluginActivationStopFailureDoesNotMutate(t *testing.T) {
	activation, request, service, previous, _, _ := managedPluginActivationFixture(t)
	if _, err := activation.Transaction.Stage(request); err != nil {
		t.Fatal(err)
	}
	service.stopErr = errors.New("injected stop failure")
	if _, err := applyManagedPluginFixture(t, activation, request.TransactionID); err == nil {
		t.Fatal("Gateway stop failure was accepted")
	}
	if data, err := os.ReadFile(CanonicalPluginLockPath(activation.Config)); err != nil || string(data) != string(previous) {
		t.Fatalf("stop failure mutated lock: %q %v", data, err)
	}
}

func TestManagedPluginActivationRejectsStaleCandidateReadiness(t *testing.T) {
	activation, request, service, previous, _, _ := managedPluginActivationFixture(t)
	result, err := activation.Transaction.Stage(request)
	if err != nil {
		t.Fatal(err)
	}
	// This receipt has the exact candidate lock and generation before the
	// candidate Gateway start. It must be deleted before Start, not accepted.
	writeManagedPluginReadiness(t, filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"), result.CandidateLock, activation.GenerationID)
	service.onStart = func(start int) error {
		if start == 1 {
			return nil
		}
		data, err := os.ReadFile(CanonicalPluginLockPath(activation.Config))
		if err != nil {
			return err
		}
		lock, err := stateparticipant.DecodePluginLock(data)
		if err != nil {
			return err
		}
		writeManagedPluginReadiness(t, filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"), lock, activation.GenerationID)
		return nil
	}
	if _, err := applyManagedPluginFixture(t, activation, request.TransactionID); err == nil {
		t.Fatal("stale candidate readiness receipt was accepted")
	}
	if data, err := os.ReadFile(CanonicalPluginLockPath(activation.Config)); err != nil || string(data) != string(previous) {
		t.Fatalf("stale readiness rollback did not restore previous lock: %q %v", data, err)
	}
}

func TestManagedPluginActivationWaitsForDelayedReadinessAndBoundsDeadline(t *testing.T) {
	t.Run("delayed candidate readiness", func(t *testing.T) {
		activation, request, service, _, _, _ := managedPluginActivationFixture(t)
		if _, err := activation.Transaction.Stage(request); err != nil {
			t.Fatal(err)
		}
		service.onStart = func(_ int) error { return nil }
		clock := activation.ReadinessClock.(*fakeManagedPluginReadinessClock)
		clock.onWait = func() {
			data, err := os.ReadFile(CanonicalPluginLockPath(activation.Config))
			if err != nil {
				t.Fatal(err)
			}
			lock, err := stateparticipant.DecodePluginLock(data)
			if err != nil {
				t.Fatal(err)
			}
			writeManagedPluginReadiness(t, filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"), lock, activation.GenerationID)
			clock.onWait = nil
		}
		if _, err := applyManagedPluginFixture(t, activation, request.TransactionID); err != nil {
			t.Fatalf("delayed exact readiness was not accepted: %v", err)
		}
		if !clock.now.After(time.Unix(0, 0)) {
			t.Fatal("readiness wait did not poll")
		}
	})
	t.Run("deadline rolls back", func(t *testing.T) {
		activation, request, service, previous, _, _ := managedPluginActivationFixture(t)
		if _, err := activation.Transaction.Stage(request); err != nil {
			t.Fatal(err)
		}
		service.onStart = func(start int) error {
			if start == 1 {
				return nil
			}
			data, err := os.ReadFile(CanonicalPluginLockPath(activation.Config))
			if err != nil {
				return err
			}
			lock, err := stateparticipant.DecodePluginLock(data)
			if err != nil {
				return err
			}
			writeManagedPluginReadiness(t, filepath.Join(activation.Config.OwnerStateRoot, "cache", "plugin-readiness.json"), lock, activation.GenerationID)
			return nil
		}
		if _, err := applyManagedPluginFixture(t, activation, request.TransactionID); err == nil {
			t.Fatal("readiness deadline was accepted")
		}
		if data, err := os.ReadFile(CanonicalPluginLockPath(activation.Config)); err != nil || string(data) != string(previous) {
			t.Fatalf("deadline rollback did not restore previous lock: %q %v", data, err)
		}
	})
}

func TestManagedPluginActivationUsesDedicatedTransactionNamespace(t *testing.T) {
	config := Config{LifecycleRoot: "/var/lib/fased-local/example/lifecycle"}
	if got, want := managedPluginTransactionRoot(config), "/var/lib/fased-local/example/lifecycle/plugin-transactions"; got != want {
		t.Fatalf("managed plugin transaction root = %q, want %q", got, want)
	}
	if got := managedPluginTransactionRoot(config); got == filepath.Join(config.LifecycleRoot, "transactions") {
		t.Fatal("managed plugin transaction root shares the core lifecycle transaction namespace")
	}
}
