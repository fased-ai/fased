package daemon

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"fased-lifecycled/engine"
	"fased-lifecycled/hostsecurity"
	"fased-lifecycled/model"
	"fased-lifecycled/protocol"
)

func init() {
	if os.Getenv("FASED_TEST_SUPERVISOR_LEASE_CLIENT") != "1" {
		return
	}
	path := os.Getenv("FASED_TEST_SUPERVISOR_LEASE_PATH")
	socket := os.Getenv("FASED_TEST_SUPERVISOR_LEASE_SOCKET")
	lease, err := hostsecurity.AcquireMutationLock(path, uint32(os.Getuid()))
	if err == nil {
		var duplicate *os.File
		duplicate, err = lease.DupForChild()
		if err == nil {
			_, err = CallWithLease(context.Background(), socket, protocol.Request{
				SchemaVersion: protocol.CurrentSchemaVersion,
				RequestID:     "11111111-1111-4111-8111-111111111111",
				Operation:     protocol.OperationInspect,
			}, 30*time.Second, duplicate)
			_ = duplicate.Close()
		}
		_ = lease.Release()
	}
	if err != nil {
		os.Exit(3)
	}
	os.Exit(0)
}

type blockingRecoverySupervisor struct {
	entered chan struct{}
	release chan struct{}
}

func (supervisor *blockingRecoverySupervisor) Run(_ context.Context, tx model.Transaction) (engine.Result, error) {
	return engine.Result{Outcome: engine.OutcomeAlreadyCurrent, Phase: model.PhaseCommitted, ActiveGenerationID: tx.Target.ID, ConvergenceReceiptDigest: digestA}, nil
}

func (supervisor *blockingRecoverySupervisor) Recover(_ context.Context, tx model.Transaction) (engine.Result, error) {
	close(supervisor.entered)
	<-supervisor.release
	return engine.Result{Outcome: engine.OutcomeAlreadyCurrent, Phase: model.PhaseCommitted, ActiveGenerationID: tx.Target.ID, ConvergenceReceiptDigest: digestA}, nil
}

// This exercises the real Unix-socket request route rather than impersonating
// a lock: a child lifecycle host takes the lease, transfers it to the
// supervisor, then crashes. The supervisor-owned duplicate must continue to
// block a concurrent core/plugin mutation until its operation completes.
func TestSupervisorRetainsReceivedLeaseAfterLifecycleHostCrash(t *testing.T) {
	root := t.TempDir()
	lockPath := filepath.Join(root, "lifecycle.lock")
	socketPath := filepath.Join(root, "supervisor.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socketPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, target := targetContract()
	pending := model.Transaction{
		SchemaVersion: model.CurrentTransactionSchemaVersion, ID: transactionID, Profile: model.ProfileProtectedLocal,
		PlanAction: "INSTALL", ReleaseSequence: 12, SecurityEpoch: 3, Phase: model.PhaseSwitched, Revision: 3,
		Target: target, TargetStateSchemas: map[string]uint32{"signer": 1}, TargetCapabilities: capabilities(),
		ManifestDigest: digestA, StateInventoryDigest: digestB, MigrationPlanDigest: digestA,
		SignerPlanDigest: digestB, PlatformDigest: digestA,
	}
	recovery := &blockingRecoverySupervisor{entered: make(chan struct{}), release: make(chan struct{})}
	service := &Service{
		Profile: model.ProfileProtectedLocal, Platform: platform(),
		Store:     pendingFakeStore{fakeStore: fakeStore{}, pending: pending},
		Inventory: &fakeInventory{}, Supervisor: recovery,
	}
	leaseReleased := make(chan struct{})
	server := &Server{
		Handler: service, AllowedUIDs: map[uint32]struct{}{uint32(os.Getuid()): {}},
		ReadTimeout: time.Second, WriteTimeout: time.Second, OperationTimeout: 10 * time.Second,
		OperationLease: func(_ context.Context, _ Peer, received *os.File) (func() error, error) {
			if received == nil {
				return nil, errors.New("missing lifecycle lease handoff")
			}
			lease, err := hostsecurity.AdoptReceivedMutationLock(int(received.Fd()), lockPath, uint32(os.Getuid()))
			if err != nil {
				return nil, err
			}
			return func() error {
				err := lease.Release()
				close(leaseReleased)
				return err
			}, nil
		},
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(ctx, listener) }()
	client := exec.Command(os.Args[0], "-test.run=^")
	client.Env = append(os.Environ(), "FASED_TEST_SUPERVISOR_LEASE_CLIENT=1", "FASED_TEST_SUPERVISOR_LEASE_PATH="+lockPath, "FASED_TEST_SUPERVISOR_LEASE_SOCKET="+socketPath)
	if err := client.Start(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-recovery.entered:
	case <-time.After(5 * time.Second):
		_ = client.Process.Kill()
		t.Fatal("supervisor did not receive the lifecycle lease request")
	}
	if err := client.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = client.Wait()
	if contender, lockErr := hostsecurity.AcquireMutationLock(lockPath, uint32(os.Getuid())); lockErr == nil {
		_ = contender.Release()
		t.Fatal("core/plugin mutation acquired after lifecycle host crash while supervisor operation was active")
	}
	close(recovery.release)
	select {
	case <-leaseReleased:
	case <-time.After(5 * time.Second):
		t.Fatal("supervisor did not release the received lifecycle lease")
	}
	if contender, lockErr := hostsecurity.AcquireMutationLock(lockPath, uint32(os.Getuid())); lockErr != nil {
		t.Fatalf("mutation lease remained held after supervisor operation: %v", lockErr)
	} else if err := contender.Release(); err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := <-serveDone; err != nil {
		t.Fatal(err)
	}
}
