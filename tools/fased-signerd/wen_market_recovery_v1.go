package main

import (
	"context"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"math/big"
	"reflect"
)

// Recovery never signs or resubmits. Missing receipts retain the original hold.
func (s *signerStoreV2) recoverWENMarketV1(ctx context.Context, c signerWENBTCReconcileRPCV1, request, digest string) (string, error) {
	bad := errors.New("market finalized recovery rejected")
	if s == nil || s.db == nil || c == nil {
		return "", bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	var saved wenMarketReservationV1
	e := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return bad
		}
		return json.Unmarshal(b.Get([]byte("market-request:"+request)), &saved)
	})
	if e != nil {
		return "", e
	}
	if saved.Digest != digest || saved.Artifact.RequestID != request || (saved.State != "submission-uncertain" && saved.State != "finalized-success" && saved.State != "finalized-failed") {
		return "", bad
	}
	hash, e := saved.Artifact.digest()
	if e != nil || hash != digest {
		return "", bad
	}
	sig, e := solana.SignatureFromBase58(saved.Signature)
	if e != nil {
		return "", bad
	}
	var cash, net uint64
	result, debit, effects, e := readWENCampaignFinalizedV1(ctx, c, saved.Artifact.Policy.Successor.Genesis, sig, func(r *rpc.GetTransactionResult) (uint64, string, error) {
		fee, spent, received, hash, e := wenMarketOutcomeV1(saved, r)
		cash, net = spent, received
		return fee, hash, e
	})
	if e != nil {
		return "", e
	}
	if result == nil {
		return saved.State, nil
	}
	state := "finalized-success"
	if result.Meta.Err != nil {
		state = "finalized-failed"
	}
	e = s.db.Update(func(tx *bolt.Tx) error {
		if e := ctx.Err(); e != nil {
			return e
		}
		b := tx.Bucket(wenBudgetBucketV1)
		key := []byte("market-request:" + request)
		var r wenMarketReservationV1
		if json.Unmarshal(b.Get(key), &r) != nil || !reflect.DeepEqual(r.Artifact, saved.Artifact) || r.Digest != digest || r.Signature != saved.Signature {
			return bad
		}
		if r.OutcomeDigest != "" {
			if r.State != state || r.OutcomeDigest != effects || r.OutcomeDebit != debit || r.OutcomeSlot != result.Slot || r.OutcomeCash != cash || r.OutcomeNet != net {
				return bad
			}
			return nil
		}
		if r.State != "submission-uncertain" {
			return bad
		}
		maximum := r.Artifact.Binding.MaxFee
		scopes := wenMarketReservationScopesV1(r.Artifact)
		if !reflect.DeepEqual(scopes, r.Scopes) || r.UsageDay == "" {
			return bad
		}
		native := map[string]uint64{wenMiningNativeScopeV1(r.Artifact.WalletID, r.Artifact.Policy.Successor.Genesis): maximum, wenMarketLaunchScopeV1(r.Artifact): maximum}
		if e = settleWENCampaignNativeV1(tx, r.Artifact.WalletID, r.UsageDay, native, maximum, debit); e != nil {
			return e
		}
		if e = settleWENMarketCashV1(tx, r.Artifact, r.UsageDay, cash); e != nil {
			return e
		}

		r.State = state
		r.OutcomeDigest = effects
		r.OutcomeDebit = debit
		r.OutcomeSlot = result.Slot
		r.OutcomeCash = cash
		r.OutcomeNet = net
		raw, e := json.Marshal(r)
		if e != nil {
			return e
		}
		return b.Put(key, raw)
	})
	if e != nil {
		return "", e
	}
	return state, nil
}

func settleWENMarketCashV1(tx *bolt.Tx, a wenMarketReviewArtifactV1, day string, debit uint64) error {
	bad := errors.New("Buy cash settlement rejected")
	maximum := a.Binding.Snapshot.Quote.InputCash
	if debit > maximum || day == "" {
		return bad
	}
	release := maximum - debit
	bucket := tx.Bucket(wenBudgetBucketV1)
	key := []byte("limit:" + wenMarketCashScopeV1(a))
	var balance wenBudgetBalanceV1
	if json.Unmarshal(bucket.Get(key), &balance) != nil || balance.Reserved < maximum || balance.Reserved > balance.Limit {
		return bad
	}
	balance.Reserved -= release
	raw, e := json.Marshal(balance)
	if e != nil {
		return e
	}
	if e = bucket.Put(key, raw); e != nil {
		return e
	}
	usage := tx.Bucket(bucketSignerUsageV2)
	key = dailyUsageKeyV2(a.WalletID, a.cashAsset(), day)
	used, ok := new(big.Int).SetString(string(usage.Get(key)), 10)
	if !ok || used.Cmp(new(big.Int).SetUint64(maximum)) < 0 {
		return bad
	}
	used.Sub(used, new(big.Int).SetUint64(release))
	return usage.Put(key, []byte(used.String()))
}
