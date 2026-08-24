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
	if state.SchemaVersion != CommandSchemaVersion || state.TransactionID != prepare.TransactionID ||
		state.OperatorUser != prepare.OperatorUser || state.TailscaleDNS == "" || !state.OnboardingRequired ||
		!state.NeedsFinalization || state.Committed {
		t.Fatalf("stable Hosting command projection is incomplete: %+v", state)
	}
	durable, err := participant.Store.ReadState()
	if err != nil {
		t.Fatal(err)
	}
	if durable.SchemaVersion != CurrentSchemaVersion || durable.TransactionID != state.TransactionID {
		t.Fatalf("command did not persist the lifecycle-host-owned state: %+v", durable)
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
