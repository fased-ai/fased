package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"reflect"
	"strconv"
)

// Internal atomic uncertainty commit. The execution owner supplies
// freshly revalidated preparation pinned to the original signed message. Sends nothing.
func (s *signerStoreV2) commitWENMiningClaimSubmissionV1(request, digest string, saved wenBudgetReservationV1, p *wenMiningClaimPreparedV1) ([]byte, error) {
	var wire []byte
	e := s.changeWENReservationV1(request, digest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		bad := errors.New("mining claim submission changed or already attempted")
		if p == nil || !reflect.DeepEqual(r.MiningClaimPrepared, saved.MiningClaimPrepared) || !reflect.DeepEqual(r.MiningClaimIntent, saved.MiningClaimIntent) || r.State != "signed" || r.MiningClaimPrepared == nil || r.MiningClaimIntent == nil || r.UsageDay != currentDayBucket(s.now()) || r.Signature != saved.Signature || !bytes.Equal(r.SignedMessage, saved.SignedMessage) || !bytes.Equal(p.message, r.SignedMessage) || p.review.reviewSHA != r.MiningClaimPrepared.ReviewSHA || p.wallet.String() != r.WalletPublicKey {
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
		if p.blockhash != r.MiningClaimPrepared.Blockhash || p.fee != r.MiningClaimPrepared.Fee || p.rent != r.MiningClaimPrepared.Rent || p.total != p.fee+p.rent || p.lastValidHeight != r.MiningClaimPrepared.LastValidHeight || p.state.StateHash != r.MiningClaimPrepared.StateHash || p.slot < r.MiningClaimPrepared.Slot {
			return bad
		}
		expiry, _ := strconv.ParseUint(r.MiningClaimIntent.ExpiresSlot, 10, 64)
		if p.slot >= expiry || p.currentHeight >= p.lastValidHeight {
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
func (s *signerStoreV2) prepareWENMiningClaimSubmissionV1(ctx context.Context, c wenMiningPrepareRPCV1, request, digest string) ([]byte, error) {
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
	if saved.Digest != digest || saved.State != "signed" || saved.MiningClaimIntent == nil || saved.MiningClaimPrepared == nil {
		return nil, errors.New("claim submission unavailable")
	}
	if _, e := wenSignedWireV1(saved, saved.SignedMessage); e != nil {
		return nil, e
	}
	p, e := preparePinnedWENMiningClaimV1(ctx, c, s.db.Path(), saved.WalletID, *saved.MiningClaimIntent, saved.MiningClaimPrepared)
	if e != nil {
		return nil, e
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	return s.commitWENMiningClaimSubmissionV1(request, digest, saved, p)
}
