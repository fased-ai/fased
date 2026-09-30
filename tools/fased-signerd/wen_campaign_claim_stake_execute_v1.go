package main

import (
	"context"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
)

type wenCampaignClaimStakeExecutionRPCV1 interface {
	wenStakingPrepareRPCV1
	signerWENBTCReconcileRPCV1
	SendRawTransactionWithOpts(context.Context, []byte, rpc.TransactionOpts) (solana.Signature, error)
}

// Internal only: loads the owner-approved artifact from protected storage.
// No caller-provided program, message or replacement blockhash is accepted.
func (s *signerServiceV2) executeWENCampaignClaimStakeV1(ctx context.Context, c wenCampaignClaimStakeExecutionRPCV1, auth *signerWebAuthnServiceV2, wallet, request string, proof *signerWebAuthnProofReferenceV2) (digest, state string, err error) {
	return s.executeGuardedWENCampaignClaimStakeV1(ctx, c, auth, wallet, request, proof, nil)
}
func (s *signerServiceV2) executeGuardedWENCampaignClaimStakeV1(ctx context.Context, c wenCampaignClaimStakeExecutionRPCV1, auth *signerWebAuthnServiceV2, wallet, request string, proof *signerWebAuthnProofReferenceV2, guard func() error) (digest, state string, err error) {
	if s == nil || s.store == nil || s.keys == nil || auth == nil || auth.store != s.store || c == nil {
		return "", "", errors.New("campaign execution unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	var a wenCampaignClaimStakeReviewV1
	err = s.store.db.View(func(tx *bolt.Tx) error {
		var review signerReviewV2
		if e := json.Unmarshal(tx.Bucket(bucketSignerReviewsV2).Get([]byte(request)), &review); e != nil {
			return e
		}
		if review.ArtifactKind != wenCampaignClaimStakeArtifactKindV1 || review.WalletID != wallet {
			return errors.New("campaign review identity mismatch")
		}
		return decodeSignerAdminStrictJSON(review.SemanticIntent, &a)
	})
	if err != nil {
		return
	}
	digest, err = a.digest()
	if err != nil {
		return
	}
	if a.RequestID != request || a.WalletID != wallet {
		return digest, "", errors.New("campaign artifact identity mismatch")
	}
	var saved *wenCampaignClaimStakeReservationV1
	err = s.store.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return nil
		}
		raw := b.Get([]byte("campaign-stake-request:" + request))
		if raw == nil {
			return nil
		}
		var r wenCampaignClaimStakeReservationV1
		if e := json.Unmarshal(raw, &r); e != nil {
			return e
		}
		saved = &r
		return nil
	})
	if err != nil {
		return
	}
	if saved != nil {
		if saved.Digest != digest {
			return digest, "", errors.New("campaign reservation identity mismatch")
		}
		state = saved.State
		if state == "submission-uncertain" || state == "finalized-success" || state == "finalized-failed" {
			state, err = s.store.recoverWENCampaignClaimStakeV1(ctx, c, request, digest)
			return
		}
		if state != "reserved" && state != "signing" && state != "signed" {
			return digest, state, errors.New("campaign requires recovery; signing will not repeat")
		}
	}
	admission := func() error {
		if guard != nil {
			if e := guard(); e != nil {
				return e
			}
		}
		return loadWENCampaignDigestAdmissionV1(s.store.db.Path(), wallet, digest)
	}
	if err = admission(); err != nil {
		return
	}
	var p *wenCampaignClaimStakePreparedV1
	owner := solana.MustPublicKeyFromBase58(a.WalletPublicKey)
	refresh := func() error {
		next, e := revalidateWENCampaignClaimStakeReviewV1(ctx, c, a, digest, owner, 32)
		if e == nil {
			p = next
		}
		return e
	}
	return s.runWENCampaignExecutionV1(ctx, wallet, digest, state, wenCampaignExecutionFlowV1{
		publicKey: a.WalletPublicKey,
		signature: func() string {
			if saved != nil {
				return saved.Signature
			}
			return ""
		}(),
		reserve:   func() error { _, _, e := s.store.reserveWENCampaignClaimStakeReviewV1(a); return e },
		authorize: func() error { return auth.authorizeWENCampaignClaimStakeV1(wallet, request, digest, proof) },
		refresh:   refresh, admission: admission, guard: guard,
		transition: func(from, to, sig string) error {
			return s.store.transitionWENCampaignClaimStakeSigningV1(wallet, request, digest, p, from, to, sig)
		},
		commit: func() ([]byte, error) {
			return s.store.commitWENCampaignClaimStakeSubmissionV1(wallet, request, digest, p)
		},
		recover:     func() (string, error) { return s.store.recoverWENCampaignClaimStakeV1(ctx, c, request, digest) },
		message:     func() []byte { return p.message },
		minimumSlot: func() uint64 { return p.snapshot.Claim.ReferenceSlot },
		send:        c.SendRawTransactionWithOpts,
	})
}
