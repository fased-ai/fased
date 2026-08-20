package main

import (
	"context"
	"encoding/json"
	"errors"
	"fased-lifecycled/daemon"
	"fased-lifecycled/hostsecurity"
	"fased-lifecycled/model"
	"fased-lifecycled/participant"
	"fased-lifecycled/protocol"
	"fmt"
	"io"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func init() {
	if os.Getenv("FASED_TEST_INITIALIZE_LEASE_HANDOFF") != "1" {
		return
	}
	path := os.Getenv("FASED_TEST_INITIALIZE_LEASE_PATH")
	lease, err := hostsecurity.AdoptMutationLock(3, path, uint32(os.Getuid()))
	if err == nil {
		defer lease.Release()
		if contender, contenderErr := hostsecurity.AcquireMutationLock(path, uint32(os.Getuid())); contenderErr == nil {
			_ = contender.Release()
			err = errors.New("plugin acquired inherited lifecycle lease")
		}
	}
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(3)
	}
	digest := "sha256:" + strings.Repeat("a", 64)
	_ = json.NewEncoder(os.Stdout).Encode(protocol.Response{SchemaVersion: protocol.CurrentSchemaVersion, Outcome: "UPDATED", ActiveGenerationID: digest, ConvergenceReceiptDigest: digest})
	os.Exit(0)
}

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

func TestInvokeLifecycleHostHandsSharedLeaseToInitialize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lifecycle.lock")
	lease, err := hostsecurity.AcquireMutationLock(path, uint32(os.Getuid()))
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	hostPath, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("FASED_TEST_INITIALIZE_LEASE_HANDOFF", "1")
	t.Setenv("FASED_TEST_INITIALIZE_LEASE_PATH", path)
	digest := "sha256:" + strings.Repeat("a", 64)
	response, _, err := invokeLifecycleHost(context.Background(), publicLifecycleRequest{Profile: model.ProfileProtectedLocal, Channel: "beta"}, publicOperator{Name: "owner", Home: t.TempDir()}, bootstrapResult{HostPath: hostPath, ApplicationPath: "/tmp/application", ReleaseSequence: 1, SecurityEpoch: 1, ManifestProtocolMin: 1, ManifestProtocolMax: 1, ReleaseIndexDigest: digest, ReleaseAuthorityDigest: digest, PluginLockDigest: digest}, lease)
	if err != nil || response.Outcome != "UPDATED" {
		t.Fatalf("initialize lease handoff did not converge: response=%+v err=%v", response, err)
	}
	if contender, lockErr := acquireManagedPluginMutationLock(path, uint32(os.Getuid())); lockErr == nil {
		_ = contender.Release()
		t.Fatal("child initialize released the parent lifecycle lease")
	}
}

type blockingRollbackHandler struct {
	entered chan struct{}
	release chan struct{}
}

func (handler *blockingRollbackHandler) Handle(_ context.Context, request protocol.Request) (protocol.Response, error) {
	close(handler.entered)
	<-handler.release
	return protocol.Response{SchemaVersion: protocol.CurrentSchemaVersion, RequestID: request.RequestID, Outcome: "UPDATED", ActiveGenerationID: request.TargetGenerationID, ConvergenceReceiptDigest: request.TargetGenerationID}, nil
}

func TestManagedRollbackRouteTransfersHeldLeaseWithoutSelfDeadlock(t *testing.T) {
	root := t.TempDir()
	lockPath := filepath.Join(root, "lifecycle.lock")
	lease, err := hostsecurity.AcquireMutationLock(lockPath, uint32(os.Getuid()))
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	socketPath := filepath.Join(root, "supervisor.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socketPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	handler := &blockingRollbackHandler{entered: make(chan struct{}), release: make(chan struct{})}
	server := &daemon.Server{
		Handler: handler, AllowedUIDs: map[uint32]struct{}{0: {}},
		ReadTimeout: time.Second, WriteTimeout: time.Second, OperationTimeout: 5 * time.Second,
		OperationLease: func(_ context.Context, peer daemon.Peer, received *os.File) (func() error, error) {
			if peer.UID != 0 || received == nil {
				return nil, errors.New("rollback route did not transfer a root lifecycle lease")
			}
			adopted, adoptErr := hostsecurity.AdoptReceivedMutationLock(int(received.Fd()), lockPath, uint32(os.Getuid()))
			if adoptErr != nil {
				return nil, adoptErr
			}
			return adopted.Release, nil
		},
	}
	serverDone := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.AcceptUnix()
		if acceptErr != nil {
			serverDone <- acceptErr
			return
		}
		defer connection.Close()
		serverDone <- server.HandlePeer(context.Background(), connection, daemon.Peer{UID: 0})
	}()
	now := time.Now().UTC().Truncate(time.Second)
	request := protocol.Request{SchemaVersion: protocol.CurrentSchemaVersion, RequestID: "11111111-1111-4111-8111-111111111111", Operation: protocol.OperationRollback,
		TargetGenerationID: "sha256:" + strings.Repeat("a", 64), ExpectedManifestDigest: "sha256:" + strings.Repeat("b", 64),
		RollbackAuthorization: &model.RollbackAuthorization{SchemaVersion: model.RollbackAuthorizationSchemaVersion,
			CurrentGenerationID: "sha256:" + strings.Repeat("b", 64), TargetGenerationID: "sha256:" + strings.Repeat("a", 64), CurrentReleaseSequence: 2, TargetReleaseSequence: 1, SecurityEpoch: 1,
			Operator: "release-owner", Reason: "restore verified previous generation", IssuedAt: now.Add(-time.Minute).Format(time.RFC3339), ExpiresAt: now.Add(time.Minute).Format(time.RFC3339), EnvelopeDigest: "sha256:" + strings.Repeat("c", 64)}}
	result := make(chan error, 1)
	go func() {
		response, callErr := callManagedRollback(context.Background(), socketPath, request, 5*time.Second, lease)
		if callErr != nil || response.Outcome != "UPDATED" {
			result <- fmt.Errorf("rollback call response=%+v err=%w", response, callErr)
			return
		}
		result <- nil
	}()
	select {
	case <-handler.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("rollback self-deadlocked before the supervisor handler")
	}
	if contender, lockErr := acquireManagedPluginMutationLock(lockPath, uint32(os.Getuid())); lockErr == nil {
		_ = contender.Release()
		t.Fatal("plugin mutation acquired while rollback supervisor operation held the shared lease")
	}
	close(handler.release)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
}

func TestFreshOnboardingCommitTransfersHeldLeaseWithoutSelfDeadlock(t *testing.T) {
	root := t.TempDir()
	lockPath := filepath.Join(root, "lifecycle.lock")
	lease, err := hostsecurity.AcquireMutationLock(lockPath, uint32(os.Getuid()))
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	socketPath := filepath.Join(root, "supervisor.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socketPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	handler := &blockingRollbackHandler{entered: make(chan struct{}), release: make(chan struct{})}
	server := &daemon.Server{
		Handler: handler, AllowedUIDs: map[uint32]struct{}{uint32(os.Getuid()): {}},
		ReadTimeout: time.Second, WriteTimeout: time.Second, OperationTimeout: 5 * time.Second,
		OperationLease: func(_ context.Context, _ daemon.Peer, received *os.File) (func() error, error) {
			if received == nil {
				return nil, errors.New("fresh onboarding did not transfer the lifecycle lease")
			}
			adopted, adoptErr := hostsecurity.AdoptReceivedMutationLock(int(received.Fd()), lockPath, uint32(os.Getuid()))
			if adoptErr != nil {
				return nil, adoptErr
			}
			return adopted.Release, nil
		},
	}
	serverDone := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.AcceptUnix()
		if acceptErr != nil {
			serverDone <- acceptErr
			return
		}
		defer connection.Close()
		serverDone <- server.HandlePeer(context.Background(), connection, daemon.Peer{UID: uint32(os.Getuid())})
	}()
	requestID := "11111111-1111-4111-8111-111111111111"
	result := make(chan error, 1)
	go func() {
		response, callErr := completeOnboardingWithLease(context.Background(), socketPath, requestID, lease)
		if callErr != nil || response.Outcome != "UPDATED" {
			result <- fmt.Errorf("fresh onboarding response=%+v err=%v", response, callErr)
			return
		}
		result <- nil
	}()
	select {
	case <-handler.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("fresh onboarding commit self-deadlocked before supervisor handling")
	}
	if contender, contenderErr := acquireManagedPluginMutationLock(lockPath, uint32(os.Getuid())); contenderErr == nil {
		_ = contender.Release()
		t.Fatal("plugin mutation acquired while fresh onboarding held the shared lease")
	}
	close(handler.release)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if err := <-serverDone; err != nil {
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
