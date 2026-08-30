package main

import (
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"fased-signerd/internal/execution"
	solana "github.com/gagliardetto/solana-go"
)

func TestValidateSignerNativeSpendDistinguishesRejectedSimulationV2(t *testing.T) {
	privateKey := testKeeperPrivateKeyV2(t)
	wallet := privateKey.PublicKey()
	program := solana.NewWallet().PublicKey()
	tx, err := execution.NewSignedTypedTransaction(
		[]solana.Instruction{solana.NewInstruction(program, solana.AccountMetaSlice{
			&solana.AccountMeta{PublicKey: wallet, IsSigner: true, IsWritable: true},
		}, []byte{1})},
		solana.Hash{9},
		privateKey,
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		defer request.Body.Close()
		var body struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		account := map[string]any{
			"lamports": 1_000_000_000, "owner": solana.SystemProgramID.String(),
			"data": []any{"", "base64"}, "executable": false, "rentEpoch": 0, "space": 0,
		}
		response := map[string]any{"jsonrpc": "2.0", "id": body.ID}
		switch body.Method {
		case "getAccountInfo":
			response["result"] = map[string]any{
				"context": map[string]any{"slot": 100}, "value": account,
			}
		case "simulateTransaction":
			response["result"] = map[string]any{
				"context": map[string]any{"slot": 101},
				"value": map[string]any{
					"err":  map[string]any{"InstructionError": []any{0, "InvalidArgument"}},
					"logs": []string{"must remain private"}, "unitsConsumed": 1,
				},
			}
		default:
			t.Fatalf("unexpected RPC method %q", body.Method)
		}
		writer.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(writer).Encode(response); err != nil {
			t.Fatal(err)
		}
	}))
	defer server.Close()

	intent := normalizedIntentV2{
		Intent: signerIntentV2{Type: intentSolanaSATAction},
		Amount: big.NewInt(0),
	}
	err = validateSignerNativeSpendV2([]string{server.URL}, tx, wallet, intent)
	if err == nil || !strings.Contains(err.Error(), "rejected transaction simulation") {
		t.Fatalf("protocol simulation rejection was flattened into RPC failure: %v", err)
	}
	if strings.Contains(err.Error(), "must remain private") {
		t.Fatalf("protocol simulation rejection leaked RPC logs: %v", err)
	}
}
