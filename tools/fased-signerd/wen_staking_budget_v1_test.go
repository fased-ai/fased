package main

import (
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"testing"
)

func TestWENStakingBudgetV1(t *testing.T) {
	for _, mode := range []string{"ok", "missing-launch", "capacity", "policy", "replay", "changed-cost", "cancel", "collision", "principal-cap", "principal-destination", "principal-daily", "missing-principal", "exit", "bound", "bound-change", "bound-cancel", "bound-fence", "failed-settlement", "failed-missing-proof", "success-settlement", "success-missing-proof"} {
		t.Run(mode, func(t *testing.T) {
			s, k := openTestSignerV2(t)
			v := stakingReviewFixture(t).Intent
			r, old := createTestSignerWalletV2(t, s, k, "staker", v.Sale, 100, 100)
			ix, _ := buildWENStakingInstructionV1(v, solana.MustPublicKeyFromBase58(r.PublicKey))
			p, e := s.putPolicy(signerPolicyV2{WalletID: "staker", Role: "agent", Operations: []string{intentWENStakingV1 + ".deposit"}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Sale}, MaxPerTx: "7000", MaxDaily: "10000"}, {Asset: "solana:spl:" + v.Mint, Destinations: []string{ix.Accounts()[7].PublicKey.String()}, MaxPerTx: "100", MaxDaily: "100"}}}, old.Version)
			if e != nil {
				t.Fatal(e)
			}
			if mode == "missing-principal" || mode == "exit" {
				p.Assets = p.Assets[:1]
				if mode == "exit" {
					v.Operation = "requestExit"
					v.Amount = "0"
					p.Operations = []string{intentWENStakingV1 + ".requestExit"}
				}
				p, e = s.putPolicy(p, p.Version)
				if e != nil {
					t.Fatal(e)
				}
			}
			if mode == "principal-cap" {
				p.Assets[1].MaxPerTx = "1"
				v.Amount = "2"
			}
			if mode == "principal-destination" {
				p.Assets[1].Destinations = []string{v.Sale}
			}
			if mode == "principal-daily" {
				p.Assets[1].MaxDaily = "1"
				v.Amount = "2"
			}
			if mode == "principal-cap" || mode == "principal-destination" || mode == "principal-daily" {
				p, e = s.putPolicy(p, p.Version)
				if e != nil {
					t.Fatal(e)
				}
			}
			wallet := solana.MustPublicKeyFromBase58(r.PublicKey)
			native := wenMiningNativeScopeV1("staker", v.Genesis)
			launch := wenStakingLaunchScopeV1("staker", v)
			if e = s.configureWENBudgetV1(native, 10000); e != nil {
				t.Fatal(e)
			}
			if mode != "missing-launch" {
				limit := uint64(10000)
				if mode == "capacity" {
					limit = 6999
				}
				if e = s.configureWENBudgetV1(launch, limit); e != nil {
					t.Fatal(e)
				}
			}
			hash := p.Hash
			if mode == "policy" {
				hash = "sha256:" + wenHashV1([]byte("wrong"))
			}
			var digest string
			var replay bool
			if mode == "bound" || mode == "bound-change" || mode == "bound-cancel" || mode == "bound-fence" {
				hashBlock := solana.MustHashFromBase58(v.Genesis)
				tx, err := solana.NewTransaction([]solana.Instruction{ix}, hashBlock, solana.TransactionPayer(wallet))
				if err != nil {
					t.Fatal(err)
				}
				tx.Message.SetVersion(solana.MessageVersionV0)
				msg, err := tx.Message.MarshalBinary()
				if err != nil {
					t.Fatal(err)
				}
				binding := wenStakingMessageBindingV1{Message: msg, Blockhash: hashBlock, ReviewSHA: wenHashV1([]byte("review")), Slot: 100, Fee: 5000, Rent: 2000, LastValidHeight: 200}
				digest, replay, e = s.reserveWENStakingBoundBudgetV1("staking-request", "staker", hash, v, wallet, 7000, &binding)
				if e != nil {
					t.Fatal(e)
				}
				if mode == "bound-change" {
					binding.LastValidHeight++
				}
				_, again, err := s.reserveWENStakingBoundBudgetV1("staking-request", "staker", hash, v, wallet, 7000, &binding)
				if mode == "bound-change" {
					if err == nil {
						t.Fatal("changed lifetime accepted")
					}
				} else if err != nil || !again {
					t.Fatal("bound replay", err)
				}
				if mode == "bound-fence" {
					all, err := tx.Message.GetAllKeys()
					if err != nil {
						t.Fatal(err)
					}
					keys := []string{}
					for _, key := range all {
						keys = append(keys, key.String())
					}
					sum := wenHashV1(msg)
					badKeys := append([]string(nil), keys...)
					badKeys[1] = wallet.String()
					if err = s.beginWENSigningAccountsV1("staking-request", digest, sum, badKeys, 100); err == nil {
						t.Fatal("substituted accounts accepted")
					}
					if err = s.beginWENSigningAccountsV1("staking-request", digest, wenHashV1([]byte("wrong")), keys, 100); err == nil {
						t.Fatal("wrong hash signed")
					}
					if err = s.beginWENSigningV1("staking-request", digest, sum); err == nil {
						t.Fatal("missing keys/slot accepted")
					}
					if err = s.beginWENSigningAccountsV1("staking-request", digest, sum, keys, 200); err == nil {
						t.Fatal("expired fence accepted")
					}
					if err = s.beginWENSigningAccountsV1("staking-request", digest, sum, keys, 100); err != nil {
						t.Fatal(err)
					}
					if err = s.beginWENSigningAccountsV1("staking-request", digest, sum, keys, 100); err == nil {
						t.Fatal("duplicate fence accepted")
					}
					if err = s.cancelWENReservationV1("staking-request", digest); err == nil {
						t.Fatal("fenced cancellation accepted")
					}
				}
				if mode == "bound-cancel" {
					if err = s.cancelWENReservationV1("staking-request", digest); err != nil {
						t.Fatal(err)
					}
				}
			} else {
				digest, replay, e = s.reserveWENStakingBudgetV1("staking-request", "staker", hash, v, wallet, 7000)
			}
			reject := mode == "missing-launch" || mode == "capacity" || mode == "policy" || mode == "principal-cap" || mode == "principal-destination" || mode == "principal-daily" || mode == "missing-principal"
			if (e != nil) != reject {
				t.Fatal("reservation", e)
			}
			if mode == "ok" {
				if err := s.beginWENSigningV1("staking-request", digest, wenHashV1([]byte("arbitrary"))); err == nil {
					t.Fatal("unbound reservation signed")
				}
			}
			if !reject && replay {
				t.Fatal("first replay")
			}
			if mode == "replay" {
				d, again, e := s.reserveWENStakingBudgetV1("staking-request", "staker", hash, v, wallet, 7000)
				if e != nil || !again || d != digest {
					t.Fatal("replay", e)
				}
			}
			if mode == "changed-cost" {
				if _, _, e := s.reserveWENStakingBudgetV1("staking-request", "staker", hash, v, wallet, 6999); e == nil {
					t.Fatal("changed cost accepted")
				}
			}
			if mode == "collision" {
				if _, _, e := s.reserveWENStakingBudgetV1("staking-second", "staker", hash, v, wallet, 7000); e == nil {
					t.Fatal("same action repeated")
				}
			}
			if mode == "cancel" {
				for i := 0; i < 2; i++ {
					if e = s.cancelWENReservationV1("staking-request", digest); e != nil {
						t.Fatal(e)
					}
				}
			}
			if mode == "failed-settlement" || mode == "failed-missing-proof" {
				err := s.changeWENReservationV1("staking-request", digest, func(_ *bolt.Tx, r *wenBudgetReservationV1) error {
					r.State = "finalized-failed"
					r.OutcomeFee = 5000
					if mode == "failed-settlement" {
						r.FailedEffectsSHA256 = wenHashV1([]byte("synthetic effects"))
					}
					return nil
				})
				if err != nil {
					t.Fatal(err)
				}
				err = s.settleWENFailedBudgetV1("staking-request", digest)
				if mode == "failed-missing-proof" {
					if err == nil {
						t.Fatal("unproved failure settled")
					}
				} else {
					if err != nil {
						t.Fatal(err)
					}
					if err = s.settleWENFailedBudgetV1("staking-request", digest); err != nil {
						t.Fatal("settlement replay", err)
					}
				}
			}
			if mode == "success-settlement" || mode == "success-missing-proof" {
				e = s.changeWENReservationV1("staking-request", digest, func(_ *bolt.Tx, r *wenBudgetReservationV1) error {
					r.State = "finalized-success"
					r.OutcomeFee = 5000
					r.SuccessNativeDebit = 6000
					r.SuccessEffectsSHA256 = wenHashV1([]byte("synthetic native"))
					if mode == "success-settlement" {
						r.StakingEffectsSHA256 = wenHashV1([]byte("synthetic staking"))
					}
					return nil
				})
				if e != nil {
					t.Fatal(e)
				}
				e = s.settleWENStakingSuccessV1("staking-request", digest)
				if mode == "success-missing-proof" {
					if e == nil {
						t.Fatal("missing proof settled")
					}
				} else {
					if e != nil {
						t.Fatal(e)
					}
					if e = s.settleWENStakingSuccessV1("staking-request", digest); e != nil {
						t.Fatal(e)
					}
				}
			}

			want := uint64(7000)
			if mode == "success-settlement" {
				want = 6000
			}
			if mode == "failed-settlement" {
				want = 5000
			}
			if reject || mode == "cancel" || mode == "bound-cancel" {
				want = 0
			}
			if e = s.db.View(func(tx *bolt.Tx) error {
				b := tx.Bucket(wenBudgetBucketV1)
				usage := tx.Bucket(bucketSignerUsageV2).Get(dailyUsageKeyV2("staker", "solana:native", currentDayBucket(s.now())))
				if (want == 7000 && string(usage) != "7000") || (want == 5000 && string(usage) != "5000") || (want == 6000 && string(usage) != "6000") {
					t.Fatalf("usage charged incorrectly: %s", usage)
				}
				tokenUsage := tx.Bucket(bucketSignerUsageV2).Get(dailyUsageKeyV2("staker", "solana:spl:"+v.Mint, currentDayBucket(s.now())))
				if (want == 7000 || want == 6000) && mode != "exit" {
					if string(tokenUsage) != v.Amount {
						t.Fatalf("wrong principal usage: %s", tokenUsage)
					}
				} else if len(tokenUsage) > 0 && string(tokenUsage) != "0" {
					t.Fatalf("principal usage not released: %s", tokenUsage)
				}
				for _, scope := range []string{native, launch} {
					raw := b.Get([]byte("limit:" + scope))
					if raw == nil {
						continue
					}
					var bal wenBudgetBalanceV1
					if e := json.Unmarshal(raw, &bal); e != nil {
						return e
					}
					if bal.Reserved != want {
						t.Fatalf("scope %s: %d != %d", scope, bal.Reserved, want)
					}
				}
				return nil
			}); e != nil {
				t.Fatal(e)
			}
		})
	}
}
