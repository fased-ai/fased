package main

import (
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"testing"
)

func TestWENWithdrawalInstructionV1(t *testing.T) {
	raw, e := os.ReadFile("testdata/wen-withdrawal-candidate.json")
	if e != nil {
		t.Fatal(e)
	}
	var rows []struct {
		Wallet   string
		Intent   signerWENWithdrawalIntentV1
		Data     []byte
		Accounts []struct {
			Address          string
			Signer, Writable bool
		}
	}
	if e = json.Unmarshal(raw, &rows); e != nil {
		t.Fatal(e)
	}
	if len(rows) != 8 {
		t.Fatal("missing canonical cases")
	}
	for _, r := range rows {
		wallet := solana.MustPublicKeyFromBase58(r.Wallet)
		ix, e := buildWENWithdrawalInstructionV1(r.Intent, wallet)
		if e != nil {
			t.Fatal(e)
		}
		data, _ := ix.Data()
		if string(data) != string(r.Data) || ix.ProgramID().String() != r.Intent.ProgramID {
			t.Fatal("Rust wire mismatch")
		}
		accounts := ix.Accounts()
		if len(accounts) != len(r.Accounts) {
			t.Fatal("account count")
		}
		for i, a := range accounts {
			want := r.Accounts[i]
			if a.PublicKey.String() != want.Address || a.IsSigner != want.Signer || a.IsWritable != want.Writable {
				t.Fatalf("Rust account %d mismatch", i)
			}
		}
	}
}
