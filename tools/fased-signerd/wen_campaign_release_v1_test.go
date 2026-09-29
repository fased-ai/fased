package main

import (
	"context"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"testing"
	"time"
)

func testCampaignReleaseV1(t *testing.T, s *signerStoreV2, a wenCampaignReviewArtifactV1, digest string, service *signerWebAuthnServiceV2, proof *signerWebAuthnProofReferenceV2) {
	t.Helper()
	if e := s.releaseWENCampaignReviewV1("other", a.RequestID, digest, "cancelled"); e == nil {
		t.Fatal("wrong wallet release")
	}
	if e := s.releaseWENCampaignReviewV1(a.WalletID, a.RequestID, digest, "expired"); e == nil {
		t.Fatal("early expiry")
	}
	key := []byte("campaign-request:" + a.RequestID)
	setState := func(state string) {
		t.Helper()
		if e := s.db.Update(func(tx *bolt.Tx) error {
			b := tx.Bucket(wenBudgetBucketV1)
			var r wenCampaignReservationV1
			if e := json.Unmarshal(b.Get(key), &r); e != nil {
				return e
			}
			r.State = state
			raw, e := json.Marshal(r)
			if e != nil {
				return e
			}
			return b.Put(key, raw)
		}); e != nil {
			t.Fatal(e)
		}
	}
	for _, state := range []string{"signing", "submitted", "submission-uncertain"} {
		setState(state)
		if e := s.releaseWENCampaignReviewV1(a.WalletID, a.RequestID, digest, "cancelled"); e == nil {
			t.Fatal("unsafe release", state)
		}
	}
	setState("reserved")
	// Underflow must roll back every scope decrement.
	usageKey := dailyUsageKeyV2(a.WalletID, "solana:native", currentDayBucket(s.now()))
	var saved []byte
	if e := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketSignerUsageV2)
		saved = append([]byte(nil), b.Get(usageKey)...)
		return b.Put(usageKey, []byte("0"))
	}); e != nil {
		t.Fatal(e)
	}
	if e := s.releaseWENCampaignReviewV1(a.WalletID, a.RequestID, digest, "cancelled"); e == nil {
		t.Fatal("usage underflow")
	}
	if e := s.db.Update(func(tx *bolt.Tx) error {
		var b wenBudgetBalanceV1
		if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+wenCampaignLaunchScopeV1(a))), &b); e != nil {
			return e
		}
		n, _ := a.debit()
		if b.Reserved != n {
			t.Fatal("release rollback")
		}
		return tx.Bucket(bucketSignerUsageV2).Put(usageKey, saved)
	}); e != nil {
		t.Fatal(e)
	}
	if a.Action.Operation == "top-up" {
		setState("signed")
		now := s.now()
		s.now = func() time.Time { return now.Add(24 * time.Hour) }
		f := &campaignExpiryFake{genesis: solana.MustHashFromBase58(a.Pins.Genesis), height: a.Binding.LastValidHeight}
		if e := s.expireWENCampaignSigningV1(context.Background(), f, a.WalletID, a.RequestID, digest); e == nil {
			t.Fatal("valid blockhash released")
		}
		f.height++
		f.bad = true
		if e := s.expireWENCampaignSigningV1(context.Background(), f, a.WalletID, a.RequestID, digest); e == nil {
			t.Fatal("wrong chain expired")
		}
		f.bad = false
		if e := s.expireWENCampaignSigningV1(context.Background(), f, a.WalletID, a.RequestID, digest); e != nil {
			t.Fatal("expired signed", e)
		}
	}
	reason := "cancelled"
	if a.Action.Operation == "top-up" {
		reason = "expired"
	}
	if a.Action.Operation == "withdraw" {
		reason = "expired"
		now := s.now()
		s.now = func() time.Time { return now.Add(24 * time.Hour) }
	}
	for i := 0; i < 2; i++ {
		if e := s.releaseWENCampaignReviewV1(a.WalletID, a.RequestID, digest, reason); e != nil {
			t.Fatal("release/retry", e)
		}
	}
	if e := s.db.View(func(tx *bolt.Tx) error {
		for _, scope := range []string{wenMiningNativeScopeV1(a.WalletID, a.Pins.Genesis), wenCampaignLaunchScopeV1(a)} {
			var b wenBudgetBalanceV1
			if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &b); e != nil {
				return e
			}
			if b.Reserved != 0 {
				t.Fatal("held budget")
			}
		}
		if string(tx.Bucket(bucketSignerUsageV2).Get(usageKey)) != "0" {
			t.Fatal("old-day usage not restored")
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	if _, _, e := s.reserveWENCampaignReviewV1(a); e == nil {
		t.Fatal("released request revived")
	}
	if e := service.authorizeWENCampaignV1(a.WalletID, a.RequestID, digest, proof); e == nil {
		t.Fatal("released approval reused")
	}
}

type campaignExpiryFake struct {
	genesis solana.Hash
	height  uint64
	bad     bool
}

func (f *campaignExpiryFake) GetGenesisHash(context.Context) (solana.Hash, error) {
	g := f.genesis
	if f.bad {
		g[0] ^= 1
	}
	return g, nil
}
func (f *campaignExpiryFake) GetBlockHeight(_ context.Context, c rpc.CommitmentType) (uint64, error) {
	if c != rpc.CommitmentFinalized {
		panic("nonfinal height")
	}
	return f.height, nil
}
