package main

import (
	"bytes"
	solana "github.com/gagliardetto/solana-go"
	"testing"
)

func TestWENMiningClaimComputeEnvelope(t *testing.T) {
	claim := solana.NewInstruction(solana.PublicKey{1}, nil, []byte{83})
	legacy, e := wenMiningClaimInstructionsV1(claim, 0)
	if e != nil || len(legacy) != 1 || legacy[0] != claim {
		t.Fatal("legacy journal instruction changed")
	}
	current, e := wenMiningClaimInstructionsV1(claim, 400000)
	if e != nil || len(current) != 2 || current[1] != claim {
		t.Fatal("claim missing from envelope")
	}
	data, e := current[0].Data()
	if e != nil || !bytes.Equal(data, []byte{2, 128, 26, 6, 0}) || current[0].ProgramID().String() != "ComputeBudget111111111111111111111111111111" || len(current[0].Accounts()) != 0 {
		t.Fatal("compute limit wire differs; no price or extra accounts allowed")
	}
	for _, limit := range []uint32{1, 200000, 400001, 1400000} {
		if _, e = wenMiningClaimInstructionsV1(claim, limit); e == nil {
			t.Fatalf("unapproved limit %d", limit)
		}
	}
}
