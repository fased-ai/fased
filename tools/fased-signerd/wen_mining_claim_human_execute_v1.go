package main

import (
	"context"
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"strings"
)

// Internal candidate only. The review and digest come from protected storage,
// never from the caller's unsigned presentation. No public dispatch is enabled.
func (s *signerServiceV2) executeHumanReviewedWENMiningClaimV1(ctx context.Context, c wenMiningClaimExecutionRPCV1, walletID, requestID string, webauthn *signerWebAuthnServiceV2, proof *signerWebAuthnProofReferenceV2, guard func() error) (string, string, error) {
	if s == nil || s.store == nil || s.keys == nil || webauthn == nil || webauthn.store != s.store || proof == nil {
		return "", "", errors.New("claim approval service unavailable")
	}
	authorization := *proof
	var review signerReviewV2
	err := s.store.db.View(func(tx *bolt.Tx) error {
		var err error
		review, _, _, err = loadReviewAndPolicyForAuthorizationV2(tx, walletID, requestID, s.store.now().UTC())
		return err
	})
	if err != nil {
		return "", "", err
	}
	if review.IntentType != intentWENMiningClaimV1 {
		return "", "", errors.New("not a WEN claim review")
	}
	var artifact wenMiningClaimReviewArtifactV1
	if err = json.Unmarshal(review.SemanticIntent, &artifact); err != nil {
		return "", "", err
	}
	return s.executeMiningClaimAuthorizationBoundaryV1(ctx, c, requestID, walletID, review.PolicyHash, artifact.Intent, guard, &artifact, strings.TrimPrefix(review.ArtifactDigest, "sha256:"), func(digest string) error {
		return webauthn.authorizeWENMiningClaimV1(walletID, requestID, digest, &authorization)
	})
}

// Configured candidate boundary: the application cannot choose an RPC endpoint
// or provide replacement intent bytes. All identity guards remain active.
func (s *signerServiceV2) executeConfiguredHumanWENMiningClaimV1(ctx context.Context, cfg signerConfig, walletID, requestID string, webauthn *signerWebAuthnServiceV2, proof *signerWebAuthnProofReferenceV2, factory func(string) wenMiningClaimExecutionRPCV1) (string, string, error) {
	if s == nil || s.store == nil || s.keys == nil || cfg.readOnly || cfg.stateDBPath != s.store.db.Path() || webauthn == nil || webauthn.store != s.store || proof == nil {
		return "", "", errors.New("configured claim approval unavailable")
	}
	var review signerReviewV2
	err := s.store.db.View(func(tx *bolt.Tx) error {
		var err error
		review, _, _, err = loadReviewAndPolicyForAuthorizationV2(tx, walletID, requestID, s.store.now().UTC())
		return err
	})
	if err != nil {
		return "", "", err
	}
	if review.IntentType != intentWENMiningClaimV1 {
		return "", "", errors.New("not a claim review")
	}
	var artifact wenMiningClaimReviewArtifactV1
	if err = json.Unmarshal(review.SemanticIntent, &artifact); err != nil {
		return "", "", err
	}
	return s.withConfiguredMiningClaimV1(ctx, cfg, walletID, artifact.Intent, factory, func(client wenMiningClaimExecutionRPCV1, _ string, guard func() error) (string, string, error) {
		return s.executeHumanReviewedWENMiningClaimV1(ctx, client, walletID, requestID, webauthn, proof, guard)
	})
}
