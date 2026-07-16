package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

type signerReviewArtifactInputV2 struct {
	WalletPublicKey string
	Kind            string
	Digest          string
	Transaction     *signerSolanaTransactionEnvelopeV2
	MessageBase64   string
	StateDigest     string
	StateSlot       uint64
}

func validateReviewPolicyV2(policy signerPolicyV2, intent normalizedIntentV2) error {
	if len(policy.Operations) == 0 {
		return errors.New("policy operations are empty; signing is denied")
	}
	if len(policy.Programs) == 0 {
		return errors.New("policy programs are empty; signing is denied")
	}
	if len(intent.RequiredPrograms) == 0 {
		return errors.New("intent has no explicit required program or signer domain")
	}
	operation := intent.PolicyOperation
	if operation == "" {
		operation = intent.Intent.Type
	}
	if !containsStringV2(policy.Operations, operation) {
		return fmt.Errorf("policy denies operation %s", operation)
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
	return s.prepareArtifactReviewV2(walletID, req, intent, signerReviewArtifactInputV2{
		Kind: signerReviewArtifactSolanaTransactionV2, Digest: transactionDigest,
		Transaction: &transaction,
	})
}

func normalizeReviewArtifactInputV2(input signerReviewArtifactInputV2) (signerReviewArtifactInputV2, error) {
	input.WalletPublicKey = strings.TrimSpace(input.WalletPublicKey)
	if input.WalletPublicKey != "" {
		wallet, err := normalizePublicKeyV2(input.WalletPublicKey, "review wallet public key")
		if err != nil {
			return input, err
		}
		input.WalletPublicKey = wallet
	}
	var err error
	input.Digest, err = normalizeSHA256DigestV2(input.Digest, "artifactDigest")
	if err != nil {
		return input, err
	}
	switch input.Kind {
	case signerReviewArtifactSolanaTransactionV2:
		if input.Transaction == nil || input.MessageBase64 != "" {
			return input, errors.New("Solana transaction review requires exactly one transaction artifact")
		}
		normalized, err := normalizeTransactionEnvelopeV2(*input.Transaction)
		if err != nil {
			return input, err
		}
		input.Transaction = &normalized
	case signerReviewArtifactDomainMessageV2:
		if input.Transaction != nil || strings.TrimSpace(input.MessageBase64) == "" {
			return input, errors.New("domain message review requires exactly one message artifact")
		}
		message, err := base64.StdEncoding.Strict().DecodeString(input.MessageBase64)
		if err != nil || len(message) == 0 || base64.StdEncoding.EncodeToString(message) != input.MessageBase64 {
			return input, errors.New("domain message artifact must be canonical non-empty base64")
		}
		digest := sha256.Sum256(message)
		if input.Digest != "sha256:"+hex.EncodeToString(digest[:]) {
			return input, errors.New("domain message artifact digest mismatch")
		}
	default:
		return input, errors.New("unsupported signer review artifact kind")
	}
	if strings.TrimSpace(input.StateDigest) != "" {
		input.StateDigest, err = normalizeSHA256DigestV2(input.StateDigest, "stateDigest")
		if err != nil {
			return input, err
		}
	} else if input.StateSlot != 0 {
		return input, errors.New("review state slot requires an exact state digest")
	}
	return input, nil
}

func (s *signerStoreV2) prepareArtifactReviewV2(
	walletID string,
	req signerReviewPrepareRequestV2,
	intent normalizedIntentV2,
	artifact signerReviewArtifactInputV2,
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
	artifact, err = normalizeReviewArtifactInputV2(artifact)
	if err != nil {
		return signerReviewV2{}, err
	}
	if intent.PolicyOperation == "" {
		intent.PolicyOperation = intent.Intent.Type
	}
	if intent.Amount == nil || intent.Amount.Sign() <= 0 || strings.TrimSpace(intent.Asset) == "" ||
		strings.TrimSpace(intent.Destination) == "" || len(intent.RequiredPrograms) == 0 {
		return signerReviewV2{}, errors.New("reviewed intent accounting or signer domain is incomplete")
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
				review.WalletPublicKey != artifact.WalletPublicKey ||
				review.IntentDigest != intent.Digest ||
				review.PolicyHash != strings.TrimSpace(req.PolicyHash) ||
				review.Mode != mode ||
				review.ArtifactKind != artifact.Kind ||
				review.ArtifactDigest != artifact.Digest ||
				review.MessageBase64 != artifact.MessageBase64 ||
				review.StateDigest != artifact.StateDigest || review.StateSlot != artifact.StateSlot ||
				review.Asset != intent.Asset || review.Amount != intent.Amount.String() ||
				review.Destination != intent.Destination || review.PolicyOperation != intent.PolicyOperation ||
				review.RequiredRole != intent.RequiredRole ||
				!equalSortedStringsV2(review.RequiredPrograms, intent.RequiredPrograms) ||
				!equalOptionalTransactionEnvelopeV2(review.Transaction, artifact.Transaction) {
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
			RequestID:        requestID,
			WalletID:         walletID,
			WalletPublicKey:  artifact.WalletPublicKey,
			IntentType:       intent.Intent.Type,
			IntentDigest:     intent.Digest,
			PolicyHash:       policy.Hash,
			Mode:             mode,
			Nonce:            nonce,
			SemanticIntent:   semanticIntent,
			ArtifactKind:     artifact.Kind,
			ArtifactDigest:   artifact.Digest,
			Transaction:      artifact.Transaction,
			MessageBase64:    artifact.MessageBase64,
			StateDigest:      artifact.StateDigest,
			StateSlot:        artifact.StateSlot,
			Asset:            intent.Asset,
			Amount:           intent.Amount.String(),
			Destination:      intent.Destination,
			PolicyOperation:  intent.PolicyOperation,
			RequiredPrograms: append([]string(nil), intent.RequiredPrograms...),
			RequiredRole:     intent.RequiredRole,
			IssuedAt:         issuedAt,
			State:            jupiterReviewPreparedV2,
			PreparedAt:       issuedAt,
			ExpiresAt:        timestampV2(reviewExpiryV2(now)),
			UpdatedAt:        timestampV2(now),
		}
		if artifact.Kind == signerReviewArtifactSolanaTransactionV2 {
			review.TransactionDigest = artifact.Digest
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

func equalOptionalTransactionEnvelopeV2(left, right *signerSolanaTransactionEnvelopeV2) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return equalTransactionEnvelopeV2(*left, *right)
}

func normalizedIntentFromStoredReviewV2(review signerReviewV2) (normalizedIntentV2, error) {
	var storedIntent signerIntentV2
	if err := json.Unmarshal(review.SemanticIntent, &storedIntent); err != nil {
		return normalizedIntentV2{}, errors.New("stored signer review semantic intent is invalid")
	}
	var intent normalizedIntentV2
	var err error
	if review.WalletPublicKey != "" {
		wallet, walletErr := solana.PublicKeyFromBase58(review.WalletPublicKey)
		if walletErr != nil {
			return normalizedIntentV2{}, errors.New("stored signer review wallet public key is invalid")
		}
		intent, err = normalizeSignerIntentForWalletV2(storedIntent, &wallet)
	} else {
		intent, err = normalizeSignerIntentV2(storedIntent)
	}
	if err != nil || intent.Digest != review.IntentDigest || intent.Intent.Type != review.IntentType {
		return normalizedIntentV2{}, errors.New("stored signer review semantic intent is inconsistent")
	}
	if review.Asset != "" {
		amount, amountErr := parsePositiveAmountV2(review.Amount, "stored reviewed amount")
		if amountErr != nil || review.Destination == "" || review.PolicyOperation == "" || len(review.RequiredPrograms) == 0 {
			return normalizedIntentV2{}, errors.New("stored signer review accounting is invalid")
		}
		intent.Asset = review.Asset
		intent.Amount = amount
		intent.Destination = review.Destination
		intent.PolicyOperation = review.PolicyOperation
		intent.RequiredPrograms = append([]string(nil), review.RequiredPrograms...)
		intent.RequiredRole = review.RequiredRole
	}
	return intent, nil
}

func (s *signerStoreV2) getReviewV2(walletID, requestID string) (signerReviewV2, normalizedIntentV2, error) {
	if s == nil || s.db == nil {
		return signerReviewV2{}, normalizedIntentV2{}, errors.New("signer state database is unavailable")
	}
	requestID, err := validateRequestIDV2(requestID)
	if err != nil {
		return signerReviewV2{}, normalizedIntentV2{}, err
	}
	var review signerReviewV2
	err = s.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSignerReviewsV2).Get([]byte(requestID))
		if raw == nil {
			return errors.New("signer review not found; review.prepare is required")
		}
		if err := json.Unmarshal(raw, &review); err != nil {
			return errors.New("invalid stored signer review")
		}
		if review.WalletID != normalizeWalletID(walletID) || review.RequestID != requestID {
			return errors.New("signer review wallet mismatch")
		}
		_, err := normalizeStoredReviewArtifactV2(review)
		return err
	})
	if err != nil {
		return signerReviewV2{}, normalizedIntentV2{}, err
	}
	intent, err := normalizedIntentFromStoredReviewV2(review)
	return review, intent, err
}

func (s *signerStoreV2) requirePreparedReviewV2(walletID, requestID string) (signerReviewV2, normalizedIntentV2, signerPolicyV2, error) {
	return s.requireReviewForExecutionV2(walletID, requestID, false)
}

func (s *signerStoreV2) requireReviewForExecutionV2(walletID, requestID string, allowSigned bool) (signerReviewV2, normalizedIntentV2, signerPolicyV2, error) {
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
		if review.State != jupiterReviewPreparedV2 && !(allowSigned && review.State == jupiterReviewSignedV2) {
			return fmt.Errorf("signer review is already %s; transaction will not be signed again", review.State)
		}
		if review.State == jupiterReviewPreparedV2 {
			expiresAt, err := time.Parse(time.RFC3339Nano, review.ExpiresAt)
			if err != nil || !s.now().Before(expiresAt) {
				return errors.New("signer review expired; prepare a fresh review")
			}
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
		intent, err = normalizedIntentFromStoredReviewV2(review)
		if err != nil {
			return err
		}
		if _, err := normalizeStoredReviewArtifactV2(review); err != nil {
			return err
		}
		return validateReviewPolicyV2(policy, intent)
	})
	return review, intent, policy, err
}

func normalizeStoredReviewArtifactV2(review signerReviewV2) (signerReviewArtifactInputV2, error) {
	kind := review.ArtifactKind
	digest := review.ArtifactDigest
	if kind == "" && review.Transaction != nil {
		kind, digest = signerReviewArtifactSolanaTransactionV2, review.TransactionDigest
	}
	artifact, err := normalizeReviewArtifactInputV2(signerReviewArtifactInputV2{
		WalletPublicKey: review.WalletPublicKey,
		Kind:            kind, Digest: digest, Transaction: review.Transaction,
		MessageBase64: review.MessageBase64, StateDigest: review.StateDigest, StateSlot: review.StateSlot,
	})
	if err != nil {
		return artifact, errors.New("stored signer review artifact is invalid")
	}
	return artifact, nil
}

func (s *signerStoreV2) markReviewSignedV2(requestID, artifactDigest, signature string) (signerReviewV2, error) {
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
		if review.ArtifactDigest != artifactDigest || strings.TrimSpace(signature) == "" {
			return errors.New("signed review requires exact artifact digest and signature")
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
