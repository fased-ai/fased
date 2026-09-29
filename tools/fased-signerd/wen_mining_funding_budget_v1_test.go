package main

import (
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"testing"
)

func TestWENMiningFundingBudget(t *testing.T) {
	for _, mode := range []string{"ok", "capacity", "policy", "bare", "message", "changed", "collision", "restart"} {
		t.Run(mode, func(t *testing.T) {
			s, k := openTestSignerV2(t)
			v, _, _ := miningFundingFixture(t)
			record, old := createTestSignerWalletV2(t, s, k, "miner", v.Sale, 100, 100)
			w := solana.MustPublicKeyFromBase58(record.PublicKey)
			policy, e := s.putPolicy(signerPolicyV2{WalletID: "miner", Role: "agent", Operations: []string{intentWENMiningFundingV1}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Sale}, MaxPerTx: "5000", MaxDaily: "12000"}}}, old.Version)
			if e != nil {
				t.Fatal(e)
			}
			for _, scope := range []string{wenMiningNativeScopeV1("miner", v.Genesis), wenMiningFundingLaunchScopeV1("miner", v)} {
				limit := uint64(12000)
				if mode == "capacity" {
					limit = 4999
				}
				if e = s.configureWENBudgetV1(scope, limit); e != nil {
					t.Fatal(e)
				}
			}
			ix, e := buildWENMiningFundingInstructionV1(v, w)
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
			b := &wenMiningFundingMessageBindingV1{Message: msg, Blockhash: block, ReviewSHA: wenHashV1([]byte("review")), StateHash: wenHashV1([]byte("state")), Slot: 10, Fee: 5000, Rent: 0, LastValidHeight: 200}
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
			digest, replay, e := s.reserveWENMiningFundingBoundBudgetV1("funding-request", "miner", hash, v, w, 5000, b)
			good := mode == "ok" || mode == "changed" || mode == "collision" || mode == "restart"
			if (e == nil) != good {
				t.Fatal(e)
			}
			if !good {
				return
			}
			if replay {
				t.Fatal("first replay")
			}
			if mode == "restart" {
				path := s.db.Path()
				now := s.now
				if e = s.Close(); e != nil {
					t.Fatal(e)
				}
				s, e = openSignerStoreV2(path)
				if e != nil {
					t.Fatal(e)
				}
				s.now = now
				t.Cleanup(func() { s.Close() })
			}
			d, again, e := s.reserveWENMiningFundingBoundBudgetV1("funding-request", "miner", hash, v, w, 5000, b)
			if e != nil || !again || d != digest {
				t.Fatal("replay", e)
			}
			if mode == "changed" {
				b.LastValidHeight++
				if _, _, e = s.reserveWENMiningFundingBoundBudgetV1("funding-request", "miner", hash, v, w, 5000, b); e == nil {
					t.Fatal("changed binding")
				}
			}
			if mode == "collision" {
				if _, _, e = s.reserveWENMiningFundingBoundBudgetV1("another-request", "miner", hash, v, w, 5000, b); e == nil {
					t.Fatal("duplicate claim")
				}
			}
			if e = s.beginWENSigningV1("funding-request", digest, wenHashV1(msg)); e == nil {
				t.Fatal("signing accepted without resolved accounts and slot")
			}
			if e = s.cancelWENReservationV1("funding-request", digest); e != nil {
				t.Fatal(e)
			}
			if e = s.db.View(func(tx *bolt.Tx) error {
				for _, scope := range []string{wenMiningNativeScopeV1("miner", v.Genesis), wenMiningFundingLaunchScopeV1("miner", v)} {
					var balance wenBudgetBalanceV1
					if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &balance); e != nil {
						return e
					}
					if balance.Reserved != 0 {
						t.Fatal("cancel did not release capacity", balance)
					}
				}
				return nil
			}); e != nil {
				t.Fatal(e)
			}
			if _, _, e = s.reserveWENMiningFundingBoundBudgetV1("after-cancel", "miner", hash, v, w, 5000, b); e == nil {
				t.Fatal("cancelled action reused")
			}
		})
	}
}
