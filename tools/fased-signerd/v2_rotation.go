package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

const (
	signerWalletRotationPreparedV2  = "prepared"
	signerWalletRotationCommittedV2 = "committed"
)

var errSignerWalletRotationNotFoundV2 = errors.New("signer wallet successor rotation not found")

type signerWalletRotationCreateRequestV2 struct {
	SuccessorWalletID           string `json:"successorWalletId"`
	ExpectedSourcePublicKey     string `json:"expectedSourcePublicKey"`
	ExpectedSourceWalletVersion uint64 `json:"expectedSourceWalletVersion"`
	ExpectedSourcePolicyVersion uint64 `json:"expectedSourcePolicyVersion"`
}

type signerWalletRotationCommitRequestV2 struct {
	RotationID                     string `json:"rotationId"`
	SuccessorWalletID              string `json:"successorWalletId"`
	ExpectedSourcePublicKey        string `json:"expectedSourcePublicKey"`
	ExpectedSuccessorPublicKey     string `json:"expectedSuccessorPublicKey"`
	ExpectedSourceWalletVersion    uint64 `json:"expectedSourceWalletVersion"`
	ExpectedSourcePolicyVersion    uint64 `json:"expectedSourcePolicyVersion"`
	ExpectedSuccessorWalletVersion uint64 `json:"expectedSuccessorWalletVersion"`
	ExpectedSuccessorPolicyVersion uint64 `json:"expectedSuccessorPolicyVersion"`
	ExpectedRotationVersion        uint64 `json:"expectedRotationVersion"`
}

type signerWalletRotationCommitFenceV2 struct {
	SourcePublicKey        string `json:"sourcePublicKey"`
	SuccessorPublicKey     string `json:"successorPublicKey"`
	SourceWalletVersion    uint64 `json:"sourceWalletVersion"`
	SourcePolicyVersion    uint64 `json:"sourcePolicyVersion"`
	SuccessorWalletVersion uint64 `json:"successorWalletVersion"`
	SuccessorPolicyVersion uint64 `json:"successorPolicyVersion"`
	RotationVersion        uint64 `json:"rotationVersion"`
}

// signerWalletRotationV2 contains public metadata only. The successor secret is
// generated, encrypted, and committed by Go in the wallets bucket; it never
// crosses either signer socket or appears in this record.
type signerWalletRotationV2 struct {
	RotationID                         string                             `json:"rotationId"`
	SourceWalletID                     string                             `json:"sourceWalletId"`
	SourcePublicKey                    string                             `json:"sourcePublicKey"`
	SuccessorWalletID                  string                             `json:"successorWalletId"`
	SuccessorPublicKey                 string                             `json:"successorPublicKey"`
	Role                               string                             `json:"role"`
	State                              string                             `json:"state"`
	Version                            uint64                             `json:"version"`
	PrepareExpectedSourceWalletVersion uint64                             `json:"prepareExpectedSourceWalletVersion"`
	PrepareExpectedSourcePolicyVersion uint64                             `json:"prepareExpectedSourcePolicyVersion"`
	SourceRetiredPolicyVersion         uint64                             `json:"sourceRetiredPolicyVersion,omitempty"`
	SourceRetiredPolicyHash            string                             `json:"sourceRetiredPolicyHash,omitempty"`
	CommitFence                        *signerWalletRotationCommitFenceV2 `json:"commitFence,omitempty"`
	CreatedAt                          string                             `json:"createdAt"`
	CommittedAt                        string                             `json:"committedAt,omitempty"`
}

func normalizeRotationWalletIDV2(raw, field string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" || len(value) > 64 || normalizeWalletID(value) != value {
		return "", fmt.Errorf("%s must be a normalized wallet ID with 1 to 64 characters", field)
	}
	return value, nil
}

func normalizeRotationPublicKeyV2(raw, field string) (string, error) {
	value, err := normalizePublicKeyV2(raw, field)
	if err != nil {
		return "", err
	}
	if value != strings.TrimSpace(raw) {
		return "", fmt.Errorf("%s must be canonical base58", field)
	}
	return value, nil
}

func signerWalletRotationIDV2(sourceWalletID, successorWalletID, sourcePublicKey, successorPublicKey string) string {
	digest := sha256.Sum256([]byte(strings.Join([]string{
		"fased:wallet-successor-rotation:v2",
		sourceWalletID,
		successorWalletID,
		sourcePublicKey,
		successorPublicKey,
	}, "\x00")))
	return "sha256:" + hex.EncodeToString(digest[:])
}

func loadSignerWalletRecordFromTxV2(tx *bolt.Tx, walletID string) (signerWalletRecordV2, error) {
	var wallet signerWalletRecordV2
	raw := tx.Bucket(bucketSignerWalletsV2).Get([]byte(walletID))
	if raw == nil {
		return wallet, errors.New("signer wallet not found")
	}
	if err := json.Unmarshal(raw, &wallet); err != nil {
		return wallet, errors.New("invalid stored signer wallet")
	}
	if wallet.WalletID != walletID || wallet.Version == 0 {
		return wallet, errors.New("stored signer wallet identity is invalid")
	}
	return wallet, nil
}

func loadSignerPolicyFromTxV2(tx *bolt.Tx, walletID string) (signerPolicyV2, error) {
	var policy signerPolicyV2
	raw := tx.Bucket(bucketSignerPoliciesV2).Get([]byte(walletID))
	if raw == nil {
		return policy, errors.New("explicit signer policy required")
	}
	if err := json.Unmarshal(raw, &policy); err != nil {
		return policy, errors.New("invalid stored signer policy")
	}
	if policy.WalletID != walletID || policy.Version == 0 {
		return policy, errors.New("stored signer policy identity is invalid")
	}
	return policy, nil
}

func loadSignerWalletRotationFromTxV2(tx *bolt.Tx, sourceWalletID string) (signerWalletRotationV2, error) {
	var rotation signerWalletRotationV2
	raw := tx.Bucket(bucketSignerRotationsV2).Get([]byte(sourceWalletID))
	if raw == nil {
		return rotation, errSignerWalletRotationNotFoundV2
	}
	if err := json.Unmarshal(raw, &rotation); err != nil {
		return rotation, errors.New("invalid stored signer wallet successor rotation")
	}
	if err := validateSignerWalletRotationRecordV2(rotation, sourceWalletID); err != nil {
		return rotation, err
	}
	return rotation, nil
}

func validateSignerWalletRotationRecordV2(rotation signerWalletRotationV2, sourceWalletID string) error {
	if rotation.SourceWalletID != sourceWalletID || len(rotation.SourceWalletID) == 0 || len(rotation.SourceWalletID) > 64 ||
		normalizeWalletID(rotation.SourceWalletID) != rotation.SourceWalletID ||
		rotation.SuccessorWalletID == rotation.SourceWalletID || len(rotation.SuccessorWalletID) == 0 || len(rotation.SuccessorWalletID) > 64 ||
		normalizeWalletID(rotation.SuccessorWalletID) != rotation.SuccessorWalletID {
		return errors.New("stored signer wallet successor rotation identity is invalid")
	}
	sourcePublicKey, err := normalizeRotationPublicKeyV2(rotation.SourcePublicKey, "stored source public key")
	if err != nil {
		return errors.New("stored signer wallet successor rotation source key is invalid")
	}
	successorPublicKey, err := normalizeRotationPublicKeyV2(rotation.SuccessorPublicKey, "stored successor public key")
	if err != nil || sourcePublicKey == successorPublicKey {
		return errors.New("stored signer wallet successor rotation successor key is invalid")
	}
	if rotation.RotationID != signerWalletRotationIDV2(
		rotation.SourceWalletID,
		rotation.SuccessorWalletID,
		sourcePublicKey,
		successorPublicKey,
	) {
		return errors.New("stored signer wallet successor rotation digest is invalid")
	}
	if rotation.Role != "agent" && rotation.Role != "mining" && rotation.Role != "vault" {
		return errors.New("stored signer wallet successor rotation role is invalid")
	}
	if rotation.PrepareExpectedSourceWalletVersion == 0 || rotation.PrepareExpectedSourcePolicyVersion == 0 {
		return errors.New("stored signer wallet successor rotation prepare fence is invalid")
	}
	if _, err := time.Parse(time.RFC3339Nano, rotation.CreatedAt); err != nil {
		return errors.New("stored signer wallet successor rotation creation time is invalid")
	}
	switch rotation.State {
	case signerWalletRotationPreparedV2:
		if rotation.Version != 1 || rotation.CommitFence != nil || rotation.CommittedAt != "" ||
			rotation.SourceRetiredPolicyVersion != 0 || rotation.SourceRetiredPolicyHash != "" {
			return errors.New("stored prepared signer wallet successor rotation is invalid")
		}
	case signerWalletRotationCommittedV2:
		if rotation.Version != 2 || rotation.CommitFence == nil || rotation.CommittedAt == "" ||
			rotation.SourceRetiredPolicyVersion == 0 || rotation.SourceRetiredPolicyHash == "" {
			return errors.New("stored committed signer wallet successor rotation is invalid")
		}
		if _, err := time.Parse(time.RFC3339Nano, rotation.CommittedAt); err != nil {
			return errors.New("stored signer wallet successor rotation commit time is invalid")
		}
		fence := rotation.CommitFence
		if fence.SourcePublicKey != sourcePublicKey || fence.SuccessorPublicKey != successorPublicKey ||
			fence.SourceWalletVersion == 0 || fence.SourcePolicyVersion == 0 ||
			fence.SuccessorWalletVersion == 0 || fence.SuccessorPolicyVersion == 0 || fence.RotationVersion != 1 ||
			fence.SourcePolicyVersion == ^uint64(0) || rotation.SourceRetiredPolicyVersion != fence.SourcePolicyVersion+1 {
			return errors.New("stored signer wallet successor rotation commit fence is invalid")
		}
		if _, err := normalizeSHA256DigestV2(rotation.SourceRetiredPolicyHash, "stored retired policy hash"); err != nil {
			return errors.New("stored signer wallet successor rotation retired policy hash is invalid")
		}
	default:
		return errors.New("stored signer wallet successor rotation state is invalid")
	}
	return nil
}

func saveSignerWalletRotationToTxV2(tx *bolt.Tx, rotation signerWalletRotationV2) error {
	if err := validateSignerWalletRotationRecordV2(rotation, rotation.SourceWalletID); err != nil {
		return err
	}
	encoded, err := json.Marshal(rotation)
	if err != nil {
		return err
	}
	return tx.Bucket(bucketSignerRotationsV2).Put([]byte(rotation.SourceWalletID), encoded)
}

func signerWalletIsRetiredInTxV2(tx *bolt.Tx, walletID string) (bool, error) {
	walletID = normalizeWalletID(walletID)
	rotation, err := loadSignerWalletRotationFromTxV2(tx, walletID)
	if errors.Is(err, errSignerWalletRotationNotFoundV2) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return rotation.State == signerWalletRotationCommittedV2, nil
}

func denyAllSignerPolicyV2(walletID, role string, version uint64) (signerPolicyV2, error) {
	return normalizeSignerPolicyV2(signerPolicyV2{
		WalletID:   walletID,
		Role:       role,
		Version:    version,
		Operations: []string{},
		Programs:   []string{},
		Assets:     []signerPolicyAssetV2{},
	})
}

func signerPolicyIsDenyAllV2(policy signerPolicyV2) bool {
	return len(policy.Operations) == 0 && len(policy.Programs) == 0 && len(policy.Assets) == 0
}

func rotationCreateMatchesV2(rotation signerWalletRotationV2, req signerWalletRotationCreateRequestV2) bool {
	return rotation.SuccessorWalletID == req.SuccessorWalletID &&
		rotation.SourcePublicKey == req.ExpectedSourcePublicKey &&
		rotation.PrepareExpectedSourceWalletVersion == req.ExpectedSourceWalletVersion &&
		rotation.PrepareExpectedSourcePolicyVersion == req.ExpectedSourcePolicyVersion
}

func (m *signerKeyManagerV2) CreateSuccessorRotation(
	sourceWalletID string,
	req signerWalletRotationCreateRequestV2,
) (signerWalletRotationV2, error) {
	if m == nil || m.store == nil || m.store.db == nil {
		return signerWalletRotationV2{}, errors.New("signer state database is unavailable")
	}
	var err error
	if sourceWalletID, err = normalizeRotationWalletIDV2(sourceWalletID, "source walletId"); err != nil {
		return signerWalletRotationV2{}, err
	}
	if req.SuccessorWalletID, err = normalizeRotationWalletIDV2(req.SuccessorWalletID, "successorWalletId"); err != nil {
		return signerWalletRotationV2{}, err
	}
	if sourceWalletID == req.SuccessorWalletID {
		return signerWalletRotationV2{}, errors.New("successor wallet ID must differ from the source wallet ID")
	}
	if req.ExpectedSourcePublicKey, err = normalizeRotationPublicKeyV2(req.ExpectedSourcePublicKey, "expectedSourcePublicKey"); err != nil {
		return signerWalletRotationV2{}, err
	}
	if req.ExpectedSourceWalletVersion == 0 || req.ExpectedSourcePolicyVersion == 0 {
		return signerWalletRotationV2{}, errors.New("source wallet and policy versions must be positive")
	}

	var existing signerWalletRotationV2
	err = m.store.db.View(func(tx *bolt.Tx) error {
		rotation, loadErr := loadSignerWalletRotationFromTxV2(tx, sourceWalletID)
		if loadErr == nil {
			existing = rotation
			return nil
		}
		if !errors.Is(loadErr, errSignerWalletRotationNotFoundV2) {
			return loadErr
		}
		return nil
	})
	if err != nil {
		return signerWalletRotationV2{}, err
	}
	if existing.RotationID != "" {
		if !rotationCreateMatchesV2(existing, req) {
			return signerWalletRotationV2{}, errors.New("source wallet is already bound to a different immutable successor rotation")
		}
		return existing, nil
	}

	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return signerWalletRotationV2{}, fmt.Errorf("generate successor wallet key: %w", err)
	}
	defer zeroBytes(privateKey)
	successor := signerWalletRecordV2{
		WalletID:  req.SuccessorWalletID,
		PublicKey: solana.PrivateKey(privateKey).PublicKey().String(),
		Version:   1,
		CreatedAt: timestampV2(m.store.now()),
	}
	if err := m.encryptRecord(&successor, privateKey); err != nil {
		return signerWalletRotationV2{}, err
	}

	var result signerWalletRotationV2
	err = m.store.db.Update(func(tx *bolt.Tx) error {
		if raw := tx.Bucket(bucketSignerRotationsV2).Get([]byte(sourceWalletID)); raw != nil {
			rotation, loadErr := loadSignerWalletRotationFromTxV2(tx, sourceWalletID)
			if loadErr != nil {
				return loadErr
			}
			if !rotationCreateMatchesV2(rotation, req) {
				return errors.New("source wallet is already bound to a different immutable successor rotation")
			}
			result = rotation
			return nil
		}
		source, loadErr := loadSignerWalletRecordFromTxV2(tx, sourceWalletID)
		if loadErr != nil {
			return loadErr
		}
		if source.RetiredAt != "" {
			return errors.New("retired signer wallet cannot create another successor")
		}
		sourcePolicy, loadErr := loadSignerPolicyFromTxV2(tx, sourceWalletID)
		if loadErr != nil {
			return loadErr
		}
		if source.PublicKey != req.ExpectedSourcePublicKey || source.Version != req.ExpectedSourceWalletVersion {
			return errors.New("source wallet public key or version conflict")
		}
		if sourcePolicy.Version != req.ExpectedSourcePolicyVersion {
			return fmt.Errorf("source signer policy version conflict: expected %d, current %d", req.ExpectedSourcePolicyVersion, sourcePolicy.Version)
		}
		wallets := tx.Bucket(bucketSignerWalletsV2)
		policies := tx.Bucket(bucketSignerPoliciesV2)
		if wallets.Get([]byte(req.SuccessorWalletID)) != nil || policies.Get([]byte(req.SuccessorWalletID)) != nil {
			return errors.New("successor signer wallet or policy already exists")
		}
		successorPolicy, normalizeErr := denyAllSignerPolicyV2(req.SuccessorWalletID, sourcePolicy.Role, 1)
		if normalizeErr != nil {
			return normalizeErr
		}
		encodedWallet, encodeErr := json.Marshal(successor)
		if encodeErr != nil {
			return encodeErr
		}
		encodedPolicy, encodeErr := json.Marshal(successorPolicy)
		if encodeErr != nil {
			return encodeErr
		}
		if err := wallets.Put([]byte(req.SuccessorWalletID), encodedWallet); err != nil {
			return err
		}
		if err := policies.Put([]byte(req.SuccessorWalletID), encodedPolicy); err != nil {
			return err
		}
		createdAt := timestampV2(m.store.now())
		result = signerWalletRotationV2{
			RotationID:                         signerWalletRotationIDV2(sourceWalletID, req.SuccessorWalletID, source.PublicKey, successor.PublicKey),
			SourceWalletID:                     sourceWalletID,
			SourcePublicKey:                    source.PublicKey,
			SuccessorWalletID:                  req.SuccessorWalletID,
			SuccessorPublicKey:                 successor.PublicKey,
			Role:                               sourcePolicy.Role,
			State:                              signerWalletRotationPreparedV2,
			Version:                            1,
			PrepareExpectedSourceWalletVersion: source.Version,
			PrepareExpectedSourcePolicyVersion: sourcePolicy.Version,
			CreatedAt:                          createdAt,
		}
		return saveSignerWalletRotationToTxV2(tx, result)
	})
	return result, err
}

func (m *signerKeyManagerV2) SuccessorRotationStatus(sourceWalletID string) (signerWalletRotationV2, error) {
	if m == nil || m.store == nil || m.store.db == nil {
		return signerWalletRotationV2{}, errors.New("signer state database is unavailable")
	}
	var err error
	if sourceWalletID, err = normalizeRotationWalletIDV2(sourceWalletID, "source walletId"); err != nil {
		return signerWalletRotationV2{}, err
	}
	var rotation signerWalletRotationV2
	err = m.store.db.View(func(tx *bolt.Tx) error {
		var loadErr error
		rotation, loadErr = loadSignerWalletRotationFromTxV2(tx, sourceWalletID)
		return loadErr
	})
	return rotation, err
}

func normalizeRotationCommitRequestV2(req signerWalletRotationCommitRequestV2) (signerWalletRotationCommitRequestV2, error) {
	var err error
	if req.SuccessorWalletID, err = normalizeRotationWalletIDV2(req.SuccessorWalletID, "successorWalletId"); err != nil {
		return req, err
	}
	if req.ExpectedSourcePublicKey, err = normalizeRotationPublicKeyV2(req.ExpectedSourcePublicKey, "expectedSourcePublicKey"); err != nil {
		return req, err
	}
	if req.ExpectedSuccessorPublicKey, err = normalizeRotationPublicKeyV2(req.ExpectedSuccessorPublicKey, "expectedSuccessorPublicKey"); err != nil {
		return req, err
	}
	if _, err := normalizeSHA256DigestV2(req.RotationID, "rotationId"); err != nil {
		return req, err
	}
	if req.ExpectedSourceWalletVersion == 0 || req.ExpectedSourcePolicyVersion == 0 ||
		req.ExpectedSuccessorWalletVersion == 0 || req.ExpectedSuccessorPolicyVersion == 0 ||
		req.ExpectedRotationVersion == 0 {
		return req, errors.New("all wallet, policy, and rotation versions must be positive")
	}
	return req, nil
}

func rotationCommitFenceFromRequestV2(req signerWalletRotationCommitRequestV2) signerWalletRotationCommitFenceV2 {
	return signerWalletRotationCommitFenceV2{
		SourcePublicKey:        req.ExpectedSourcePublicKey,
		SuccessorPublicKey:     req.ExpectedSuccessorPublicKey,
		SourceWalletVersion:    req.ExpectedSourceWalletVersion,
		SourcePolicyVersion:    req.ExpectedSourcePolicyVersion,
		SuccessorWalletVersion: req.ExpectedSuccessorWalletVersion,
		SuccessorPolicyVersion: req.ExpectedSuccessorPolicyVersion,
		RotationVersion:        req.ExpectedRotationVersion,
	}
}

func equalRotationCommitFenceV2(left, right *signerWalletRotationCommitFenceV2) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

func invalidateRetiredWalletAuthorizationsV2(tx *bolt.Tx, walletID string) error {
	challenges := tx.Bucket(bucketSignerWebAuthnChallengesV2)
	challengeCursor := challenges.Cursor()
	for key, raw := challengeCursor.First(); key != nil; key, raw = challengeCursor.Next() {
		var challenge signerWebAuthnChallengeV2
		if err := json.Unmarshal(raw, &challenge); err != nil {
			return errors.New("invalid stored signer WebAuthn challenge")
		}
		if challenge.State == signerWebAuthnChallengePending && challenge.Binding != nil && challenge.Binding.WalletID == walletID {
			if err := challengeCursor.Delete(); err != nil {
				return err
			}
		}
	}
	proofs := tx.Bucket(bucketSignerReviewProofsV2)
	proofCursor := proofs.Cursor()
	for key, raw := proofCursor.First(); key != nil; key, raw = proofCursor.Next() {
		var proof signerReviewProofRecordV2
		if err := json.Unmarshal(raw, &proof); err != nil {
			return errors.New("invalid stored review authorization proof")
		}
		if proof.State == signerReviewProofPending && proof.Binding.WalletID == walletID {
			if err := proofCursor.Delete(); err != nil {
				return err
			}
		}
	}
	return nil
}

func (m *signerKeyManagerV2) CommitSuccessorRotation(
	sourceWalletID string,
	req signerWalletRotationCommitRequestV2,
) (signerWalletRotationV2, error) {
	if m == nil || m.store == nil || m.store.db == nil {
		return signerWalletRotationV2{}, errors.New("signer state database is unavailable")
	}
	var err error
	if sourceWalletID, err = normalizeRotationWalletIDV2(sourceWalletID, "source walletId"); err != nil {
		return signerWalletRotationV2{}, err
	}
	if req, err = normalizeRotationCommitRequestV2(req); err != nil {
		return signerWalletRotationV2{}, err
	}
	expectedFence := rotationCommitFenceFromRequestV2(req)
	var result signerWalletRotationV2
	err = m.store.db.Update(func(tx *bolt.Tx) error {
		rotation, loadErr := loadSignerWalletRotationFromTxV2(tx, sourceWalletID)
		if loadErr != nil {
			return loadErr
		}
		if rotation.RotationID != req.RotationID || rotation.SuccessorWalletID != req.SuccessorWalletID ||
			rotation.SourcePublicKey != req.ExpectedSourcePublicKey || rotation.SuccessorPublicKey != req.ExpectedSuccessorPublicKey {
			return errors.New("rotation commit does not match the immutable source and successor binding")
		}
		if rotation.State == signerWalletRotationCommittedV2 {
			if !equalRotationCommitFenceV2(rotation.CommitFence, &expectedFence) {
				return errors.New("rotation is already committed under a different immutable version fence")
			}
			result = rotation
			return nil
		}
		if rotation.State != signerWalletRotationPreparedV2 || rotation.Version != req.ExpectedRotationVersion {
			return fmt.Errorf("rotation version conflict: expected %d, current %d", req.ExpectedRotationVersion, rotation.Version)
		}
		source, loadErr := loadSignerWalletRecordFromTxV2(tx, sourceWalletID)
		if loadErr != nil {
			return loadErr
		}
		successor, loadErr := loadSignerWalletRecordFromTxV2(tx, req.SuccessorWalletID)
		if loadErr != nil {
			return loadErr
		}
		sourcePolicy, loadErr := loadSignerPolicyFromTxV2(tx, sourceWalletID)
		if loadErr != nil {
			return loadErr
		}
		successorPolicy, loadErr := loadSignerPolicyFromTxV2(tx, req.SuccessorWalletID)
		if loadErr != nil {
			return loadErr
		}
		if source.RetiredAt != "" {
			return errors.New("source signer wallet is already retired")
		}
		if source.PublicKey != req.ExpectedSourcePublicKey || source.Version != req.ExpectedSourceWalletVersion {
			return errors.New("source wallet public key or version conflict")
		}
		if successor.PublicKey != req.ExpectedSuccessorPublicKey || successor.Version != req.ExpectedSuccessorWalletVersion {
			return errors.New("successor wallet public key or version conflict")
		}
		if sourcePolicy.Version != req.ExpectedSourcePolicyVersion {
			return fmt.Errorf("source signer policy version conflict: expected %d, current %d", req.ExpectedSourcePolicyVersion, sourcePolicy.Version)
		}
		if successorPolicy.Version != req.ExpectedSuccessorPolicyVersion {
			return fmt.Errorf("successor signer policy version conflict: expected %d, current %d", req.ExpectedSuccessorPolicyVersion, successorPolicy.Version)
		}
		if sourcePolicy.Role != rotation.Role || successorPolicy.Role != rotation.Role || !signerPolicyIsDenyAllV2(successorPolicy) {
			return errors.New("successor must retain its immutable source role and explicit deny-all policy until rotation commit")
		}
		if sourcePolicy.Version == ^uint64(0) {
			return errors.New("source signer policy version is exhausted")
		}

		retiredPolicy, normalizeErr := denyAllSignerPolicyV2(sourceWalletID, sourcePolicy.Role, sourcePolicy.Version+1)
		if normalizeErr != nil {
			return normalizeErr
		}
		encodedRetiredPolicy, encodeErr := json.Marshal(retiredPolicy)
		if encodeErr != nil {
			return encodeErr
		}
		now := timestampV2(m.store.now())
		source.RetiredAt = now
		source.SuccessorWalletID = successor.WalletID
		source.RotationID = rotation.RotationID
		encodedSource, encodeErr := json.Marshal(source)
		if encodeErr != nil {
			return encodeErr
		}
		if err := tx.Bucket(bucketSignerPoliciesV2).Put([]byte(sourceWalletID), encodedRetiredPolicy); err != nil {
			return err
		}
		if err := tx.Bucket(bucketSignerWalletsV2).Put([]byte(sourceWalletID), encodedSource); err != nil {
			return err
		}
		if err := invalidateRetiredWalletAuthorizationsV2(tx, sourceWalletID); err != nil {
			return err
		}
		rotation.State = signerWalletRotationCommittedV2
		rotation.Version++
		rotation.SourceRetiredPolicyVersion = retiredPolicy.Version
		rotation.SourceRetiredPolicyHash = retiredPolicy.Hash
		rotation.CommitFence = &expectedFence
		rotation.CommittedAt = now
		if err := saveSignerWalletRotationToTxV2(tx, rotation); err != nil {
			return err
		}
		result = rotation
		return nil
	})
	return result, err
}
