package main

import (
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"time"
)

// Delegation authorizes only protected admitted Buy reviews. It cannot install
// drafts, admission, custody or budgets, nor authorize arbitrary signing.
func validateWENMarketDelegationV1(policy signerPolicyV2, uid uint32, now time.Time) error {
	if policy.ApprovalMode != "automatic" || policy.RequirePasskey || policy.Delegation == nil || uid == 0 || policy.Delegation.ExecutorUID != uid {
		return errors.New("automatic executor not delegated")
	}
	start, startErr := time.Parse(time.RFC3339Nano, policy.Delegation.NotBefore)
	expiry, err := time.Parse(time.RFC3339Nano, policy.Delegation.ExpiresAt)
	if err != nil || startErr != nil || now.Before(start) || !expiry.After(now) || !expiry.After(start) || expiry.Sub(start) > 24*time.Hour {
		return errors.New("delegation expired or exceeds 24 hours")
	}
	return nil
}
func (s *signerServiceV2) delegatedWENMarketProofV1(req request, requestID string) (signerWebAuthnProofReferenceV2, error) {
	var result signerWebAuthnProofReferenceV2
	if req.applicationPeerUID == nil || req.operatorSocket || s == nil || s.store == nil {
		return result, errors.New("authenticated application executor required")
	}
	err := s.store.db.Update(func(tx *bolt.Tx) error {
		now := s.store.now().UTC()
		review, policy, binding, err := loadReviewAndPolicyForAuthorizationV2(tx, req.WalletID, requestID, now)
		if err != nil {
			return err
		}
		if err := validateWENMarketDelegationV1(policy, *req.applicationPeerUID, now); err != nil {
			return err
		}
		if review.ArtifactKind != wenMarketArtifactKindV1 || review.PolicyOperation != wenMarketOperationV1 {
			return errors.New("delegation cannot approve another operation")
		}
		retired, err := signerWalletIsRetiredInTxV2(tx, req.WalletID)
		if err != nil {
			return err
		}
		if retired {
			return errors.New("retired wallet")
		}
		expiry, err := time.Parse(time.RFC3339Nano, binding.ExpiresAt)
		if err != nil {
			return err
		}
		ceiling, _ := time.Parse(time.RFC3339Nano, policy.Delegation.ExpiresAt)
		if expiry.After(ceiling) {
			expiry = ceiling
		}
		id, err := randomBase64URLV2(32)
		if err != nil {
			return err
		}
		proof := signerReviewProofRecordV2{ID: id, State: signerReviewProofPending, Binding: binding, ApprovalMethod: "owner-delegation", ExecutorUID: *req.applicationPeerUID, AuthorizedAt: timestampV2(now), ExpiresAt: timestampV2(expiry)}
		raw, err := json.Marshal(proof)
		if err != nil {
			return err
		}
		if err := tx.Bucket(bucketSignerReviewProofsV2).Put([]byte(id), raw); err != nil {
			return err
		}
		result.ProofID = id
		return nil
	})
	return result, err
}
