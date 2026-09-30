package main

import (
	"encoding/base64"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWENMiningClaimPrepareSocketHost(t *testing.T) {
	dir := os.Getenv("WEN_PREPARE_SOCKET_DIR")
	if dir == "" {
		t.Skip("explicit local socket fixture")
	}
	op := os.Getenv("WEN_PREPARE_SOCKET_OPERATION")
	if op != "sol" && op != "sat" {
		t.Fatal("operation")
	}
	_, _, pins, _ := miningClaimRPCFixture(t, op)
	raw, pins := miningClaimReviewDescriptor(t, pins)
	store, keys, v, _, client := miningClaimExecutionFixture(t, raw, pins, op, "success")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var in struct {
			ID     json.RawMessage
			Method string
			Params []json.RawMessage
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		var result any
		var err error
		commitment := rpc.CommitmentFinalized
		switch in.Method {
		case "getGenesisHash":
			result = v.Genesis
		case "getSlot":
			result = client.reference
		case "getMultipleAccounts":
			var addresses []solana.PublicKey
			var opts rpc.GetMultipleAccountsOpts
			if len(in.Params) != 2 {
				t.Error("params")
				return
			}
			if err = json.Unmarshal(in.Params[0], &addresses); err == nil {
				err = json.Unmarshal(in.Params[1], &opts)
			}
			if err == nil {
				result, err = client.GetMultipleAccountsWithOpts(r.Context(), addresses, &opts)
			}
		case "getLatestBlockhash":
			result, err = client.GetLatestBlockhash(r.Context(), commitment)
		case "getBlockHeight":
			result, err = client.GetBlockHeight(r.Context(), commitment)
		case "getFeeForMessage":
			var msg string
			err = json.Unmarshal(in.Params[0], &msg)
			if err == nil {
				result, err = client.GetFeeForMessage(r.Context(), msg, commitment)
			}
		case "getBalance":
			var address string
			err = json.Unmarshal(in.Params[0], &address)
			if err == nil {
				var key solana.PublicKey
				key, err = solana.PublicKeyFromBase58(address)
				if err == nil {
					result, err = client.GetBalance(r.Context(), key, commitment)
				}
			}
		case "simulateTransaction":
			var wire string
			var opts rpc.SimulateTransactionOpts
			if len(in.Params) != 2 {
				t.Error("simulation params")
				return
			}
			if err = json.Unmarshal(in.Params[0], &wire); err == nil {
				err = json.Unmarshal(in.Params[1], &opts)
			}
			if err == nil {
				var bytes []byte
				bytes, err = base64.StdEncoding.DecodeString(wire)
				if err == nil {
					result, err = client.SimulateRawTransactionWithOpts(r.Context(), bytes, &opts)
				}
			}
		default:
			t.Errorf("unexpected RPC %s", in.Method)
			w.WriteHeader(400)
			return
		}
		if err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": in.ID, "result": result}); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	keys.genesisHash = func(string) (string, error) { return v.Genesis, nil }
	if _, err := keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: server.URL}); err != nil {
		t.Fatal(err)
	}
	admission, _, err := loadWENMiningClaimAdmissionV1(store.db.Path(), "miner", v)
	if err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "prepare.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err = os.Chmod(socket, 0600); err != nil {
		t.Fatal(err)
	}
	ready, err := json.Marshal(map[string]any{"socket": socket, "walletId": "miner", "request": wenMiningClaimReviewPrepareRequestV1{RequestID: "client-preparation", Intent: v, ReviewSHA256: admission.reviewSHA}})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "ready.tmp"), ready, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(filepath.Join(dir, "ready.tmp"), filepath.Join(dir, "ready.json")); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		listener.(*net.UnixListener).SetDeadline(time.Now().Add(15 * time.Second))
		conn, err := listener.Accept()
		if err != nil {
			t.Fatal(err)
		}
		handleConn(conn, signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}, newRateLimiter(time.Minute, map[string]int{"v2.wenMining.claim.review.prepare": 3}), &auditWriter{path: filepath.Join(dir, "audit.jsonl"), maxBytes: 1048576}, &signerServiceV2{store: store, keys: keys}, false)
	}
	if client.sends != 0 {
		t.Fatal("preparation sent")
	}
}
