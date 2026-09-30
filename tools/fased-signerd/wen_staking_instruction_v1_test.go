package main

import (
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"testing"
)

func TestWENStakingInstructionV1(t *testing.T) {
	raw, e := os.ReadFile("testdata/wen-staking-candidate.json")
	if e != nil {
		t.Fatal(e)
	}
	var rows []struct {
		Wallet   string
		Intent   signerWENStakingIntentV1
		Data     []byte
		Accounts []struct {
			Address          string
			Signer, Writable bool
		}
	}
	if e = json.Unmarshal(raw, &rows); e != nil {
		t.Fatal(e)
	}
	if len(rows) != 6 {
		t.Fatal("missing canonical cases")
	}
	for _, r := range rows {
		wallet := solana.MustPublicKeyFromBase58(r.Wallet)
		ix, e := buildWENStakingInstructionV1(r.Intent, wallet)
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
		for _, mutate := range []func(*signerWENStakingIntentV1){
			func(v *signerWENStakingIntentV1) { v.Mint = v.Sale },
			func(v *signerWENStakingIntentV1) { v.Day = "18446744073709551615" },
			func(v *signerWENStakingIntentV1) { v.Last = "12" },
			func(v *signerWENStakingIntentV1) { v.AggregateFrom = "12" },
			func(v *signerWENStakingIntentV1) { v.Amount = "01" },
			func(v *signerWENStakingIntentV1) { v.Amount = "18446744073709551616" },
			func(v *signerWENStakingIntentV1) { v.Operation = "withdraw" },
			func(v *signerWENStakingIntentV1) { v.Operation = "requestExit"; v.Amount = "1" },
			func(v *signerWENStakingIntentV1) { v.Operation = "deposit"; v.Amount = "0" },
			func(v *signerWENStakingIntentV1) { v.MaxFeeLamports = "0" },
			func(v *signerWENStakingIntentV1) { v.ExpiresSlot = v.MinFinalizedSlot },
		} {
			bad := r.Intent
			mutate(&bad)
			if _, e := buildWENStakingInstructionV1(bad, wallet); e == nil {
				t.Fatal("invalid intent accepted", bad)
			}
		}
		b, _ := json.Marshal(r.Intent)
		if _, e := decodeWENStakingIntentV1(b); e != nil {
			t.Fatal(e)
		}
		b = append(b[:len(b)-1], []byte(",\"wire\":\"AAAA\"}")...)
		if _, e := decodeWENStakingIntentV1(b); e == nil {
			t.Fatal("arbitrary wire accepted")
		}
	}
}
