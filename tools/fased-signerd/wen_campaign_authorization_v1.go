package main

import (
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"strings"
	"time"
)

// Internal only. Consumption and the exact reserved campaign authorization commit
// together. No signature is produced here; public execution is not enabled.
func (s *signerWebAuthnServiceV2) authorizeWENCampaignV1(walletID, requestID, reservationDigest string, authorization *signerWebAuthnProofReferenceV2) error {
	if err := s.requireEnabled(); err != nil {
		return err
	}
	if authorization == nil || authorization.ProofID == "" || strings.TrimSpace(authorization.ProofID) != authorization.ProofID || len(authorization.ProofID) > 128 {
		return errors.New("campaign authorization proof required")
	}
	return s.store.db.Update(func(tx *bolt.Tx) error {
		bad := errors.New("reserved campaign does not match authorization")
		now := s.store.now().UTC()
		review, _, expected, err := loadReviewAndPolicyForAuthorizationV2(tx, walletID, requestID, now)
		if err != nil {
			return err
		}
		if review.ArtifactKind != wenCampaignArtifactKindV1 {
			return bad
		}
		retired, err := signerWalletIsRetiredInTxV2(tx, walletID)
		if err != nil {
			return err
		}
		if retired {
			return bad
		}
		var wallet signerWalletRecordV2
		if json.Unmarshal(tx.Bucket(bucketSignerWalletsV2).Get([]byte(walletID)), &wallet) != nil || wallet.PublicKey != review.WalletPublicKey {
			return bad
		}
		bucket := tx.Bucket(wenBudgetBucketV1)
		key := []byte("campaign-request:" + requestID)
		var reservation wenCampaignReservationV1
		if bucket == nil || json.Unmarshal(bucket.Get(key), &reservation) != nil || reservation.State != "reserved" || reservation.Version != 1 || reservation.Digest != reservationDigest || reservation.Artifact.WalletID != walletID || reservation.Artifact.WalletPublicKey != review.WalletPublicKey || reservation.Artifact.PolicyHash != review.PolicyHash {
			return bad
		}
		hash, err := reservation.Artifact.digest()
		if err != nil || hash != reservation.Digest || "sha256:"+hash != review.ArtifactDigest {
			return bad
		}
		proofs := tx.Bucket(bucketSignerReviewProofsV2)
		var proof signerReviewProofRecordV2
		if json.Unmarshal(proofs.Get([]byte(authorization.ProofID)), &proof) != nil || proof.ID != authorization.ProofID || !equalSignerReviewBindingV2(proof.Binding, expected) {
			return bad
		}
		_, credentialID, err := normalizeSignerWebAuthnCredentialIDV2(proof.CredentialID)
		if err != nil || tx.Bucket(bucketSignerWebAuthnCredentialsV2).Get(signerWebAuthnCredentialKeyV2(credentialID)) == nil {
			return errors.New("campaign approval credential revoked")
		}
		if reservation.Authorization != nil {
			saved := reservation.Authorization
			if saved.ProofID != proof.ID || saved.ArtifactDigest != review.ArtifactDigest || saved.AuthorizedAt == "" || proof.State != signerReviewProofConsumed || proof.ConsumedAt != saved.AuthorizedAt {
				return bad
			}
			return nil
		}
		expiry, err := time.Parse(time.RFC3339Nano, proof.ExpiresAt)
		if err != nil || !expiry.After(now) || proof.State != signerReviewProofPending {
			return errors.New("campaign proof expired or consumed")
		}
		stamp := timestampV2(now)
		proof.State = signerReviewProofConsumed
		proof.ConsumedAt = stamp
		reservation.Authorization = &wenMiningClaimAuthorizationV1{ProofID: proof.ID, ArtifactDigest: review.ArtifactDigest, AuthorizedAt: stamp}
		raw, err := json.Marshal(proof)
		if err != nil {
			return err
		}
		if err = proofs.Put([]byte(proof.ID), raw); err != nil {
			return err
		}
		raw, err = json.Marshal(reservation)
		if err != nil {
			return err
		}
		return bucket.Put(key, raw)
	})
}
