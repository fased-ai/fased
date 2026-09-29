package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"strconv"
	"time"
)

const wenMiningClaimArtifactKindV1 = "wen-mining-claim-v1"

// Internal candidate preparation. No public review.prepare or execution dispatch.
func (s *signerStoreV2) storeWENMiningClaimReviewV1(a wenMiningClaimReviewArtifactV1) (signerReviewV2, error) {
	var out signerReviewV2
	digest, err := a.digest()
	if err != nil {
		return out, err
	}
	semantic, err := json.Marshal(a)
	if err != nil {
		return out, err
	}
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return out, err
	}
	err = s.db.Update(func(tx *bolt.Tx) error {
		now := s.now().UTC()
		out = signerReviewV2{RequestID: a.RequestID, WalletID: a.WalletID, WalletPublicKey: a.WalletPublicKey,
			IntentType: intentWENMiningClaimV1, IntentDigest: "sha256:" + digest, PolicyHash: a.PolicyHash,
			Mode: jupiterReviewModeReviewedV2, Nonce: hex.EncodeToString(nonce), SemanticIntent: semantic,
			ArtifactKind: wenMiningClaimArtifactKindV1, ArtifactDigest: "sha256:" + digest,
			StateDigest: a.Binding.StateHash, StateSlot: a.Binding.Slot, TransactionDigest: "sha256:" + wenHashV1(a.Binding.Message),
			Asset: "solana:native", Amount: strconv.FormatUint(a.Binding.Fee, 10), Destination: a.Intent.Economy,
			PolicyOperation: intentWENMiningClaimV1, RequiredPrograms: []string{a.Intent.ProgramID},
			IssuedAt: timestampV2(now), PreparedAt: timestampV2(now), UpdatedAt: timestampV2(now), ExpiresAt: timestampV2(now.Add(2 * time.Minute)), State: jupiterReviewPreparedV2}
		var policy signerPolicyV2
		if err := json.Unmarshal(tx.Bucket(bucketSignerPoliciesV2).Get([]byte(a.WalletID)), &policy); err != nil {
			return err
		}
		if _, err := wenMiningClaimStoredBindingV1(out, policy); err != nil {
			return err
		}
		bucket := tx.Bucket(bucketSignerReviewsV2)
		// Never overwrite a review (including its nonce or outstanding authorization).
		if bucket.Get([]byte(a.RequestID)) != nil {
			return errors.New("claim review request already exists")
		}
		raw, err := json.Marshal(out)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(a.RequestID), raw)
	})
	return out, err
}

func wenMiningClaimStoredBindingV1(r signerReviewV2, p signerPolicyV2) (signerReviewBindingV2, error) {
	var a wenMiningClaimReviewArtifactV1
	bad := errors.New("stored WEN claim review mismatch")
	if err := decodeSignerAdminStrictJSON(r.SemanticIntent, &a); err != nil {
		return signerReviewBindingV2{}, bad
	}
	d, err := a.digest()
	if err != nil || r.IntentType != intentWENMiningClaimV1 || r.State != jupiterReviewPreparedV2 || r.Mode != jupiterReviewModeReviewedV2 ||
		r.RequestID != a.RequestID || r.WalletID != a.WalletID || r.WalletPublicKey != a.WalletPublicKey || r.PolicyHash != a.PolicyHash || p.WalletID != a.WalletID || p.Hash != a.PolicyHash ||
		!containsStringV2(p.Operations, intentWENMiningClaimV1) || !containsStringV2(p.Programs, a.Intent.ProgramID) ||
		r.ArtifactKind != wenMiningClaimArtifactKindV1 || r.ArtifactDigest != "sha256:"+d || r.IntentDigest != r.ArtifactDigest ||
		r.TransactionDigest != "sha256:"+wenHashV1(a.Binding.Message) || r.StateDigest != a.Binding.StateHash || r.StateSlot != a.Binding.Slot ||
		r.Asset != "solana:native" || r.Amount != strconv.FormatUint(a.Binding.Fee, 10) || r.Destination != a.Intent.Economy || r.PolicyOperation != intentWENMiningClaimV1 ||
		len(r.RequiredPrograms) != 1 || r.RequiredPrograms[0] != a.Intent.ProgramID || r.Nonce == "" || r.IssuedAt == "" || r.ExpiresAt == "" ||
		r.Transaction != nil || r.VaultReference != nil || r.MessageBase64 != "" {
		return signerReviewBindingV2{}, bad
	}
	return signerReviewBindingV2{RequestID: r.RequestID, WalletID: r.WalletID, WalletPublicKey: r.WalletPublicKey, Role: p.Role,
		IntentType: r.IntentType, IntentDigest: r.IntentDigest, SemanticIntent: append(json.RawMessage(nil), r.SemanticIntent...),
		ArtifactKind: r.ArtifactKind, ArtifactDigest: r.ArtifactDigest, TransactionDigest: r.TransactionDigest,
		StateDigest: r.StateDigest, StateSlot: r.StateSlot, Asset: r.Asset, Amount: r.Amount, Destination: r.Destination,
		PolicyOperation: r.PolicyOperation, RequiredPrograms: append([]string(nil), r.RequiredPrograms...), PolicyHash: r.PolicyHash,
		Nonce: r.Nonce, IssuedAt: r.IssuedAt, ExpiresAt: r.ExpiresAt}, nil
}
