package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

func wenSignedWireV1(r wenBudgetReservationV1, message []byte) ([]byte, error) {
	bad := errors.New("WEN signed wire does not match journal")
	if len(message) == 0 || len(message)+65 > 1232 || !bytes.Equal(r.SignedMessage, message) || wenHashV1(message) != r.MessageSHA256 {
		return nil, bad
	}
	if r.MiningClaimIntent != nil || r.MiningClaimPrepared != nil {
		if e := validateWENMiningClaimFenceV1(r, wenHashV1(message), r.AccountKeys, []uint64{r.MinExecutionSlot}); e != nil {
			return nil, e
		}
	}
	if r.MiningFundingIntent != nil || r.MiningFundingPrepared != nil {
		if e := validateWENMiningFundingFenceV1(r, wenHashV1(message), r.AccountKeys, []uint64{r.MinExecutionSlot}); e != nil {
			return nil, e
		}
	}
	if r.NativeClaimIntent != nil || r.NativeClaimPrepared != nil {
		if e := validateWENNativeClaimFenceV1(r, wenHashV1(message), r.AccountKeys, []uint64{r.MinExecutionSlot}); e != nil {
			return nil, e
		}
	}
	if r.BTCClaimIntent != nil || r.BTCClaimPrepared != nil {
		if e := validateWENBTCClaimFenceV1(r, wenHashV1(message), r.AccountKeys, []uint64{r.MinExecutionSlot}); e != nil {
			return nil, e
		}
	}
	if r.WithdrawalIntent != nil {
		if e := validateWENWithdrawalFenceV1(r, wenHashV1(message), r.AccountKeys, []uint64{r.MinExecutionSlot}); e != nil {
			return nil, e
		}
	}
	if r.StakingIntent != nil {
		if e := validateWENStakingFenceV1(r, wenHashV1(message), r.AccountKeys, []uint64{r.MinExecutionSlot}); e != nil {
			return nil, e
		}
	}
	pub, err := solana.PublicKeyFromBase58(r.WalletPublicKey)
	if err != nil || pub.IsZero() {
		return nil, bad
	}
	sig, err := solana.SignatureFromBase58(r.Signature)
	if err != nil || sig.String() != r.Signature || !ed25519.Verify(ed25519.PublicKey(pub[:]), message, sig[:]) {
		return nil, bad
	}
	wire := make([]byte, 65+len(message))
	wire[0] = 1
	copy(wire[1:65], sig[:])
	copy(wire[65:], message)
	return wire, nil
}

// Private, one-time submission preparation. Revalidate AFTER signature creation,
// then persist uncertainty BEFORE returning any wire bytes to the send owner.
// This function sends nothing. Crash/error after this commit cannot authorize
// release or a new signature; recovery must inspect the journaled transaction.
func (s *signerStoreV2) prepareWENSubmissionV1(ctx context.Context, client signerWENBTCPrepareRPCV1, a *signerWENBTCExecutionAdmissionV1, nowHint uint64) ([]byte, error) {
	message, err := s.revalidateWENExecutionStateV1(ctx, client, a, nowHint, "signed")
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var wire []byte
	err = s.changeWENReservationV1(a.requestID, a.reservationDigest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		if r.MiningClaimIntent != nil || r.MiningClaimPrepared != nil {
			return errors.New("mining claim requires dedicated submission revalidation")
		}
		if r.State != "signed" || r.UsageDay != currentDayBucket(s.now()) {
			return errors.New("WEN submission already attempted or stale")
		}
		var policy signerPolicyV2
		if json.Unmarshal(tx.Bucket(bucketSignerPoliciesV2).Get([]byte(r.WalletID)), &policy) != nil || policy.Hash != r.PolicyHash || policy.WalletID != r.WalletID {
			return errors.New("WEN submission policy changed")
		}
		candidate, err := wenSignedWireV1(*r, message)
		if err != nil {
			return err
		}
		r.State = "submission-uncertain"
		wire = candidate
		return nil
	})
	if err != nil {
		return nil, err
	}
	return wire, nil
}
