package main

import (
	solana "github.com/gagliardetto/solana-go"
	"testing"
)

func TestWENMiningClaimFence(t *testing.T) {
	for _, op := range []string{"sol", "sat"} {
		for _, mode := range []string{"ok", "missing-intent", "missing-binding", "mixed-family", "wrong-fee", "extra-asset", "message", "keys", "slot", "expired", "missing-slot", "owner", "genesis", "state"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				v := miningClaimIntentFixture()
				v.Operation = op
				if op == "sat" {
					d := solana.PublicKey{4}.String()
					v.Destination = &d
				}
				w := solana.PublicKey{5}
				ix, e := buildWENMiningClaimInstructionV1(v, w)
				if e != nil {
					t.Fatal(e)
				}
				hash := solana.Hash{8}
				tx, e := solana.NewTransaction([]solana.Instruction{ix}, hash, solana.TransactionPayer(w))
				if e != nil {
					t.Fatal(e)
				}
				tx.Message.SetVersion(solana.MessageVersionV0)
				message, e := tx.Message.MarshalBinary()
				if e != nil {
					t.Fatal(e)
				}
				all, _ := tx.Message.GetAllKeys()
				keys := make([]string, len(all))
				for i, k := range all {
					keys[i] = k.String()
				}
				b := wenMiningClaimMessageBindingV1{Message: message, Blockhash: hash, ReviewSHA: wenHashV1([]byte("review")), StateHash: v.AccountStateSHA256, Slot: 2, Fee: 5000, LastValidHeight: 200}
				r := wenBudgetReservationV1{MiningClaimIntent: &v, MiningClaimPrepared: &b, WalletPublicKey: w.String(), WalletClaims: map[string]uint64{"solana:native": 5000}, Genesis: v.Genesis}
				digest := wenHashV1(message)
				slots := []uint64{2}
				switch mode {
				case "missing-intent":
					r.MiningClaimIntent = nil
				case "missing-binding":
					r.MiningClaimPrepared = nil
				case "mixed-family":
					r.MiningFundingPrepared = &wenMiningFundingMessageBindingV1{}
				case "wrong-fee":
					r.WalletClaims["solana:native"]--
				case "extra-asset":
					r.WalletClaims["other"] = 1
				case "message":
					digest = wenHashV1([]byte("changed"))
				case "keys":
					keys[1] = w.String()
				case "slot":
					slots[0] = 1
				case "expired":
					slots[0] = 33
				case "missing-slot":
					slots = nil
				case "owner":
					r.WalletPublicKey = solana.PublicKey{7}.String()
				case "genesis":
					r.Genesis = "other"
				case "state":
					b.StateHash = wenHashV1([]byte("other"))
				}
				if e = validateWENMiningClaimFenceV1(r, digest, keys, slots); (e == nil) != (mode == "ok") {
					t.Fatal(mode, e)
				}
			})
		}
	}
}
