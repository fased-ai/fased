package hostsecurity

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeHost struct {
	inspection     Inspection
	calls          []string
	serve          string
	signerWebAuthn string
	fail           string
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
	host := &fakeHost{}
	participant := Participant{Store: Store{StatePath: filepath.Join(root, "state.json"), ReceiptPath: filepath.Join(root, "hosting-prerequisites"), ExpectedUID: uint32(os.Getuid())}, Host: host}
	request := Request{TransactionID: "01234567-89ab-4cde-8fab-0123456789ab", Release: "1.2.3-rc.4", Channel: "beta", GatewayPort: 18789, OperatorUser: "app", Interactive: true}
	return participant, host, request
}

func TestHostingSecurityTwoPhaseCommit(t *testing.T) {
	participant, host, request := fixture(t)
	state, err := participant.Prepare(context.Background(), request)
	if err != nil || state.Phase != PhasePrepared {
		t.Fatalf("prepare: state=%+v err=%v", state, err)
	}
	host.inspection.SignerReady = true
	state, err = participant.MarkRuntimeReady(context.Background(), request.TransactionID)
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
	if _, err := participant.MarkRuntimeReady(context.Background(), state.TransactionID); err != nil {
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
	if retried, err := participant.Prepare(context.Background(), request); err != nil || retried.Phase != PhasePrepared {
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
	if _, err := participant.MarkRuntimeReady(context.Background(), state.TransactionID); err != nil {
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
	if _, err := participant.MarkRuntimeReady(context.Background(), state.TransactionID); err != nil {
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
	if _, err := participant.MarkRuntimeReady(context.Background(), state.TransactionID); err != nil {
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
	if _, err := participant.MarkRuntimeReady(context.Background(), state.TransactionID); err != nil {
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
		Channel: request.Channel, GatewayPort: request.GatewayPort, OperatorUser: request.OperatorUser, Phase: PhaseCommitted,
		SignerWebAuthnMutationStarted: true, SignerWebAuthnChanged: true, RuntimeReady: true, AccessConfirmed: true,
		HardeningAdopted: true, HardeningCommitted: true}
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
	if _, err := participant.MarkRuntimeReady(context.Background(), state.TransactionID); err != nil {
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
	if _, err := participant.MarkRuntimeReady(context.Background(), state.TransactionID); err != nil {
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
	if err != nil || state.TransactionID != request.TransactionID || state.Phase != PhasePrepared {
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
		Channel: request.Channel, GatewayPort: request.GatewayPort, OperatorUser: request.OperatorUser, Phase: PhaseHardening,
		TailscaleDNS: "fased.tailnet.ts.net", TailscaleIPv4: "100.64.1.9", TailscaleVersion: "1.88.1",
		RuntimeReady: true, AccessConfirmed: true, SignerWebAuthnMutationStarted: true, SignerWebAuthnChanged: true,
		HardeningStarted: true, HardeningSnapshot: "snapshot-v1"}
	if err := participant.Store.WriteState(state); err != nil {
		t.Fatal(err)
	}
	host.inspection = Inspection{TailscaleInstalled: true, TailscaleRunning: true, Authenticated: true, TailscaleDNS: state.TailscaleDNS,
		TailscaleIPv4: state.TailscaleIPv4, TailscaleVersion: state.TailscaleVersion, PrivateServeReady: true, SignerWebAuthnReady: true, SignerReady: true}
	prepared, err := participant.Prepare(context.Background(), request)
	if err != nil || prepared.Phase != PhaseHardening {
		t.Fatalf("resume prepare: state=%+v err=%v", prepared, err)
	}
	committed, err := participant.Commit(context.Background(), prepared.TransactionID, false)
	if err != nil || committed.Phase != PhaseCommitted {
		t.Fatalf("resume commit: state=%+v err=%v", committed, err)
	}
	joined := strings.Join(host.calls, ",")
	if strings.Contains(joined, "snapshot-hardening") || strings.Contains(joined, "stage-hardening") || !strings.Contains(joined, "commit-hardening") {
		t.Fatalf("durable hardening snapshot was not resumed exactly: %s", joined)
	}
}
