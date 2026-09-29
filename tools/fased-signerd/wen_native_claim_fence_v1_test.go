package main

import (
	solana "github.com/gagliardetto/solana-go"
	"testing"
)

func TestWENNativeClaimFence(t *testing.T) {
	v := nativeClaimIntentFixture()
	v.MaxRentLamports = "1000"
	w := solana.PublicKey{5}
	ix, e := buildWENNativeClaimInstructionV1(v, w)
	if e != nil {
		t.Fatal(e)
	}
	tx, _ := solana.NewTransaction([]solana.Instruction{ix}, solana.Hash{8}, solana.TransactionPayer(w))
	tx.Message.SetVersion(solana.MessageVersionV0)
	msg, _ := tx.Message.MarshalBinary()
	all, _ := tx.Message.GetAllKeys()
	keys := []string{}
	for _, k := range all {
		keys = append(keys, k.String())
	}
	for _, mode := range []string{"ok", "hash", "keys", "expired", "old-slot", "no-slot", "budget", "bare", "net", "transfer-fee"} {
		t.Run(mode, func(t *testing.T) {
			b := &wenNativeClaimMessageBindingV1{Gross: 250, TransferFee: 8, Net: 242, Weight: 25, Message: msg, Blockhash: solana.Hash{8}, ReviewSHA: wenHashV1([]byte("review")), StateHash: wenHashV1([]byte("state")), Slot: 10, Fee: 5000, Rent: 1000, LastValidHeight: 200}
			r := wenBudgetReservationV1{NativeClaimIntent: &v, NativeClaimPrepared: b, WalletPublicKey: w.String(), WalletClaims: map[string]uint64{"solana:native": 6000}}
			ks := append([]string(nil), keys...)
			slots := []uint64{10}
			hash := wenHashV1(msg)
			switch mode {
			case "hash":
				hash = wenHashV1([]byte("other"))
			case "keys":
				ks[0] = v.Sale
			case "expired":
				slots[0] = 100
			case "old-slot":
				slots[0] = 9
			case "no-slot":
				slots = nil
			case "budget":
				r.WalletClaims["solana:native"]--
			case "bare":
				r.NativeClaimPrepared = nil
			case "net":
				b.Net++
			case "transfer-fee":
				b.TransferFee++
			}
			if e := validateWENNativeClaimFenceV1(r, hash, ks, slots); (e == nil) != (mode == "ok") {
				t.Fatal(e)
			}
		})
	}
}
