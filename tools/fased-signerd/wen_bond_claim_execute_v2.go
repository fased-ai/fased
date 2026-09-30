package main

import (
	"context"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
)

type wenBondClaimExecutionRPCV2 interface {
	wenMiningPrepareRPCV1
	wenBondClaimRecoveryRPCV2
	SendRawTransactionWithOpts(context.Context, []byte, rpc.TransactionOpts) (solana.Signature, error)
}

// Internal only: loads the owner-approved artifact from protected storage.
// No caller-provided program, message or replacement blockhash is accepted.
func (s *signerServiceV2) executeWENBondClaimV2(ctx context.Context, c wenBondClaimExecutionRPCV2, auth *signerWebAuthnServiceV2, wallet, request string, proof *signerWebAuthnProofReferenceV2) (digest, state string, err error) {
	return s.executeGuardedWENBondClaimV2(ctx, c, auth, wallet, request, proof, nil)
}
func (s *signerServiceV2) executeGuardedWENBondClaimV2(ctx context.Context, c wenBondClaimExecutionRPCV2, auth *signerWebAuthnServiceV2, wallet, request string, proof *signerWebAuthnProofReferenceV2, guard func() error) (digest, state string, err error) {
	if s == nil || s.store == nil || s.keys == nil || auth == nil || auth.store != s.store || c == nil {
		return "", "", errors.New("Bond claim execution unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	var a wenBondClaimReviewArtifactV2
	err = s.store.db.View(func(tx *bolt.Tx) error {
		var review signerReviewV2
		if e := json.Unmarshal(tx.Bucket(bucketSignerReviewsV2).Get([]byte(request)), &review); e != nil {
			return e
		}
		if review.ArtifactKind != wenBondClaimArtifactKindV2 || review.WalletID != wallet {
			return errors.New("Bond review identity mismatch")
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
		return digest, "", errors.New("Bond artifact identity mismatch")
	}
	var saved *wenBondClaimReservationV2
	err = s.store.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return nil
		}
		raw := b.Get([]byte("bond-claim-request:" + request))
		if raw == nil {
			return nil
		}
		var r wenBondClaimReservationV2
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
			return digest, "", errors.New("Bond reservation identity mismatch")
		}
		state = saved.State
		if state == "submission-uncertain" || state == "finalized-success" || state == "finalized-failed" {
			state, err = s.store.recoverWENBondClaimV2(ctx, c, request, digest)
			return
		}
		if state != "reserved" && state != "signing" && state != "signed" {
			return digest, state, errors.New("Bond requires recovery; signing will not repeat")
		}
	}
	admission := func() error {
		if guard != nil {
			if e := guard(); e != nil {
				return e
			}
		}
		return loadWENCampaignDigestAdmissionV1(s.store.db.Path(), a.WalletID, digest)
	}
	if err = admission(); err != nil {
		return
	}
	b := a.Binding
	p := &wenBondClaimPreparedV2{pins: a.Pins, policy: a.Policy, maxFee: a.MaxFee, retainedLamports: a.RetainedLamports, snapshot: b.Snapshot, message: b.Message, blockhash: b.Blockhash, fee: b.Fee, units: b.Units, currentHeight: b.CurrentHeight, lastValidHeight: b.LastValidHeight}
	refresh := func() error {
		next, e := prepareWENBondClaimV2(ctx, c, a.Pins, a.Policy, a.MaxFee, a.RetainedLamports, p)
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
		reserve:   func() error { _, _, e := s.store.reserveWENBondClaimReviewV2(a); return e },
		authorize: func() error { return auth.authorizeWENBondClaimV2(wallet, request, digest, proof) },
		refresh:   refresh, admission: admission, guard: guard,
		transition: func(from, to, sig string) error {
			return s.store.transitionWENBondClaimSigningV2(wallet, request, digest, p, from, to, sig)
		},
		commit:      func() ([]byte, error) { return s.store.commitWENBondClaimSubmissionV2(wallet, request, digest, p) },
		recover:     func() (string, error) { return s.store.recoverWENBondClaimV2(ctx, c, request, digest) },
		message:     func() []byte { return p.message },
		minimumSlot: func() uint64 { return p.snapshot.ReferenceSlot },
		send:        c.SendRawTransactionWithOpts,
	})
}
