package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"reflect"
	"strconv"
	"time"
)

// Protected review preparation. It cannot create admission or authorize execution.
func (s *signerStoreV2) storeWENMarketReviewV1(a wenMarketReviewArtifactV1) (signerReviewV2, error) {
	var out signerReviewV2
	if s == nil || s.db == nil {
		return out, errors.New("Buy review store unavailable")
	}
	digest, err := a.digest()
	if err != nil {
		return out, err
	}
	debit := a.Binding.Snapshot.Quote.InputCash
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
			IntentType: wenMarketOperationV1, IntentDigest: "sha256:" + digest, PolicyHash: a.PolicyHash,
			Mode: jupiterReviewModeReviewedV2, Nonce: hex.EncodeToString(nonce), SemanticIntent: semantic,
			ArtifactKind: wenMarketArtifactKindV1, ArtifactDigest: "sha256:" + digest,
			StateDigest: a.Binding.Snapshot.StateSHA256, StateSlot: a.Binding.Snapshot.Quote.Slot, TransactionDigest: "sha256:" + wenHashV1(a.Binding.Message),
			Asset: a.cashAsset(), Amount: strconv.FormatUint(debit, 10), Destination: a.Pins.Pool.String(),
			PolicyOperation: wenMarketOperationV1, RequiredPrograms: a.requiredPrograms(),
			IssuedAt: timestampV2(now), PreparedAt: timestampV2(now), UpdatedAt: timestampV2(now), ExpiresAt: timestampV2(now.Add(2 * time.Minute)), State: jupiterReviewPreparedV2}
		var policy signerPolicyV2
		if err := json.Unmarshal(tx.Bucket(bucketSignerPoliciesV2).Get([]byte(a.WalletID)), &policy); err != nil {
			return err
		}
		if _, err := wenMarketStoredBindingV1(out, policy); err != nil {
			return err
		}
		bucket := tx.Bucket(bucketSignerReviewsV2)
		// Never overwrite a review (including its nonce or outstanding authorization).
		if bucket.Get([]byte(a.RequestID)) != nil {
			return errors.New("Buy review request already exists")
		}
		raw, err := json.Marshal(out)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(a.RequestID), raw)
	})
	return out, err
}

func wenMarketStoredBindingV1(r signerReviewV2, p signerPolicyV2) (signerReviewBindingV2, error) {
	var a wenMarketReviewArtifactV1
	bad := errors.New("stored WEN Buy review mismatch")
	if err := decodeSignerAdminStrictJSON(r.SemanticIntent, &a); err != nil {
		return signerReviewBindingV2{}, bad
	}
	debit := a.Binding.Snapshot.Quote.InputCash
	d, err := a.digest()
	if err != nil || r.IntentType != wenMarketOperationV1 || r.State != jupiterReviewPreparedV2 || r.Mode != jupiterReviewModeReviewedV2 ||
		r.RequestID != a.RequestID || r.WalletID != a.WalletID || r.WalletPublicKey != a.WalletPublicKey || r.PolicyHash != a.PolicyHash || p.WalletID != a.WalletID || p.Hash != a.PolicyHash ||
		!containsStringV2(p.Operations, wenMarketOperationV1) || !wenMarketProgramsAllowedV1(p, a) ||
		r.ArtifactKind != wenMarketArtifactKindV1 || r.ArtifactDigest != "sha256:"+d || r.IntentDigest != r.ArtifactDigest ||
		r.TransactionDigest != "sha256:"+wenHashV1(a.Binding.Message) || r.StateDigest != a.Binding.Snapshot.StateSHA256 || r.StateSlot != a.Binding.Snapshot.Quote.Slot ||
		r.Asset != a.cashAsset() || r.Amount != strconv.FormatUint(debit, 10) || r.Destination != a.Pins.Pool.String() || r.PolicyOperation != wenMarketOperationV1 ||
		!reflect.DeepEqual(r.RequiredPrograms, a.requiredPrograms()) || r.Nonce == "" || r.IssuedAt == "" || r.ExpiresAt == "" ||
		r.Transaction != nil || r.MessageBase64 != "" {
		return signerReviewBindingV2{}, bad
	}
	return signerReviewBindingV2{RequestID: r.RequestID, WalletID: r.WalletID, WalletPublicKey: r.WalletPublicKey, Role: p.Role,
		IntentType: r.IntentType, IntentDigest: r.IntentDigest, SemanticIntent: append(json.RawMessage(nil), r.SemanticIntent...),
		ArtifactKind: r.ArtifactKind, ArtifactDigest: r.ArtifactDigest, TransactionDigest: r.TransactionDigest,
		StateDigest: r.StateDigest, StateSlot: r.StateSlot, Asset: r.Asset, Amount: r.Amount, Destination: r.Destination,
		PolicyOperation: r.PolicyOperation, RequiredPrograms: append([]string(nil), r.RequiredPrograms...), PolicyHash: r.PolicyHash,
		Nonce: r.Nonce, IssuedAt: r.IssuedAt, ExpiresAt: r.ExpiresAt}, nil
}

func wenMarketProgramsAllowedV1(p signerPolicyV2, a wenMarketReviewArtifactV1) bool {
	for _, program := range a.requiredPrograms() {
		if !containsStringV2(p.Programs, program) {
			return false
		}
	}
	return true
}
