package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

func validateReviewPolicyV2(policy signerPolicyV2, intent normalizedIntentV2) error {
	if !containsStringV2(policy.Operations, intent.Intent.Type) {
		return fmt.Errorf("policy denies operation %s", intent.Intent.Type)
	}
	for _, program := range intent.RequiredPrograms {
		if !containsStringV2(policy.Programs, program) {
			return fmt.Errorf("policy denies program %s", program)
		}
	}
	if intent.CapExempt {
		return nil
	}
	_, err := policyAssetForIntentV2(policy, intent)
	return err
}

func (s *signerStoreV2) prepareReviewV2(
	walletID string,
	req signerReviewPrepareRequestV2,
	intent normalizedIntentV2,
	transaction signerSolanaTransactionEnvelopeV2,
	transactionDigest string,
) (signerReviewV2, error) {
	if s == nil || s.db == nil {
		return signerReviewV2{}, errors.New("signer state database is unavailable")
	}
	requestID, err := validateRequestIDV2(req.RequestID)
	if err != nil {
		return signerReviewV2{}, err
	}
	walletID = normalizeWalletID(walletID)
	mode, err := normalizeReviewModeV2(req.Mode)
	if err != nil {
		return signerReviewV2{}, err
	}
	transaction, err = normalizeTransactionEnvelopeV2(transaction)
	if err != nil {
		return signerReviewV2{}, err
	}
	transactionDigest, err = normalizeSHA256DigestV2(transactionDigest, "transactionDigest")
	if err != nil {
		return signerReviewV2{}, err
	}
	var review signerReviewV2
	semanticIntent, err := json.Marshal(intent.Intent)
	if err != nil {
		return signerReviewV2{}, err
	}
	nonceBytes := make([]byte, 32)
	if _, err := rand.Read(nonceBytes); err != nil {
		return signerReviewV2{}, errors.New("generate signer review nonce")
	}
	nonce := hex.EncodeToString(nonceBytes)
	err = s.db.Update(func(tx *bolt.Tx) error {
		reviews := tx.Bucket(bucketSignerReviewsV2)
		if raw := reviews.Get([]byte(requestID)); raw != nil {
			if err := json.Unmarshal(raw, &review); err != nil {
				return fmt.Errorf("decode signer review: %w", err)
			}
			if review.WalletID != walletID ||
				review.IntentDigest != intent.Digest ||
				review.PolicyHash != strings.TrimSpace(req.PolicyHash) ||
				review.Mode != mode ||
				review.TransactionDigest != transactionDigest ||
				!equalTransactionEnvelopeV2(review.Transaction, transaction) {
				return errors.New("requestId is already bound to a different immutable signer review")
			}
			if review.State != jupiterReviewPreparedV2 {
				return fmt.Errorf("signer review is already %s", review.State)
			}
			return nil
		}

		rawPolicy := tx.Bucket(bucketSignerPoliciesV2).Get([]byte(walletID))
		if rawPolicy == nil {
			return errors.New("explicit signer policy required")
		}
		var policy signerPolicyV2
		if err := json.Unmarshal(rawPolicy, &policy); err != nil {
			return fmt.Errorf("decode signer policy: %w", err)
		}
		if strings.TrimSpace(req.PolicyHash) == "" || req.PolicyHash != policy.Hash {
			return errors.New("signer policy hash mismatch")
		}
		if mode == jupiterReviewModeAutonomousV2 && policy.Role != "agent" {
			return errors.New("autonomous signer review is restricted to Agent-role wallets")
		}
		if err := validateReviewPolicyV2(policy, intent); err != nil {
			return err
		}
		now := s.now()
		issuedAt := timestampV2(now)
		review = signerReviewV2{
			RequestID:         requestID,
			WalletID:          walletID,
			IntentType:        intent.Intent.Type,
			IntentDigest:      intent.Digest,
			PolicyHash:        policy.Hash,
			Mode:              mode,
			Nonce:             nonce,
			SemanticIntent:    semanticIntent,
			Transaction:       transaction,
			IssuedAt:          issuedAt,
			State:             jupiterReviewPreparedV2,
			PreparedAt:        issuedAt,
			ExpiresAt:         timestampV2(reviewExpiryV2(now)),
			UpdatedAt:         timestampV2(now),
			TransactionDigest: transactionDigest,
		}
		encoded, err := json.Marshal(review)
		if err != nil {
			return err
		}
		return reviews.Put([]byte(requestID), encoded)
	})
	return review, err
}

func equalTransactionEnvelopeV2(left, right signerSolanaTransactionEnvelopeV2) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && string(leftJSON) == string(rightJSON)
}

func (s *signerStoreV2) requirePreparedReviewV2(walletID, requestID string) (signerReviewV2, normalizedIntentV2, signerPolicyV2, error) {
	if s == nil || s.db == nil {
		return signerReviewV2{}, normalizedIntentV2{}, signerPolicyV2{}, errors.New("signer state database is unavailable")
	}
	requestID, err := validateRequestIDV2(requestID)
	if err != nil {
		return signerReviewV2{}, normalizedIntentV2{}, signerPolicyV2{}, err
	}
	walletID = normalizeWalletID(walletID)
	var review signerReviewV2
	var intent normalizedIntentV2
	var policy signerPolicyV2
	err = s.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSignerReviewsV2).Get([]byte(requestID))
		if raw == nil {
			return errors.New("signer review not found; review.prepare is required")
		}
		if err := json.Unmarshal(raw, &review); err != nil {
			return fmt.Errorf("decode signer review: %w", err)
		}
		if review.WalletID != walletID {
			return errors.New("signer review wallet mismatch")
		}
		if review.State != jupiterReviewPreparedV2 {
			return fmt.Errorf("signer review is already %s; transaction will not be signed again", review.State)
		}
		expiresAt, err := time.Parse(time.RFC3339Nano, review.ExpiresAt)
		if err != nil || !s.now().Before(expiresAt) {
			return errors.New("signer review expired; prepare a fresh review")
		}
		rawPolicy := tx.Bucket(bucketSignerPoliciesV2).Get([]byte(walletID))
		if rawPolicy == nil {
			return errors.New("explicit signer policy required")
		}
		if err := json.Unmarshal(rawPolicy, &policy); err != nil {
			return err
		}
		if policy.Hash != review.PolicyHash {
			return errors.New("prepared signer review policy is no longer current")
		}
		var storedIntent signerIntentV2
		if err := json.Unmarshal(review.SemanticIntent, &storedIntent); err != nil {
			return errors.New("stored signer review semantic intent is invalid")
		}
		intent, err = normalizeSignerIntentV2(storedIntent)
		if err != nil || intent.Digest != review.IntentDigest || intent.Intent.Type != review.IntentType {
			return errors.New("stored signer review semantic intent is inconsistent")
		}
		if _, err := normalizeTransactionEnvelopeV2(review.Transaction); err != nil {
			return errors.New("stored signer review transaction envelope is invalid")
		}
		if _, err := normalizeSHA256DigestV2(review.TransactionDigest, "transactionDigest"); err != nil {
			return errors.New("stored signer review transaction digest is invalid")
		}
		return validateReviewPolicyV2(policy, intent)
	})
	return review, intent, policy, err
}

func (s *signerStoreV2) markReviewSignedV2(requestID, transactionDigest, signature string) (signerReviewV2, error) {
	if s == nil || s.db == nil {
		return signerReviewV2{}, errors.New("signer state database is unavailable")
	}
	var review signerReviewV2
	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSignerReviewsV2)
		raw := bucket.Get([]byte(requestID))
		if raw == nil {
			return errors.New("signer review not found")
		}
		if err := json.Unmarshal(raw, &review); err != nil {
			return err
		}
		if review.State != jupiterReviewPreparedV2 {
			return fmt.Errorf("cannot sign review in state %s", review.State)
		}
		if review.TransactionDigest != transactionDigest || strings.TrimSpace(signature) == "" {
			return errors.New("signed review requires transaction digest and signature")
		}
		review.State = jupiterReviewSignedV2
		review.Signature = strings.TrimSpace(signature)
		review.UpdatedAt = timestampV2(s.now())
		encoded, err := json.Marshal(review)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(requestID), encoded)
	})
	return review, err
}
