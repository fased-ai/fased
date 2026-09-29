package main

import (
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"testing"
)

func TestWENBTCClaimBudget(t *testing.T) {
	for _, mode := range []string{"ok", "capacity", "policy", "bare", "message", "changed", "collision", "fence", "failed", "failed-unproved", "failed-scope", "failed-fee", "success", "success-unproved"} {
		t.Run(mode, func(t *testing.T) {
			s, k := openTestSignerV2(t)
			v := btcClaimIntentFixture()
			v.MaxRentLamports = "1000"
			record, old := createTestSignerWalletV2(t, s, k, "miner", v.Sale, 100, 100)
			w := solana.MustPublicKeyFromBase58(record.PublicKey)
			policy, e := s.putPolicy(signerPolicyV2{WalletID: "miner", Role: "agent", Operations: []string{intentWENBTCClaimV1}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Sale}, MaxPerTx: "6000", MaxDaily: "12000"}}}, old.Version)
			if e != nil {
				t.Fatal(e)
			}
			for _, scope := range []string{wenMiningNativeScopeV1("miner", v.Genesis), wenBTCClaimLaunchScopeV1("miner", v)} {
				limit := uint64(12000)
				if mode == "capacity" {
					limit = 5999
				}
				if e = s.configureWENBudgetV1(scope, limit); e != nil {
					t.Fatal(e)
				}
			}
			ix, e := buildWENBTCClaimInstructionV1(v, w)
			if e != nil {
				t.Fatal(e)
			}
			block := solana.Hash{8}
			tx, e := solana.NewTransaction([]solana.Instruction{ix}, block, solana.TransactionPayer(w))
			if e != nil {
				t.Fatal(e)
			}
			tx.Message.SetVersion(solana.MessageVersionV0)
			msg, _ := tx.Message.MarshalBinary()
			b := &wenBTCClaimMessageBindingV1{Amount: 250, Weight: 25, Message: msg, Blockhash: block, ReviewSHA: wenHashV1([]byte("review")), StateHash: wenHashV1([]byte("state")), Slot: 10, Fee: 5000, Rent: 1000, LastValidHeight: 200}
			hash := policy.Hash
			switch mode {
			case "bare":
				b = nil
			case "message":
				b.Message = append([]byte(nil), msg...)
				b.Message[0] ^= 1
			case "policy":
				hash = "sha256:" + wenHashV1([]byte("wrong"))
			}
			digest, replay, e := s.reserveWENBTCClaimBoundBudgetV1("claim-request", "miner", hash, v, w, 6000, b)
			good := mode == "ok" || mode == "changed" || mode == "collision" || mode == "fence" || mode == "failed" || mode == "failed-unproved" || mode == "failed-scope" || mode == "failed-fee" || mode == "success" || mode == "success-unproved"
			if (e == nil) != good {
				t.Fatal(e)
			}
			if !good {
				return
			}
			if replay {
				t.Fatal("first replay")
			}
			d, again, e := s.reserveWENBTCClaimBoundBudgetV1("claim-request", "miner", hash, v, w, 6000, b)
			if e != nil || !again || d != digest {
				t.Fatal("replay", e)
			}
			if mode == "changed" {
				b.LastValidHeight++
				if _, _, e = s.reserveWENBTCClaimBoundBudgetV1("claim-request", "miner", hash, v, w, 6000, b); e == nil {
					t.Fatal("changed binding")
				}
			}
			if mode == "collision" {
				if _, _, e = s.reserveWENBTCClaimBoundBudgetV1("another-request", "miner", hash, v, w, 6000, b); e == nil {
					t.Fatal("duplicate claim")
				}
			}
			if mode == "fence" {
				all, e := tx.Message.GetAllKeys()
				if e != nil {
					t.Fatal(e)
				}
				keys := make([]string, len(all))
				for i, k := range all {
					keys[i] = k.String()
				}
				record := wenBudgetReservationV1{BTCClaimIntent: &v, BTCClaimPrepared: b, WalletPublicKey: w.String(), WalletClaims: map[string]uint64{"solana:native": 6000}}
				if e = validateWENBTCClaimFenceV1(record, wenHashV1(msg), keys, []uint64{10}); e != nil {
					t.Fatal(e)
				}
				for _, which := range []string{"hash", "keys", "slot", "missing-slot", "budget"} {
					r := record
					h := wenHashV1(msg)
					ks := append([]string(nil), keys...)
					slots := []uint64{10}
					switch which {
					case "hash":
						h = wenHashV1([]byte("wrong"))
					case "keys":
						ks[0] = v.Sale
					case "slot":
						slots[0] = 100
					case "missing-slot":
						slots = nil
					case "budget":
						r.WalletClaims = map[string]uint64{"solana:native": 5999}
					}
					if validateWENBTCClaimFenceV1(r, h, ks, slots) == nil {
						t.Fatal("invalid fence", which)
					}
				}
			}

			if mode == "failed" || mode == "failed-unproved" || mode == "failed-scope" || mode == "failed-fee" || mode == "success" || mode == "success-unproved" {
				// This fixture tests ledger settlement, not transaction-outcome authentication.
				if e = s.db.Update(func(tx *bolt.Tx) error {
					bucket := tx.Bucket(wenBudgetBucketV1)
					var r wenBudgetReservationV1
					if e := json.Unmarshal(bucket.Get([]byte("request:claim-request")), &r); e != nil {
						return e
					}
					r.State = "finalized-failed"
					if mode == "success" || mode == "success-unproved" {
						r.State = "finalized-success"
						r.SuccessNativeDebit = 5500
						r.SuccessEffectsSHA256 = wenHashV1([]byte("native"))
						if mode == "success" {
							r.BTCClaimEffectsSHA256 = wenHashV1([]byte("claim"))
						}
					}
					r.OutcomeFee = 5000
					if mode == "success" || mode == "success-unproved" {
						r.OutcomeFee = 4500
					}
					r.FailedEffectsSHA256 = wenHashV1([]byte("proved fixture"))
					switch mode {
					case "failed-unproved":
						r.FailedEffectsSHA256 = ""
					case "failed-scope":
						r.Scopes[wenBTCClaimLaunchScopeV1("miner", v)] = 5999
					case "failed-fee":
						r.OutcomeFee = 5001
					}
					raw, _ := json.Marshal(r)
					return bucket.Put([]byte("request:claim-request"), raw)
				}); e != nil {
					t.Fatal(e)
				}
				if mode == "success" || mode == "success-unproved" {
					e = s.settleWENBTCClaimSuccessV1("claim-request", digest)
				} else {
					e = s.settleWENFailedBudgetV1("claim-request", digest)
				}
				if (e == nil) != (mode == "failed" || mode == "success") {
					t.Fatal("failure settlement", e)
				}
				if mode == "failed" {
					if e = s.settleWENFailedBudgetV1("claim-request", digest); e != nil {
						t.Fatal("repeat settlement", e)
					}
				}
				want := uint64(6000)
				if mode == "success" {
					want = 5500
					if e = s.settleWENBTCClaimSuccessV1("claim-request", digest); e != nil {
						t.Fatal(e)
					}
				}
				if mode == "failed" {
					want = 5000
				}
				if e = s.db.View(func(tx *bolt.Tx) error {
					for _, scope := range []string{wenMiningNativeScopeV1("miner", v.Genesis), wenBTCClaimLaunchScopeV1("miner", v)} {
						var b wenBudgetBalanceV1
						if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &b); e != nil {
							return e
						}
						if b.Reserved != want {
							t.Fatalf("scope retained %d want %d", b.Reserved, want)
						}
					}
					return nil
				}); e != nil {
					t.Fatal(e)
				}
				return
			}
			if e = s.beginWENSigningV1("claim-request", digest, wenHashV1(msg)); e == nil {
				t.Fatal("unimplemented signing enabled")
			}
		})
	}
}
