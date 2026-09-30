package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"reflect"
)

// Revalidates the original blockhash/message, never constructs a replacement.
func (s *signerStoreV2) prepareWENWithdrawalSubmissionV1(ctx context.Context, c wenMiningPrepareRPCV1, request, digest string) ([]byte, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("withdrawal store unavailable")
	}
	var saved wenBudgetReservationV1
	if e := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return errors.New("missing reservation")
		}
		return json.Unmarshal(b.Get([]byte("request:"+request)), &saved)
	}); e != nil {
		return nil, e
	}
	if saved.Digest != digest || saved.State != "signed" || saved.WithdrawalIntent == nil || saved.WithdrawalPrepared == nil {
		return nil, errors.New("withdrawal submission unavailable")
	}
	if _, e := wenSignedWireV1(saved, saved.SignedMessage); e != nil {
		return nil, e
	}
	p, e := preparePinnedWENWithdrawalV1(ctx, c, s.db.Path(), saved.WalletID, *saved.WithdrawalIntent, saved.WithdrawalPrepared)
	if e != nil {
		return nil, e
	}
	if p.wallet.String() != saved.WalletPublicKey || !bytes.Equal(p.message, saved.SignedMessage) || p.review.reviewSHA != saved.WithdrawalPrepared.ReviewSHA {
		return nil, errors.New("withdrawal submission changed")
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	return s.commitWENWithdrawalSubmissionV1(request, digest, saved, p)
}

// Internal transaction step; only the preceding full revalidation supplies p.
func (s *signerStoreV2) commitWENWithdrawalSubmissionV1(request, digest string, saved wenBudgetReservationV1, p *wenWithdrawalPreparedV1) ([]byte, error) {
	var wire []byte
	e := s.changeWENReservationV1(request, digest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		bad := errors.New("withdrawal submission changed or already attempted")
		if p == nil || !reflect.DeepEqual(r.WithdrawalPrepared, saved.WithdrawalPrepared) || !reflect.DeepEqual(r.WithdrawalIntent, saved.WithdrawalIntent) || r.State != "signed" || r.WithdrawalPrepared == nil || r.WithdrawalIntent == nil || r.UsageDay != currentDayBucket(s.now()) || r.Signature != saved.Signature || !bytes.Equal(r.SignedMessage, saved.SignedMessage) || !bytes.Equal(p.message, r.SignedMessage) || p.review.reviewSHA != r.WithdrawalPrepared.ReviewSHA || p.wallet.String() != r.WalletPublicKey {
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
