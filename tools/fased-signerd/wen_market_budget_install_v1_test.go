package main

import (
	"encoding/json"
	bolt "go.etcd.io/bbolt"
	"testing"
	"time"
)

func TestWENMarketOwnerBudgetInstallation(t *testing.T) {
	for _, mode := range []string{"repeat", "operator", "digest", "wallet", "conflict", "reserved", "expired", "stale-policy"} {
		t.Run(mode, func(t *testing.T) {
			s, _, review, _ := marketBrowserSignerFixtureV1(t, "localhost", "http://localhost")
			var a wenMarketReviewArtifactV1
			if e := json.Unmarshal(review.SemanticIntent, &a); e != nil {
				t.Fatal(e)
			}
			digest, e := a.digest()
			if e != nil {
				t.Fatal(e)
			}
			cfg := signerConfig{stateDBPath: s.store.db.Path(), chains: []string{"solana"}}
			wallet, control := "miner", true
			native := wenMiningNativeScopeV1(wallet, a.Policy.Successor.Genesis)
			cash := wenMarketCashScopeV1(a)
			switch mode {
			case "operator":
				control = false
			case "digest":
				digest = wenHashV1([]byte("different"))
			case "wallet":
				wallet = "other"
			case "expired":
				now := s.store.now()
				s.store.now = func() time.Time { return now.Add(3 * time.Minute) }
			case "stale-policy":
				policy, e := s.store.getPolicy(wallet)
				if e != nil {
					t.Fatal(e)
				}
				version := policy.Version
				policy.Assets[0].MaxPerTx = "1"
				if _, e = s.store.putPolicy(policy, version); e != nil {
					t.Fatal(e)
				}
			case "conflict", "reserved":
				e = s.store.db.Update(func(tx *bolt.Tx) error {
					b := tx.Bucket(wenBudgetBucketV1)
					v := wenBudgetBalanceV1{Limit: a.Binding.MaxFee, Reserved: 1}
					if mode == "conflict" {
						v.Limit++
					}
					raw, _ := json.Marshal(v)
					if e := b.Put([]byte("limit:"+native), raw); e != nil {
						return e
					}
					if mode == "conflict" {
						return b.Delete([]byte("limit:" + cash))
					}
					return nil
				})
				if e != nil {
					t.Fatal(e)
				}
			}
			e = s.installWENMarketBudgetV1(cfg, wallet, a.RequestID, digest, control)
			pass := mode == "repeat" || mode == "reserved"
			if (e == nil) != pass {
				t.Fatalf("mode %s: %v", mode, e)
			}
			if mode == "conflict" || mode == "reserved" {
				e = s.store.db.View(func(tx *bolt.Tx) error {
					b := tx.Bucket(wenBudgetBucketV1)
					var v wenBudgetBalanceV1
					if e := json.Unmarshal(b.Get([]byte("limit:"+native)), &v); e != nil {
						return e
					}
					if v.Reserved != 1 {
						t.Fatal("reservation reset")
					}
					if mode == "conflict" && b.Get([]byte("limit:"+cash)) != nil {
						t.Fatal("partial budget installation")
					}
					return nil
				})
				if e != nil {
					t.Fatal(e)
				}
			}
		})
	}
}
