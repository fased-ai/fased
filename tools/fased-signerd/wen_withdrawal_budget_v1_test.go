package main

import (
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"testing"
)

func TestWENWithdrawalBudgetV1(t *testing.T) {
	for _, mode := range []string{"ok", "missing-launch", "capacity", "policy", "bare", "cancel", "changed", "collision", "fence"} {
		t.Run(mode, func(t *testing.T) {
			s, k := openTestSignerV2(t)
			v := withdrawalReviewFixture(t).Intent
			record, old := createTestSignerWalletV2(t, s, k, "staker", v.Sale, 100, 100)
			wallet := solana.MustPublicKeyFromBase58(record.PublicKey)
			p, e := s.putPolicy(signerPolicyV2{WalletID: "staker", Role: "agent", Operations: []string{intentWENWithdrawalV1}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Sale}, MaxPerTx: "5000", MaxDaily: "10000"}}}, old.Version)
			if e != nil {
				t.Fatal(e)
			}
			native := wenMiningNativeScopeV1("staker", v.Genesis)
			launch := wenWithdrawalLaunchScopeV1("staker", v)
			if launch != wenStakingLaunchScopeV1("staker", v.identity()) {
				t.Fatal("launch budget split")
			}
			if e = s.configureWENBudgetV1(native, 10000); e != nil {
				t.Fatal(e)
			}
			if mode != "missing-launch" {
				limit := uint64(10000)
				if mode == "capacity" {
					limit = 4999
				}
				if e = s.configureWENBudgetV1(launch, limit); e != nil {
					t.Fatal(e)
				}
			}
			ix, e := buildWENWithdrawalInstructionV1(v, wallet)
			if e != nil {
				t.Fatal(e)
			}
			block := solana.MustHashFromBase58(v.Genesis)
			tx, e := solana.NewTransaction([]solana.Instruction{ix}, block, solana.TransactionPayer(wallet))
			if e != nil {
				t.Fatal(e)
			}
			tx.Message.SetVersion(solana.MessageVersionV0)
			msg, e := tx.Message.MarshalBinary()
			if e != nil {
				t.Fatal(e)
			}
			binding := &wenWithdrawalMessageBindingV1{Message: msg, Blockhash: block, ReviewSHA: wenHashV1([]byte("review")), Slot: 100, Fee: 5000, LastValidHeight: 200}
			if mode == "bare" {
				binding = nil
			}
			hash := p.Hash
			if mode == "policy" {
				hash = "sha256:" + wenHashV1([]byte("wrong"))
			}
			digest, replay, e := s.reserveWENWithdrawalBoundBudgetV1("withdraw-request", "staker", hash, v, wallet, 5000, binding)
			reject := mode == "missing-launch" || mode == "capacity" || mode == "policy"
			if (e != nil) != reject {
				t.Fatal("reservation", e)
			}
			if reject {
				return
			}
			if replay {
				t.Fatal("initial replay")
			}
			d, again, e := s.reserveWENWithdrawalBoundBudgetV1("withdraw-request", "staker", hash, v, wallet, 5000, binding)
			if e != nil || !again || d != digest {
				t.Fatal("replay", e)
			}
			if mode == "changed" {
				binding.LastValidHeight++
				if _, _, e = s.reserveWENWithdrawalBoundBudgetV1("withdraw-request", "staker", hash, v, wallet, 5000, binding); e == nil {
					t.Fatal("changed binding accepted")
				}
			}
			if mode == "collision" {
				v.MinimumNet = "1"
				if _, _, e = s.reserveWENWithdrawalBoundBudgetV1("other-request", "staker", hash, v, wallet, 5000, binding); e == nil {
					t.Fatal("duplicate position withdrawal")
				}
			}
			if mode == "bare" && s.beginWENSigningV1("withdraw-request", digest, wenHashV1(msg)) == nil {
				t.Fatal("bare reservation signed")
			}
			if mode == "fence" {
				all, e := tx.Message.GetAllKeys()
				if e != nil {
					t.Fatal(e)
				}
				keys := []string{}
				for _, k := range all {
					keys = append(keys, k.String())
				}
				if s.beginWENSigningV1("withdraw-request", digest, wenHashV1(msg)) == nil {
					t.Fatal("missing keys accepted")
				}
				if s.beginWENSigningAccountsV1("withdraw-request", digest, wenHashV1([]byte("wrong")), keys, 100) == nil {
					t.Fatal("wrong message accepted")
				}
				if s.beginWENSigningAccountsV1("withdraw-request", digest, wenHashV1(msg), keys, 200) == nil {
					t.Fatal("expiry accepted")
				}
				if e = s.beginWENSigningAccountsV1("withdraw-request", digest, wenHashV1(msg), keys, 100); e != nil {
					t.Fatal(e)
				}
				if s.beginWENSigningAccountsV1("withdraw-request", digest, wenHashV1(msg), keys, 100) == nil {
					t.Fatal("duplicate signing fence")
				}
				if s.cancelWENReservationV1("withdraw-request", digest) == nil {
					t.Fatal("cancel after fence")
				}
			}
			want := uint64(5000)
			if mode == "cancel" {
				if e = s.cancelWENReservationV1("withdraw-request", digest); e != nil {
					t.Fatal(e)
				}
				want = 0
			}
			if e = s.db.View(func(tx *bolt.Tx) error {
				b := tx.Bucket(wenBudgetBucketV1)
				for _, scope := range []string{native, launch} {
					var balance wenBudgetBalanceV1
					if e := json.Unmarshal(b.Get([]byte("limit:"+scope)), &balance); e != nil {
						return e
					}
					if balance.Reserved != want {
						t.Fatal("wrong reserved cost", balance)
					}
				}
				var saved wenBudgetReservationV1
				if e := json.Unmarshal(b.Get([]byte("request:withdraw-request")), &saved); e != nil {
					return e
				}
				if len(saved.WalletClaims) != 1 || saved.WalletClaims["solana:native"] != 5000 || saved.WithdrawalIntent == nil || saved.StakingIntent != nil {
					t.Fatal("wrong withdrawal claims")
				}
				if mode == "changed" && saved.WithdrawalPrepared.LastValidHeight != 200 {
					t.Fatal("caller mutated saved binding")
				}
				return nil
			}); e != nil {
				t.Fatal(e)
			}
		})
	}
}
