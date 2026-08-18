package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"fased-signerd/internal/execution"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

var removedSignerOperations = []string{
	"custodyStatus",
	"unlockCustody",
	"lockCustody",
	"prepareTx",
	"signTx",
	"sendTx",
	"sendSolanaInstruction",
	"sendSolanaInstructions",
}

func TestRemovedSignerOperationsAreUnsupported(t *testing.T) {
	cfg := signerConfig{chains: []string{"solana"}}
	for _, operation := range removedSignerOperations {
		t.Run(operation, func(t *testing.T) {
			err := mustValidate(request{
				Op:       operation,
				Chain:    "solana",
				WalletID: "agent",
				Request:  json.RawMessage(`{"requestId":"legacy-request","amount":"1"}`),
			}, cfg)
			if err == nil || err.Error() != "unsupported op" {
				t.Fatalf("removed operation %q was not rejected as unsupported: %v", operation, err)
			}
		})
	}
}

func TestReviewLookupRequiresAnExactWalletScopedRequest(t *testing.T) {
	valid := request{
		Op: "v2.review.get", WalletID: "vault", Request: json.RawMessage(`{"requestId":"review-123"}`),
	}
	if err := mustValidate(valid, signerConfig{}); err != nil {
		t.Fatalf("valid review lookup was rejected: %v", err)
	}
	for _, invalid := range []request{
		{Op: "v2.review.get", WalletID: "vault"},
		{Op: "v2.review.get", Request: valid.Request},
		{Op: "v2.review.get", WalletID: "vault", Chain: "solana", Request: valid.Request},
	} {
		if err := mustValidate(invalid, signerConfig{}); err == nil {
			t.Fatalf("invalid review lookup was accepted: %#v", invalid)
		}
	}
}

func TestJupiterTriggerHistoryIsARealWalletScopedApplicationRead(t *testing.T) {
	valid := request{Op: "v2.jupiter.trigger.history", WalletID: "agent"}
	if err := mustValidate(valid, signerConfig{}); err != nil {
		t.Fatalf("valid Trigger history request was rejected before dispatch: %v", err)
	}
	for _, invalid := range []request{
		{Op: valid.Op},
		{Op: valid.Op, WalletID: "   "},
		{Op: valid.Op, WalletID: "agent", Chain: "solana"},
		{Op: valid.Op, WalletID: "agent", Request: json.RawMessage(`{}`)},
	} {
		if err := mustValidate(invalid, signerConfig{}); err == nil {
			t.Fatalf("invalid Trigger history request was accepted: %#v", invalid)
		}
	}
	limiter := newRateLimiter(time.Minute, map[string]int{"v2.jupiter.trigger.history": 2})
	if !limiter.allow(valid.Op) || !limiter.allow(valid.Op) || limiter.allow(valid.Op) {
		t.Fatal("Trigger history does not have the expected bounded read-rate classification")
	}

	store, keys := openTestSignerV2(t)
	service := &signerServiceV2{store: store, keys: keys}
	server, client := net.Pipe()
	done := make(chan struct{})
	go func() {
		handleConn(server, signerConfig{}, newRateLimiter(time.Minute, map[string]int{valid.Op: 1}), &auditWriter{}, service, false)
		close(done)
	}()
	_ = client.SetDeadline(time.Now().Add(5 * time.Second))
	encoded, _ := json.Marshal(valid)
	if _, err := client.Write(append(encoded, '\n')); err != nil {
		t.Fatalf("write Trigger history application-socket request: %v", err)
	}
	line, err := bufio.NewReader(client).ReadString('\n')
	if err != nil {
		t.Fatalf("read Trigger history response: %v", err)
	}
	if !strings.Contains(line, "signer-owned Jupiter Trigger API key is not configured") || strings.Contains(line, "unsupported op") || strings.Contains(line, "rate limit") {
		t.Fatalf("Trigger history did not reach its application-socket handler: %s", line)
	}
	_ = client.Close()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Trigger history socket did not close")
	}
}

func TestSignerSuccessorAndCredentialAdminRequestClassification(t *testing.T) {
	valid := []request{
		{Op: "v2.wallet.rotation.create", WalletID: "agent", Request: json.RawMessage(`{"successorWalletId":"agent_next"}`)},
		{Op: "v2.wallet.rotation.status", WalletID: "agent"},
		{Op: "v2.wallet.rotation.commit", WalletID: "agent", Request: json.RawMessage(`{"rotationId":"sha256:test"}`)},
		{Op: "v2.webauthn.credentials.revoke", Request: json.RawMessage(`{"credentialId":"YQ"}`)},
	}
	for _, req := range valid {
		if err := mustValidate(req, signerConfig{}); err != nil {
			t.Fatalf("valid administrative envelope classification rejected %#v: %v", req, err)
		}
	}
	invalid := []request{
		{Op: "v2.wallet.rotation.create", WalletID: "agent"},
		{Op: "v2.wallet.rotation.status", WalletID: "agent", Request: json.RawMessage(`{}`)},
		{Op: "v2.wallet.rotation.commit", Request: json.RawMessage(`{}`)},
		{Op: "v2.webauthn.credentials.revoke", WalletID: "agent", Request: json.RawMessage(`{}`)},
	}
	for _, req := range invalid {
		if err := mustValidate(req, signerConfig{}); err == nil {
			t.Fatalf("invalid administrative envelope classification accepted %#v", req)
		}
	}
}

func TestCompatibilityReadsRequireAnExactWalletScope(t *testing.T) {
	cfg := signerConfig{chains: []string{"solana"}}
	for _, valid := range []request{
		{Op: "getAddresses", WalletID: "agent"},
		{Op: "getBalance", Chain: "solana", WalletID: "agent"},
	} {
		if err := mustValidate(valid, cfg); err != nil {
			t.Fatalf("valid wallet-scoped read was rejected: request=%#v err=%v", valid, err)
		}
	}
	for _, invalid := range []request{
		{Op: "getAddresses"},
		{Op: "getAddresses", WalletID: "   "},
		{Op: "getBalance", Chain: "solana"},
		{Op: "getBalance", Chain: "solana", WalletID: "   "},
	} {
		if err := mustValidate(invalid, cfg); err == nil {
			t.Fatalf("unscoped compatibility read was accepted: %#v", invalid)
		}
	}
}

func TestRemovedSignerOperationsCannotMutateSignerState(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)
	service := &signerServiceV2{store: store, keys: keys}
	cfg := signerConfig{chains: []string{"solana"}}
	limiter := newRateLimiter(time.Minute, map[string]int{
		"health":       100,
		"getAddresses": 100,
		"getBalance":   100,
	})
	baseline := snapshotSignerState(t, store)

	for _, operation := range removedSignerOperations {
		t.Run(operation, func(t *testing.T) {
			server, client := net.Pipe()
			done := make(chan struct{})
			go func() {
				handleConn(server, cfg, limiter, &auditWriter{}, service, false)
				close(done)
			}()
			_ = client.SetDeadline(time.Now().Add(5 * time.Second))
			encoded, err := json.Marshal(request{
				Op:       operation,
				Chain:    "solana",
				WalletID: "agent",
				Request:  json.RawMessage(`{"requestId":"legacy-request","amount":"1"}`),
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := client.Write(append(encoded, '\n')); err != nil {
				t.Fatalf("write removed operation request: %v", err)
			}
			line, err := bufio.NewReader(client).ReadString('\n')
			if err != nil {
				t.Fatalf("read removed operation response: %v", err)
			}
			var response struct {
				OK    bool   `json:"ok"`
				Error string `json:"error"`
			}
			if err := json.Unmarshal([]byte(line), &response); err != nil {
				t.Fatalf("decode removed operation response: %v", err)
			}
			if response.OK || response.Error != "unsupported op" {
				t.Fatalf("removed operation reached a signer implementation: %s", line)
			}
			_ = client.Close()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("signer connection did not close")
			}
			if current := snapshotSignerState(t, store); current != baseline {
				t.Fatalf("removed operation %q mutated signer state\nbefore:\n%s\nafter:\n%s", operation, baseline, current)
			}
		})
	}
}

func snapshotSignerState(t *testing.T, store *signerStoreV2) string {
	t.Helper()
	var records []string
	if err := store.db.View(func(tx *bolt.Tx) error {
		return tx.ForEach(func(bucketName []byte, bucket *bolt.Bucket) error {
			return bucket.ForEach(func(key, value []byte) error {
				encoded := "<bucket>"
				if value != nil {
					encoded = base64.RawStdEncoding.EncodeToString(value)
				}
				records = append(records, string(bucketName)+"\x00"+string(key)+"\x00"+encoded)
				return nil
			})
		})
	}); err != nil {
		t.Fatalf("snapshot signer state: %v", err)
	}
	sort.Strings(records)
	return strings.Join(records, "\n")
}

func TestCompatibilityReadsUseSignerOwnedWalletAndNetwork(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	wallet, _ := createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)

	addresses, err := (&signerServiceV2{store: store, keys: keys}).handle(
		request{Op: "getAddresses", WalletID: "agent"},
		signerConfig{chains: []string{"solana"}},
		false,
	)
	if err != nil || !strings.Contains(string(addresses), wallet.PublicKey) {
		t.Fatalf("getAddresses did not use signer-owned wallet: response=%s err=%v", addresses, err)
	}

	rpcServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, httpRequest *http.Request) {
		defer httpRequest.Body.Close()
		var rpcRequest struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
		}
		if err := json.NewDecoder(httpRequest.Body).Decode(&rpcRequest); err != nil {
			t.Errorf("decode Solana RPC request: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		if rpcRequest.Method != "getBalance" {
			t.Errorf("unexpected Solana RPC method %q", rpcRequest.Method)
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"jsonrpc": "2.0",
			"id":      rpcRequest.ID,
			"result":  map[string]any{"context": map[string]any{"slot": 1}, "value": 4242},
		})
	}))
	defer rpcServer.Close()
	if _, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0),
		PrimaryRPCURL:   rpcServer.URL,
	}); err != nil {
		t.Fatalf("configure signer-owned RPC: %v", err)
	}
	t.Setenv("FASED_WALLET_SOLANA_RPC_URL", "https://gateway-rpc.invalid")
	balance, err := (&signerServiceV2{store: store, keys: keys}).handle(
		request{Op: "getBalance", Chain: "solana", WalletID: "agent"},
		signerConfig{chains: []string{"solana"}},
		false,
	)
	if err != nil || !strings.Contains(string(balance), `"balance":"4242"`) || !strings.Contains(string(balance), wallet.PublicKey) {
		t.Fatalf("getBalance did not use signer-owned wallet/network: response=%s err=%v", balance, err)
	}
}

func TestSolanaWriteRPCCircuitKeepsPrimaryFailureAfterFallbackSuccess(t *testing.T) {
	now := time.Unix(100, 0)
	priorPool := solanaWriteRPCPool
	solanaWriteRPCPool = execution.NewRPCPool(func() time.Time { return now })
	t.Cleanup(func() {
		solanaWriteRPCPool = priorPool
	})

	primary := "https://primary.invalid"
	fallback := "https://fallback.invalid"
	markSolanaWriteRPCFailure(primary, errors.New("429 quota exhausted"))
	markSolanaWriteRPCSuccess(fallback)
	active, err := activeSolanaWriteRPCURLs([]string{primary, fallback})
	if err != nil {
		t.Fatalf("activeSolanaWriteRPCURLs error: %v", err)
	}
	if len(active) != 1 || active[0] != fallback {
		t.Fatalf("expected only fallback while primary cools down, got %#v", active)
	}

	now = now.Add(30 * time.Second)
	active, err = activeSolanaWriteRPCURLs([]string{primary, fallback})
	if err != nil || len(active) != 2 || active[0] != primary || active[1] != fallback {
		t.Fatalf("expected primary after quota cooldown expiry: active=%#v err=%v", active, err)
	}
	markSolanaWriteRPCFailure(primary, errors.New("temporary network failure"))
	active, err = activeSolanaWriteRPCURLs([]string{primary, fallback})
	if err != nil || len(active) != 1 || active[0] != fallback {
		t.Fatalf("cooldown expiry erased primary failure history: active=%#v err=%v", active, err)
	}
	markSolanaWriteRPCSuccess(primary)
	active, err = activeSolanaWriteRPCURLs([]string{primary, fallback})
	if err != nil || len(active) != 2 || active[0] != primary || active[1] != fallback {
		t.Fatalf("expected successful primary reset to restore configured order: active=%#v err=%v", active, err)
	}
}

func TestSignerOwnedRPCMalformedResponseDoesNotLeakCredentials(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		requests++
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte("{"))
	}))
	defer server.Close()
	secret := "write-rpc-secret" // pragma: allowlist secret
	rpcURL := server.URL + "?api-key=" + secret
	_, err := signerLatestBlockhashWithFallbackV2([]string{rpcURL})
	if err == nil {
		t.Fatal("malformed signer-owned RPC response was accepted")
	}
	if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), rpcURL) {
		t.Fatalf("malformed RPC diagnostic leaked credentials: %v", err)
	}
	if requests != 1 {
		t.Fatalf("expected one bounded malformed-response request, got %d", requests)
	}
}

func TestSignerOwnedRPCConfirmationTimeoutHasBoundedPolling(t *testing.T) {
	t.Setenv("FASED_WALLET_SOLANA_WRITE_RPC_TIMEOUT_MS", "100")
	t.Setenv("FASED_WALLET_SOLANA_CONFIRM_TIMEOUT_MS", "25")
	statusRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		statusRequests++
		defer request.Body.Close()
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"result": map[string]any{"context": map[string]any{"slot": 1}, "value": []any{nil}},
		})
	}))
	defer server.Close()
	var signature solana.Signature
	signature[0] = 1
	err := confirmSignerSolanaSignatureAcrossRPCsV2([]string{server.URL}, signature)
	if err == nil || !strings.Contains(err.Error(), "confirmation timed out") {
		t.Fatalf("expected bounded confirmation timeout, got %v", err)
	}
	if statusRequests != 1 {
		t.Fatalf("expected one confirmation poll inside the short timeout, got %d", statusRequests)
	}
}

func TestReadRequestLineRejectsOversizedPayload(t *testing.T) {
	reader := bufio.NewReader(strings.NewReader(strings.Repeat("a", 32) + "\n"))
	if _, err := readRequestLine(reader, 16); err != errRequestTooLarge {
		t.Fatalf("expected errRequestTooLarge, got %v", err)
	}
}
