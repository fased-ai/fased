package main

import (
	"context"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"reflect"
)

// Recovery never signs or resubmits. Missing receipts retain the original hold.
func (s *signerStoreV2) recoverWENCampaignV1(ctx context.Context, c signerWENBTCReconcileRPCV1, request, digest string) (string, error) {
	bad := errors.New("campaign finalized recovery rejected")
	if s == nil || s.db == nil || c == nil {
		return "", bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	var saved wenCampaignReservationV1
	e := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return bad
		}
		return json.Unmarshal(b.Get([]byte("campaign-request:"+request)), &saved)
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
	result, debit, effects, e := readWENCampaignFinalizedV1(ctx, c, saved.Artifact.Pins.Genesis, sig, func(r *rpc.GetTransactionResult) (uint64, string, error) { return wenCampaignOutcomeV1(saved, r) })
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
		key := []byte("campaign-request:" + request)
		var r wenCampaignReservationV1
		if json.Unmarshal(b.Get(key), &r) != nil || !reflect.DeepEqual(r.Artifact, saved.Artifact) || r.Digest != digest || r.Signature != saved.Signature {
			return bad
		}
		if r.OutcomeDigest != "" {
			if r.State != state || r.OutcomeDigest != effects || r.OutcomeDebit != debit || r.OutcomeSlot != result.Slot {
				return bad
			}
			return nil
		}
		if r.State != "submission-uncertain" {
			return bad
		}
		maximum, e := r.Artifact.debit()
		if e != nil || debit > maximum {
			return bad
		}
		scopes := map[string]uint64{wenMiningNativeScopeV1(r.Artifact.WalletID, r.Artifact.Pins.Genesis): maximum, wenCampaignLaunchScopeV1(r.Artifact): maximum}
		if !reflect.DeepEqual(scopes, r.Scopes) || r.UsageDay == "" {
			return bad
		}
		if e = settleWENCampaignNativeV1(tx, r.Artifact.WalletID, r.UsageDay, scopes, maximum, debit); e != nil {
			return e
		}
		r.State = state
		r.OutcomeDigest = effects
		r.OutcomeDebit = debit
		r.OutcomeSlot = result.Slot
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
