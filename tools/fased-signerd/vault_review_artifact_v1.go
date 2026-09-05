package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	solana "github.com/gagliardetto/solana-go"
)

const signerReviewArtifactVaultReferenceV1 = "vault-commitment-reference"

// Public review metadata only. Never add nonce, allocation or serialized bytes.
// Expiry, policy and one-shot authorization remain owned by signerReviewV2.
type vaultReviewReferenceV1 struct {
	Scope             vaultCommitmentScopeV1              `json:"scope"`
	Commitment        signerSATCommitmentBindingRequestV1 `json:"commitment"`
	Reference         string                              `json:"reference"`
	Blockhash         string                              `json:"blockhash"`
	TransactionDigest string                              `json:"transactionDigest"`
}

func vaultReviewReferenceDigestV1(reference vaultReviewReferenceV1, wallet string) (string, error) {
	if err := validateVaultCommitmentScopeV1(reference.Scope, wallet, reference.Commitment.ProgramID); err != nil {
		return "", err
	}
	normalized, err := normalizeSATCommitmentBindingRequestV1(reference.Commitment)
	if err != nil || normalized != reference.Commitment || normalized.Cluster != "devnet" || normalized.ProtocolGeneration != "2" {
		return "", errors.New("invalid Vault review commitment binding")
	}
	for _, digest := range []string{reference.Reference, reference.TransactionDigest} {
		if normalized, err := normalizeSHA256DigestV2(digest, "Vault review digest"); err != nil || normalized != digest {
			return "", errors.New("invalid Vault review digest")
		}
	}
	blockhash, err := solana.HashFromBase58(reference.Blockhash)
	if err != nil || blockhash == (solana.Hash{}) || blockhash.String() != reference.Blockhash {
		return "", errors.New("invalid Vault review blockhash")
	}
	encoded, err := json.Marshal(reference)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(append([]byte("fased:vault-reveal-review:v1\x00"), encoded...))
	return "sha256:" + hex.EncodeToString(hash[:]), nil
}

func equalVaultReviewReferenceV1(a, b *vaultReviewReferenceV1) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// Called only with a transaction reconstructed from signer-owned storage.
// The artifact digest binds the public reference metadata as well as tx bytes.
func vaultRevealReviewArtifactV1(reference vaultReviewReferenceV1, tx *solana.Transaction, stateDigest string, stateSlot uint64) (signerReviewArtifactInputV2, error) {
	var empty signerReviewArtifactInputV2
	if tx == nil || len(tx.Signatures) != 1 || !tx.Signatures[0].IsZero() || len(tx.Message.AccountKeys) == 0 || tx.Message.AccountKeys[0] != reference.Scope.Executor || tx.Message.RecentBlockhash.String() != reference.Blockhash {
		return empty, errors.New("invalid unsigned Vault review transaction")
	}
	raw, err := tx.MarshalBinary()
	if err != nil {
		return empty, err
	}
	defer zeroBytes(raw)
	if len(raw) > 1232 {
		return empty, errors.New("Vault review transaction exceeds packet size")
	}
	digest := sha256.Sum256(raw)
	reference.TransactionDigest = "sha256:" + hex.EncodeToString(digest[:])
	artifactDigest, err := vaultReviewReferenceDigestV1(reference, reference.Scope.Executor.String())
	if err != nil {
		return empty, err
	}
	return normalizeReviewArtifactInputV2(signerReviewArtifactInputV2{Kind: signerReviewArtifactVaultReferenceV1, WalletPublicKey: reference.Scope.Executor.String(), Digest: artifactDigest, VaultReference: &reference, StateDigest: stateDigest, StateSlot: stateSlot})
}

func validateVaultReviewedReconstructionV1(artifact signerReviewArtifactInputV2, tx *solana.Transaction) error {
	validated, err := normalizeReviewArtifactInputV2(artifact)
	if err != nil || validated.Kind != signerReviewArtifactVaultReferenceV1 {
		return errors.New("invalid Vault reference review")
	}
	rebuilt, err := vaultRevealReviewArtifactV1(*validated.VaultReference, tx, validated.StateDigest, validated.StateSlot)
	if err != nil {
		return err
	}
	if rebuilt.Digest != validated.Digest {
		return errors.New("Vault reconstructed transaction differs from reviewed artifact")
	}
	return nil
}
