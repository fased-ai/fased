package main

import (
	"bytes"
	"context"
	"errors"
	"fased-lifecycled/hostsecurity"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"fased-lifecycled/model"
	"fased-lifecycled/platform"
	"fased-lifecycled/protocol"
	"fased-lifecycled/store"
	"golang.org/x/sys/unix"
)

func init() {
	if os.Getenv("FASED_TEST_INITIALIZATION_LEASE_HANDOFF") != "1" {
		return
	}
	path := os.Getenv("FASED_TEST_INITIALIZATION_LEASE_PATH")
	lock, err := acquireInheritedInitializationLockAt(3, path, uint32(os.Getuid()))
	if err == nil {
		err = lock.Release()
	}
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(3)
	}
	os.Exit(0)
}

type missingCandidateAuthority struct{ err error }

func (missing missingCandidateAuthority) ReadCandidateAuthority(string) (store.CandidateAuthority, error) {
	return store.CandidateAuthority{}, missing.err
}

func TestManagedInitializationFastPathAdoptsOnlySchemaOneWithoutCandidateAuthority(t *testing.T) {
	manifest := model.Manifest{
		SchemaVersion: 1,
		ActiveGeneration: &model.Generation{
			ID: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
	}
	if _, bound, err := managedFastPathAuthority(missingCandidateAuthority{err: os.ErrNotExist}, manifest); err != nil || bound {
		t.Fatalf("schema-one predecessor did not select full initialization: bound=%v err=%v", bound, err)
	}
	manifest.SchemaVersion = model.CurrentManifestSchemaVersion
	if _, _, err := managedFastPathAuthority(missingCandidateAuthority{err: os.ErrNotExist}, manifest); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("schema-two authority loss did not fail closed: %v", err)
	}
	manifest.SchemaVersion = 1
	corrupt := errors.New("candidate authority is malformed")
	if _, _, err := managedFastPathAuthority(missingCandidateAuthority{err: corrupt}, manifest); !errors.Is(err, corrupt) {
		t.Fatalf("schema-one authority corruption was treated as absence: %v", err)
	}
}

func TestManagedInitializationFastPathRequiresExactPolicyAndReleaseAuthority(t *testing.T) {
	config, err := platform.NewConfig(
		model.ProfileProtectedLocal, "0123456789abcdef", "/home/owner/.fased",
		platform.Principal{UID: 1000, GID: 1000},
		platform.Principal{UID: 1001, GID: 1001},
		platform.Principal{UID: 1002, GID: 1002},
	)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := config.Identity()
	if err != nil {
		t.Fatal(err)
	}
	generationID := "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	digest := "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	manifest := model.Manifest{Profile: config.Profile, Platform: identity, ActiveGeneration: &model.Generation{ID: generationID}}
	operator := platform.AccountRecord{Name: "owner", UID: 1000, GID: 1000, Home: "/home/owner"}
	authority := store.CandidateAuthority{
		GenerationID: generationID, ReleaseSequence: 5, SecurityEpoch: 1,
		ManifestMin: 1, ManifestMax: 2, ReleaseIndex: digest, ReleaseAuthority: digest, PluginLockDigest: digest,
	}
	policy := platform.UpdatePolicy{SchemaVersion: 1, Profile: config.Profile, InstanceID: config.InstanceID, Channel: "beta"}
	fast, err := managedInitializationInputsMatch(manifest, config, operator, config.OwnerStateRoot, config.GatewayPort, "beta",
		authority, policy, 5, 1, 1, 2, digest, digest, digest)
	if err != nil || !fast {
		t.Fatalf("exact managed current inputs did not select the no-bootstrap path: fast=%v err=%v", fast, err)
	}
	policy.Channel = "stable"
	fast, err = managedInitializationInputsMatch(manifest, config, operator, config.OwnerStateRoot, config.GatewayPort, "beta",
		authority, policy, 5, 1, 1, 2, digest, digest, digest)
	if err != nil || fast {
		t.Fatalf("different root channel policy selected the no-bootstrap path: fast=%v err=%v", fast, err)
	}
	policy.Channel = "beta"
	fast, err = managedInitializationInputsMatch(manifest, config, operator, config.OwnerStateRoot, config.GatewayPort, "beta",
		authority, policy, 6, 1, 1, 2, digest, digest, digest)
	if err != nil || fast {
		t.Fatalf("different signed release authority selected the no-bootstrap path: fast=%v err=%v", fast, err)
	}
	operator.Home = "/home/other"
	if _, err := managedInitializationInputsMatch(manifest, config, operator, config.OwnerStateRoot, config.GatewayPort, "beta",
		authority, policy, 5, 1, 1, 2, digest, digest, digest); err == nil {
		t.Fatal("different operator identity was accepted for the managed fast path")
	}
}

func TestWriteConvergenceResponseEmitsBoundedFailureBeforeReturningError(t *testing.T) {
	for _, outcome := range []string{"ROLLED_BACK", "RECOVERY_PENDING", "REPAIR_REQUIRED", "REJECT_UNKNOWN_NEWER", "REJECT_DOWNGRADE"} {
		t.Run(outcome, func(t *testing.T) {
			var output bytes.Buffer
			response := protocol.Response{SchemaVersion: 1, RequestID: "11111111-1111-4111-8111-111111111111", Outcome: outcome, Detail: "injected failure"}
			err := writeConvergenceResponse(&output, response)
			if err == nil || !strings.Contains(err.Error(), outcome) || !strings.Contains(output.String(), `"outcome":"`+outcome+`"`) {
				t.Fatalf("bounded result was not emitted before failure: output=%q err=%v", output.String(), err)
			}
		})
	}
}

func TestStateAccessCheckUsesKernelAccessAndRejectsSymlinks(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "state.json")
	if err := os.WriteFile(file, []byte("state\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := runStateAccessCheck([]string{"--path", file}); err != nil {
		t.Fatalf("current identity could not access writable state: %v", err)
	}
	if err := runStateAccessCheck([]string{"--path", root, "--directory"}); err != nil {
		t.Fatalf("current identity could not access writable state directory: %v", err)
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(file, alias); err != nil {
		t.Fatal(err)
	}
	if err := runStateAccessCheck([]string{"--path", alias}); err == nil {
		t.Fatal("state access check followed a symlink")
	}
}

func TestPrepareSocketParentConvergesAuthorizedTraversal(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "runtime")
	if err := os.Mkdir(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := prepareSocketParent(parent, os.Getegid()); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(parent, "request.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	info, err := os.Lstat(parent)
	if err != nil {
		t.Fatal(err)
	}
	stat := info.Sys().(*syscall.Stat_t)
	if info.Mode().Perm() != 0o710 || stat.Uid != uint32(os.Geteuid()) || stat.Gid != uint32(os.Getegid()) {
		t.Fatalf("%s identity = %d:%d %o, want %d:%d 710", parent, stat.Uid, stat.Gid, info.Mode().Perm(), os.Geteuid(), os.Getegid())
	}
	connection, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("authorized group could not traverse to lifecycle socket: %v", err)
	}
	_ = connection.Close()
}

func TestInitializationLockSerializesAndReleases(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bootstrap.lock")
	first, err := acquireInitializationLockAt(path, uint32(os.Geteuid()))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := acquireInitializationLockAt(path, uint32(os.Geteuid())); err == nil {
		t.Fatal("concurrent bootstrap lock acquisition succeeded")
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	second, err := acquireInitializationLockAt(path, uint32(os.Geteuid()))
	if err != nil {
		t.Fatal(err)
	}
	if err := second.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestInitializationLockAdoptsBootstrapHandoffWithoutUnlockingParent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bootstrap.lock")
	parent, err := hostsecurity.AcquireMutationLock(path, uint32(os.Getuid()))
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Release()
	childLease, err := parent.DupForChild()
	if err != nil {
		t.Fatal(err)
	}
	defer childLease.Close()
	command := exec.Command(os.Args[0], "-test.run=^$")
	command.ExtraFiles = []*os.File{childLease}
	command.Env = append(os.Environ(), "FASED_TEST_INITIALIZATION_LEASE_HANDOFF=1", "FASED_TEST_INITIALIZATION_LEASE_PATH="+path)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("inherited initialization lease failed: %v: %s", err, output)
	}
	if contender, err := hostsecurity.AcquireMutationLock(path, uint32(os.Getuid())); err == nil {
		_ = contender.Release()
		t.Fatal("child initialization unlocked the bootstrap parent lease")
	}
}

func TestInitializationLockRejectsInheritedDescriptorForWrongPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bootstrap.lock")
	parent, err := hostsecurity.AcquireMutationLock(path, uint32(os.Getuid()))
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Release()
	childLease, err := parent.DupForChild()
	if err != nil {
		t.Fatal(err)
	}
	defer childLease.Close()
	command := exec.Command(os.Args[0], "-test.run=^$")
	command.ExtraFiles = []*os.File{childLease}
	command.Env = append(os.Environ(), "FASED_TEST_INITIALIZATION_LEASE_HANDOFF=1", "FASED_TEST_INITIALIZATION_LEASE_PATH="+filepath.Join(filepath.Dir(path), "other.lock"))
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "differs from the expected lock") {
		t.Fatalf("wrong inherited descriptor path was accepted: err=%v output=%s", err, output)
	}
}

func TestStoppedSupervisorPendingRecoveryAdoptsStartupLeaseBeforeSocket(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "fsl-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	config := platform.Config{LifecycleRoot: root}
	lockPath := filepath.Join(root, "lifecycle.lock")
	initializationLease, err := hostsecurity.AcquireMutationLock(lockPath, uint32(os.Geteuid()))
	if err != nil {
		t.Fatal(err)
	}
	initialization := &initializationMutationLock{handoff: initializationLease}
	broker, err := startSupervisorStartupLeaseBroker(context.Background(), config, initialization)
	if err != nil {
		_ = initialization.Release()
		t.Fatal(err)
	}
	recovered := false
	err = recoverStoppedSupervisorPending(context.Background(), config, lockPath,
		func() (model.Transaction, error) { return model.Transaction{}, nil },
		func(context.Context) error {
			if contender, contenderErr := hostsecurity.AcquireMutationLock(lockPath, uint32(os.Geteuid())); contenderErr == nil {
				_ = contender.Release()
				return errors.New("pending recovery did not retain the shared lifecycle lease")
			}
			recovered = true
			return nil
		})
	if err != nil {
		_ = broker.Close()
		_ = initialization.Release()
		t.Fatalf("stopped supervisor pending recovery self-deadlocked or released its lease: %v", err)
	}
	if !recovered {
		t.Fatal("stopped supervisor did not replay the pending transaction")
	}
	// Only after terminal pending recovery may the stopped supervisor expose its
	// public socket; the initialize lease continues through its first request.
	if err := broker.Close(); err != nil {
		t.Fatal(err)
	}
	if err := initialization.Release(); err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(root, "supervisor.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socketPath, Net: "unix"})
	if err != nil {
		t.Fatalf("supervisor socket did not start after pending recovery: %v", err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestStandaloneSupervisorPendingRecoveryAcquiresSharedLease(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "fsl-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	config := platform.Config{LifecycleRoot: root}
	lockPath := filepath.Join(config.LifecycleRoot, "lifecycle.lock")
	lease, err := acquireSupervisorStartupLease(context.Background(), config, lockPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := hostsecurity.AcquireMutationLock(lockPath, uint32(os.Geteuid())); err == nil {
		t.Fatal("standalone supervisor did not acquire the shared lifecycle lease")
	}
	if err := lease.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestStartupLeaseBrokerRejectsInvalidRequest(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "fsl-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	config := platform.Config{LifecycleRoot: root}
	lock, err := hostsecurity.AcquireMutationLock(filepath.Join(root, "lifecycle.lock"), uint32(os.Geteuid()))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	broker, err := startSupervisorStartupLeaseBroker(context.Background(), config, &initializationMutationLock{handoff: lock})
	if err != nil {
		t.Fatal(err)
	}
	connection, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: startupLeaseSocketPath(config), Net: "unix"})
	if err != nil {
		_ = broker.Close()
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		broker.mu.Lock()
		active := broker.active != nil
		broker.mu.Unlock()
		if active {
			break
		}
		if time.Now().After(deadline) {
			_ = connection.Close()
			_ = broker.Close()
			t.Fatal("broker did not register the invalid-request peer")
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := connection.Write([]byte{0}); err != nil {
		_ = connection.Close()
		_ = broker.Close()
		t.Fatal(err)
	}
	<-broker.done
	_ = connection.Close()
	if err := broker.Close(); err == nil || !strings.Contains(err.Error(), "request is invalid") {
		t.Fatalf("invalid startup lease request was accepted: %v", err)
	}
}

func TestStartupLeaseBrokerCloseInterruptsConnectedStalledPeer(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "fsl-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	config := platform.Config{LifecycleRoot: root}
	lock, err := hostsecurity.AcquireMutationLock(filepath.Join(root, "lifecycle.lock"), uint32(os.Geteuid()))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	broker, err := startSupervisorStartupLeaseBroker(context.Background(), config, &initializationMutationLock{handoff: lock})
	if err != nil {
		t.Fatal(err)
	}
	client, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: startupLeaseSocketPath(config), Net: "unix"})
	if err != nil {
		_ = broker.Close()
		t.Fatal(err)
	}
	defer client.Close()
	deadline := time.Now().Add(time.Second)
	for {
		broker.mu.Lock()
		active := broker.active != nil
		broker.mu.Unlock()
		if active {
			break
		}
		if time.Now().After(deadline) {
			_ = broker.Close()
			t.Fatal("broker did not register the connected stalled peer")
		}
		time.Sleep(time.Millisecond)
	}
	started := time.Now()
	closeErr := broker.Close()
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("broker close waited on stalled peer for %s", elapsed)
	}
	if closeErr == nil || !strings.Contains(closeErr.Error(), "request is invalid") {
		t.Fatalf("stalled peer broker failure was not propagated: %v", closeErr)
	}
}

func TestStartupLeaseAdoptionClosesInvalidOrTruncatedDescriptors(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("descriptor accounting is Linux-specific")
	}
	for _, truncated := range []bool{false, true} {
		t.Run(fmt.Sprintf("truncated=%t", truncated), func(t *testing.T) {
			root, err := os.MkdirTemp("/tmp", "fsl-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(root)
			path := filepath.Join(root, "broker.sock")
			listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			lease, err := os.OpenFile(filepath.Join(root, "lease.lock"), os.O_CREATE|os.O_RDWR, 0o600)
			if err != nil {
				t.Fatal(err)
			}
			defer lease.Close()
			sent := make(chan error, 1)
			go func() {
				connection, acceptErr := listener.AcceptUnix()
				if acceptErr != nil {
					sent <- acceptErr
					return
				}
				n, _, writeErr := connection.WriteMsgUnix([]byte{0}, unix.UnixRights(int(lease.Fd())), nil)
				if writeErr == nil && n != 1 {
					writeErr = errors.New("short broker test response")
				}
				closeErr := connection.Close()
				if writeErr == nil {
					writeErr = closeErr
				}
				sent <- writeErr
			}()
			client, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			data := make([]byte, 1)
			oobSize := unix.CmsgSpace(4 * 4)
			if truncated {
				oobSize = 1
			}
			oob := make([]byte, oobSize)
			n, oobn, flags, _, readErr := client.ReadMsgUnix(data, oob)
			if err := <-sent; err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadDir("/proc/self/fd")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := adoptSupervisorStartupLease(data, oob[:oobn], flags, n, readErr, filepath.Join(root, "lifecycle.lock")); err == nil {
				t.Fatal("invalid or truncated startup lease descriptor was accepted")
			}
			after, err := os.ReadDir("/proc/self/fd")
			if err != nil {
				t.Fatal(err)
			}
			expected := len(before)
			if !truncated {
				expected--
			}
			if len(after) != expected {
				t.Fatalf("startup lease invalid path leaked descriptors: before=%d after=%d want=%d", len(before), len(after), expected)
			}
		})
	}
}

func TestBootstrapPathRemovalFailuresPreserveCriticalErrors(t *testing.T) {
	removal := &platform.BootstrapPathRemovalError{Path: "/created", Err: syscall.ENOTEMPTY}
	selected, only := bootstrapPathRemovalFailures(removal)
	if !only || len(selected) != 1 || selected[0].Path != "/created" {
		t.Fatalf("typed removal was not selected: only=%v selected=%+v", only, selected)
	}
	critical := errors.New("systemd rollback failed")
	if _, only := bootstrapPathRemovalFailures(errors.Join(removal, critical)); only {
		t.Fatal("critical rollback failure was incorrectly treated as removable residue")
	}
}

func TestPrepareSocketParentRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "runtime")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := prepareSocketParent(link, os.Getegid()); err == nil {
		t.Fatal("symlinked lifecycle socket directory was accepted")
	}
}

func TestInitializationApplyArgumentsSelectsOneVerifiedInput(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "generation.tar.gz")
	topology := "local-user-systemd-v1"
	dependency := filepath.Join(t.TempDir(), "dependencies.tar.gz")
	indexDigest, releaseAuthorityDigest, pluginLockDigest := "sha256:"+strings.Repeat("a", 64), "sha256:"+strings.Repeat("b", 64), "sha256:"+strings.Repeat("c", 64)
	got, err := initializationApplyArguments("/platform.json", archive, dependency, topology, "0.1.75", 12, 3, 1, 2, indexDigest, releaseAuthorityDigest, pluginLockDigest)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--config", "/platform.json", "--generation-archive", archive, "--release-sequence", "12", "--security-epoch", "3", "--manifest-protocol-min", "1", "--manifest-protocol-max", "2", "--release-index-digest", indexDigest, "--release-authority-digest", releaseAuthorityDigest, "--plugin-lock-digest", pluginLockDigest, "--dependency-archive", dependency, "--source-topology", topology, "--public-predecessor-version", "0.1.75"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("arguments = %#v, want %#v", got, want)
	}
	for _, input := range []string{"", "relative"} {
		if _, err := initializationApplyArguments("/platform.json", input, "", "", "", 12, 3, 1, 2, indexDigest, releaseAuthorityDigest, pluginLockDigest); err == nil {
			t.Fatalf("expected generation input %q to be rejected", input)
		}
	}
	if _, err := initializationApplyArguments("/platform.json", archive, "", topology, "", 12, 3, 1, 2, indexDigest, releaseAuthorityDigest, pluginLockDigest); err == nil {
		t.Fatal("bridge apply accepted missing predecessor version")
	}
	if _, err := initializationApplyArguments("/platform.json", archive, "", "", "0.1.75", 12, 3, 1, 2, indexDigest, releaseAuthorityDigest, pluginLockDigest); err == nil {
		t.Fatal("bridge apply accepted predecessor version without topology")
	}
	if _, err := initializationApplyArguments("/platform.json", archive, "", "", "", 0, 0, 0, 0, "", "", ""); err == nil {
		t.Fatal("initialization accepted missing signed release authority")
	}
}

func TestLifecycleRequestArgumentsBindPublicPredecessorEvidence(t *testing.T) {
	arguments := []string{"--socket", "/run/fased/test.sock", "--operation", "CONVERGE", "--request-id", "018f47d2-5a6b-7c8d-9e0f-123456789abc",
		"--target-generation", "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "--expected-manifest", "absent",
		"--source-topology", "local-user-systemd-v1", "--public-predecessor-version", "0.1.75"}
	socket, request, err := parseLifecycleRequestArguments(arguments)
	if err != nil || socket != "/run/fased/test.sock" || request.SourceTopology != "local-user-systemd-v1" || request.PublicPredecessorVersion != "0.1.75" {
		t.Fatalf("request predecessor evidence was not forwarded: socket=%q request=%+v err=%v", socket, request, err)
	}
	if _, _, err := parseLifecycleRequestArguments(arguments[:len(arguments)-2]); err == nil {
		t.Fatal("request accepted predecessor topology without its verified version")
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
