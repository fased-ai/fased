package platform

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
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
