package hostsecurity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHostingProgressUsesSetupFrame(t *testing.T) {
	got := formatHostingProgressFrame("Fased: configuring private Tailscale Serve...")
	for _, expected := range []string{"HOSTING SETUP", "configuring private Tailscale Serve", "╭─", "╰─"} {
		if !strings.Contains(got, expected) {
			t.Fatalf("progress frame %q does not contain %q", got, expected)
		}
	}
}

type fakeHost struct {
	inspection           Inspection
	calls                []string
	serve                string
	signerWebAuthn       string
	fail                 string
	prerequisitesMissing bool
}

func (host *fakeHost) call(name string) error {
	host.calls = append(host.calls, name)
	if host.fail == name {
		return errors.New("fixture failure")
	}
	return nil
}
func (host *fakeHost) Inspect(context.Context, uint16, string) (Inspection, error) {
	host.calls = append(host.calls, "inspect")
	if !host.prerequisitesMissing {
		host.inspection.LifecyclePrerequisitesReady = true
	}
	return host.inspection, nil
}
func (host *fakeHost) SnapshotTailscaleInstall(context.Context) (string, error) {
	if err := host.call("snapshot-tailscale-install"); err != nil {
		return "", err
	}
	return "tailscale-install-snapshot-v1", nil
}
func (host *fakeHost) InstallTailscale(context.Context, io.Writer) error {
	if err := host.call("install-tailscale"); err != nil {
		return err
	}
	host.inspection.TailscaleInstalled = true
	return nil
}
func (host *fakeHost) RestoreTailscaleInstall(context.Context, string) error {
	return host.call("restore-tailscale-install")
}
func (host *fakeHost) EnableTailscale(context.Context) error {
	if err := host.call("enable-tailscale"); err != nil {
		return err
	}
	host.inspection.TailscaleRunning = true
	return nil
}
func (host *fakeHost) Authenticate(context.Context, string, bool, io.Writer) error {
	if err := host.call("authenticate"); err != nil {
		return err
	}
	host.inspection.Authenticated = true
	host.inspection.TailscaleDNS = "fased.tailnet.ts.net"
	host.inspection.TailscaleIPv4 = "100.64.1.9"
	host.inspection.TailscaleVersion = "1.88.1"
	return nil
}
func (host *fakeHost) SnapshotPrivateServe(context.Context) (string, error) {
	if err := host.call("snapshot-serve"); err != nil {
		return "", err
	}
	return host.serve, nil
}
func (host *fakeHost) ConfigurePrivateServe(context.Context, uint16) error {
	if err := host.call("configure-serve"); err != nil {
		return err
	}
	host.serve = "configured"
	host.inspection.PrivateServeReady = true
	return nil
}
func (host *fakeHost) RestorePrivateServe(_ context.Context, previous string) error {
	if err := host.call("restore-serve"); err != nil {
		return err
	}
	host.serve = previous
	host.inspection.PrivateServeReady = previous == "configured"
	return nil
}
func (host *fakeHost) SnapshotSignerWebAuthn(context.Context) (string, bool, error) {
	if err := host.call("snapshot-signer-webauthn"); err != nil {
		return "", false, err
	}
	return host.signerWebAuthn, host.signerWebAuthn != "", nil
}
func (host *fakeHost) ConfigureSignerWebAuthn(_ context.Context, dns string, _ bool) error {
	if err := host.call("configure-signer-webauthn"); err != nil {
		return err
	}
	host.signerWebAuthn = dns
	host.inspection.SignerWebAuthnReady = true
	return nil
}
func (host *fakeHost) RestoreSignerWebAuthn(_ context.Context, previous string, existed bool) error {
	if err := host.call("restore-signer-webauthn"); err != nil {
		return err
	}
	host.signerWebAuthn = previous
	host.inspection.SignerWebAuthnReady = existed
	return nil
}
func (host *fakeHost) LogoutTailscale(context.Context) error {
	if err := host.call("logout"); err != nil {
		return err
	}
	host.inspection.Authenticated = false
	return nil
}
func (host *fakeHost) SnapshotHardening(context.Context, string, io.Writer) (string, error) {
	if err := host.call("snapshot-hardening"); err != nil {
		return "", err
	}
	return "snapshot-v1", nil
}
func (host *fakeHost) StageHardening(context.Context, string, io.Writer) error {
	return host.call("stage-hardening")
}
func (host *fakeHost) StageLifecyclePrerequisites(context.Context, string, io.Writer) error {
	if err := host.call("stage-lifecycle-prerequisites"); err != nil {
		return err
	}
	host.inspection.LifecyclePrerequisitesReady = true
	host.prerequisitesMissing = false
	return nil
}
func (host *fakeHost) CommitHardening(context.Context, string) error {
	if err := host.call("commit-hardening"); err != nil {
		return err
	}
	host.inspection.HardeningReady = true
	return nil
}
func (host *fakeHost) RestoreHardening(context.Context, string) error {
	if err := host.call("restore-hardening"); err != nil {
		return err
	}
	host.inspection.HardeningReady = false
	return nil
}

func fixture(t *testing.T) (Participant, *fakeHost, Request) {
	t.Helper()
	root := t.TempDir()
	host := &fakeHost{inspection: Inspection{LifecyclePrerequisitesReady: true}}
	participant := Participant{Store: Store{StatePath: filepath.Join(root, "state.json"), ReceiptPath: filepath.Join(root, "hosting-prerequisites"), ExpectedUID: uint32(os.Getuid())}, Host: host}
	request := Request{
		TransactionID:    "01234567-89ab-4cde-8fab-0123456789ab",
		Release:          "1.2.3-rc.4",
		Channel:          "beta",
		GatewayPort:      18789,
		OperatorUser:     "app",
		Interactive:      true,
		PlatformIdentity: "linux/x64",
		TrustRootSHA256:  strings.Repeat("a", 64),
	}
	return participant, host, request
}

func markRuntimeReady(t *testing.T, participant Participant, transactionID string) (State, error) {
	t.Helper()
	return participant.BindRuntimeReady(
		context.Background(),
		transactionID,
		"sha256:"+strings.Repeat("b", 64),
		"sha256:"+strings.Repeat("c", 64),
		false,
	)
}

func terminationFixture(root string, target Phase) (Participant, *fakeHost, Request) {
	host := &fakeHost{inspection: Inspection{LifecyclePrerequisitesReady: true}}
	store := Store{
		StatePath: filepath.Join(root, "state.json"), ReceiptPath: filepath.Join(root, "hosting-prerequisites"),
		ExpectedUID: uint32(os.Getuid()),
	}
	if target != "" {
		store.afterWriteState = func(state State) {
			if state.Phase == target {
				os.Exit(73)
			}
		}
	}
	request := Request{
		TransactionID: "01234567-89ab-4cde-8fab-0123456789ab", Release: "1.2.3-rc.4",
		Channel: "beta", GatewayPort: 18789, OperatorUser: "app", Interactive: true,
		PlatformIdentity: "linux/x64", TrustRootSHA256: strings.Repeat("a", 64),
		OnboardingRequired: target != PhaseRuntimeReady,
	}
	return Participant{Store: store, Host: host}, host, request
}

func TestHostingCoordinatorTerminationProcess(t *testing.T) {
	target := Phase(os.Getenv("FASED_HOSTING_TERMINATION_PHASE"))
	root := os.Getenv("FASED_HOSTING_TERMINATION_ROOT")
	if target == "" || root == "" {
		return
	}
	participant, host, request := terminationFixture(root, target)
	state, err := participant.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	host.inspection.SignerReady = true
	state, err = participant.BindRuntimeReady(context.Background(), state.TransactionID,
		"sha256:"+strings.Repeat("b", 64), "sha256:"+strings.Repeat("c", 64), request.OnboardingRequired)
	if err != nil {
		t.Fatal(err)
	}
	if state.Phase == PhaseOnboardingPending {
		state, err = participant.MarkOnboardingComplete(state.TransactionID)
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := participant.Commit(context.Background(), state.TransactionID, true); err != nil {
		t.Fatal(err)
	}
	t.Fatalf("termination phase %s was not reached", target)
}

func recoveredTerminationHost(state State) *fakeHost {
	dns := state.TailscaleDNS
	if dns == "" {
		dns = "fased.tailnet.ts.net"
	}
	ipv4 := state.TailscaleIPv4
	if ipv4 == "" {
		ipv4 = "100.64.1.9"
	}
	version := state.TailscaleVersion
	if version == "" {
		version = "1.88.1"
	}
	hardened := state.Phase == PhaseHardeningReady || state.Phase == PhaseCommitted
	return &fakeHost{
		serve: dns, signerWebAuthn: dns,
		inspection: Inspection{
			LifecyclePrerequisitesReady: true, TailscaleInstalled: true, TailscaleRunning: true,
			Authenticated: true, TailscaleDNS: dns, TailscaleIPv4: ipv4, TailscaleVersion: version,
			PrivateServeReady: true, SignerWebAuthnReady: true, SignerReady: true, HardeningReady: hardened,
		},
	}
}

func completeTerminatedCoordinator(t *testing.T, participant Participant, host *fakeHost, request Request) State {
	t.Helper()
	state, err := participant.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if state.Phase == PhaseCommitted {
		return state
	}
	host.inspection.SignerReady = true
	state, err = participant.BindRuntimeReady(context.Background(), state.TransactionID,
		"sha256:"+strings.Repeat("d", 64), "sha256:"+strings.Repeat("e", 64), request.OnboardingRequired)
	if err != nil {
		t.Fatal(err)
	}
	if state.Phase == PhaseOnboardingPending {
		state, err = participant.MarkOnboardingComplete(state.TransactionID)
		if err != nil {
			t.Fatal(err)
		}
	}
	state, err = participant.Commit(context.Background(), state.TransactionID, true)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func TestHostingCoordinatorTerminationRecoveryMatrix(t *testing.T) {
	phases := []Phase{
		PhasePreflight, PhasePrerequisitesReady, PhasePrivateNetworkReady, PhaseGenerationReady,
		PhaseRuntimeReady, PhaseOnboardingPending, PhaseOnboardingComplete, PhaseHardening,
		PhaseHardeningReady, PhaseCommitted,
	}
	for _, phase := range phases {
		phase := phase
		for _, mode := range []string{"same-release", "newer-release", "mismatched-environment"} {
			mode := mode
			t.Run(string(phase)+"/"+mode, func(t *testing.T) {
				root := t.TempDir()
				command := exec.Command(os.Args[0], "-test.run=^TestHostingCoordinatorTerminationProcess$")
				command.Env = append(os.Environ(),
					"FASED_HOSTING_TERMINATION_PHASE="+string(phase),
					"FASED_HOSTING_TERMINATION_ROOT="+root)
				err := command.Run()
				var exitErr *exec.ExitError
				if !errors.As(err, &exitErr) || exitErr.ExitCode() != 73 {
					t.Fatalf("phase owner was not terminated after durable %s: %v", phase, err)
				}

				store := Store{StatePath: filepath.Join(root, "state.json"), ReceiptPath: filepath.Join(root, "hosting-prerequisites"), ExpectedUID: uint32(os.Getuid())}
				state, err := store.ReadState()
				if err != nil || state.Phase != phase {
					t.Fatalf("terminated phase was not durable: state=%+v err=%v", state, err)
				}
				before, err := os.ReadFile(store.StatePath)
				if err != nil {
					t.Fatal(err)
				}
				host := recoveredTerminationHost(state)
				participant := Participant{Store: store, Host: host}
				_, _, request := terminationFixture(root, phase)
				switch mode {
				case "newer-release":
					request.TransactionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
					request.Release = "1.2.3-rc.5"
				case "mismatched-environment":
					request.TransactionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
					request.GatewayPort++
					if _, err := participant.Prepare(context.Background(), request); err == nil {
						t.Fatal("mismatched environment resumed a terminated Hosting coordinator")
					}
					after, err := os.ReadFile(store.StatePath)
					if err != nil || !bytes.Equal(before, after) {
						t.Fatalf("mismatch changed terminated state: err=%v", err)
					}
					return
				}
				completed := completeTerminatedCoordinator(t, participant, host, request)
				if completed.Phase != PhaseCommitted || completed.Release != request.Release {
					t.Fatalf("terminated coordinator did not converge: %+v", completed)
				}
			})
		}
	}
}

func TestHostingSecurityTwoPhaseCommit(t *testing.T) {
	participant, host, request := fixture(t)
	state, err := participant.Prepare(context.Background(), request)
	if err != nil || state.Phase != PhasePrivateNetworkReady {
		t.Fatalf("prepare: state=%+v err=%v", state, err)
	}
	host.inspection.SignerReady = true
	state, err = markRuntimeReady(t, participant, request.TransactionID)
	if err != nil || state.Phase != PhaseRuntimeReady {
		t.Fatalf("runtime ready: state=%+v err=%v", state, err)
	}
	receipt, err := os.ReadFile(participant.Store.ReceiptPath)
	if err != nil || !strings.Contains(string(receipt), "firewallReady=pending") || strings.Contains(string(receipt), "tailnetSshConfirmed") {
		t.Fatalf("pending receipt: %q err=%v", receipt, err)
	}
	if _, err := participant.Commit(context.Background(), request.TransactionID, false); err == nil || !strings.Contains(err.Error(), "independent tailnet access") {
		t.Fatalf("hardening crossed unconfirmed provider handoff: %v", err)
	}
	state, err = participant.Commit(context.Background(), request.TransactionID, true)
	if err != nil || state.Phase != PhaseCommitted || !state.HardeningCommitted {
		t.Fatalf("commit: state=%+v err=%v", state, err)
	}
	receipt, err = os.ReadFile(participant.Store.ReceiptPath)
	if err != nil || !strings.Contains(string(receipt), "firewallReady=true") || !strings.Contains(string(receipt), "tailscaleDns=fased.tailnet.ts.net") {
		t.Fatalf("committed receipt: %q err=%v", receipt, err)
	}
}

func TestHostingSecurityStagesACLPrerequisiteBeforeRuntimeBootstrap(t *testing.T) {
	participant, host, request := fixture(t)
	host.inspection.LifecyclePrerequisitesReady = false
	host.prerequisitesMissing = true

	state, err := participant.Prepare(context.Background(), request)
	if err != nil || state.Phase != PhasePrivateNetworkReady || !state.HardeningStarted ||
		!state.LifecyclePrerequisitesStaged || state.HardeningSnapshot != "snapshot-v1" {
		t.Fatalf("prepare lifecycle prerequisites: state=%+v err=%v", state, err)
	}
	joined := strings.Join(host.calls, ",")
	if !strings.Contains(joined, "snapshot-hardening,stage-lifecycle-prerequisites,inspect") ||
		strings.Contains(joined, "stage-hardening") {
		t.Fatalf("ACL prerequisite was not isolated before runtime bootstrap: %s", joined)
	}
}

func TestHostingSecurityPrepareFailureRollsBackExternalAccess(t *testing.T) {
	participant, host, request := fixture(t)
	host.fail = "configure-serve"
	if _, err := participant.Prepare(context.Background(), request); err == nil {
		t.Fatal("prepare failure was ignored")
	}
	state, err := participant.Store.ReadState()
	if err != nil || state.Phase != PhaseAborted {
		t.Fatalf("abort state: %+v err=%v", state, err)
	}
	joined := strings.Join(host.calls, ",")
	if !strings.Contains(joined, "logout") || !strings.Contains(joined, "restore-serve") {
		t.Fatalf("prepared external access was not rolled back: %s", joined)
	}
	if _, err := os.Stat(participant.Store.ReceiptPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed transaction retained a public receipt: %v", err)
	}
}

func TestHostingSecurityInterruptedPreRuntimeRecoveryDoesNotOwnLegacyReceipt(t *testing.T) {
	participant, host, request := fixture(t)
	previous := State{
		SchemaVersion: CurrentSchemaVersion, TransactionID: request.TransactionID,
		Release: request.Release, Channel: request.Channel, GatewayPort: request.GatewayPort,
		OperatorUser: request.OperatorUser, PlatformIdentity: request.PlatformIdentity,
		TrustRootSHA256: request.TrustRootSHA256, Phase: PhasePreparing,
	}
	if err := participant.Store.WriteState(previous); err != nil {
		t.Fatal(err)
	}
	legacyReceipt := []byte("legacy-root-placeholder\n")
	if err := os.WriteFile(participant.Store.ReceiptPath, legacyReceipt, 0o600); err != nil {
		t.Fatal(err)
	}

	request.TransactionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	prepared, err := participant.Prepare(context.Background(), request)
	if err != nil || prepared.Phase != PhasePrivateNetworkReady || prepared.TransactionID != request.TransactionID {
		t.Fatalf("recover pre-runtime transaction: state=%+v err=%v", prepared, err)
	}
	beforeReady, err := os.ReadFile(participant.Store.ReceiptPath)
	if err != nil || !bytes.Equal(beforeReady, legacyReceipt) {
		t.Fatalf("pre-runtime recovery touched an unowned receipt: %q err=%v", beforeReady, err)
	}

	host.inspection.SignerReady = true
	if _, err := markRuntimeReady(t, participant, request.TransactionID); err != nil {
		t.Fatal(err)
	}
	receipt, err := os.ReadFile(participant.Store.ReceiptPath)
	if err != nil || !strings.Contains(string(receipt), "transactionId="+request.TransactionID+"\n") {
		t.Fatalf("retry did not publish its exact receipt: %q err=%v", receipt, err)
	}
	info, err := os.Lstat(participant.Store.ReceiptPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o644 {
		t.Fatalf("retry did not converge receipt metadata: mode=%v", info.Mode().Perm())
	}
}

func TestHostingSecurityUnsafeRootFileErrorNamesPathAndMetadata(t *testing.T) {
	path := filepath.Join(t.TempDir(), "active.json")
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o666); err != nil {
		t.Fatal(err)
	}
	_, err := readSecureRootFile(path, 0o600, uint32(os.Getuid()), maxStateBytes)
	if err == nil || !strings.Contains(err.Error(), path) ||
		!strings.Contains(err.Error(), "mode=0666") || !strings.Contains(err.Error(), "mode=0600") {
		t.Fatalf("unsafe metadata error is not actionable: %v", err)
	}
	_, err = readRootReceiptForOwnership(path, uint32(os.Getuid()), 4096)
	if err == nil || !strings.Contains(err.Error(), path) || !strings.Contains(err.Error(), "non-writable") {
		t.Fatalf("unsafe receipt cleanup did not fail closed: %v", err)
	}
}

func TestHostingSecurityLegacyUpdateAbortIsTerminalAndRetryable(t *testing.T) {
	participant, host, request := fixture(t)
	request.RequireExistingHardening = true
	host.signerWebAuthn = "existing.tailnet.ts.net"
	host.inspection = Inspection{
		TailscaleInstalled: true, TailscaleRunning: true, Authenticated: true,
		TailscaleDNS: "existing.tailnet.ts.net", TailscaleIPv4: "100.100.1.2",
		TailscaleVersion: "1.88.1", PrivateServeReady: true,
		SignerWebAuthnReady: true, LegacyHardeningReady: true, SignerReady: true,
	}
	state, err := participant.Prepare(context.Background(), request)
	if err != nil || !state.LegacyHardeningAdopted || !state.AccessConfirmed {
		t.Fatalf("legacy update prepare: state=%+v err=%v", state, err)
	}
	if _, err := markRuntimeReady(t, participant, state.TransactionID); err != nil {
		t.Fatal(err)
	}
	if err := participant.Abort(context.Background(), state.TransactionID); err != nil {
		t.Fatalf("legacy update abort did not converge: %v", err)
	}
	aborted, err := participant.Store.ReadState()
	if err != nil || aborted.Phase != PhaseAborted || aborted.AccessConfirmed ||
		aborted.LegacyHardeningAdopted || aborted.HardeningAdopted {
		t.Fatalf("legacy update abort retained a non-terminal adoption state: %+v err=%v", aborted, err)
	}
	request.TransactionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	request.Release = "1.2.3-rc.5"
	if retried, err := participant.Prepare(context.Background(), request); err != nil || retried.Phase != PhasePrivateNetworkReady {
		t.Fatalf("identical legacy update retry did not prepare: state=%+v err=%v", retried, err)
	}
}

func TestHostingSecurityUpdateAdoptsExistingHardening(t *testing.T) {
	participant, host, request := fixture(t)
	host.inspection = Inspection{TailscaleInstalled: true, TailscaleRunning: true, Authenticated: true,
		TailscaleDNS: "existing.tailnet.ts.net", TailscaleIPv4: "100.100.1.2", TailscaleVersion: "1.88.1", PrivateServeReady: true, HardeningReady: true, SignerReady: true}
	state, err := participant.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := markRuntimeReady(t, participant, state.TransactionID); err != nil {
		t.Fatal(err)
	}
	state, err = participant.Commit(context.Background(), state.TransactionID, false)
	if err != nil || !state.HardeningCommitted {
		t.Fatalf("existing hardening did not converge without reconfiguration: %+v err=%v", state, err)
	}
	joined := strings.Join(host.calls, ",")
	for _, unexpected := range []string{"install-tailscale", "authenticate", "configure-serve", "snapshot-hardening", "stage-hardening", "commit-hardening"} {
		if strings.Contains(joined, unexpected) {
			t.Fatalf("existing hardening was mutated by %s: %s", unexpected, joined)
		}
	}
	ownership, err := participant.Store.ReadOwnership()
	if err != nil {
		t.Fatal(err)
	}
	if ownership.TailscaleInstallOwned || ownership.AuthenticationOwned || ownership.ServeOwned || ownership.HardeningOwned {
		t.Fatalf("pre-existing host controls were incorrectly claimed: %+v", ownership)
	}
}

func TestHostingSecurityOwnershipPreservesFirstInstallBaselineAcrossUpdates(t *testing.T) {
	participant, host, request := fixture(t)
	state, err := participant.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	host.inspection.SignerReady = true
	if _, err := markRuntimeReady(t, participant, state.TransactionID); err != nil {
		t.Fatal(err)
	}
	if _, err := participant.Commit(context.Background(), state.TransactionID, true); err != nil {
		t.Fatal(err)
	}
	first, err := participant.Store.ReadOwnership()
	if err != nil {
		t.Fatal(err)
	}
	if !first.TailscaleInstallOwned || !first.AuthenticationOwned || !first.ServeOwned || !first.SignerWebAuthnOwned || !first.HardeningOwned {
		t.Fatalf("first install ownership is incomplete: %+v", first)
	}

	request.TransactionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	request.Release = "1.2.3-rc.5"
	request.RequireExistingHardening = true
	host.calls = nil
	state, err = participant.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := markRuntimeReady(t, participant, state.TransactionID); err != nil {
		t.Fatal(err)
	}
	if _, err := participant.Commit(context.Background(), state.TransactionID, false); err != nil {
		t.Fatal(err)
	}
	current, err := participant.Store.ReadOwnership()
	if err != nil {
		t.Fatal(err)
	}
	if current != first || current.TransactionID != "01234567-89ab-4cde-8fab-0123456789ab" {
		t.Fatalf("later update replaced the first-install baseline: first=%+v current=%+v", first, current)
	}
}

type durableFileSnapshot struct {
	data    []byte
	modTime time.Time
}

func snapshotDurableFile(t *testing.T, path string) durableFileSnapshot {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return durableFileSnapshot{data: data, modTime: info.ModTime()}
}

func requireDurableFileUnchanged(t *testing.T, path string, before durableFileSnapshot) {
	t.Helper()
	after := snapshotDurableFile(t, path)
	if string(after.data) != string(before.data) || !after.modTime.Equal(before.modTime) {
		t.Fatalf("durable Hosting security file changed: path=%s before=%q/%s after=%q/%s", path, before.data, before.modTime, after.data, after.modTime)
	}
}

func commitFixtureHostingSecurity(t *testing.T) (Participant, *fakeHost, Request, State) {
	t.Helper()
	participant, host, request := fixture(t)
	state, err := participant.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	host.inspection.SignerReady = true
	if _, err := markRuntimeReady(t, participant, state.TransactionID); err != nil {
		t.Fatal(err)
	}
	state, err = participant.Commit(context.Background(), state.TransactionID, true)
	if err != nil {
		t.Fatal(err)
	}
	return participant, host, request, state
}

func TestHostingSecurityExactCommittedPrepareReusesWithoutMutation(t *testing.T) {
	participant, host, request, committed := commitFixtureHostingSecurity(t)
	paths := []string{participant.Store.StatePath, participant.Store.ReceiptPath, participant.Store.ownershipPath()}
	fixedTime := time.Unix(1, 0).UTC()
	for _, path := range paths {
		if err := os.Chtimes(path, fixedTime, fixedTime); err != nil {
			t.Fatal(err)
		}
	}
	before := make(map[string]durableFileSnapshot, len(paths))
	for _, path := range paths {
		before[path] = snapshotDurableFile(t, path)
	}

	host.calls = nil
	request.TransactionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	request.RequireExistingHardening = true
	reused, err := participant.Prepare(context.Background(), request)
	if err != nil || reused != committed {
		t.Fatalf("exact committed transaction was not reused: state=%+v err=%v", reused, err)
	}
	if got := strings.Join(host.calls, ","); got != "inspect" {
		t.Fatalf("exact committed reuse made a host mutation: %s", got)
	}
	for _, path := range paths {
		requireDurableFileUnchanged(t, path, before[path])
	}
}

func TestHostingSecurityExactCommittedPrepareFailsClosedWithoutMutation(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*fakeHost)
	}{
		{name: "DNS", mutate: func(host *fakeHost) { host.inspection.TailscaleDNS = "other.tailnet.ts.net" }},
		{name: "IPv4", mutate: func(host *fakeHost) { host.inspection.TailscaleIPv4 = "100.100.1.10" }},
		{name: "version", mutate: func(host *fakeHost) { host.inspection.TailscaleVersion = "1.89.1" }},
		{name: "signer", mutate: func(host *fakeHost) { host.inspection.SignerReady = false }},
	} {
		t.Run(test.name, func(t *testing.T) {
			participant, host, request, _ := commitFixtureHostingSecurity(t)
			paths := []string{participant.Store.StatePath, participant.Store.ReceiptPath, participant.Store.ownershipPath()}
			before := make(map[string]durableFileSnapshot, len(paths))
			for _, path := range paths {
				before[path] = snapshotDurableFile(t, path)
			}

			host.calls = nil
			test.mutate(host)
			request.TransactionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
			request.RequireExistingHardening = true
			if _, err := participant.Prepare(context.Background(), request); err == nil || !strings.Contains(err.Error(), "committed Hosting security boundary") {
				t.Fatalf("unsafe committed transaction was accepted: %v", err)
			}
			if got := strings.Join(host.calls, ","); got != "inspect" {
				t.Fatalf("unsafe committed reuse made a host mutation: %s", got)
			}
			for _, path := range paths {
				requireDurableFileUnchanged(t, path, before[path])
			}
		})
	}
}

func TestHostingSecurityCommittedTransactionCommitRemainsRecoverable(t *testing.T) {
	participant, host, _, committed := commitFixtureHostingSecurity(t)
	host.calls = nil
	recovered, err := participant.Commit(context.Background(), committed.TransactionID, false)
	if err != nil || recovered != committed {
		t.Fatalf("committed Hosting security transaction was not recoverable: state=%+v err=%v", recovered, err)
	}
	if len(host.calls) != 0 {
		t.Fatalf("committed Hosting security recovery touched the host: %v", host.calls)
	}
}

func TestHostingSecurityOwnershipFailsClosedOnCorruptionOrPlatformMismatch(t *testing.T) {
	participant, _, request := fixture(t)
	ownershipPath := participant.Store.ownershipPath()
	if err := os.WriteFile(ownershipPath, []byte("{not-json}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	committed := State{SchemaVersion: CurrentSchemaVersion, TransactionID: request.TransactionID, Release: request.Release,
		Channel: request.Channel, GatewayPort: request.GatewayPort, OperatorUser: request.OperatorUser,
		PlatformIdentity: request.PlatformIdentity, TrustRootSHA256: request.TrustRootSHA256, Phase: PhaseCommitted,
		SignerWebAuthnMutationStarted: true, SignerWebAuthnChanged: true, RuntimeReady: true, AccessConfirmed: true,
		LifecycleGenerationID: "sha256:" + strings.Repeat("b", 64), ConvergenceReceiptDigest: "sha256:" + strings.Repeat("c", 64),
		OnboardingComplete: true, HardeningAdopted: true, HardeningCommitted: true}
	if _, err := participant.Store.EnsureOwnership(committed); err == nil {
		t.Fatal("corrupt ownership baseline was replaced")
	}
	if err := os.Remove(ownershipPath); err != nil {
		t.Fatal(err)
	}
	if _, err := participant.Store.EnsureOwnership(committed); err != nil {
		t.Fatal(err)
	}
	committed.OperatorUser = "different"
	if _, err := participant.Store.EnsureOwnership(committed); err == nil || !strings.Contains(err.Error(), "differs from the active platform") {
		t.Fatalf("ownership identity mismatch was accepted: %v", err)
	}
}

func TestHostingSecurityUninstallRestoresOnlyFirstInstallOwnership(t *testing.T) {
	participant, host, request := fixture(t)
	state, err := participant.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	host.inspection.SignerReady = true
	if _, err := markRuntimeReady(t, participant, state.TransactionID); err != nil {
		t.Fatal(err)
	}
	if _, err := participant.Commit(context.Background(), state.TransactionID, true); err != nil {
		t.Fatal(err)
	}
	host.calls = nil
	record, err := participant.Uninstall(context.Background())
	if err != nil || !record.Completed {
		t.Fatalf("uninstall: record=%+v err=%v", record, err)
	}
	want := []string{"restore-hardening", "restore-serve", "restore-signer-webauthn", "logout", "restore-tailscale-install"}
	if strings.Join(host.calls, ",") != strings.Join(want, ",") {
		t.Fatalf("first-install ownership was not restored in safe order: got=%v want=%v", host.calls, want)
	}
	host.calls = nil
	if replay, err := participant.Uninstall(context.Background()); err != nil || !replay.Completed || len(host.calls) != 0 {
		t.Fatalf("completed uninstall was not an exact no-op: record=%+v calls=%v err=%v", replay, host.calls, err)
	}
}

func TestHostingSecurityUninstallResumesAfterLastDurableStep(t *testing.T) {
	participant, host, request := fixture(t)
	state, err := participant.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	host.inspection.SignerReady = true
	if _, err := markRuntimeReady(t, participant, state.TransactionID); err != nil {
		t.Fatal(err)
	}
	if _, err := participant.Commit(context.Background(), state.TransactionID, true); err != nil {
		t.Fatal(err)
	}
	host.calls = nil
	host.fail = "restore-signer-webauthn"
	if _, err := participant.Uninstall(context.Background()); err == nil {
		t.Fatal("uninstall restore failure was ignored")
	}
	failed, err := participant.Store.ReadUninstall()
	if err != nil || !failed.HardeningRestored || !failed.ServeRestored || failed.SignerWebAuthnRestored || failed.Completed {
		t.Fatalf("uninstall progress is not durable: record=%+v err=%v", failed, err)
	}
	host.calls = nil
	host.fail = ""
	completed, err := participant.Uninstall(context.Background())
	if err != nil || !completed.Completed {
		t.Fatalf("uninstall resume: record=%+v err=%v", completed, err)
	}
	want := []string{"restore-signer-webauthn", "logout", "restore-tailscale-install"}
	if strings.Join(host.calls, ",") != strings.Join(want, ",") {
		t.Fatalf("uninstall replayed durable steps: got=%v want=%v", host.calls, want)
	}
}

func TestHostingSecurityUpdateRefusesBrokenPredecessorBeforeMutation(t *testing.T) {
	participant, host, request := fixture(t)
	request.RequireExistingHardening = true
	if _, err := participant.Prepare(context.Background(), request); err == nil || !strings.Contains(err.Error(), "boundary is not intact") {
		t.Fatalf("broken Hosting predecessor was accepted: %v", err)
	}
	joined := strings.Join(host.calls, ",")
	for _, mutation := range []string{"install-tailscale", "authenticate", "configure-serve", "stage-hardening", "commit-hardening"} {
		if strings.Contains(joined, mutation) {
			t.Fatalf("update preflight mutated the broken host via %s: %s", mutation, joined)
		}
	}
}

func TestHostingSecurityRecoversPreparingTransactionBeforeNewMutation(t *testing.T) {
	participant, host, request := fixture(t)
	previous := State{SchemaVersion: CurrentSchemaVersion, TransactionID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		Release: request.Release, Channel: request.Channel, GatewayPort: request.GatewayPort, OperatorUser: request.OperatorUser,
		PlatformIdentity: request.PlatformIdentity, TrustRootSHA256: request.TrustRootSHA256,
		Phase: PhasePreparing, TailscaleInstallStarted: true, TailscaleInstallSnapshot: "tailscale-install-snapshot-v1", AuthenticationStarted: true, AuthenticatedByTransaction: true,
		ServeMutationStarted: true, ServeChanged: true, PreviousServe: "previous", TailscaleDNS: "old.tailnet.ts.net",
		TailscaleIPv4: "100.64.1.2", TailscaleVersion: "1.88.1"}
	if err := participant.Store.WriteState(previous); err != nil {
		t.Fatal(err)
	}
	host.serve = "configured"
	host.inspection = Inspection{TailscaleInstalled: true, TailscaleRunning: true, Authenticated: true,
		TailscaleDNS: "old.tailnet.ts.net", TailscaleIPv4: "100.64.1.2", TailscaleVersion: "1.88.1", PrivateServeReady: true}
	state, err := participant.Prepare(context.Background(), request)
	if err != nil || state.TransactionID != request.TransactionID || state.Phase != PhasePrivateNetworkReady {
		t.Fatalf("recovered prepare: state=%+v err=%v", state, err)
	}
	joined := strings.Join(host.calls, ",")
	if !strings.Contains(joined, "restore-serve") || !strings.Contains(joined, "logout") || !strings.Contains(joined, "restore-tailscale-install") {
		t.Fatalf("previous prepared mutations were not restored first: %s", joined)
	}
}

func TestHostingSecurityResumesDurableHardeningSnapshot(t *testing.T) {
	participant, host, request := fixture(t)
	state := State{SchemaVersion: CurrentSchemaVersion, TransactionID: request.TransactionID, Release: request.Release,
		Channel: request.Channel, GatewayPort: request.GatewayPort, OperatorUser: request.OperatorUser,
		PlatformIdentity: request.PlatformIdentity, TrustRootSHA256: request.TrustRootSHA256, Phase: PhaseHardening,
		TailscaleDNS: "fased.tailnet.ts.net", TailscaleIPv4: "100.64.1.9", TailscaleVersion: "1.88.1",
		RuntimeReady: true, LifecycleGenerationID: "sha256:" + strings.Repeat("b", 64),
		ConvergenceReceiptDigest: "sha256:" + strings.Repeat("c", 64), OnboardingComplete: true,
		AccessConfirmed: true, SignerWebAuthnMutationStarted: true, SignerWebAuthnChanged: true,
		HardeningStarted: true, HardeningSnapshot: "snapshot-v1"}
	if err := participant.Store.WriteState(state); err != nil {
		t.Fatal(err)
	}
	host.inspection = Inspection{TailscaleInstalled: true, TailscaleRunning: true, Authenticated: true, TailscaleDNS: state.TailscaleDNS,
		TailscaleIPv4: state.TailscaleIPv4, TailscaleVersion: state.TailscaleVersion, PrivateServeReady: true, SignerWebAuthnReady: true, SignerReady: true}
	committed, err := participant.Prepare(context.Background(), request)
	if err != nil || committed.Phase != PhaseCommitted {
		t.Fatalf("resume prepare did not finish prior hardening: state=%+v err=%v", committed, err)
	}
	joined := strings.Join(host.calls, ",")
	if strings.Contains(joined, "snapshot-hardening") || !strings.Contains(joined, "stage-hardening") || !strings.Contains(joined, "commit-hardening") {
		t.Fatalf("durable hardening snapshot was not resumed exactly: %s", joined)
	}
}

func TestHostingSecurityRebindsRuntimeReadyPredecessorToNewRelease(t *testing.T) {
	participant, host, request := fixture(t)
	request.Release = "0.1.76-rc.114"
	state, err := participant.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	host.inspection.SignerReady = true
	state, err = markRuntimeReady(t, participant, state.TransactionID)
	if err != nil {
		t.Fatal(err)
	}
	previousTransactionID := state.TransactionID

	host.calls = nil
	request.TransactionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	request.Release = "0.1.76-rc.115"
	rebound, err := participant.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if rebound.Phase != PhaseRuntimeReady || rebound.TransactionID != request.TransactionID || rebound.Release != request.Release {
		t.Fatalf("runtime-ready predecessor was not rebound: %+v", rebound)
	}
	if rebound.TransactionID == previousTransactionID {
		t.Fatal("runtime-ready predecessor retained its previous transaction identity")
	}
	if got := strings.Join(host.calls, ","); got != "inspect" {
		t.Fatalf("cross-release recovery mutated the prepared host: %s", got)
	}
	pending, err := os.ReadFile(participant.Store.ReceiptPath)
	if err != nil || !strings.Contains(string(pending), "release="+request.Release+"\n") ||
		!strings.Contains(string(pending), "transactionId="+request.TransactionID+"\n") ||
		!strings.Contains(string(pending), "firewallReady=pending\n") {
		t.Fatalf("rebound pending receipt is not exact: %q err=%v", pending, err)
	}

	committed, err := participant.Commit(context.Background(), rebound.TransactionID, true)
	if err != nil || committed.Phase != PhaseCommitted {
		t.Fatalf("commit rebound transaction: state=%+v err=%v", committed, err)
	}
	receipt, err := os.ReadFile(participant.Store.ReceiptPath)
	if err != nil || !strings.Contains(string(receipt), "release="+request.Release+"\n") ||
		!strings.Contains(string(receipt), "transactionId="+request.TransactionID+"\n") ||
		!strings.Contains(string(receipt), "firewallReady=true\n") {
		t.Fatalf("rebound committed receipt is not exact: %q err=%v", receipt, err)
	}
}

func TestHostingSecurityCrossReleaseRecoveryRejectsBoundaryMismatchWithoutMutation(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*Request, *fakeHost)
	}{
		{name: "channel", mutate: func(request *Request, _ *fakeHost) {
			request.Channel = "stable"
			request.Release = "1.2.4"
		}},
		{name: "gateway port", mutate: func(request *Request, _ *fakeHost) { request.GatewayPort++ }},
		{name: "operator", mutate: func(request *Request, _ *fakeHost) { request.OperatorUser = "other" }},
		{name: "Tailscale identity", mutate: func(_ *Request, host *fakeHost) { host.inspection.TailscaleDNS = "other.tailnet.ts.net" }},
		{name: "signer readiness", mutate: func(_ *Request, host *fakeHost) { host.inspection.SignerReady = false }},
	} {
		t.Run(test.name, func(t *testing.T) {
			participant, host, request := fixture(t)
			state, err := participant.Prepare(context.Background(), request)
			if err != nil {
				t.Fatal(err)
			}
			host.inspection.SignerReady = true
			if _, err := markRuntimeReady(t, participant, state.TransactionID); err != nil {
				t.Fatal(err)
			}
			stateBefore := snapshotDurableFile(t, participant.Store.StatePath)
			receiptBefore := snapshotDurableFile(t, participant.Store.ReceiptPath)

			request.TransactionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
			request.Release = "1.2.3-rc.5"
			test.mutate(&request, host)
			if _, err := participant.Prepare(context.Background(), request); err == nil {
				t.Fatal("cross-release boundary mismatch was accepted")
			}
			requireDurableFileUnchanged(t, participant.Store.StatePath, stateBefore)
			requireDurableFileUnchanged(t, participant.Store.ReceiptPath, receiptBefore)
		})
	}
}

func TestHostingSecurityRebindsPrivateNetworkReadyFailureToCorrectedRelease(t *testing.T) {
	participant, host, failed := fixture(t)
	failed.Release = "0.1.76-rc.129"
	prepared, err := participant.Prepare(context.Background(), failed)
	if err != nil || prepared.Phase != PhasePrivateNetworkReady {
		t.Fatalf("prepare failed release: state=%+v err=%v", prepared, err)
	}

	host.calls = nil
	corrected := failed
	corrected.TransactionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	corrected.Release = "0.1.76-rc.130"
	rebound, err := participant.Prepare(context.Background(), corrected)
	if err != nil {
		t.Fatal(err)
	}
	if rebound.Phase != PhasePrivateNetworkReady || rebound.Release != corrected.Release || rebound.TransactionID != corrected.TransactionID ||
		rebound.TailscaleDNS != prepared.TailscaleDNS || rebound.TailscaleIPv4 != prepared.TailscaleIPv4 || rebound.TailscaleVersion != prepared.TailscaleVersion {
		t.Fatalf("prepared Hosting boundary was not rebound exactly: %+v", rebound)
	}
	if got := strings.Join(host.calls, ","); got != "inspect" {
		t.Fatalf("cross-release retry mutated the prepared host: %s", got)
	}
}

func TestHostingSecurityRuntimeReadyRecoveryRepairsMissingReceipt(t *testing.T) {
	participant, host, request := fixture(t)
	state, err := participant.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	host.inspection.SignerReady = true
	state, err = markRuntimeReady(t, participant, state.TransactionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(participant.Store.ReceiptPath); err != nil {
		t.Fatal(err)
	}

	request.TransactionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	recovered, err := participant.Prepare(context.Background(), request)
	if err != nil || recovered.TransactionID != state.TransactionID {
		t.Fatalf("repair runtime-ready receipt: state=%+v err=%v", recovered, err)
	}
	receipt, err := os.ReadFile(participant.Store.ReceiptPath)
	if err != nil || !strings.Contains(string(receipt), "transactionId="+state.TransactionID+"\n") {
		t.Fatalf("runtime-ready receipt was not repaired: %q err=%v", receipt, err)
	}
}

func TestHostingCoordinatorBlocksHardeningUntilOnboardingCompletes(t *testing.T) {
	participant, host, request := fixture(t)
	request.OnboardingRequired = true
	state, err := participant.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	host.inspection.SignerReady = true
	state, err = participant.BindRuntimeReady(context.Background(), state.TransactionID,
		"sha256:"+strings.Repeat("d", 64), "sha256:"+strings.Repeat("e", 64), true)
	if err != nil || state.Phase != PhaseOnboardingPending || !state.OnboardingRequired || state.OnboardingComplete {
		t.Fatalf("onboarding boundary was not durable: state=%+v err=%v", state, err)
	}
	if _, err := participant.Commit(context.Background(), state.TransactionID, true); err == nil || !strings.Contains(err.Error(), "not runtime-ready") {
		t.Fatalf("hardening crossed pending onboarding: %v", err)
	}
	state, err = participant.MarkOnboardingComplete(state.TransactionID)
	if err != nil || state.Phase != PhaseOnboardingComplete || !state.OnboardingComplete {
		t.Fatalf("onboarding completion was not durable: state=%+v err=%v", state, err)
	}
	state, err = participant.Commit(context.Background(), state.TransactionID, true)
	if err != nil || state.Phase != PhaseCommitted {
		t.Fatalf("completed coordinator did not commit: state=%+v err=%v", state, err)
	}
	receipt, err := os.ReadFile(participant.Store.ReceiptPath)
	if err != nil || !strings.Contains(string(receipt), "schemaVersion=4\n") ||
		!strings.Contains(string(receipt), "onboardingComplete=true\n") ||
		!strings.Contains(string(receipt), "lifecycleGenerationId=sha256:"+strings.Repeat("d", 64)+"\n") {
		t.Fatalf("composite receipt is incomplete: %q err=%v", receipt, err)
	}
}

func TestHostingCoordinatorPendingRetryMatrix(t *testing.T) {
	participant, host, request := fixture(t)
	request.OnboardingRequired = true
	state, err := participant.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	host.inspection.SignerReady = true
	state, err = participant.BindRuntimeReady(context.Background(), state.TransactionID,
		"sha256:"+strings.Repeat("d", 64), "sha256:"+strings.Repeat("e", 64), true)
	if err != nil {
		t.Fatal(err)
	}
	stateBefore := snapshotDurableFile(t, participant.Store.StatePath)

	same := request
	same.TransactionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	recovered, err := participant.Prepare(context.Background(), same)
	if err != nil || recovered.TransactionID != state.TransactionID || recovered.Phase != PhaseOnboardingPending {
		t.Fatalf("same-release retry did not resume pending onboarding: state=%+v err=%v", recovered, err)
	}
	requireDurableFileUnchanged(t, participant.Store.StatePath, stateBefore)

	mismatch := same
	mismatch.PlatformIdentity = "linux/arm64"
	if _, err := participant.Prepare(context.Background(), mismatch); err == nil {
		t.Fatal("platform-mismatched retry was accepted")
	}
	requireDurableFileUnchanged(t, participant.Store.StatePath, stateBefore)
	mismatch = same
	mismatch.TrustRootSHA256 = strings.Repeat("f", 64)
	if _, err := participant.Prepare(context.Background(), mismatch); err == nil {
		t.Fatal("trust-root-mismatched retry was accepted")
	}
	requireDurableFileUnchanged(t, participant.Store.StatePath, stateBefore)

	newer := request
	newer.TransactionID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	newer.Release = "1.2.3-rc.5"
	rebound, err := participant.Prepare(context.Background(), newer)
	if err != nil || rebound.TransactionID != newer.TransactionID || rebound.Release != newer.Release || rebound.Phase != PhaseOnboardingPending {
		t.Fatalf("newer-release retry did not preserve pending coordinator state: state=%+v err=%v", rebound, err)
	}
}

func TestHostingCoordinatorCommittedBoundaryRejectsEnvironmentMismatch(t *testing.T) {
	participant, host, request := fixture(t)
	state, err := participant.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	host.inspection.SignerReady = true
	state, err = markRuntimeReady(t, participant, state.TransactionID)
	if err != nil {
		t.Fatal(err)
	}
	state, err = participant.Commit(context.Background(), state.TransactionID, true)
	if err != nil || state.Phase != PhaseCommitted {
		t.Fatalf("commit: state=%+v err=%v", state, err)
	}
	stateBefore := snapshotDurableFile(t, participant.Store.StatePath)
	receiptBefore := snapshotDurableFile(t, participant.Store.ReceiptPath)

	for name, mutate := range map[string]func(*Request){
		"channel":  func(candidate *Request) { candidate.Channel = "stable"; candidate.Release = "1.2.4" },
		"operator": func(candidate *Request) { candidate.OperatorUser = "operator" },
		"port":     func(candidate *Request) { candidate.GatewayPort++ },
		"platform": func(candidate *Request) { candidate.PlatformIdentity = "linux/arm64" },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := request
			candidate.TransactionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
			candidate.Release = "1.2.3-rc.5"
			mutate(&candidate)
			if _, err := participant.Prepare(context.Background(), candidate); err == nil {
				t.Fatal("committed environment mismatch was accepted")
			}
			requireDurableFileUnchanged(t, participant.Store.StatePath, stateBefore)
			requireDurableFileUnchanged(t, participant.Store.ReceiptPath, receiptBefore)
		})
	}
}

func TestHostingCoordinatorCommittedBoundaryAcceptsAuthenticatedTrustRootRotation(t *testing.T) {
	participant, host, first := fixture(t)
	first.Release = "0.1.76-rc.118"
	state, err := participant.Prepare(context.Background(), first)
	if err != nil {
		t.Fatal(err)
	}
	host.inspection.SignerReady = true
	state, err = markRuntimeReady(t, participant, state.TransactionID)
	if err != nil {
		t.Fatal(err)
	}
	state, err = participant.Commit(context.Background(), state.TransactionID, true)
	if err != nil || state.Phase != PhaseCommitted {
		t.Fatalf("commit staged build: state=%+v err=%v", state, err)
	}

	public := first
	public.TransactionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	public.Release = "0.1.76-rc.119"
	public.TrustRootSHA256 = strings.Repeat("f", 64)
	public.RequireExistingHardening = true
	prepared, err := participant.Prepare(context.Background(), public)
	if err != nil {
		t.Fatalf("authenticated trust-root rotation was rejected: %v", err)
	}
	if prepared.Release != public.Release || prepared.TransactionID != public.TransactionID ||
		prepared.TrustRootSHA256 != public.TrustRootSHA256 || prepared.Phase != PhasePrivateNetworkReady {
		t.Fatalf("rotated Hosting state did not advance exactly: %+v", prepared)
	}
	persisted, err := participant.Store.ReadState()
	if err != nil || persisted != prepared {
		t.Fatalf("rotated Hosting state was not durable: state=%+v err=%v", persisted, err)
	}
}

func TestHostingCoordinatorPersistentCrossBuildUpdateAcceptsStableRoot(t *testing.T) {
	participant, host, first := fixture(t)
	first.Release = "0.1.76-rc.116"
	state, err := participant.Prepare(context.Background(), first)
	if err != nil {
		t.Fatal(err)
	}
	host.inspection.SignerReady = true
	state, err = markRuntimeReady(t, participant, state.TransactionID)
	if err != nil {
		t.Fatal(err)
	}
	state, err = participant.Commit(context.Background(), state.TransactionID, true)
	if err != nil || state.Phase != PhaseCommitted {
		t.Fatalf("commit first build: state=%+v err=%v", state, err)
	}

	second := first
	second.TransactionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	second.Release = "0.1.76-rc.117"
	second.RequireExistingHardening = true
	prepared, err := participant.Prepare(context.Background(), second)
	if err != nil {
		t.Fatalf("persistent cross-build update rejected the stable root: %v", err)
	}
	if prepared.Release != second.Release || prepared.TransactionID != second.TransactionID || prepared.TrustRootSHA256 != first.TrustRootSHA256 || prepared.Phase != PhasePrivateNetworkReady {
		t.Fatalf("cross-build Hosting state did not advance exactly: %+v", prepared)
	}
	persisted, err := participant.Store.ReadState()
	if err != nil || persisted != prepared {
		t.Fatalf("cross-build Hosting state was not durable: state=%+v err=%v", persisted, err)
	}
}

func TestHostingCoordinatorMigratesSchemaOneRuntimeBeforeNewRelease(t *testing.T) {
	participant, host, request := fixture(t)
	state, err := participant.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	host.inspection.SignerReady = true
	state, err = markRuntimeReady(t, participant, state.TransactionID)
	if err != nil {
		t.Fatal(err)
	}
	state.SchemaVersion = 1
	state.PlatformIdentity, state.TrustRootSHA256 = "", ""
	state.LifecycleGenerationID, state.ConvergenceReceiptDigest = "", ""
	state.OnboardingRequired, state.OnboardingComplete = false, false
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(participant.Store.StatePath, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}

	request.TransactionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	request.Release = "1.2.3-rc.5"
	request.OnboardingRequired = true
	migrated, err := participant.Prepare(context.Background(), request)
	if err != nil || migrated.SchemaVersion != CurrentSchemaVersion || !migrated.LegacyRuntimeBindingPending ||
		migrated.PlatformIdentity != request.PlatformIdentity || migrated.TrustRootSHA256 != request.TrustRootSHA256 {
		t.Fatalf("schema-one runtime was not migrated into the coordinator: state=%+v err=%v", migrated, err)
	}
	bound, err := participant.BindRuntimeReady(context.Background(), migrated.TransactionID,
		"sha256:"+strings.Repeat("1", 64), "sha256:"+strings.Repeat("2", 64), true)
	if err != nil || bound.LegacyRuntimeBindingPending || bound.Phase != PhaseOnboardingPending {
		t.Fatalf("migrated runtime was not rebound exactly: state=%+v err=%v", bound, err)
	}
}
