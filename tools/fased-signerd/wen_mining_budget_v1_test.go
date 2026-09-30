package main

import (
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"sync"
	"testing"
	"time"
)

func miningBudgetFixture(t *testing.T) (*signerStoreV2, signerWENMiningIntentV1, solana.PublicKey, signerPolicyV2) {
	t.Helper()
	s, k := openTestSignerV2(t)
	v := miningFixture(t).Intent
	r, old := createTestSignerWalletV2(t, s, k, "miner", v.Economy, 100, 100)
	p, e := s.putPolicy(signerPolicyV2{WalletID: "miner", Role: "agent", Operations: []string{intentWENMiningV1 + ".commit", intentWENMiningV1 + ".reveal"}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Economy}, MaxPerTx: "5000", MaxDaily: "10000"}}}, old.Version)
	if e != nil {
		t.Fatal(e)
	}
	if e := s.configureWENBudgetV1(wenMiningNativeScopeV1("miner", v.Genesis), 10000); e != nil {
		t.Fatal(e)
	}
	return s, v, solana.MustPublicKeyFromBase58(r.PublicKey), p
}
func TestWENMiningPolicyBudgetV1(t *testing.T) {
	for _, mode := range []string{"valid", "policy", "operation", "program", "destination", "per-tx", "daily", "capacity", "wrong-wallet", "replay", "different-request", "different-intent", "revoke", "cancel", "cancel-restart", "fence", "race", "replay-next-day", "damaged-record"} {
		t.Run(mode, func(t *testing.T) {
			s, v, wallet, p := miningBudgetFixture(t)
			hash := p.Hash
			day := s.now()
			switch mode {
			case "policy":
				hash = wenHashV1([]byte("wrong"))
			case "operation":
				p.Operations = []string{intentWENMiningV1 + ".reveal"}
			case "program":
				p.Programs = []string{wallet.String()}
			case "destination":
				p.Assets[0].Destinations = []string{wallet.String()}
			case "per-tx":
				p.Assets[0].MaxPerTx = "4999"
			case "wrong-wallet":
				wallet = solana.NewWallet().PublicKey()
			}
			if mode == "operation" || mode == "program" || mode == "destination" || mode == "per-tx" {
				var e error
				p, e = s.putPolicy(p, p.Version)
				if e != nil {
					t.Fatal(e)
				}
				hash = p.Hash
			}
			if mode == "daily" || mode == "capacity" {
				e := s.db.Update(func(tx *bolt.Tx) error {
					if mode == "daily" {
						return tx.Bucket(bucketSignerUsageV2).Put(dailyUsageKeyV2("miner", "solana:native", currentDayBucket(day)), []byte("5001"))
					}
					b, _ := json.Marshal(wenBudgetBalanceV1{Limit: 10000, Reserved: 5001})
					return tx.Bucket(wenBudgetBucketV1).Put([]byte("limit:"+wenMiningNativeScopeV1("miner", v.Genesis)), b)
				})
				if e != nil {
					t.Fatal(e)
				}
			}
			if mode == "race" {
				var wg sync.WaitGroup
				results := make(chan error, 2)
				for _, id := range []string{"mining-one", "mining-two"} {
					wg.Add(1)
					go func(id string) {
						defer wg.Done()
						_, _, e := s.reserveWENMiningBudgetV1(id, "miner", hash, v, wallet)
						results <- e
					}(id)
				}
				wg.Wait()
				close(results)
				ok := 0
				for e := range results {
					if e == nil {
						ok++
					}
				}
				if ok != 1 {
					t.Fatal("race did not admit exactly one")
				}
				used, _ := s.dailyUsage("miner", "solana:native", day)
				if used.Uint64() != 5000 {
					t.Fatal("race usage")
				}
				return
			}
			digest, exists, e := s.reserveWENMiningBudgetV1("mining-request", "miner", hash, v, wallet)
			reject := mode == "policy" || mode == "operation" || mode == "program" || mode == "destination" || mode == "per-tx" || mode == "daily" || mode == "capacity" || mode == "wrong-wallet"
			if (e != nil) != reject || exists {
				t.Fatal("unexpected reservation", e)
			}
			used, _ := s.dailyUsage("miner", "solana:native", day)
			want := uint64(5000)
			if reject {
				want = 0
			}
			if mode == "daily" {
				want = 5001
			}
			if used.Uint64() != want {
				t.Fatal("non-atomic daily usage", used, want)
			}
			if reject {
				return
			}
			if mode == "valid" {
				copy := v
				copy.Operation = "reveal"
				if _, _, e := s.reserveWENMiningBudgetV1("mining-reveal", "miner", hash, copy, wallet); e != nil {
					t.Fatal(e)
				}
				used, _ = s.dailyUsage("miner", "solana:native", day)
				if used.Uint64() != 10000 {
					t.Fatal("commit/reveal fee budget")
				}
				return
			}
			if mode == "cancel-restart" {
				path := s.db.Path()
				if e := s.Close(); e != nil {
					t.Fatal(e)
				}
				s, e = openSignerStoreV2(path)
				if e != nil {
					t.Fatal(e)
				}
				defer s.Close()
				s.now = func() time.Time { return day.Add(24 * time.Hour) }
			}
			if mode == "cancel" || mode == "cancel-restart" {
				if e := s.cancelWENReservationV1("mining-request", digest); e != nil {
					t.Fatal(e)
				}
				if e := s.cancelWENReservationV1("mining-request", digest); e != nil {
					t.Fatal(e)
				}
				used, _ = s.dailyUsage("miner", "solana:native", day)
				held, _ := s.wenBudgetReservedV1(wenMiningNativeScopeV1("miner", v.Genesis))
				if used.Sign() != 0 || held != 0 {
					t.Fatal("cancel conservation")
				}
				if _, _, e := s.reserveWENMiningBudgetV1("mining-second", "miner", hash, v, wallet); e == nil {
					t.Fatal("cancel recycled action")
				}
				return
			}
			if mode == "revoke" {
				p.Operations = []string{intentWENMiningV1 + ".reveal"}
				if _, e := s.putPolicy(p, p.Version); e != nil {
					t.Fatal(e)
				}
			}
			if mode == "fence" {
				if e := s.beginWENSigningV1("mining-request", digest, wenHashV1([]byte("test message"))); e != nil {
					t.Fatal(e)
				}
				if e := s.cancelWENReservationV1("mining-request", digest); e == nil {
					t.Fatal("signed reservation cancelled")
				}
			}
			if mode == "replay-next-day" {
				s.now = func() time.Time { return day.Add(24 * time.Hour) }
			}
			if mode == "damaged-record" {
				e := s.db.Update(func(tx *bolt.Tx) error {
					b := tx.Bucket(wenBudgetBucketV1)
					var r wenBudgetReservationV1
					if e := json.Unmarshal(b.Get([]byte("request:mining-request")), &r); e != nil {
						return e
					}
					r.WalletClaims["solana:native"] = 1
					raw, _ := json.Marshal(r)
					return b.Put([]byte("request:mining-request"), raw)
				})
				if e != nil {
					t.Fatal(e)
				}
			}
			id := "mining-request"
			if mode == "different-request" {
				id = "mining-second"
			}
			if mode == "different-intent" {
				v.Capital = "1000001"
			}
			_, exists, e = s.reserveWENMiningBudgetV1(id, "miner", hash, v, wallet)
			if mode == "replay" {
				if e != nil || !exists {
					t.Fatal("idempotent retry", e)
				}
			} else if e == nil {
				t.Fatal("unsafe reuse")
			}
		})
	}
}

func TestWENMiningLaunchCeilingsV1(t *testing.T) {
	for _, mode := range []string{"launch-limit", "two-launch-shared-limit"} {
		t.Run(mode, func(t *testing.T) {
			s, a, wallet, p := miningBudgetFixture(t)
			b := a
			b.Economy = solana.NewWallet().PublicKey().String()
			b.Entry = solana.NewWallet().PublicKey().String()
			b.Offer = solana.NewWallet().PublicKey().String()
			p.Assets[0].Destinations = append(p.Assets[0].Destinations, b.Economy)
			var err error
			p, err = s.putPolicy(p, p.Version)
			if err != nil {
				t.Fatal(err)
			}
			limit := uint64(5000)
			if mode == "launch-limit" {
				limit = 4999
			}
			if err = s.configureWENBudgetV1(wenMiningLaunchScopeV1("miner", a), limit); err != nil {
				t.Fatal(err)
			}
			if err = s.configureWENBudgetV1(wenMiningLaunchScopeV1("miner", b), 5000); err != nil {
				t.Fatal(err)
			}
			if mode == "launch-limit" {
				if _, _, err = s.reserveWENMiningBudgetV1("launch-a", "miner", p.Hash, a, wallet); err == nil {
					t.Fatal("launch ceiling ignored")
				}
			} else {
				if err = s.db.Update(func(tx *bolt.Tx) error {
					raw, _ := json.Marshal(wenBudgetBalanceV1{Limit: 9999})
					return tx.Bucket(wenBudgetBucketV1).Put([]byte("limit:"+wenMiningNativeScopeV1("miner", a.Genesis)), raw)
				}); err != nil {
					t.Fatal(err)
				}
				if _, _, err = s.reserveWENMiningBudgetV1("launch-a", "miner", p.Hash, a, wallet); err != nil {
					t.Fatal(err)
				}
				if _, _, err = s.reserveWENMiningBudgetV1("launch-b", "miner", p.Hash, b, wallet); err == nil {
					t.Fatal("shared wallet ceiling ignored")
				}
			}
			err = s.db.View(func(tx *bolt.Tx) error {
				expected := uint64(0)
				if mode != "launch-limit" {
					expected = 5000
				}
				for _, scope := range []string{wenMiningNativeScopeV1("miner", a.Genesis), wenMiningLaunchScopeV1("miner", a)} {
					var balance wenBudgetBalanceV1
					if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &balance); e != nil {
						return e
					}
					if balance.Reserved != expected {
						t.Errorf("reserved %d want %d", balance.Reserved, expected)
					}
				}
				var balance wenBudgetBalanceV1
				if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+wenMiningLaunchScopeV1("miner", b))), &balance); e != nil {
					return e
				}
				if balance.Reserved != 0 {
					t.Error("failed reservation charged other launch")
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestWENMiningLaunchReplayAndCancelV1(t *testing.T) {
	s, v, w, p := miningBudgetFixture(t)
	launch := wenMiningLaunchScopeV1("miner", v)
	if err := s.configureWENBudgetV1(launch, 5000); err != nil {
		t.Fatal(err)
	}
	digest, _, err := s.reserveWENMiningBudgetV1("launch-cancel", "miner", p.Hash, v, w)
	if err != nil {
		t.Fatal(err)
	}
	if _, existing, err := s.reserveWENMiningBudgetV1("launch-cancel", "miner", p.Hash, v, w); err != nil || !existing {
		t.Fatalf("replay: %v %v", existing, err)
	}
	if err = s.cancelWENReservationV1("launch-cancel", digest); err != nil {
		t.Fatal(err)
	}
	if err = s.cancelWENReservationV1("launch-cancel", digest); err != nil {
		t.Fatal(err)
	}
	if err = s.db.View(func(tx *bolt.Tx) error {
		for _, scope := range []string{launch, wenMiningNativeScopeV1("miner", v.Genesis)} {
			var b wenBudgetBalanceV1
			if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &b); e != nil {
				return e
			}
			if b.Reserved != 0 {
				t.Error("cancel did not release both ceilings")
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestWENMiningRequiredLaunchBudgetV2(t *testing.T) {
	s, v, w, p := miningBudgetFixture(t)
	if _, _, e := s.reserveWENMiningBudgetModeV1("scoped-task", "miner", p.Hash, v, w, true); e == nil {
		t.Fatal("missing launch budget admitted")
	}
	if e := s.configureWENBudgetV1(wenMiningLaunchScopeV1("miner", v), 5000); e != nil {
		t.Fatal(e)
	}
	if _, _, e := s.reserveWENMiningBudgetModeV1("scoped-task", "miner", p.Hash, v, w, true); e != nil {
		t.Fatal(e)
	}
}

func TestWENMiningConcurrentLaunchAdmissionV2(t *testing.T) {
	s, a, w, p := miningBudgetFixture(t)
	b := a
	b.Economy = solana.NewWallet().PublicKey().String()
	b.Entry = solana.NewWallet().PublicKey().String()
	p.Assets[0].Destinations = append(p.Assets[0].Destinations, b.Economy)
	var e error
	p, e = s.putPolicy(p, p.Version)
	if e != nil {
		t.Fatal(e)
	}
	for _, v := range []signerWENMiningIntentV1{a, b} {
		if e = s.configureWENBudgetV1(wenMiningLaunchScopeV1("miner", v), 5000); e != nil {
			t.Fatal(e)
		}
	}
	if e = s.db.Update(func(tx *bolt.Tx) error {
		raw, _ := json.Marshal(wenBudgetBalanceV1{Limit: 9999})
		return tx.Bucket(wenBudgetBucketV1).Put([]byte("limit:"+wenMiningNativeScopeV1("miner", a.Genesis)), raw)
	}); e != nil {
		t.Fatal(e)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	for i, v := range []signerWENMiningIntentV1{a, b} {
		go func(i int, v signerWENMiningIntentV1) {
			<-start
			_, _, e := s.reserveWENMiningBudgetModeV1([]string{"race-launch-a", "race-launch-b"}[i], "miner", p.Hash, v, w, true)
			results <- e
		}(i, v)
	}
	close(start)
	passed := 0
	for i := 0; i < 2; i++ {
		if <-results == nil {
			passed++
		}
	}
	if passed != 1 {
		t.Fatalf("admitted %d want 1", passed)
	}
	if e = s.db.View(func(tx *bolt.Tx) error {
		sum := uint64(0)
		for _, v := range []signerWENMiningIntentV1{a, b} {
			var balance wenBudgetBalanceV1
			if err := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+wenMiningLaunchScopeV1("miner", v))), &balance); err != nil {
				return err
			}
			sum += balance.Reserved
		}
		if sum != 5000 {
			t.Errorf("launch reserved sum %d", sum)
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
}

func TestWENMiningSettlementScopeBindingV1(t *testing.T) {
	v := miningFixture(t).Intent
	native := wenMiningNativeScopeV1("miner", v.Genesis)
	launch := wenMiningLaunchScopeV1("miner", v)
	r := wenBudgetReservationV1{WalletID: "miner", Genesis: v.Genesis, MiningIntent: &v, WalletClaims: map[string]uint64{"solana:native": 5000}, Scopes: map[string]uint64{native: 5000, launch: 5000}}
	if !wenMiningSettlementScopesValidV1(r) {
		t.Fatal("valid scopes rejected")
	}
	for _, scopes := range []map[string]uint64{{native: 5000, "other-launch": 5000}, {native: 5000, launch: 4999}, {launch: 5000}, {native: 5000, launch: 5000, "extra": 5000}} {
		r.Scopes = scopes
		if wenMiningSettlementScopesValidV1(r) {
			t.Fatal("invalid scopes accepted")
		}
	}
}
