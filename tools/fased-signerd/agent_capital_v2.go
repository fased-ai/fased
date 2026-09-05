package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"

	solana "github.com/gagliardetto/solana-go"
)

func agentCapitalRoleV1(action string) string {
	switch action {
	case "deposit_capital_offer", "deposit_capital_offer_generation", "claim_vault_sat", "finalize_vault_exit", "refund_cancelled_position", "request_vault_exit":
		return "vault"
	default:
		return "profile"
	}
}

func normalizeAgentCapitalIntentV2(input signerIntentV2, wallet solana.PublicKey) (normalizedIntentV2, error) {
	if input.Type != intentSolanaAgentCapitalAction || input.Cluster == "" || input.Action == "" ||
		input.ProgramID == "" || input.DataBase64 == "" || len(input.Keys) == 0 ||
		len(input.Instructions) != 0 || input.Context != nil || input.SATCommitment != nil ||
		input.Destination != "" || input.Amount != "" || input.Jupiter != nil || input.Federation != nil {
		return normalizedIntentV2{}, errors.New("typed Agent Capital intent contains unsupported or missing fields")
	}
	cluster, err := normalizeSolanaClusterV2(input.Cluster)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	contract, ok := agentCapitalInstructionContractsV1[strings.TrimSpace(input.Action)]
	if !ok {
		return normalizedIntentV2{}, fmt.Errorf("unsupported Agent Capital action %q", input.Action)
	}
	program, err := solana.PublicKeyFromBase58(strings.TrimSpace(input.ProgramID))
	if err != nil || program.String() != agentCapitalProgramIDV1 {
		return normalizedIntentV2{}, errors.New("Agent Capital action requires the pinned canonical program")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(input.DataBase64)
	if err != nil || len(data) != contract.DataSize || base64.StdEncoding.EncodeToString(data) != input.DataBase64 {
		return normalizedIntentV2{}, errors.New("Agent Capital instruction data is not canonical")
	}
	if subtle.ConstantTimeCompare(data[:8], contract.Discriminator[:]) != 1 {
		return normalizedIntentV2{}, errors.New("Agent Capital action discriminator mismatch")
	}
	if len(input.Keys) != len(contract.Accounts) {
		return normalizedIntentV2{}, errors.New("Agent Capital account count mismatch")
	}
	accounts := make(solana.AccountMetaSlice, 0, len(input.Keys))
	canonicalKeys := make([]signerSATAccountV2, 0, len(input.Keys))
	signerFound := false
	for index, raw := range input.Keys {
		expected := contract.Accounts[index]
		key, keyErr := solana.PublicKeyFromBase58(strings.TrimSpace(raw.Pubkey))
		if keyErr != nil || raw.IsSigner != expected.IsSigner || raw.IsWritable != expected.IsWritable {
			return normalizedIntentV2{}, fmt.Errorf("Agent Capital account %s does not match the generated contract", expected.Name)
		}
		if expected.Address != "" && key.String() != expected.Address {
			return normalizedIntentV2{}, fmt.Errorf("Agent Capital account %s has the wrong fixed address", expected.Name)
		}
		if raw.IsSigner {
			if !key.Equals(wallet) {
				return normalizedIntentV2{}, errors.New("Agent Capital reviewed execution currently requires every signer meta to use the selected signer-owned wallet")
			}
			signerFound = true
		}
		accounts = append(accounts, &solana.AccountMeta{PublicKey: key, IsSigner: raw.IsSigner, IsWritable: raw.IsWritable})
		canonicalKeys = append(canonicalKeys, signerSATAccountV2{Pubkey: key.String(), IsSigner: raw.IsSigner, IsWritable: raw.IsWritable})
	}
	if !signerFound {
		return normalizedIntentV2{}, errors.New("Agent Capital action does not bind the signer-owned wallet")
	}
	action := strings.TrimSpace(input.Action)
	canonical := signerIntentV2{Type: input.Type, Cluster: cluster, Action: action, ProgramID: program.String(), DataBase64: input.DataBase64, Keys: canonicalKeys}
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	digest := sha256.Sum256(encoded)
	amount := big.NewInt(1)
	asset := "agent-capital:action"
	if action == "deposit_capital_offer" || action == "deposit_capital_offer_generation" {
		amount = new(big.Int).SetUint64(binary.LittleEndian.Uint64(data[8:16]))
		if amount.Sign() <= 0 {
			return normalizedIntentV2{}, errors.New("Agent Capital deposit must be positive")
		}
		asset = "solana:native"
	}
	instruction := solana.NewInstruction(program, accounts, data)
	return normalizedIntentV2{
		Intent: canonical, Digest: "sha256:" + hex.EncodeToString(digest[:]), Asset: asset,
		Amount: amount, RequiredPrograms: []string{program.String()}, Destination: program.String(),
		Instructions:    []solana.Instruction{instruction},
		PolicyOperation: "agentCapital." + action + "@" + program.String(),
		RequiredRole:    agentCapitalRoleV1(action),
	}, nil
}

func agentCapitalSnapshotAddressesV2(intent normalizedIntentV2, wallet solana.PublicKey) ([]solana.PublicKey, error) {
	static := map[string]bool{wallet.String(): true, agentCapitalProgramIDV1: true,
		solana.SystemProgramID.String(): true, solana.TokenProgramID.String(): true,
		solana.Token2022ProgramID.String(): true, solana.SPLAssociatedTokenAccountProgramID.String(): true,
		solana.SysVarRentPubkey.String(): true, solana.SysVarClockPubkey.String(): true,
	}
	seen := map[string]bool{}
	addresses := []solana.PublicKey{}
	for _, account := range intent.Instructions[0].Accounts() {
		key := account.PublicKey.String()
		if static[key] || seen[key] {
			continue
		}
		seen[key] = true
		addresses = append(addresses, account.PublicKey)
	}
	if len(addresses) == 0 || len(addresses) > 16 {
		return nil, errors.New("Agent Capital review has no bounded state set")
	}
	return addresses, nil
}

// The Devnet exception still enters exact policy, verified-genesis, account-state,
// simulation, nonce and replay checks. It does not authorize arbitrary Profile use.
func allowsControlUIReviewIntentV2(intent signerIntentV2, role string) bool {
	if isTypedTransferIntentV2(intent.Type) && (role == "agent" || role == "vault") {
		return true
	}
	return role == "profile" && intent.Type == intentSolanaAgentCapitalAction &&
		intent.Cluster == "devnet" && intent.Action == "initialize_capital_offer" &&
		intent.ProgramID == agentCapitalProgramIDV1
}

func resolveAgentCapitalReviewStateV2(rpcURLs []string, wallet solana.PublicKey, intent normalizedIntentV2) (normalizedIntentV2, signerOwnedAccountSnapshotV2, []string, error) {
	verified, err := solanaRPCURLsForClusterV2(rpcURLs, intent.Intent.Cluster)
	if err != nil {
		return intent, signerOwnedAccountSnapshotV2{}, nil, err
	}
	addresses, err := agentCapitalSnapshotAddressesV2(intent, wallet)
	if err != nil {
		return intent, signerOwnedAccountSnapshotV2{}, nil, err
	}
	snapshot, err := fetchVaultBondAccountSnapshotV2(verified, intent.Intent.Cluster, addresses)
	return intent, snapshot, verified, err
}

func buildAgentCapitalUnsignedTransactionV2(rpcURLs []string, wallet solana.PublicKey, intent normalizedIntentV2, recentBlockhash *solana.Hash) (*solana.Transaction, error) {
	if intent.Intent.Type != intentSolanaAgentCapitalAction || len(intent.Instructions) != 1 {
		return nil, errors.New("reviewed Agent Capital transaction requires one instruction")
	}
	blockhash := solana.Hash{}
	var err error
	if recentBlockhash == nil {
		blockhash, err = signerLatestBlockhashWithFallbackV2(rpcURLs)
	} else {
		blockhash = *recentBlockhash
	}
	if err != nil {
		return nil, err
	}
	tx, err := solana.NewTransaction(intent.Instructions, blockhash, solana.TransactionPayer(wallet))
	if err != nil {
		return nil, err
	}
	if tx.Message.IsVersioned() || tx.Message.Header.NumRequiredSignatures != 1 || len(tx.Message.AccountKeys) == 0 || !tx.Message.AccountKeys[0].Equals(wallet) {
		return nil, errors.New("Agent Capital transaction must require only the selected signer-owned wallet")
	}
	tx.Signatures = make([]solana.Signature, 1)
	return tx, nil
}

func validateAndSimulateAgentCapitalReviewV2(rpcURLs []string, wallet solana.PublicKey, intent normalizedIntentV2, input signerSolanaTransactionEnvelopeV2) (jupiterValidatedTransactionV2, error) {
	envelope, err := normalizeTransactionEnvelopeV2(input)
	if err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(envelope.SerializedTxBase64)
	if err != nil || len(raw) == 0 || len(raw) > 1232 {
		return jupiterValidatedTransactionV2{}, errors.New("reviewed Agent Capital transaction is invalid")
	}
	tx, err := solana.TransactionFromBytes(raw)
	if err != nil || tx.Message.Header.NumRequiredSignatures != 1 || len(tx.Signatures) != 1 || !tx.Signatures[0].IsZero() {
		return jupiterValidatedTransactionV2{}, errors.New("reviewed Agent Capital signer layout is invalid")
	}
	expected, err := buildAgentCapitalUnsignedTransactionV2(rpcURLs, wallet, intent, &tx.Message.RecentBlockhash)
	if err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	expectedEnvelope, expectedRaw, err := typedTransactionEnvelopeV2(expected)
	if err != nil || len(raw) != len(expectedRaw) || subtle.ConstantTimeCompare(raw, expectedRaw) != 1 {
		return jupiterValidatedTransactionV2{}, errors.New("reviewed Agent Capital transaction changed")
	}
	if !equalSortedStringsV2(envelope.Programs, expectedEnvelope.Programs) || !equalSortedStringsV2(envelope.WritableAccounts, expectedEnvelope.WritableAccounts) {
		return jupiterValidatedTransactionV2{}, errors.New("Agent Capital transaction manifest changed")
	}
	if err := simulateTypedTransferReviewV2(rpcURLs, tx); err != nil {
		return jupiterValidatedTransactionV2{}, fmt.Errorf("reviewed Agent Capital simulation failed: %w", err)
	}
	return jupiterValidatedTransactionV2{Transaction: tx, RawUnsigned: raw, Programs: expectedEnvelope.Programs, Writable: expectedEnvelope.WritableAccounts, WalletSignerIndex: 0}, nil
}

func agentCapitalArtifactDigestV2(validated jupiterValidatedTransactionV2) string {
	digest := sha256.Sum256(validated.RawUnsigned)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func compareAgentCapitalReviewStateV2(review signerReviewV2, current normalizedIntentV2, snapshot signerOwnedAccountSnapshotV2) error {
	if review.StateDigest == "" || subtle.ConstantTimeCompare([]byte(review.StateDigest), []byte(snapshot.Digest)) != 1 {
		return errors.New("Agent Capital state changed after review")
	}
	if review.Asset != current.Asset || review.Amount != current.Amount.String() || review.Destination != current.Destination || review.PolicyOperation != current.PolicyOperation {
		return errors.New("Agent Capital reviewed effect changed")
	}
	return nil
}
