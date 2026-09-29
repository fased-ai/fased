package main

import (
	solana "github.com/gagliardetto/solana-go"
	"testing"
)

func TestWENStakingMessageBindingV1(t *testing.T) {
	f := stakingReviewFixture(t)
	w := solana.MustPublicKeyFromBase58(f.Wallet)
	ix, e := buildWENStakingInstructionV1(f.Intent, w)
	if e != nil {
		t.Fatal(e)
	}
	block := solana.MustHashFromBase58(f.Intent.Genesis)
	tx, e := solana.NewTransaction([]solana.Instruction{ix}, block, solana.TransactionPayer(w))
	if e != nil {
		t.Fatal(e)
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	msg, e := tx.Message.MarshalBinary()
	if e != nil {
		t.Fatal(e)
	}
	b := wenStakingMessageBindingV1{Message: msg, Blockhash: block, ReviewSHA: wenHashV1([]byte("review")), Slot: 100, Fee: 5000, Rent: 2000, LastValidHeight: 200}
	if e = validateWENStakingMessageBindingV1(f.Intent, w, 7000, b); e != nil {
		t.Fatal(e)
	}
	for i := range msg {
		bad := b
		bad.Message = append([]byte(nil), msg...)
		bad.Message[i] ^= 1
		if validateWENStakingMessageBindingV1(f.Intent, w, 7000, bad) == nil {
			t.Fatalf("message mutation %d accepted", i)
		}
	}
	for _, change := range []func(*wenStakingMessageBindingV1){func(b *wenStakingMessageBindingV1) { b.Fee++ }, func(b *wenStakingMessageBindingV1) { b.Rent++ }, func(b *wenStakingMessageBindingV1) { b.Slot = 200 }, func(b *wenStakingMessageBindingV1) { b.LastValidHeight = 0 }, func(b *wenStakingMessageBindingV1) { b.Blockhash[0] ^= 1 }, func(b *wenStakingMessageBindingV1) { b.ReviewSHA = "bad" }} {
		bad := b
		change(&bad)
		if validateWENStakingMessageBindingV1(f.Intent, w, 7000, bad) == nil {
			t.Fatal("invalid binding accepted")
		}
	}
}
