package main

import (
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"time"
)

// Recheck persisted approval at every transition, including restart and submit.
func validateWENCampaignConsumedApprovalV1(tx *bolt.Tx, walletID, requestID, digest, publicKey string, authorization *wenMiningClaimAuthorizationV1, now time.Time) error {
	bad := errors.New("campaign persisted authorization rejected")
	if authorization == nil {
		return bad
	}
	review, policy, binding, e := loadReviewAndPolicyForAuthorizationV2(tx, walletID, requestID, now)
	if e != nil {
		return e
	}
	if review.ArtifactDigest != "sha256:"+digest || review.WalletPublicKey != publicKey {
		return bad
	}
	retired, e := signerWalletIsRetiredInTxV2(tx, walletID)
	if e != nil {
		return e
	}
	if retired {
		return bad
	}
	var wallet signerWalletRecordV2
	if json.Unmarshal(tx.Bucket(bucketSignerWalletsV2).Get([]byte(walletID)), &wallet) != nil || wallet.PublicKey != publicKey {
		return bad
	}
	var proof signerReviewProofRecordV2
	auth := authorization
	if json.Unmarshal(tx.Bucket(bucketSignerReviewProofsV2).Get([]byte(auth.ProofID)), &proof) != nil || proof.ID != auth.ProofID || proof.State != signerReviewProofConsumed || proof.ConsumedAt != auth.AuthorizedAt || auth.AuthorizedAt == "" || auth.ArtifactDigest != review.ArtifactDigest || !equalSignerReviewBindingV2(proof.Binding, binding) {
		return bad
	}
	if proof.ApprovalMethod == "owner-control" {
		if review.ArtifactKind != wenMarketArtifactKindV1 || policy.ApprovalMode != "manual" || policy.RequirePasskey || proof.CredentialID != "" {
			return bad
		}
		return nil
	}
	if proof.ApprovalMethod == "owner-delegation" {
		if review.ArtifactKind != wenMarketArtifactKindV1 || proof.CredentialID != "" {
			return bad
		}
		return validateWENMarketDelegationV1(policy, proof.ExecutorUID, now)
	}
	if policy.ApprovalMode == "automatic" {
		return bad
	}
	if proof.ApprovalMethod != "" {
		return bad
	}
	_, id, e := normalizeSignerWebAuthnCredentialIDV2(proof.CredentialID)
	if e != nil || tx.Bucket(bucketSignerWebAuthnCredentialsV2).Get(signerWebAuthnCredentialKeyV2(id)) == nil {
		return bad
	}
	return nil
}
