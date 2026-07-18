package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	solana "github.com/gagliardetto/solana-go"
)

func normalizedVaultBondInstructionV2(intent normalizedIntentV2, wallet solana.PublicKey) (normalizedSATInstructionV2, error) {
	if intent.Intent.Type != intentSolanaVaultBondAction || intent.Intent.Action == "" || len(intent.Intent.Instructions) != 0 {
		return normalizedSATInstructionV2{}, errors.New("reviewed Vault bond intent requires exactly one typed action")
	}
	return normalizeSATInstructionV2(signerSATInstructionV2{
		Action: intent.Intent.Action, ProgramID: intent.Intent.ProgramID,
		DataBase64: intent.Intent.DataBase64, Keys: intent.Intent.Keys, Context: intent.Intent.Context,
	}, wallet)
}

func vaultBondReviewSnapshotAddressesV2(instruction normalizedSATInstructionV2, wallet solana.PublicKey) ([]solana.PublicKey, error) {
	if instruction.Codec.Family != satFamilyBond {
		return nil, errors.New("Vault bond review requires a generated bond codec")
	}
	static := map[string]bool{
		wallet.String(): true, instruction.Program.String(): true,
		solana.SystemProgramID.String(): true, solana.TokenProgramID.String(): true,
		solana.Token2022ProgramID.String(): true, solana.SPLAssociatedTokenAccountProgramID.String(): true,
		solana.SysVarRentPubkey.String(): true, solana.SysVarClockPubkey.String(): true,
		solana.SysVarInstructionsPubkey.String(): true, solana.SysVarSlotHashesPubkey.String(): true,
	}
	seen := map[string]bool{}
	addresses := make([]solana.PublicKey, 0, len(instruction.Accounts))
	for _, account := range instruction.Accounts {
		key := account.PublicKey.String()
		if static[key] || seen[key] {
			continue
		}
		seen[key] = true
		addresses = append(addresses, account.PublicKey)
	}
	if len(addresses) == 0 || len(addresses) > 16 {
		return nil, errors.New("Vault bond review has no bounded signer-owned state set")
	}
	return addresses, nil
}

func resolveVaultBondReviewStateV2(
	rpcURLs []string,
	wallet solana.PublicKey,
	intent normalizedIntentV2,
) (normalizedIntentV2, signerOwnedAccountSnapshotV2, []string, error) {
	verifiedRPCs, err := solanaRPCURLsForClusterV2(rpcURLs, intent.Intent.Cluster)
	if err != nil {
		return normalizedIntentV2{}, signerOwnedAccountSnapshotV2{}, nil, err
	}
	instruction, err := normalizedVaultBondInstructionV2(intent, wallet)
	if err != nil {
		return normalizedIntentV2{}, signerOwnedAccountSnapshotV2{}, nil, err
	}
	addresses, err := vaultBondReviewSnapshotAddressesV2(instruction, wallet)
	if err != nil {
		return normalizedIntentV2{}, signerOwnedAccountSnapshotV2{}, nil, err
	}
	snapshot, err := fetchVaultBondAccountSnapshotV2(verifiedRPCs, intent.Intent.Cluster, addresses)
	if err != nil {
		return normalizedIntentV2{}, signerOwnedAccountSnapshotV2{}, nil, err
	}
	if instruction.Codec.Action == "finalizeBondUnlock" {
		effect, effectErr := resolveVaultBondFinalizeEffectV2(instruction, wallet, snapshot)
		if effectErr != nil {
			return normalizedIntentV2{}, signerOwnedAccountSnapshotV2{}, nil, effectErr
		}
		intent.Asset = effect.Asset
		intent.Amount = effect.Amount
		intent.Destination = effect.Destination
	} else if instruction.Codec.Action == "claimBondStakingRewards" || instruction.Codec.Action == "claimUnallocatedStakingRewards" {
		effect, effectErr := resolveVaultBondClaimEffectV2(instruction, wallet, snapshot)
		if effectErr != nil {
			return normalizedIntentV2{}, signerOwnedAccountSnapshotV2{}, nil, effectErr
		}
		intent.Asset = effect.Asset
		intent.Amount = effect.Amount
		intent.Destination = effect.Destination
	}
	return intent, snapshot, verifiedRPCs, nil
}

func buildVaultBondUnsignedTransactionV2(
	rpcURLs []string,
	wallet solana.PublicKey,
	intent normalizedIntentV2,
	recentBlockhash *solana.Hash,
) (*solana.Transaction, error) {
	if intent.Intent.Type != intentSolanaVaultBondAction || len(intent.Instructions) != 1 {
		return nil, errors.New("reviewed Vault bond transaction requires exactly one signer-validated instruction")
	}
	blockhash := solana.Hash{}
	var err error
	if recentBlockhash == nil {
		blockhash, err = signerLatestBlockhashWithFallbackV2(rpcURLs)
		if err != nil {
			return nil, err
		}
	} else {
		blockhash = *recentBlockhash
	}
	tx, err := solana.NewTransaction(intent.Instructions, blockhash, solana.TransactionPayer(wallet))
	if err != nil {
		return nil, err
	}
	if tx.Message.IsVersioned() || tx.Message.Header.NumRequiredSignatures != 1 ||
		len(tx.Message.AccountKeys) == 0 || !tx.Message.AccountKeys[0].Equals(wallet) {
		return nil, errors.New("reviewed Vault bond transaction must require only the signer-owned Vault")
	}
	tx.Signatures = make([]solana.Signature, 1)
	return tx, nil
}

func validateAndSimulateVaultBondReviewV2(
	rpcURLs []string,
	wallet solana.PublicKey,
	intent normalizedIntentV2,
	envelopeInput signerSolanaTransactionEnvelopeV2,
) (jupiterValidatedTransactionV2, error) {
	envelope, err := normalizeTransactionEnvelopeV2(envelopeInput)
	if err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	if envelope.Submission != jupiterSubmissionRPCV2 {
		return jupiterValidatedTransactionV2{}, errors.New("reviewed Vault bond transactions require signer-owned RPC submission")
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(envelope.SerializedTxBase64)
	if err != nil || len(raw) == 0 || len(raw) > 1232 || base64.StdEncoding.EncodeToString(raw) != envelope.SerializedTxBase64 {
		return jupiterValidatedTransactionV2{}, errors.New("reviewed Vault bond transaction is invalid or exceeds the Solana packet limit")
	}
	tx, err := solana.TransactionFromBytes(raw)
	if err != nil {
		return jupiterValidatedTransactionV2{}, errors.New("decode reviewed Vault bond transaction")
	}
	if tx.Message.IsVersioned() || len(tx.Message.GetAddressTableLookups()) != 0 ||
		tx.Message.Header.NumRequiredSignatures != 1 || len(tx.Signatures) != 1 ||
		len(tx.Message.AccountKeys) == 0 || !tx.Message.AccountKeys[0].Equals(wallet) || !tx.Signatures[0].IsZero() {
		return jupiterValidatedTransactionV2{}, errors.New("reviewed Vault bond signer layout is invalid")
	}
	expected, err := buildVaultBondUnsignedTransactionV2(rpcURLs, wallet, intent, &tx.Message.RecentBlockhash)
	if err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	expectedEnvelope, expectedRaw, err := typedTransactionEnvelopeV2(expected)
	if err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	if len(raw) != len(expectedRaw) || subtle.ConstantTimeCompare(raw, expectedRaw) != 1 {
		return jupiterValidatedTransactionV2{}, errors.New("stored Vault bond transaction does not exactly match signer-built semantics")
	}
	if !equalSortedStringsV2(envelope.Programs, expectedEnvelope.Programs) ||
		!equalSortedStringsV2(envelope.WritableAccounts, expectedEnvelope.WritableAccounts) {
		return jupiterValidatedTransactionV2{}, errors.New("stored Vault bond transaction manifest does not match decoded transaction")
	}
	if err := simulateTypedTransferReviewV2(rpcURLs, tx); err != nil {
		return jupiterValidatedTransactionV2{}, fmt.Errorf("reviewed Vault bond simulation failed: %w", err)
	}
	return jupiterValidatedTransactionV2{
		Transaction: tx, RawUnsigned: raw, Programs: expectedEnvelope.Programs,
		Writable: expectedEnvelope.WritableAccounts, WalletSignerIndex: 0,
	}, nil
}

func vaultBondReviewArtifactDigestV2(validated jupiterValidatedTransactionV2) string {
	digest := sha256.Sum256(validated.RawUnsigned)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func compareVaultBondReviewStateV2(review signerReviewV2, current normalizedIntentV2, snapshot signerOwnedAccountSnapshotV2) error {
	if review.StateDigest == "" || snapshot.Digest == "" ||
		subtle.ConstantTimeCompare([]byte(review.StateDigest), []byte(snapshot.Digest)) != 1 {
		return errors.New("Vault bond signer-owned state changed after review; prepare a fresh review")
	}
	if review.Asset != current.Asset || review.Amount != current.Amount.String() ||
		review.Destination != current.Destination || review.PolicyOperation != current.PolicyOperation ||
		!equalSortedStringsV2(review.RequiredPrograms, current.RequiredPrograms) {
		return errors.New("Vault bond exact reviewed effect changed after review")
	}
	return nil
}

func federationMessageArtifactV2(intent normalizedIntentV2) (signerReviewArtifactInputV2, error) {
	if intent.Intent.Type != intentFederationBondChallenge || len(intent.Message) == 0 {
		return signerReviewArtifactInputV2{}, errors.New("federation review requires an exact domain-separated payload")
	}
	digest := sha256.Sum256(intent.Message)
	return signerReviewArtifactInputV2{
		Kind:          signerReviewArtifactDomainMessageV2,
		Digest:        "sha256:" + hex.EncodeToString(digest[:]),
		MessageBase64: base64.StdEncoding.EncodeToString(intent.Message),
	}, nil
}

func decodeFederationReviewMessageV2(review signerReviewV2) ([]byte, error) {
	artifact, err := normalizeStoredReviewArtifactV2(review)
	if err != nil || artifact.Kind != signerReviewArtifactDomainMessageV2 {
		return nil, errors.New("stored federation review message artifact is invalid")
	}
	message, err := base64.StdEncoding.Strict().DecodeString(artifact.MessageBase64)
	if err != nil || strings.TrimSpace(artifact.MessageBase64) == "" {
		return nil, errors.New("stored federation review message artifact is invalid")
	}
	return message, nil
}
