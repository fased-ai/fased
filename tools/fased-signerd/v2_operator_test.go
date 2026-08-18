package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
)

func TestSignerOperatorContextBindsReleaseExpiryAndOneTimeNonce(t *testing.T) {
	store, _ := openTestSignerV2(t)
	now := time.Date(2026, 7, 20, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	release, err := signerReleaseIdentity()
	if err != nil {
		t.Fatal(err)
	}
	context := signerOperatorContextV1{
		Nonce: strings.Repeat("a", 64), ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano), Release: release,
	}
	req := request{Op: "health", Operator: &context}
	if err := validateSignerOperatorContextV1(req, store, now); err != nil {
		t.Fatalf("valid operator context was rejected: %v", err)
	}
	if err := validateSignerOperatorContextV1(req, store, now); err == nil || !strings.Contains(err.Error(), "already used") {
		t.Fatalf("operator nonce replay was accepted: %v", err)
	}

	badRelease := context
	badRelease.Nonce = strings.Repeat("b", 64)
	badRelease.Release.Commit = "different"
	if err := validateSignerOperatorContextV1(request{Op: "health", Operator: &badRelease}, store, now); err == nil || !strings.Contains(err.Error(), "release identity") {
		t.Fatalf("mismatched operator release was accepted: %v", err)
	}
	expired := context
	expired.Nonce = strings.Repeat("c", 64)
	expired.ExpiresAt = now.Format(time.RFC3339Nano)
	if err := validateSignerOperatorContextV1(request{Op: "health", Operator: &expired}, store, now); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expired operator request was accepted: %v", err)
	}
	nonces := []string{"d", "e", "f", "a", "b", "c"}
	for index, op := range []string{
		"v2.policy.put",
		"v2.wallet.recovery.export",
		"v2.wallet.recovery.import",
		"v2.wallet.exportRaw",
		"v2.wallet.rotation.create",
		"v2.wallet.rotation.commit",
	} {
		forbidden := context
		forbidden.Nonce = strings.Repeat(nonces[index], 64)
		if err := validateSignerOperatorContextV1(request{Op: op, Operator: &forbidden}, store, now); err == nil || !strings.Contains(err.Error(), "not available") {
			t.Fatalf("%s was accepted on operator authority: %v", op, err)
		}
	}
}

func TestSignerOperatorLifecycleAllowsTypedSetupButDeniesCustodyExport(t *testing.T) {
	store, keys := openTestSignerV2(t)
	service := &signerServiceV2{store: store, keys: keys}
	createBody, err := json.Marshal(signerOperatorWalletCreateRequestV1{
		ExpectedVersion: 0,
		Baseline:        signerRoleBaselineRequestV1{Version: 1, Role: "vault"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.handle(request{
		Op: "v2.wallet.create", WalletID: "operator-vault", Request: createBody, operatorSocket: true,
	}, signerConfig{}, false); err != nil {
		t.Fatalf("operator create failed: %v", err)
	}
	createdPolicy, err := store.getPolicy("operator-vault")
	if err != nil || createdPolicy.Role != "vault" || createdPolicy.BaselineVersion != 1 {
		t.Fatalf("operator create omitted its fixed Vault baseline: policy=%#v err=%v", createdPolicy, err)
	}
	networkBody, _ := json.Marshal(signerOperatorNetworkSetPrimaryRequestV1{
		ExpectedVersion: 0,
		PrimaryRPCURL:   "https://api.devnet.solana.com",
	})
	if _, err := service.handle(request{
		Op: "v2.network.setPrimary", WalletID: "operator-vault", Request: networkBody, operatorSocket: true,
	}, signerConfig{}, false); err != nil {
		t.Fatalf("operator primary RPC activation failed: %v", err)
	}
	network, err := keys.NetworkSummaryV2("operator-vault")
	if err != nil || !network.Ready || network.Version != 1 || network.Hash == "" {
		t.Fatalf("operator primary RPC was not durably activated: network=%#v err=%v", network, err)
	}
	locked, _, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{
		WalletID: "operator-locked", ExpectedVersion: 0,
		Policy: signerPolicyV2{Role: "agent", Operations: []string{}, Programs: []string{}, Assets: []signerPolicyAssetV2{}},
	})
	if err != nil {
		t.Fatal(err)
	}
	activationBody, err := json.Marshal(signerOperatorPolicyActivateBaselineRequestV1{
		ExpectedVersion: 1,
		Baseline:        signerRoleBaselineRequestV1{Version: 1, Role: "agent"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.handle(request{
		Op: "v2.policy.activateBaseline", WalletID: locked.WalletID, Request: activationBody, operatorSocket: true,
	}, signerConfig{}, false); err != nil {
		t.Fatalf("operator role-baseline activation failed: %v", err)
	}
	activated, err := store.getPolicy(locked.WalletID)
	if err != nil || activated.BaselineVersion != 1 || activated.Version != 2 {
		t.Fatalf("operator role-baseline activation was not durable: policy=%#v err=%v", activated, err)
	}

	privateKey := solana.NewWallet().PrivateKey
	importBody, err := json.Marshal(signerOperatorWalletImportRequestV1{
		ExpectedVersion: 0,
		Baseline:        signerRoleBaselineRequestV1{Version: 1, Role: "agent"},
		KeypairBase64:   base64.RawStdEncoding.EncodeToString(privateKey),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.handle(request{
		Op: "v2.wallet.import", WalletID: "operator-agent", Request: importBody, operatorSocket: true,
	}, signerConfig{}, false); err != nil {
		t.Fatalf("operator import failed: %v", err)
	}
	wallet, err := keys.PublicRecord("operator-agent")
	if err != nil || wallet.PublicKey != privateKey.PublicKey().String() {
		t.Fatalf("operator import stored the wrong signer key: wallet=%#v err=%v", wallet, err)
	}
	policy, err := store.getPolicy("operator-agent")
	if err != nil || policy.Role != "agent" || policy.BaselineVersion != 1 || len(policy.Operations) == 0 {
		t.Fatalf("operator import omitted the signer-owned role baseline: policy=%#v err=%v", policy, err)
	}

	rawBody, _ := json.Marshal(signerOperatorRawExportRequestV1{
		ExpectedPublicKey: wallet.PublicKey, AcknowledgeCustodyReduction: true,
	})
	if _, err := service.handle(request{
		Op: "v2.wallet.exportRaw", WalletID: wallet.WalletID, Request: rawBody, operatorSocket: true,
	}, signerConfig{}, false); err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("operator raw export was not denied: %v", err)
	}
	if strings.Contains(string(importBody), "path") {
		t.Fatalf("operator import exposed a caller-chosen signer path: %s", importBody)
	}

	policyBody, _ := json.Marshal(signerPolicyV2{Role: "agent"})
	if _, err := service.handle(request{
		Op: "v2.policy.put", WalletID: wallet.WalletID, Request: policyBody, operatorSocket: true,
	}, signerConfig{}, false); err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("operator socket accepted arbitrary policy administration: %v", err)
	}
}

func TestSignerPeerCredentialRequiresExpectedUnixPeerUID(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("Unix peer credentials are intentionally fail-closed on this platform")
	}
	// macOS limits Unix-domain socket paths to roughly 104 bytes. t.TempDir()
	// includes the full test name and can exceed that limit on hosted runners.
	socketDir, err := os.MkdirTemp("", "fsp-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(socketDir) })
	socketPath := filepath.Join(socketDir, "peer.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, _ := listener.Accept()
		accepted <- conn
	}()
	client, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server := <-accepted
	defer server.Close()
	credential, err := requireSignerPeerCredentialV2(server, os.Geteuid())
	if err != nil || !credential.Proven || credential.UID != os.Geteuid() {
		t.Fatalf("expected Unix peer identity was not proven: credential=%#v err=%v", credential, err)
	}
	if os.Geteuid() != 0 {
		if _, err := requireSignerPeerCredentialV2(server, os.Geteuid()+1); err == nil || !strings.Contains(err.Error(), "not authorized") {
			t.Fatalf("unexpected Unix peer UID was accepted: %v", err)
		}
	}
}

func TestSignerMutationRefusesBeforeStateChangeWhenAuditUnavailable(t *testing.T) {
	store, keys := openTestSignerV2(t)
	service := &signerServiceV2{store: store, keys: keys}
	body, err := json.Marshal(signerWalletCreateRequestV2{
		ExpectedVersion: 0,
		Baseline:        &signerRoleBaselineRequestV1{Version: 1, Role: "agent"},
	})
	if err != nil {
		t.Fatal(err)
	}
	req := request{Op: "v2.wallet.create", WalletID: "audit-refused", Request: body}
	auditPath := t.TempDir()
	server, client := net.Pipe()
	done := make(chan struct{})
	go func() {
		handleConn(
			server,
			signerConfig{},
			newRateLimiter(time.Minute, map[string]int{req.Op: 1}),
			&auditWriter{path: auditPath},
			service,
			false,
		)
		close(done)
	}()
	encoded, _ := json.Marshal(req)
	if _, err := client.Write(append(encoded, '\n')); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(client).ReadString('\n')
	if err != nil || !strings.Contains(line, "audit is unavailable; mutation refused") {
		t.Fatalf("mutation was not refused at the audit boundary: response=%q err=%v", line, err)
	}
	_ = client.Close()
	<-done
	if _, err := keys.PublicRecord("audit-refused"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("audit-unavailable mutation changed signer state: %v", err)
	}
}
