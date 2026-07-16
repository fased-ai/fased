package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
)

func signerUint64PointerV2(value uint64) *uint64 {
	return &value
}

func TestSignerNetworkConfigurationIsEncryptedAndMetadataOnly(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)
	primary := "https://rpc.example.com/solana?api-key=primary-secret-token"
	fallback := "https://fallback.example.com/rpc/fallback-secret-token"

	summary, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0),
		PrimaryRPCURL:   primary,
		FallbackRPCURL:  fallback,
	})
	if err != nil {
		t.Fatalf("put encrypted signer network: %v", err)
	}
	if !summary.Configured || !summary.Ready || summary.Version != 1 || !strings.HasPrefix(summary.Hash, "hmac-sha256:") {
		t.Fatalf("unexpected signer network summary: %#v", summary)
	}
	encodedSummary, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{primary, fallback, "primary-secret-token", "fallback-secret-token"} {
		if bytes.Contains(encodedSummary, []byte(secret)) {
			t.Fatalf("network summary exposed RPC material %q: %s", secret, encodedSummary)
		}
	}

	var stored []byte
	if err := store.db.View(func(tx *bolt.Tx) error {
		stored = append([]byte(nil), tx.Bucket(bucketSignerNetworksV2).Get([]byte("agent"))...)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(stored) == 0 {
		t.Fatal("encrypted signer network record was not stored")
	}
	for _, secret := range []string{primary, fallback, "primary-secret-token", "fallback-secret-token"} {
		if bytes.Contains(stored, []byte(secret)) {
			t.Fatalf("bbolt signer network record contains plaintext RPC material %q", secret)
		}
	}
	databaseBytes, err := os.ReadFile(store.db.Path())
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{primary, fallback, "primary-secret-token", "fallback-secret-token"} {
		if bytes.Contains(databaseBytes, []byte(secret)) {
			t.Fatalf("bbolt signer state file contains plaintext RPC material %q", secret)
		}
	}
	var record signerNetworkRecordV2
	if err := json.Unmarshal(stored, &record); err != nil || record.Nonce == "" || record.Secret == "" {
		t.Fatalf("invalid encrypted signer network record: %#v err=%v", record, err)
	}

	urls, err := keys.SolanaRPCURLsV2("agent")
	if err != nil || len(urls) != 2 || urls[0] != primary || urls[1] != fallback {
		t.Fatalf("decrypt signer-owned RPC URLs: urls=%#v err=%v", urls, err)
	}
	readSummary, err := keys.NetworkSummaryV2("agent")
	if err != nil || readSummary != summary {
		t.Fatalf("read signer network metadata: %#v err=%v", readSummary, err)
	}
	webauthn, err := newSignerWebAuthnServiceV2(store, "", "")
	if err != nil {
		t.Fatal(err)
	}
	health, err := (&signerServiceV2{store: store, keys: keys, webauthn: webauthn}).health(signerConfig{chains: []string{"solana"}})
	if err != nil || !health.Schema.Ready || health.Schema.Version != signerStateSchemaVersionV2 || !health.Network.Ready || len(health.Network.Wallets) != 1 {
		t.Fatalf("health did not report schema/network readiness: %#v err=%v", health, err)
	}
	encodedHealth, err := json.Marshal(health)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{primary, fallback, "primary-secret-token", "fallback-secret-token"} {
		if bytes.Contains(encodedHealth, []byte(secret)) {
			t.Fatalf("health exposed RPC material %q: %s", secret, encodedHealth)
		}
	}

	if _, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0),
		PrimaryRPCURL:   "https://new.example.com",
	}); err == nil || !strings.Contains(err.Error(), "version conflict") {
		t.Fatalf("expected stale signer network version rejection, got %v", err)
	}
	updated, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(1),
		PrimaryRPCURL:   "https://new.example.com",
	})
	if err != nil || updated.Version != 2 || updated.Hash == summary.Hash {
		t.Fatalf("versioned signer network replacement failed: %#v err=%v", updated, err)
	}
}

func TestSignerNetworkHashIsWalletBoundAndSurvivesRestart(t *testing.T) {
	directory := t.TempDir()
	dbPath := filepath.Join(directory, "state.db")
	masterPath := filepath.Join(directory, "master.key")
	store, err := openSignerStoreV2(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := openSignerKeyManagerV2(store, masterPath)
	if err != nil {
		t.Fatal(err)
	}
	destination := solana.NewWallet().PublicKey().String()
	createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)
	createTestSignerWalletV2(t, store, keys, "mining", destination, 100, 1000)
	input := signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0),
		PrimaryRPCURL:   "https://rpc.example.com?token=shared-secret",
	}
	agent, err := keys.PutNetworkV2("agent", input)
	if err != nil {
		t.Fatal(err)
	}
	mining, err := keys.PutNetworkV2("mining", input)
	if err != nil {
		t.Fatal(err)
	}
	if agent.Hash == mining.Hash {
		t.Fatal("signer network hash was not bound to wallet identity")
	}
	keys.Close()
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := openSignerStoreV2(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	reopenedKeys, err := openSignerKeyManagerV2(reopened, masterPath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopenedKeys.Close()
	urls, err := reopenedKeys.SolanaRPCURLsV2("agent")
	if err != nil || len(urls) != 1 || !strings.Contains(urls[0], "shared-secret") {
		t.Fatalf("encrypted signer network did not survive restart: %#v err=%v", urls, err)
	}
	health, err := reopenedKeys.NetworkHealthV2()
	if err != nil || !health.Ready || len(health.Wallets) != 2 {
		t.Fatalf("unexpected signer network health after restart: %#v err=%v", health, err)
	}
}

func TestSignerNetworkPendingAndCorruptionFailClosed(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)
	summary, err := keys.NetworkSummaryV2("agent")
	if err != nil || summary.Configured || summary.Ready {
		t.Fatalf("missing signer network must be pending: %#v err=%v", summary, err)
	}
	if _, err := keys.SolanaRPCURLsV2("agent"); !errors.Is(err, errSignerNetworkPendingV2) {
		t.Fatalf("expected network-pending error, got %v", err)
	}
	health, err := keys.NetworkHealthV2()
	if err != nil || health.Ready || len(health.Wallets) != 1 || health.Wallets[0].Ready {
		t.Fatalf("missing network health did not fail closed: %#v err=%v", health, err)
	}

	if err := store.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSignerNetworksV2).Put([]byte("agent"), []byte(`{"not":"a valid record"}`))
	}); err != nil {
		t.Fatal(err)
	}
	corrupt, err := keys.NetworkSummaryV2("agent")
	if err != nil || !corrupt.Configured || corrupt.Ready {
		t.Fatalf("corrupt signer network should expose metadata readiness only: %#v err=%v", corrupt, err)
	}
	if _, err := keys.SolanaRPCURLsV2("agent"); !errors.Is(err, errSignerNetworkPendingV2) {
		t.Fatalf("corrupt network did not fail network-pending: %v", err)
	}

	record, err := keys.encryptNetworkRecordV2("agent", 1, signerNetworkSecretV2{PrimaryRPCURL: "https://rpc.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	record.Nonce = "AA"
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSignerNetworksV2).Put([]byte("agent"), encoded)
	}); err != nil {
		t.Fatal(err)
	}
	badNonce, err := keys.NetworkSummaryV2("agent")
	if err != nil || !badNonce.Configured || badNonce.Ready || badNonce.Version != 1 {
		t.Fatalf("invalid encrypted nonce did not fail readiness safely: %#v err=%v", badNonce, err)
	}

	record.Hash = "https://must-not-escape.example/?token=record-secret"
	encoded, err = json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSignerNetworksV2).Put([]byte("agent"), encoded)
	}); err != nil {
		t.Fatal(err)
	}
	unsafeMetadata, err := keys.NetworkSummaryV2("agent")
	if err != nil || !unsafeMetadata.Configured || unsafeMetadata.Ready || unsafeMetadata.Hash != "" || unsafeMetadata.Version != 0 {
		t.Fatalf("unsafe record metadata was exposed: %#v err=%v", unsafeMetadata, err)
	}
	public, err := json.Marshal(unsafeMetadata)
	if err != nil || bytes.Contains(public, []byte("record-secret")) || bytes.Contains(public, []byte("must-not-escape")) {
		t.Fatalf("unsafe stored metadata escaped network summary: %s err=%v", public, err)
	}
}

func TestSignerNetworkWrongMasterKeyAndCrossWalletRecordFailClosed(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)
	createTestSignerWalletV2(t, store, keys, "mining", destination, 100, 1000)
	for _, walletID := range []string{"agent", "mining"} {
		if _, err := keys.PutNetworkV2(walletID, signerNetworkPutRequestV2{
			ExpectedVersion: signerUint64PointerV2(0),
			PrimaryRPCURL:   "https://" + walletID + ".example.com/?token=" + walletID + "-secret",
		}); err != nil {
			t.Fatal(err)
		}
	}

	wrongKey := &signerKeyManagerV2{store: store, masterKey: bytes.Repeat([]byte{0x42}, 32)}
	summary, err := wrongKey.NetworkSummaryV2("agent")
	if err != nil || !summary.Configured || summary.Ready {
		t.Fatalf("wrong signer master key did not fail network readiness: %#v err=%v", summary, err)
	}
	if _, err := wrongKey.SolanaRPCURLsV2("agent"); !errors.Is(err, errSignerNetworkPendingV2) {
		t.Fatalf("wrong signer master key did not fail network-pending: %v", err)
	}

	if err := store.db.Update(func(tx *bolt.Tx) error {
		networks := tx.Bucket(bucketSignerNetworksV2)
		copied := append([]byte(nil), networks.Get([]byte("mining"))...)
		return networks.Put([]byte("agent"), copied)
	}); err != nil {
		t.Fatal(err)
	}
	summary, err = keys.NetworkSummaryV2("agent")
	if err != nil || !summary.Configured || summary.Ready {
		t.Fatalf("cross-wallet encrypted network record did not fail closed: %#v err=%v", summary, err)
	}
	if _, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: "https://replacement.example.com",
	}); err == nil || !strings.Contains(err.Error(), "invalid stored") {
		t.Fatalf("network put silently replaced cross-wallet record: %v", err)
	}
}

func TestSignerRPCURLValidationRejectsUnsafeTargets(t *testing.T) {
	valid := []string{
		"https://api.mainnet-beta.solana.com",
		"https://abc.def",
		"https://rpc.example.com/v1?token=secret",
		"http://localhost:8899",
		"http://node.localhost:8899/rpc",
		"http://127.0.0.1:8899",
		"http://[::1]:8899",
		"https://10.0.0.5:443/private-rpc",
	}
	for _, candidate := range valid {
		if _, err := normalizeSignerRPCURLV2(candidate, "primaryRpcUrl"); err != nil {
			t.Errorf("valid signer RPC URL rejected: %s: %v", candidate, err)
		}
	}
	tooLong := "https://example.com/" + strings.Repeat("a", maxSignerRPCURLBytesV2)
	invalid := []string{
		"http://rpc.example.com",
		"ftp://rpc.example.com",
		"https://user:password@rpc.example.com",
		"https://rpc.example.com/#secret-fragment",
		"https://rpc.example.com#",
		"https://169.254.169.254/latest/meta-data",
		"https://169.254.170.2/v2/credentials",
		"https://100.100.100.200/latest/meta-data",
		"https://168.63.129.16/metadata",
		"https://192.0.0.192/metadata",
		"https://[fd00:ec2::254]/latest/meta-data",
		"https://[fd20:ce::254]/computeMetadata/v1",
		"https://224.0.0.1/rpc",
		"https://[ff02::1]/rpc",
		"https://[fe80::1]/rpc",
		"https://0.0.0.0/rpc",
		"https://[::]/rpc",
		"https://metadata.google.internal/computeMetadata/v1",
		"https://2130706433/rpc",
		"https://127.1/rpc",
		"https://rpc_example.com",
		" https://rpc.example.com",
		tooLong,
	}
	for _, candidate := range invalid {
		if _, err := normalizeSignerRPCURLV2(candidate, "primaryRpcUrl"); err == nil {
			t.Errorf("unsafe signer RPC URL accepted: %s", candidate)
		} else if strings.Contains(err.Error(), candidate) || strings.Contains(err.Error(), "secret-fragment") {
			t.Errorf("RPC validation error reflected secret URL material: %v", err)
		}
	}
	if _, err := normalizeSignerNetworkInputV2(signerNetworkPutRequestV2{
		PrimaryRPCURL:  "https://rpc.example.com",
		FallbackRPCURL: "https://rpc.example.com",
	}); err == nil || !strings.Contains(err.Error(), "must differ") {
		t.Fatalf("expected duplicate fallback rejection, got %v", err)
	}
}

func TestSignerOwnedRPCTransportIgnoresProxyAndRedirects(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	httpClient := newSignerOwnedHTTPClientV2()
	transport, ok := httpClient.Transport.(*http.Transport)
	if !ok || transport.Proxy != nil {
		t.Fatalf("signer-owned RPC transport inherited an environment proxy: %#v", httpClient.Transport)
	}
	var redirectedRequests atomic.Int64
	destination := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		redirectedRequests.Add(1)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":{"blockhash":"11111111111111111111111111111111","lastValidBlockHeight":1}}}`))
	}))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := newSignerOwnedSolanaRPCClientV2(redirect.URL).GetLatestBlockhash(ctx, rpc.CommitmentFinalized); err == nil {
		t.Fatal("signer-owned RPC client followed or accepted an HTTP redirect")
	}
	if redirectedRequests.Load() != 0 {
		t.Fatalf("signer-owned RPC client followed redirect to another endpoint %d times", redirectedRequests.Load())
	}
	for _, address := range []string{"169.254.169.254:443", "224.0.0.1:443", "[fd00:ec2::254]:443"} {
		if connection, err := dialSignerOwnedRPCV2(ctx, "tcp", address); err == nil || connection != nil || !strings.Contains(err.Error(), "unsafe") {
			t.Fatalf("signer-owned RPC dialer accepted unsafe address %s: connection=%#v err=%v", address, connection, err)
		}
	}
}

func TestSignerNetworkProtocolIsControlOnlyAndNeverReturnsURLs(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)
	service := &signerServiceV2{store: store, keys: keys}
	secret := "protocol-secret-token"
	body, err := json.Marshal(signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0),
		PrimaryRPCURL:   "https://rpc.example.com?token=" + secret,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.handle(request{Op: "v2.network.put", WalletID: "agent", Request: body}, signerConfig{}, false); err == nil || !strings.Contains(err.Error(), "control socket") {
		t.Fatalf("application socket accepted network put: %v", err)
	}
	if _, err := service.handle(request{Op: "v2.network.get", WalletID: "agent"}, signerConfig{}, false); err == nil || !strings.Contains(err.Error(), "control socket") {
		t.Fatalf("application socket accepted network get: %v", err)
	}
	response, err := service.handle(request{Op: "v2.network.put", WalletID: "agent", Request: body}, signerConfig{}, true)
	if err != nil {
		t.Fatalf("control network put: %v", err)
	}
	if bytes.Contains(response, []byte(secret)) || bytes.Contains(response, []byte("rpc.example.com")) {
		t.Fatalf("network put response exposed RPC URL: %s", response)
	}
	response, err = service.handle(request{Op: "v2.network.get", WalletID: "agent"}, signerConfig{}, true)
	if err != nil {
		t.Fatalf("control network get: %v", err)
	}
	if bytes.Contains(response, []byte(secret)) || bytes.Contains(response, []byte("rpc.example.com")) {
		t.Fatalf("network get response exposed RPC URL: %s", response)
	}
	if _, err := service.handle(request{Op: "v2.network.put", WalletID: "agent", Request: body}, signerConfig{readOnly: true}, true); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("read-only signer accepted network put: %v", err)
	}
	missingVersion := json.RawMessage(`{"primaryRpcUrl":"https://rpc.example.com"}`)
	if _, err := service.handle(request{Op: "v2.network.put", WalletID: "agent", Request: missingVersion}, signerConfig{}, true); err == nil || !strings.Contains(err.Error(), "expectedVersion") {
		t.Fatalf("network put accepted missing expectedVersion: %v", err)
	}
	trailing := append(append([]byte(nil), body...), []byte(` {}`)...)
	if _, err := service.handle(request{Op: "v2.network.put", WalletID: "agent", Request: trailing}, signerConfig{}, true); err == nil || !strings.Contains(err.Error(), "invalid signer-v2") {
		t.Fatalf("network put accepted trailing JSON: %v", err)
	}
	duplicate := json.RawMessage(`{"expectedVersion":0,"expectedVersion":1,"primaryRpcUrl":"https://rpc.example.com"}`)
	if _, err := service.handle(request{Op: "v2.network.put", WalletID: "agent", Request: duplicate}, signerConfig{}, true); err == nil || !strings.Contains(err.Error(), "invalid signer-v2") {
		t.Fatalf("network put accepted duplicate JSON fields: %v", err)
	}
}

func TestSignerV2ExecutionUsesOnlySignerOwnedNetwork(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	_, policy := createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)
	service := &signerServiceV2{store: store, keys: keys}
	intent := signerIntentV2{Type: intentSolanaNativeTransfer, Destination: destination, Lamports: "1"}
	var gatewayRequests atomic.Int64
	gatewayRPC := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		gatewayRequests.Add(1)
		writer.WriteHeader(http.StatusInternalServerError)
	}))
	defer gatewayRPC.Close()
	gatewayConfig := signerConfig{solanaRPCURL: gatewayRPC.URL, rpcURL: gatewayRPC.URL}
	pendingBody, err := json.Marshal(signerExecuteRequestV2{
		RequestID: "network-pending-request", PolicyHash: policy.Hash, Intent: intent,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.handle(request{Op: "v2.execute", WalletID: "agent", Request: pendingBody}, gatewayConfig, false); !errors.Is(err, errSignerNetworkPendingV2) {
		t.Fatalf("Gateway RPC environment bypassed network-pending: err=%v", err)
	}
	if _, err := store.getOperation("network-pending-request"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("network-pending request mutated durable operation state: %v", err)
	}
	usage, err := store.dailyUsage("agent", "solana:native", store.now())
	if err != nil || usage.Sign() != 0 {
		t.Fatalf("network-pending request reserved spend: usage=%v err=%v", usage, err)
	}

	var signerRequests atomic.Int64
	signerRPC := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		signerRequests.Add(1)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"intentional"}}`))
	}))
	defer signerRPC.Close()
	secret := "signer-rpc-secret-token"
	if _, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0),
		PrimaryRPCURL:   signerRPC.URL + "?api-key=" + secret,
	}); err != nil {
		t.Fatalf("configure signer-owned test network: %v", err)
	}
	executeBody, err := json.Marshal(signerExecuteRequestV2{
		RequestID: "signer-network-request", PolicyHash: policy.Hash, Intent: intent,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.handle(request{Op: "v2.execute", WalletID: "agent", Request: executeBody}, gatewayConfig, false); err == nil || signerRequests.Load() == 0 || gatewayRequests.Load() != 0 {
		t.Fatalf("v2 execution did not exclusively use signer-owned RPC: signer=%d gateway=%d err=%v", signerRequests.Load(), gatewayRequests.Load(), err)
	}
	operation, getErr := store.getOperation("signer-network-request")
	if getErr != nil {
		t.Fatalf("read failed signer operation: %v", getErr)
	}
	if strings.Contains(err.Error(), secret) || strings.Contains(operation.Error, secret) || strings.Contains(err.Error(), signerRPC.URL) {
		t.Fatalf("v2 RPC failure exposed encrypted endpoint material: operation=%#v err=%v", operation, err)
	}
}

func TestSignerV2TerminalIdempotencyDoesNotDependOnCurrentNetwork(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	wallet, policy := createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)
	publicKey, err := solana.PublicKeyFromBase58(wallet.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	request := signerExecuteRequestV2{
		RequestID: "terminal-idempotency-request", PolicyHash: policy.Hash,
		Intent:         signerIntentV2{Type: intentSolanaNativeTransfer, Destination: destination, Lamports: "1"},
		intentWalletID: "agent",
	}
	intent, err := normalizeSignerIntentForWalletV2(request.Intent, &publicKey)
	if err != nil {
		t.Fatal(err)
	}
	reserved, _, err := store.reserveOperation(request, intent)
	if err != nil {
		t.Fatal(err)
	}
	failed, err := store.markFailed(reserved.RequestID, errors.New("test terminal state"))
	if err != nil {
		t.Fatal(err)
	}
	result, err := (&signerServiceV2{store: store, keys: keys}).execute(request)
	if err != nil || result.State != operationFailed || result.RequestID != failed.RequestID {
		t.Fatalf("terminal idempotent result required signer network: result=%#v err=%v", result, err)
	}
}

func TestSignerV2ReconcileUsesOnlySignerOwnedNetwork(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	wallet, policy := createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)
	publicKey, err := solana.PublicKeyFromBase58(wallet.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	executeRequest := signerExecuteRequestV2{
		RequestID: "reconcile-network-request", PolicyHash: policy.Hash,
		Intent:         signerIntentV2{Type: intentSolanaNativeTransfer, Destination: destination, Lamports: "1"},
		intentWalletID: "agent",
	}
	intent, err := normalizeSignerIntentForWalletV2(executeRequest.Intent, &publicKey)
	if err != nil {
		t.Fatal(err)
	}
	operation, _, err := store.reserveOperation(executeRequest, intent)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := solana.NewWallet().PrivateKey.Sign([]byte("reconcile signer-owned RPC test"))
	if err != nil {
		t.Fatal(err)
	}
	operation, err = store.markBroadcast(operation.RequestID, signature.String(), "sha256:"+strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	service := &signerServiceV2{store: store, keys: keys}
	if result, err := service.reconcile(operation.RequestID, "agent"); !errors.Is(err, errSignerNetworkPendingV2) || result.RequestID != operation.RequestID {
		t.Fatalf("reconcile without signer network did not fail pending: result=%#v err=%v", result, err)
	}

	var signerRequests atomic.Int64
	signerRPC := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		signerRequests.Add(1)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"intentional"}}`))
	}))
	defer signerRPC.Close()
	secret := "reconcile-rpc-secret-token"
	if _, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: signerRPC.URL + "?token=" + secret,
	}); err != nil {
		t.Fatal(err)
	}
	var gatewayRequests atomic.Int64
	gatewayRPC := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		gatewayRequests.Add(1)
		writer.WriteHeader(http.StatusInternalServerError)
	}))
	defer gatewayRPC.Close()
	body, err := json.Marshal(signerOperationLookupV2{RequestID: operation.RequestID})
	if err != nil {
		t.Fatal(err)
	}
	response, err := service.handle(
		request{Op: "v2.operation.reconcile", WalletID: "agent", Request: body},
		signerConfig{solanaRPCURL: gatewayRPC.URL, rpcURL: gatewayRPC.URL},
		false,
	)
	if err != nil || signerRequests.Load() == 0 || gatewayRequests.Load() != 0 {
		t.Fatalf("reconcile did not exclusively use signer-owned RPC: signer=%d gateway=%d err=%v", signerRequests.Load(), gatewayRequests.Load(), err)
	}
	if bytes.Contains(response, []byte(secret)) || bytes.Contains(response, []byte(signerRPC.URL)) {
		t.Fatalf("reconcile exposed encrypted endpoint material: %s", response)
	}
	reconciled, err := store.getOperation(operation.RequestID)
	if err != nil || reconciled.State != operationUnknown {
		t.Fatalf("reconcile did not preserve an ambiguous result safely: result=%#v err=%v", reconciled, err)
	}
}

func TestSignerNetworkRejectsMissingWalletAndUnsafePort(t *testing.T) {
	_, keys := openTestSignerV2(t)
	if _, err := keys.PutNetworkV2("missing", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: "https://rpc.example.com",
	}); err == nil || !strings.Contains(err.Error(), "wallet not found") {
		t.Fatalf("network config accepted missing wallet: %v", err)
	}
	if _, err := normalizeSignerRPCURLV2("https://rpc.example.com:99999", "primaryRpcUrl"); err == nil {
		t.Fatal("network config accepted invalid port")
	}
}
