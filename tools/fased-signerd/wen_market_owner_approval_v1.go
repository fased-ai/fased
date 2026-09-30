package main

import (
	"encoding/json"
	"errors"
	"time"

	bolt "go.etcd.io/bbolt"
)

// The caller is the control-only admin dispatcher. Application requests cannot
// issue this proof. It authorizes one exact review, never an arbitrary packet.
func (s *signerServiceV2) ownerApproveWENMarketV1(wallet string, body wenMarketAdmissionInstallRequestV1) (signerWebAuthnProofReferenceV2, error) {
	var result signerWebAuthnProofReferenceV2
	if s == nil || s.store == nil || s.store.db == nil || !wenReservationHashV1(body.ExpectedSHA256) {
		return result, errors.New("invalid owner confirmation")
	}
	err := s.store.db.Update(func(tx *bolt.Tx) error {
		now := s.store.now().UTC()
		review, policy, binding, err := loadReviewAndPolicyForAuthorizationV2(tx, wallet, body.RequestID, now)
		if err != nil {
			return err
		}
		if policy.ApprovalMode != "manual" || policy.RequirePasskey || review.ArtifactKind != wenMarketArtifactKindV1 || review.ArtifactDigest != "sha256:"+body.ExpectedSHA256 {
			return errors.New("owner confirmation does not match manual policy and review")
		}
		retired, err := signerWalletIsRetiredInTxV2(tx, wallet)
		if err != nil {
			return err
		}
		if retired {
			return errors.New("retired wallet cannot be approved")
		}
		expires, err := time.Parse(time.RFC3339Nano, binding.ExpiresAt)
		if err != nil {
			return err
		}
		if ceiling := now.Add(30 * time.Second); expires.After(ceiling) {
			expires = ceiling
		}
		id, err := randomBase64URLV2(32)
		if err != nil {
			return err
		}
		proof := signerReviewProofRecordV2{ID: id, State: signerReviewProofPending, Binding: binding, ApprovalMethod: "owner-control", AuthorizedAt: timestampV2(now), ExpiresAt: timestampV2(expires)}
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

// Inspection cannot create or consume authority. Possession of the unpredictable
// handle is required, and the current policy/review must still match.
func (s *signerServiceV2) inspectOwnerWENMarketProofV1(wallet string, requestID string, proofID string) (map[string]string, error) {
	var result map[string]string
	if s == nil || s.store == nil || s.store.db == nil || len(proofID) != 43 {
		return nil, errors.New("owner approval unavailable")
	}
	err := s.store.db.View(func(tx *bolt.Tx) error {
		now := s.store.now().UTC()
		review, policy, binding, err := loadReviewAndPolicyForAuthorizationV2(tx, wallet, requestID, now)
		if err != nil {
			return err
		}
		retired, err := signerWalletIsRetiredInTxV2(tx, wallet)
		if err != nil {
			return err
		}
		if retired {
			return errors.New("retired wallet cannot be approved")
		}
		var proof signerReviewProofRecordV2
		if json.Unmarshal(tx.Bucket(bucketSignerReviewProofsV2).Get([]byte(proofID)), &proof) != nil || proof.ID != proofID || proof.ApprovalMethod != "owner-control" || proof.CredentialID != "" || proof.State != signerReviewProofPending || !equalSignerReviewBindingV2(proof.Binding, binding) || review.ArtifactKind != wenMarketArtifactKindV1 || policy.ApprovalMode != "manual" || policy.RequirePasskey {
			return errors.New("owner approval changed")
		}
		expiry, err := time.Parse(time.RFC3339Nano, proof.ExpiresAt)
		if err != nil || !expiry.After(now) {
			return errors.New("owner approval expired")
		}
		result = map[string]string{"proofId": proof.ID, "requestId": review.RequestID, "walletId": review.WalletID, "artifactDigest": review.ArtifactDigest, "expiresAt": proof.ExpiresAt}
		return nil
	})
	return result, err
}
