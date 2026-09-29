package main

import (
	"encoding/json"
	"fmt"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
	"testing"
)

func TestWENMiningClaimBudget(t *testing.T) {
	for _, mode := range []string{"ok", "capacity", "policy", "bare", "message", "changed", "collision", "restart"} {
		t.Run(mode, func(t *testing.T) {
			s, k := openTestSignerV2(t)
			v := miningClaimIntentFixture()
			record, old := createTestSignerWalletV2(t, s, k, "miner", v.Economy, 100, 100)
			w := solana.MustPublicKeyFromBase58(record.PublicKey)
			policy, e := s.putPolicy(signerPolicyV2{WalletID: "miner", Role: "agent", Operations: []string{intentWENMiningClaimV1}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Economy}, MaxPerTx: "5000", MaxDaily: "12000"}}}, old.Version)
			if e != nil {
				t.Fatal(e)
			}
			for _, scope := range []string{wenMiningNativeScopeV1("miner", v.Genesis), wenMiningClaimLaunchScopeV1("miner", v)} {
				limit := uint64(12000)
				if mode == "capacity" {
					limit = 4999
				}
				if e = s.configureWENBudgetV1(scope, limit); e != nil {
					t.Fatal(e)
				}
			}
			ix, e := buildWENMiningClaimInstructionV1(v, w)
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
			b := &wenMiningClaimMessageBindingV1{Message: msg, Blockhash: block, ReviewSHA: wenHashV1([]byte("review")), StateHash: v.AccountStateSHA256, Slot: 2, Fee: 5000, Rent: 0, LastValidHeight: 200}
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
			digest, replay, e := s.reserveWENMiningClaimBoundBudgetV1("claim-request", "miner", hash, v, w, 5000, b)
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
			d, again, e := s.reserveWENMiningClaimBoundBudgetV1("claim-request", "miner", hash, v, w, 5000, b)
			if e != nil || !again || d != digest {
				t.Fatal("replay", e)
			}
			if mode == "changed" {
				b.LastValidHeight++
				if _, _, e = s.reserveWENMiningClaimBoundBudgetV1("claim-request", "miner", hash, v, w, 5000, b); e == nil {
					t.Fatal("changed binding")
				}
			}
			if mode == "collision" {
				if _, _, e = s.reserveWENMiningClaimBoundBudgetV1("another-request", "miner", hash, v, w, 5000, b); e == nil {
					t.Fatal("duplicate claim")
				}
			}
			if e = s.beginWENSigningV1("claim-request", digest, wenHashV1(msg)); e == nil {
				t.Fatal("signing accepted without resolved accounts and slot")
			}
			if e = s.cancelWENReservationV1("claim-request", digest); e != nil {
				t.Fatal(e)
			}
			if e = s.db.View(func(tx *bolt.Tx) error {
				for _, scope := range []string{wenMiningNativeScopeV1("miner", v.Genesis), wenMiningClaimLaunchScopeV1("miner", v)} {
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
			if _, _, e = s.reserveWENMiningClaimBoundBudgetV1("after-cancel", "miner", hash, v, w, 5000, b); e == nil {
				t.Fatal("cancelled action reused")
			}
		})
	}
}

// Distinct claim legs share the owner/launch fee ceiling but never a replay key.
func TestWENMiningClaimConcurrentLegBudgets(t *testing.T) {
	s, k := openTestSignerV2(t)
	v := miningClaimIntentFixture()
	record, old := createTestSignerWalletV2(t, s, k, "miner", v.Economy, 100, 100)
	w := solana.MustPublicKeyFromBase58(record.PublicKey)
	policy, e := s.putPolicy(signerPolicyV2{WalletID: "miner", Role: "agent", Operations: []string{intentWENMiningClaimV1}, Programs: []string{v.ProgramID}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{v.Economy}, MaxPerTx: "5000", MaxDaily: "12000"}}}, old.Version)
	if e != nil {
		t.Fatal(e)
	}
	scopes := []string{wenMiningNativeScopeV1("miner", v.Genesis), wenMiningClaimLaunchScopeV1("miner", v)}
	for _, scope := range scopes {
		if e = s.configureWENBudgetV1(scope, 12000); e != nil {
			t.Fatal(e)
		}
	}
	bind := func(v signerWENMiningClaimIntentV1) *wenMiningClaimMessageBindingV1 {
		ix, e := buildWENMiningClaimInstructionV1(v, w)
		if e != nil {
			t.Fatal(e)
		}
		h := solana.Hash{8}
		tx, e := solana.NewTransaction([]solana.Instruction{ix}, h, solana.TransactionPayer(w))
		if e != nil {
			t.Fatal(e)
		}
		tx.Message.SetVersion(solana.MessageVersionV0)
		m, e := tx.Message.MarshalBinary()
		if e != nil {
			t.Fatal(e)
		}
		return &wenMiningClaimMessageBindingV1{Message: m, Blockhash: h, ReviewSHA: wenHashV1([]byte("review")), StateHash: v.AccountStateSHA256, Slot: 2, Fee: 5000, LastValidHeight: 200}
	}
	b := bind(v)
	type result struct {
		request, digest string
		err             error
	}
	ch := make(chan result, 12)
	for i := 0; i < 12; i++ {
		go func(i int) {
			request := fmt.Sprintf("claim-race-%d", i)
			d, _, e := s.reserveWENMiningClaimBoundBudgetV1(request, "miner", policy.Hash, v, w, 5000, b)
			ch <- result{request, d, e}
		}(i)
	}
	var winner result
	wins := 0
	for i := 0; i < 12; i++ {
		r := <-ch
		if r.err == nil {
			wins++
			winner = r
		}
	}
	if wins != 1 {
		t.Fatal("duplicate race winners", wins)
	}
	other := v
	other.Operation = "sat"
	destination := solana.PublicKey{4}.String()
	other.Destination = &destination
	second, _, e := s.reserveWENMiningClaimBoundBudgetV1("sat-leg-request", "miner", policy.Hash, other, w, 5000, bind(other))
	if e != nil {
		t.Fatal("other claim leg excluded", e)
	}
	check := func(expected uint64) {
		t.Helper()
		if e := s.db.View(func(tx *bolt.Tx) error {
			for _, scope := range scopes {
				var balance wenBudgetBalanceV1
				if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &balance); e != nil {
					return e
				}
				if balance.Reserved != expected {
					t.Fatalf("fee-only accounting: %d != %d", balance.Reserved, expected)
				}
			}
			return nil
		}); e != nil {
			t.Fatal(e)
		}
	}
	check(10000)
	third := v
	third.Nonce = "3"
	if _, _, e = s.reserveWENMiningClaimBoundBudgetV1("over-capacity", "miner", policy.Hash, third, w, 5000, bind(third)); e == nil {
		t.Fatal("shared ceiling bypassed")
	}
	check(10000)
	if e = s.cancelWENReservationV1(winner.request, winner.digest); e != nil {
		t.Fatal(e)
	}
	check(5000)
	if e = s.cancelWENReservationV1("sat-leg-request", second); e != nil {
		t.Fatal(e)
	}
	check(0)
	if _, _, e = s.reserveWENMiningClaimBoundBudgetV1("recycle-sol", "miner", policy.Hash, v, w, 5000, b); e == nil {
		t.Fatal("cancelled leg recycled")
	}
	// Failed admission must not leave a tombstone or charge that prevents later work.
	if _, _, e = s.reserveWENMiningClaimBoundBudgetV1("after-capacity", "miner", policy.Hash, third, w, 5000, bind(third)); e != nil {
		t.Fatal("failed reservation was not atomic", e)
	}
	check(5000)
}
