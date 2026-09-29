package main

import (
	"context"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"strconv"
	"testing"
	"time"
)

type marketExpiryFakeV1 struct {
	genesis solana.Hash
	height  uint64
	reads   int
}

func (f *marketExpiryFakeV1) GetGenesisHash(context.Context) (solana.Hash, error) {
	f.reads++
	return f.genesis, nil
}
func (f *marketExpiryFakeV1) GetBlockHeight(_ context.Context, c rpc.CommitmentType) (uint64, error) {
	if c != rpc.CommitmentFinalized {
		panic("expiry must use finalized height")
	}
	return f.height, nil
}
func TestWENMarketCancellationExpiryAndBudgetRollback(t *testing.T) {
	for _, mode := range []string{"review-cancel", "review-expire", "reserved-cancel", "reserved-expire", "signing-expire", "signed-expire", "uncertain", "bad-scope", "missing-cash"} {
		t.Run(mode, func(t *testing.T) {
			store, a, _ := marketReviewFixtureV1(t)
			review, e := store.storeWENMarketReviewV1(a)
			if e != nil {
				t.Fatal(e)
			}
			digest, _ := a.digest()
			expiry, _ := time.Parse(time.RFC3339Nano, review.ExpiresAt)
			c := &marketExpiryFakeV1{genesis: solana.MustHashFromBase58(a.Policy.Successor.Genesis), height: a.Binding.LastValidHeight + 1}
			reserved := mode != "review-cancel" && mode != "review-expire"
			if reserved {
				for scope, n := range wenMarketReservationScopesV1(a) {
					if e = store.configureWENBudgetV1(scope, n); e != nil {
						t.Fatal(e)
					}
				}
				if _, _, e = store.reserveWENMarketReviewV1(a); e != nil {
					t.Fatal(e)
				}
			}
			setState := func(state string) {
				if e = store.db.Update(func(tx *bolt.Tx) error {
					bucket := tx.Bucket(wenBudgetBucketV1)
					key := []byte("market-request:" + a.RequestID)
					var r wenMarketReservationV1
					if e := json.Unmarshal(bucket.Get(key), &r); e != nil {
						return e
					}
					r.State = state
					raw, e := json.Marshal(r)
					if e != nil {
						return e
					}
					return bucket.Put(key, raw)
				}); e != nil {
					t.Fatal(e)
				}
			}
			reason := "cancelled"
			switch mode {
			case "review-expire", "reserved-expire":
				reason = "expired"
				if e = store.releaseWENMarketStateV1(a.WalletID, a.RequestID, digest, reason, "reserved", 0); e == nil {
					t.Fatal("early expiry accepted")
				}
				store.now = func() time.Time { return expiry.Add(time.Second) }
			case "signing-expire", "signed-expire":
				state := "signing"
				if mode == "signed-expire" {
					state = "signed"
				}
				setState(state)
				if e = store.releaseWENMarketReviewV1(a.WalletID, a.RequestID, digest, "cancelled"); e == nil {
					t.Fatal("signing cancelled without expiry proof")
				}
				store.now = func() time.Time { return expiry.Add(time.Second) }
				c.height = a.Binding.LastValidHeight
				if e = store.expireWENMarketReviewV1(context.Background(), c, a.WalletID, a.RequestID, digest); e == nil {
					t.Fatal("live blockhash expired")
				}
				c.height++
				valid := c.genesis
				c.genesis = solana.Hash{1}
				if e = store.expireWENMarketReviewV1(context.Background(), c, a.WalletID, a.RequestID, digest); e == nil {
					t.Fatal("wrong chain released hold")
				}
				c.genesis = valid
				reason = "expired"
			case "uncertain":
				setState("submission-uncertain")
				store.now = func() time.Time { return expiry.Add(time.Hour) }
				if e = store.releaseWENMarketReviewV1(a.WalletID, a.RequestID, digest, "cancelled"); e == nil {
					t.Fatal("uncertain cancelled")
				}
				if e = store.expireWENMarketReviewV1(context.Background(), c, a.WalletID, a.RequestID, digest); e == nil {
					t.Fatal("uncertain expired")
				}
				assertMarketHoldV1(t, store, a, true)
				return
			case "bad-scope":
				if e = store.db.Update(func(tx *bolt.Tx) error {
					bucket := tx.Bucket(wenBudgetBucketV1)
					key := []byte("market-request:" + a.RequestID)
					var r wenMarketReservationV1
					if e := json.Unmarshal(bucket.Get(key), &r); e != nil {
						return e
					}
					r.Scopes[wenMarketCashScopeV1(a)]--
					raw, e := json.Marshal(r)
					if e != nil {
						return e
					}
					return bucket.Put(key, raw)
				}); e != nil {
					t.Fatal(e)
				}
				if e = store.releaseWENMarketReviewV1(a.WalletID, a.RequestID, digest, "cancelled"); e == nil {
					t.Fatal("altered scopes released")
				}
				assertMarketHoldV1(t, store, a, true)
				return
			case "missing-cash":
				if e = store.db.Update(func(tx *bolt.Tx) error {
					return tx.Bucket(wenBudgetBucketV1).Delete([]byte("limit:" + wenMarketCashScopeV1(a)))
				}); e != nil {
					t.Fatal(e)
				}
				if e = store.releaseWENMarketReviewV1(a.WalletID, a.RequestID, digest, "cancelled"); e == nil {
					t.Fatal("missing cash ledger released")
				}
				if e = store.db.View(func(tx *bolt.Tx) error {
					var n wenBudgetBalanceV1
					if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+wenMiningNativeScopeV1(a.WalletID, a.Policy.Successor.Genesis))), &n); e != nil {
						return e
					}
					if n.Reserved != a.Binding.MaxFee {
						t.Fatal("partial native release committed")
					}
					return nil
				}); e != nil {
					t.Fatal(e)
				}
				return
			}
			for i := 0; i < 2; i++ {
				if reason == "cancelled" {
					e = store.releaseWENMarketReviewV1(a.WalletID, a.RequestID, digest, reason)
				} else {
					e = store.expireWENMarketReviewV1(context.Background(), c, a.WalletID, a.RequestID, digest)
				}
				if e != nil {
					t.Fatal("close/retry", e)
				}
				if i == 0 {
					path, clock := store.db.Path(), store.now
					if e = store.Close(); e != nil {
						t.Fatal(e)
					}
					store, e = openSignerStoreV2(path)
					if e != nil {
						t.Fatal(e)
					}
					defer store.Close()
					store.now = clock
				}
			}
			if reserved {
				assertMarketHoldV1(t, store, a, false)
			}
			if _, _, e = store.reserveWENMarketReviewV1(a); e == nil {
				t.Fatal("closed review revived")
			}
		})
	}
}
func assertMarketHoldV1(t *testing.T, s *signerStoreV2, a wenMarketReviewArtifactV1, held bool) {
	t.Helper()
	if e := s.db.View(func(tx *bolt.Tx) error {
		for scope, n := range wenMarketReservationScopesV1(a) {
			var balance wenBudgetBalanceV1
			if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &balance); e != nil {
				return e
			}
			want := uint64(0)
			if held {
				want = n
			}
			if balance.Reserved != want {
				t.Fatal("reservation release mismatch", scope)
			}
		}
		var r wenMarketReservationV1
		if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("market-request:"+a.RequestID)), &r); e != nil {
			return e
		}
		for asset, n := range map[string]uint64{"solana:native": a.Binding.MaxFee, a.cashAsset(): a.Binding.Snapshot.Quote.InputCash} {
			used := string(tx.Bucket(bucketSignerUsageV2).Get(dailyUsageKeyV2(a.WalletID, asset, r.UsageDay)))
			want := uint64(0)
			if held {
				want = n
			}
			if used != strconv.FormatUint(want, 10) {
				t.Fatal("usage release mismatch", asset, used)
			}
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
}
