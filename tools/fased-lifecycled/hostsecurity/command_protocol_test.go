package hostsecurity

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHostingSecuritySystemLogIsBoundedAndSecure(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "log")
	path := filepath.Join(directory, "hosting-security.log")
	log, err := openBoundedSystemLog(directory, path, uint32(os.Getuid()), 8)
	if err != nil {
		t.Fatal(err)
	}
	if written, err := log.Write([]byte("123456789")); err == nil || written != 8 {
		t.Fatalf("oversized log write was not bounded: written=%d err=%v", written, err)
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil || info.Size() != 8 || info.Mode().Perm() != 0o600 {
		t.Fatalf("bounded log identity: info=%v err=%v", info, err)
	}
}

func TestHostingSecurityCommandRunsPolicyInsideLifecycleHostBoundary(t *testing.T) {
	participant, _, prepare := fixture(t)
	request := CommandRequest{
		SchemaVersion: CommandSchemaVersion, Operation: CommandPrepare,
		TransactionID: prepare.TransactionID, Release: prepare.Release, Channel: prepare.Channel,
		GatewayPort: prepare.GatewayPort, OperatorUser: prepare.OperatorUser,
		PlatformIdentity: prepare.PlatformIdentity, TrustRootSHA256: prepare.TrustRootSHA256,
		Interactive: true, OnboardingRequired: true,
	}
	state, err := ExecuteCommand(context.Background(), participant, request)
	if err != nil {
		t.Fatal(err)
	}
	if state.SchemaVersion != CommandSchemaVersion || state.TransactionID != prepare.TransactionID || state.DurableTransactionID != prepare.TransactionID ||
		state.OperatorUser != prepare.OperatorUser || state.TailscaleDNS == "" || !state.OnboardingRequired ||
		!state.NeedsFinalization || state.Committed {
		t.Fatalf("stable Hosting command projection is incomplete: %+v", state)
	}
	durable, err := participant.Store.ReadState()
	if err != nil {
		t.Fatal(err)
	}
	if durable.SchemaVersion != CurrentSchemaVersion || durable.TransactionID != state.DurableTransactionID {
		t.Fatalf("command did not persist the lifecycle-host-owned state: %+v", durable)
	}
}

func TestHostingSecurityCommandSeparatesRetryCorrelationFromDurableTransaction(t *testing.T) {
	participant, _, prepare := fixture(t)
	firstRequest := CommandRequest{
		SchemaVersion: CommandSchemaVersion, Operation: CommandPrepare,
		TransactionID: prepare.TransactionID, Release: prepare.Release, Channel: prepare.Channel,
		GatewayPort: prepare.GatewayPort, OperatorUser: prepare.OperatorUser,
		PlatformIdentity: prepare.PlatformIdentity, TrustRootSHA256: prepare.TrustRootSHA256,
		Interactive: true, OnboardingRequired: true,
	}
	first, err := ExecuteCommand(context.Background(), participant, firstRequest)
	if err != nil {
		t.Fatal(err)
	}
	retry := firstRequest
	retry.TransactionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	resumed, err := ExecuteCommand(context.Background(), participant, retry)
	if err != nil {
		t.Fatal(err)
	}
	if resumed.TransactionID != retry.TransactionID || resumed.DurableTransactionID != first.DurableTransactionID {
		t.Fatalf("retry identities were conflated: first=%+v resumed=%+v", first, resumed)
	}
	resolved, err := resumed.DurableTransactionIDFor(retry)
	if err != nil || resolved != first.DurableTransactionID {
		t.Fatalf("durable retry identity was not recoverable: resolved=%q err=%v", resolved, err)
	}
	durable, err := participant.Store.ReadState()
	if err != nil || durable.TransactionID != first.DurableTransactionID {
		t.Fatalf("retry replaced durable transaction history: state=%+v err=%v", durable, err)
	}
}

func TestHostingSecurityCommandRejectsUncorrelatedDurableProjection(t *testing.T) {
	request := CommandRequest{
		SchemaVersion: CommandSchemaVersion, Operation: CommandPrepare,
		TransactionID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Release: "1.2.3-rc.4", Channel: "beta",
		GatewayPort: 18789, OperatorUser: "app", PlatformIdentity: "linux/x64",
		TrustRootSHA256: strings.Repeat("a", 64), Interactive: true,
	}
	state := CommandState{
		SchemaVersion: CommandSchemaVersion, TransactionID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		DurableTransactionID: "01234567-89ab-4cde-8fab-0123456789ab", Release: request.Release, OperatorUser: request.OperatorUser,
	}
	if _, err := state.DurableTransactionIDFor(request); err == nil || !strings.Contains(err.Error(), "correlation") {
		t.Fatalf("uncorrelated lifecycle-host response was accepted: %v", err)
	}
}

func TestHostingSecurityCommandAcceptsLegacyPrepareResumeProjection(t *testing.T) {
	request := CommandRequest{
		SchemaVersion: CommandSchemaVersion, Operation: CommandPrepare,
		TransactionID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Release: "1.2.3-rc.4", Channel: "beta",
		GatewayPort: 18789, OperatorUser: "app", PlatformIdentity: "linux/x64",
		TrustRootSHA256: strings.Repeat("a", 64), Interactive: true,
	}
	legacyDurable := "01234567-89ab-4cde-8fab-0123456789ab"
	state := CommandState{
		SchemaVersion: CommandSchemaVersion, TransactionID: legacyDurable,
		Release: request.Release, OperatorUser: request.OperatorUser,
	}
	resolved, err := state.DurableTransactionIDFor(request)
	if err != nil || resolved != legacyDurable {
		t.Fatalf("legacy lifecycle-host retry projection was not recoverable: resolved=%q err=%v", resolved, err)
	}
}

func TestHostingSecurityCommandDecoderRejectsUnknownBootstrapPolicy(t *testing.T) {
	request := CommandRequest{SchemaVersion: CommandSchemaVersion, Operation: CommandAbort, TransactionID: "01234567-89ab-4cde-8fab-0123456789ab"}
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	data = bytes.Replace(data, []byte("}"), []byte(`,"durableStateSchema":99}`), 1)
	if _, err := DecodeCommandRequest(bytes.NewReader(data)); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("bootstrap injected lifecycle-host policy was accepted: %v", err)
	}
}
