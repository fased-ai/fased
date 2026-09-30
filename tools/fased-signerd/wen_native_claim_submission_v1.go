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
func (s *signerStoreV2) commitWENNativeClaimSubmissionV1(request, digest string, saved wenBudgetReservationV1, p *wenNativeClaimPreparedV1) ([]byte, error) {
	var wire []byte
	e := s.changeWENReservationV1(request, digest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		bad := errors.New("native SAT claim submission changed or already attempted")
		if p == nil || !reflect.DeepEqual(r.NativeClaimPrepared, saved.NativeClaimPrepared) || !reflect.DeepEqual(r.NativeClaimIntent, saved.NativeClaimIntent) || r.State != "signed" || r.NativeClaimPrepared == nil || r.NativeClaimIntent == nil || r.UsageDay != currentDayBucket(s.now()) || r.Signature != saved.Signature || !bytes.Equal(r.SignedMessage, saved.SignedMessage) || !bytes.Equal(p.message, r.SignedMessage) || p.review.reviewSHA != r.NativeClaimPrepared.ReviewSHA || p.wallet.String() != r.WalletPublicKey {
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
		if p.state.Allocation.Gross != r.NativeClaimPrepared.Gross || p.state.Allocation.Fee != r.NativeClaimPrepared.TransferFee || p.state.Allocation.Net != r.NativeClaimPrepared.Net || p.state.Allocation.Weight != r.NativeClaimPrepared.Weight || p.blockhash != r.NativeClaimPrepared.Blockhash || p.fee != r.NativeClaimPrepared.Fee || p.rent != r.NativeClaimPrepared.Rent || p.total != p.fee+p.rent || p.lastValidHeight != r.NativeClaimPrepared.LastValidHeight || p.state.StateHash != r.NativeClaimPrepared.StateHash || p.slot < r.NativeClaimPrepared.Slot {
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
func (s *signerStoreV2) prepareWENNativeClaimSubmissionV1(ctx context.Context, c wenStakingPrepareRPCV1, request, digest string) ([]byte, error) {
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
	if saved.Digest != digest || saved.State != "signed" || saved.NativeClaimIntent == nil || saved.NativeClaimPrepared == nil {
		return nil, errors.New("claim submission unavailable")
	}
	if _, e := wenSignedWireV1(saved, saved.SignedMessage); e != nil {
		return nil, e
	}
	p, e := preparePinnedWENNativeClaimV1(ctx, c, s.db.Path(), saved.WalletID, *saved.NativeClaimIntent, saved.NativeClaimPrepared)
	if e != nil {
		return nil, e
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	return s.commitWENNativeClaimSubmissionV1(request, digest, saved, p)
}
