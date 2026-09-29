package main

import (
	"encoding/base64"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestSATRewardGlobalAdmissionV2(t *testing.T) {
	program := solana.NewWallet().PublicKey()
	expected := solana.NewWallet().PublicKey()
	data := make([]byte, 472)
	data[0] = 130
	copy(data[232:264], expected[:])
	good := func() *rpc.Account {
		return &rpc.Account{Owner: program, Data: rpc.DataBytesOrJSONFromBytes(append([]byte(nil), data...))}
	}
	if err := validateSATRewardGlobalV2(good(), program, expected); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"missing", "owner", "executable", "short", "tag", "padding", "recipient"} {
		t.Run(name, func(t *testing.T) {
			a := good()
			b := append([]byte(nil), data...)
			switch name {
			case "missing":
				a = nil
			case "owner":
				a.Owner = expected
			case "executable":
				a.Executable = true
			case "short":
				b = b[:263]
			case "tag":
				b[0] = 131
			case "padding":
				b[1] = 1
			case "recipient":
				b[232] ^= 1
			}
			if a != nil {
				a.Data = rpc.DataBytesOrJSONFromBytes(b)
			}
			if validateSATRewardGlobalV2(a, program, expected) == nil {
				t.Fatal("invalid account admitted")
			}
		})
	}
}
func TestSATRewardEntrySelectionV2(t *testing.T) {
	for _, action := range []string{"openCycleV2", "commitCycleV2"} {
		entry := normalizedIntentV2{Intent: signerIntentV2{Type: intentSolanaSATAction, Action: action}}
		if satRewardEntryIntentV2(entry) == nil {
			t.Fatal("entry bypass")
		}
		keeper := normalizedIntentV2{Intent: signerIntentV2{Type: intentSolanaSATKeeperAction}, ParentIntent: &entry}
		if satRewardEntryIntentV2(keeper) == nil {
			t.Fatal("keeper bypass")
		}
	}
	for _, action := range []string{"revealCycleV2", "claimCycleRewardsV2", "withdrawCapital", "releaseUnrevealedCommitV2", "finalizeCycleV2", "openCycle"} {
		intent := normalizedIntentV2{Intent: signerIntentV2{Type: intentSolanaSATAction, Action: action}}
		if err := validateSATRewardEntryRPCV2(nil, intent); err != nil {
			t.Fatalf("drain/legacy %s blocked: %v", action, err)
		}
	}
}

func TestSATRewardAdmissionFinalizedRPCV2(t *testing.T) {
	program := solana.NewWallet().PublicKey()
	bond := solana.NewWallet().PublicKey()
	global, _, err := solana.FindProgramAddress([][]byte{[]byte("sat_global_state_v2")}, program)
	if err != nil {
		t.Fatal(err)
	}
	expected, _, err := solana.FindProgramAddress([][]byte{[]byte("sat_bond_epoch_distributor_v3")}, bond)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     json.RawMessage   `json:"id"`
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
			http.Error(w, "bad request", 400)
			return
		}
		if req.Method != "getAccountInfo" || len(req.Params) != 2 {
			t.Error("unexpected RPC")
			http.Error(w, "bad method", 400)
			return
		}
		var address string
		var opts struct {
			Commitment string `json:"commitment"`
			Encoding   string `json:"encoding"`
		}
		if json.Unmarshal(req.Params[0], &address) != nil || json.Unmarshal(req.Params[1], &opts) != nil || address != global.String() || opts.Commitment != "finalized" || opts.Encoding != "base64" {
			t.Error("unbound RPC request")
		}
		call := calls.Add(1)
		data := make([]byte, 472)
		data[0] = 130
		copy(data[232:264], expected[:])
		owner := program.String()
		if call == 1 {
			data[232] ^= 1
		}
		if call == 3 {
			owner = bond.String()
		}
		var value any = map[string]any{"owner": owner, "executable": false, "lamports": 5000000, "rentEpoch": 0, "data": []string{base64.StdEncoding.EncodeToString(data), "base64"}}
		if call == 4 {
			value = nil
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"context": map[string]any{"slot": 100}, "value": value}})
	}))
	defer server.Close()
	for i := 1; i <= 4; i++ {
		err := readSATRewardEntryGlobalRPCV2([]string{server.URL}, program, bond)
		if (i == 2) != (err == nil) {
			t.Fatalf("read %d: %v", i, err)
		}
	}
	if calls.Load() != 4 {
		t.Fatalf("expected fresh reads, got %d", calls.Load())
	}
	if readSATRewardEntryGlobalRPCV2(nil, program, bond) == nil {
		t.Fatal("missing RPC admitted")
	}
}

func TestSATRewardEntryAtomicNormalizationV2(t *testing.T) {
	keeper := testKeeperPrivateKeyV2(t)
	authority := testKeeperPrivateKeyV2(t)
	program := solana.NewWallet().PublicKey()
	input := testAtomicOpenCommitIntentV2(t, keeper.PublicKey(), authority.PublicKey(), authority.PublicKey(), program, 42)
	normalized, err := normalizeKeeperFeePayerIntentV2(input, keeper.PublicKey(), "mining", authority.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	entry := satRewardEntryIntentV2(normalized)
	if entry == nil || entry.Intent.Action != "commitCycleV2" || entry.Intent.ProgramID != program.String() {
		t.Fatal("atomic normalization lost reward admission binding")
	}
}
