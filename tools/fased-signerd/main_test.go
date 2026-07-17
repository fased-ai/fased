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
	solanaWriteRPCCircuits.Lock()
	solanaWriteRPCCircuits.Endpoints = map[string]solanaWriteRPCEndpointState{}
	solanaWriteRPCCircuits.Unlock()
	t.Cleanup(func() {
		solanaWriteRPCCircuits.Lock()
		solanaWriteRPCCircuits.Endpoints = map[string]solanaWriteRPCEndpointState{}
		solanaWriteRPCCircuits.Unlock()
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
}

func TestReadRequestLineRejectsOversizedPayload(t *testing.T) {
	reader := bufio.NewReader(strings.NewReader(strings.Repeat("a", 32) + "\n"))
	if _, err := readRequestLine(reader, 16); err != errRequestTooLarge {
		t.Fatalf("expected errRequestTooLarge, got %v", err)
	}
}
