package main

import (
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestVaultReviewRPCWitnessesV1(t *testing.T) {
	intent := normalizedIntentV2{Intent: signerIntentV2{Cluster: "devnet", VaultMining: &signerVaultMiningIntentV1{Profile: solana.NewWallet().PublicKey().String(), PermanentMining: solana.NewWallet().PublicKey().String(), CycleID: "43", MinFinalizedSlot: "101"}}}
	makeRPC := func(rent uint64, slot uint64) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var request struct {
				ID     json.RawMessage   `json:"id"`
				Method string            `json:"method"`
				Params []json.RawMessage `json:"params"`
			}
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
				return
			}
			var result any
			switch request.Method {
			case "getMultipleAccounts":
				var config map[string]any
				if len(request.Params) != 2 {
					t.Error("missing finalized request")
					return
				}
				_ = json.Unmarshal(request.Params[1], &config)
				if config["commitment"] != "finalized" {
					t.Error("non-finalized request")
				}
				result = map[string]any{"context": map[string]any{"slot": slot}, "value": make([]any, 13)}
			case "getMinimumBalanceForRentExemption":
				result = rent
			case "getFeeForMessage":
				result = map[string]any{"context": map[string]any{"slot": slot}, "value": rent}
			default:
				t.Errorf("unexpected RPC %s", request.Method)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
		}))
	}
	a, b := makeRPC(1000000, 101), makeRPC(1000000, 102)
	defer a.Close()
	defer b.Close()
	snapshot, rent, err := fetchVaultReviewSnapshotV1([]string{a.URL, b.URL}, intent)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Slot != 101 || rent != 1000000 || len(snapshot.Accounts) != 13 {
		t.Fatal("wrong native snapshot")
	}
	transaction := &solana.Transaction{Message: solana.Message{}}
	if err := validateVaultNetworkFeeV1([]string{a.URL, b.URL}, transaction, "1000000"); err != nil {
		t.Fatal(err)
	}
	if err := validateVaultNetworkFeeV1([]string{a.URL, b.URL}, transaction, "999999"); err == nil {
		t.Fatal("accepted fee above separate cap")
	}
	if _, _, err := fetchVaultReviewSnapshotV1([]string{a.URL, a.URL}, intent); err == nil {
		t.Fatal("accepted one witness twice")
	}
	c := makeRPC(2000000, 102)
	defer c.Close()
	if _, _, err := fetchVaultReviewSnapshotV1([]string{a.URL, c.URL}, intent); err == nil {
		t.Fatal("accepted disagreeing rent")
	}
	d := makeRPC(1000000, 100)
	defer d.Close()
	if _, _, err := fetchVaultReviewSnapshotV1([]string{a.URL, d.URL}, intent); err == nil {
		t.Fatal("accepted stale witness")
	}
	// Public resolution is disabled before consulting wallet keys or RPC.
	if _, _, _, err := (&signerServiceV2{}).resolveVaultReviewV1("executor", intent, nil); err == nil {
		t.Fatal("enabled unpinned release")
	}
}
