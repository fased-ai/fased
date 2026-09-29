package main

import (
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"testing"
)

func TestWENCrossOperationBudgetV1(t *testing.T) {
	for _, bottleneck := range []string{"native", "launch"} {
		t.Run(bottleneck, func(t *testing.T) {
			s, k := openTestSignerV2(t)
			withdrawal := withdrawalReviewFixture(t).Intent
			staking := withdrawal.identity()
			record, old := createTestSignerWalletV2(t, s, k, "staker", withdrawal.Sale, 100, 100)
			wallet := solana.MustPublicKeyFromBase58(record.PublicKey)
			p, err := s.putPolicy(signerPolicyV2{WalletID: "staker", Role: "agent", Operations: []string{intentWENWithdrawalV1, intentWENStakingV1 + ".requestExit"}, Programs: []string{withdrawal.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{withdrawal.Sale}, MaxPerTx: "6000", MaxDaily: "20000"}}}, old.Version)
			if err != nil {
				t.Fatal(err)
			}
			native := wenMiningNativeScopeV1("staker", withdrawal.Genesis)
			launch := wenWithdrawalLaunchScopeV1("staker", withdrawal)
			for name, scope := range map[string]string{"native": native, "launch": launch} {
				limit := uint64(20000)
				if name == bottleneck {
					limit = 10000
				}
				if err = s.configureWENBudgetV1(scope, limit); err != nil {
					t.Fatal(err)
				}
			}
			type result struct {
				name, digest string
				err          error
			}
			reserve := func(name string) result {
				var d string
				var e error
				if name == "withdraw" {
					d, _, e = s.reserveWENWithdrawalBudgetV1("request-"+name, "staker", p.Hash, withdrawal, wallet, 6000)
				} else {
					d, _, e = s.reserveWENStakingBudgetV1("request-"+name, "staker", p.Hash, staking, wallet, 6000)
				}
				return result{name, d, e}
			}
			start := make(chan struct{})
			out := make(chan result, 2)
			for _, name := range []string{"withdraw", "exit"} {
				go func(name string) { <-start; out <- reserve(name) }(name)
			}
			close(start)
			a, b := <-out, <-out
			if (a.err == nil) == (b.err == nil) {
				t.Fatalf("exactly one reservation must succeed: %v / %v", a.err, b.err)
			}
			winner, loser := a, b
			if winner.err != nil {
				winner, loser = b, a
			}
			check := func(want uint64) {
				t.Helper()
				if err := s.db.View(func(tx *bolt.Tx) error {
					for _, scope := range []string{native, launch} {
						var balance wenBudgetBalanceV1
						if err := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &balance); err != nil {
							return err
						}
						if balance.Reserved != want {
							t.Fatalf("cross-operation reserved=%d want=%d", balance.Reserved, want)
						}
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			check(6000)
			if err = s.cancelWENReservationV1("request-"+winner.name, winner.digest); err != nil {
				t.Fatal(err)
			}
			check(0)
			retry := reserve(loser.name)
			if retry.err != nil {
				t.Fatal("cancelled capacity not reusable", retry.err)
			}
			check(6000)
		})
	}
}
