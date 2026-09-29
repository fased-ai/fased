package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"reflect"
)

// Internal atomic uncertainty commit. The execution owner supplies
// freshly revalidated preparation pinned to the original signed message. Sends nothing.
func (s *signerStoreV2) commitWENMiningFundingSubmissionV1(request, digest string, saved wenBudgetReservationV1, p *wenMiningFundingPreparedV1) ([]byte, error) {
	var wire []byte
	e := s.changeWENReservationV1(request, digest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		bad := errors.New("mining funding submission changed or already attempted")
		if p == nil || !reflect.DeepEqual(r.MiningFundingPrepared, saved.MiningFundingPrepared) || !reflect.DeepEqual(r.MiningFundingIntent, saved.MiningFundingIntent) || r.State != "signed" || r.MiningFundingPrepared == nil || r.MiningFundingIntent == nil || r.UsageDay != currentDayBucket(s.now()) || r.Signature != saved.Signature || !bytes.Equal(r.SignedMessage, saved.SignedMessage) || !bytes.Equal(p.message, r.SignedMessage) || p.review.reviewSHA != r.MiningFundingPrepared.ReviewSHA || p.wallet.String() != r.WalletPublicKey {
			return bad
		}
		retired, e := signerWalletIsRetiredInTxV2(tx, r.WalletID)
		if e != nil {
			return e
		}
		if retired {
			return bad
		}
		var policy signerPolicyV2
		if json.Unmarshal(tx.Bucket(bucketSignerPoliciesV2).Get([]byte(r.WalletID)), &policy) != nil || policy.WalletID != r.WalletID || policy.Hash != r.PolicyHash {
			return bad
		}
		if p.blockhash != r.MiningFundingPrepared.Blockhash || p.fee != r.MiningFundingPrepared.Fee || p.rent != r.MiningFundingPrepared.Rent || p.total != p.fee+p.rent || p.lastValidHeight != r.MiningFundingPrepared.LastValidHeight || p.state.StateHash != r.MiningFundingPrepared.StateHash || p.slot < r.MiningFundingPrepared.Slot {
			return bad
		}
		candidate, e := wenSignedWireV1(*r, r.SignedMessage)
		if e != nil {
			return e
		}
		r.State = "submission-uncertain"
		wire = candidate
		return nil
	})
	if e != nil {
		return nil, e
	}
	return wire, nil
}

// Revalidate the original signed bytes against current protected review and state.
// Never replaces the blockhash, signs, or sends a transaction.
func (s *signerStoreV2) prepareWENMiningFundingSubmissionV1(ctx context.Context, c wenMiningPrepareRPCV1, request, digest string) ([]byte, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("funding store unavailable")
	}
	var saved wenBudgetReservationV1
	if e := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return errors.New("missing funding reservation")
		}
		return json.Unmarshal(b.Get([]byte("request:"+request)), &saved)
	}); e != nil {
		return nil, e
	}
	if saved.Digest != digest || saved.State != "signed" || saved.MiningFundingIntent == nil || saved.MiningFundingPrepared == nil {
		return nil, errors.New("funding submission unavailable")
	}
	if _, e := wenSignedWireV1(saved, saved.SignedMessage); e != nil {
		return nil, e
	}
	p, e := preparePinnedWENMiningFundingV1(ctx, c, s.db.Path(), saved.WalletID, *saved.MiningFundingIntent, saved.MiningFundingPrepared)
	if e != nil {
		return nil, e
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	return s.commitWENMiningFundingSubmissionV1(request, digest, saved, p)
}
