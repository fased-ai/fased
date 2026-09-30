package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

func TestWENBTCSuccessSettlement(t *testing.T) {
	for _, name := range []string{"valid", "next-day-restart", "unproved", "over-budget", "underflow"} {
		t.Run(name, func(t *testing.T) {
			s, r := wenStateFixture(t)
			original := s.now()
			observed, result := wenFundingReceiptFixture(t, "acceptance")
			r.State = "finalized-success"
			r.OutcomeFee = result.Meta.Fee
			r.OutcomeSlot = result.Slot
			r.SuccessEffectsSHA256, r.SuccessNativeDebit = wenSuccessNativeEffectsV1(observed, result)
			r.SuccessFundingEffectsSHA256 = wenSuccessFundingEffectsV1(observed, result)
			if name == "unproved" {
				r.SuccessFundingEffectsSHA256 = ""
			}
			if name == "over-budget" {
				r.SuccessNativeDebit = r.WalletClaims["solana:native"] + 1
			}
			raw, _ := json.Marshal(r)
			if err := s.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(wenBudgetBucketV1).Put([]byte("request:state-request"), raw) }); err != nil {
				t.Fatal(err)
			}
			if name == "underflow" {
				if err := s.db.Update(func(tx *bolt.Tx) error {
					return tx.Bucket(bucketSignerUsageV2).Put(dailyUsageKeyV2(r.WalletID, "solana:native", r.UsageDay), []byte("1"))
				}); err != nil {
					t.Fatal(err)
				}
			}
			if name == "next-day-restart" {
				path := s.db.Path()
				if err := s.Close(); err != nil {
					t.Fatal(err)
				}
				reopened, err := openSignerStoreV2(path)
				if err != nil {
					t.Fatal(err)
				}
				defer reopened.Close()
				s = reopened
				s.now = func() time.Time { return original.Add(24 * time.Hour) }
				if err := s.db.Update(func(tx *bolt.Tx) error {
					return tx.Bucket(bucketSignerUsageV2).Put(dailyUsageKeyV2(r.WalletID, "solana:native", currentDayBucket(s.now())), []byte("9"))
				}); err != nil {
					t.Fatal(err)
				}
			}
			err := s.settleWENSuccessBudgetV1("state-request", r.Digest)
			success := name == "valid" || name == "next-day-restart"
			if (err == nil) != success {
				t.Fatal("settlement", err)
			}
			if success {
				if err := s.settleWENSuccessBudgetV1("state-request", r.Digest); err != nil {
					t.Fatal("retry", err)
				}
			}
			if readWENState(t, s).SuccessBudgetSettled != success {
				t.Fatal("settlement marker")
			}
			for scope, amount := range r.Scopes {
				if success && strings.HasSuffix(scope, ":sol") {
					amount = r.SuccessNativeDebit
				}
				got, err := s.wenBudgetReservedV1(scope)
				if err != nil || got != amount {
					t.Fatal("cash/native scope accounting", got, amount, err)
				}
			}
			for asset, amount := range r.WalletClaims {
				if success && asset == "solana:native" {
					amount = r.SuccessNativeDebit
				}
				if name == "underflow" && asset == "solana:native" {
					amount = 1
				}
				got, err := s.dailyUsage(r.WalletID, asset, original)
				if err != nil || got.Uint64() != amount {
					t.Fatal("original day usage", got, amount, err)
				}
			}
			if name == "next-day-restart" {
				got, err := s.dailyUsage(r.WalletID, "solana:native", s.now())
				if err != nil || got.Uint64() != 9 {
					t.Fatal("new day changed", err)
				}
			}
		})
	}
}
