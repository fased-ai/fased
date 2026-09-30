package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"reflect"
)

// Internal atomic uncertainty commit. A future execution owner must supply
// freshly revalidated preparation pinned to the original signed message. Sends nothing.
func (s *signerStoreV2) commitWENBTCClaimSubmissionV1(request, digest string, saved wenBudgetReservationV1, p *wenBTCClaimPreparedV1) ([]byte, error) {
	var wire []byte
	e := s.changeWENReservationV1(request, digest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		bad := errors.New("BTC claim submission changed or already attempted")
		if p == nil || !reflect.DeepEqual(r.BTCClaimPrepared, saved.BTCClaimPrepared) || !reflect.DeepEqual(r.BTCClaimIntent, saved.BTCClaimIntent) || r.State != "signed" || r.BTCClaimPrepared == nil || r.BTCClaimIntent == nil || r.UsageDay != currentDayBucket(s.now()) || r.Signature != saved.Signature || !bytes.Equal(r.SignedMessage, saved.SignedMessage) || !bytes.Equal(p.message, r.SignedMessage) || p.review.reviewSHA != r.BTCClaimPrepared.ReviewSHA || p.wallet.String() != r.WalletPublicKey {
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
		if p.state.Amount != r.BTCClaimPrepared.Amount || p.state.Weight != r.BTCClaimPrepared.Weight || p.blockhash != r.BTCClaimPrepared.Blockhash || p.fee != r.BTCClaimPrepared.Fee || p.rent != r.BTCClaimPrepared.Rent || p.total != p.fee+p.rent || p.lastValidHeight != r.BTCClaimPrepared.LastValidHeight || p.state.StateHash != r.BTCClaimPrepared.StateHash || p.slot < r.BTCClaimPrepared.Slot {
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
func (s *signerStoreV2) prepareWENBTCClaimSubmissionV1(ctx context.Context, c wenStakingPrepareRPCV1, request, digest string) ([]byte, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("claim store unavailable")
	}
	var saved wenBudgetReservationV1
	if e := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return errors.New("missing claim reservation")
		}
		return json.Unmarshal(b.Get([]byte("request:"+request)), &saved)
	}); e != nil {
		return nil, e
	}
	if saved.Digest != digest || saved.State != "signed" || saved.BTCClaimIntent == nil || saved.BTCClaimPrepared == nil {
		return nil, errors.New("claim submission unavailable")
	}
	if _, e := wenSignedWireV1(saved, saved.SignedMessage); e != nil {
		return nil, e
	}
	p, e := preparePinnedWENBTCClaimV1(ctx, c, s.db.Path(), saved.WalletID, *saved.BTCClaimIntent, saved.BTCClaimPrepared)
	if e != nil {
		return nil, e
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	return s.commitWENBTCClaimSubmissionV1(request, digest, saved, p)
}
