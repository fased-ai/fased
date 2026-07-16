package main

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"

	solana "github.com/gagliardetto/solana-go"
	rpc "github.com/gagliardetto/solana-go/rpc"
)

func isTypedTransferIntentV2(intentType string) bool {
	switch intentType {
	case intentSolanaNativeTransfer, intentSolanaSPLTransferChecked:
		return true
	default:
		return false
	}
}

func buildTypedUnsignedTransactionV2(
	rpcURLs []string,
	wallet solana.PublicKey,
	intent normalizedIntentV2,
	recentBlockhash *solana.Hash,
) (*solana.Transaction, error) {
	if !isTypedTransferIntentV2(intent.Intent.Type) {
		return nil, errors.New("reviewed typed transaction must be a native SOL or SPL transfer")
	}
	var decimals *uint8
	if intent.Intent.Type == intentSolanaSPLTransferChecked {
		tokenProgram := solana.MustPublicKeyFromBase58(intent.Intent.TokenProgram)
		mint := solana.MustPublicKeyFromBase58(intent.Intent.Mint)
		resolvedDecimals, err := resolveMintDecimalsV2(rpcURLs, mint, tokenProgram)
		if err != nil {
			return nil, err
		}
		decimals = &resolvedDecimals
	}
	instructions, err := buildTypedInstructionsV2(wallet, intent, decimals)
	if err != nil {
		return nil, err
	}
	blockhash := solana.Hash{}
	if recentBlockhash == nil {
		blockhash, err = signerLatestBlockhashWithFallbackV2(rpcURLs)
		if err != nil {
			return nil, err
		}
	} else {
		blockhash = *recentBlockhash
	}
	tx, err := solana.NewTransaction(instructions, blockhash, solana.TransactionPayer(wallet))
	if err != nil {
		return nil, err
	}
	if tx.Message.Header.NumRequiredSignatures != 1 {
		return nil, errors.New("reviewed typed transaction must require exactly the signer-owned wallet")
	}
	tx.Signatures = make([]solana.Signature, 1)
	return tx, nil
}

func typedTransactionEnvelopeV2(tx *solana.Transaction) (signerSolanaTransactionEnvelopeV2, []byte, error) {
	if tx == nil {
		return signerSolanaTransactionEnvelopeV2{}, nil, errors.New("reviewed typed transaction is missing")
	}
	raw, err := tx.MarshalBinary()
	if err != nil || len(raw) == 0 || len(raw) > 1232 {
		return signerSolanaTransactionEnvelopeV2{}, nil, errors.New("reviewed typed transaction is invalid or too large")
	}
	programs := make([]string, 0, len(tx.Message.Instructions))
	for _, instruction := range tx.Message.Instructions {
		program, err := tx.Message.Program(instruction.ProgramIDIndex)
		if err != nil {
			return signerSolanaTransactionEnvelopeV2{}, nil, errors.New("reviewed typed transaction program index is invalid")
		}
		programs = append(programs, program.String())
	}
	programs, err = normalizeSortedStringsV2(programs, func(raw string) (string, error) {
		return normalizePublicKeyV2(raw, "transaction program")
	})
	if err != nil || len(programs) == 0 {
		return signerSolanaTransactionEnvelopeV2{}, nil, errors.New("reviewed typed transaction program manifest is invalid")
	}
	writable, err := tx.Message.Writable()
	if err != nil || len(writable) == 0 {
		return signerSolanaTransactionEnvelopeV2{}, nil, errors.New("reviewed typed transaction writable accounts are invalid")
	}
	envelope := signerSolanaTransactionEnvelopeV2{
		SerializedTxBase64: base64.StdEncoding.EncodeToString(raw),
		Programs:           programs,
		WritableAccounts:   publicKeyStringsSortedV2(writable),
		Submission:         jupiterSubmissionRPCV2,
	}
	normalized, err := normalizeTransactionEnvelopeV2(envelope)
	return normalized, raw, err
}

func validateAndSimulateTypedTransferReviewV2(
	rpcURLs []string,
	wallet solana.PublicKey,
	intent normalizedIntentV2,
	envelopeInput signerSolanaTransactionEnvelopeV2,
) (jupiterValidatedTransactionV2, error) {
	if !isTypedTransferIntentV2(intent.Intent.Type) {
		return jupiterValidatedTransactionV2{}, errors.New("reviewed typed transaction must be a native SOL or SPL transfer")
	}
	envelope, err := normalizeTransactionEnvelopeV2(envelopeInput)
	if err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	if envelope.Submission != jupiterSubmissionRPCV2 {
		return jupiterValidatedTransactionV2{}, errors.New("reviewed typed transfers require signer-owned RPC submission")
	}
	raw, err := base64.StdEncoding.DecodeString(envelope.SerializedTxBase64)
	if err != nil || len(raw) == 0 || len(raw) > 1232 {
		return jupiterValidatedTransactionV2{}, errors.New("serialized Solana transaction is invalid or exceeds the signer limit")
	}
	tx, err := solana.TransactionFromBytes(raw)
	if err != nil {
		return jupiterValidatedTransactionV2{}, errors.New("decode reviewed typed Solana transaction")
	}
	if tx.Message.IsVersioned() || len(tx.Message.GetAddressTableLookups()) != 0 ||
		tx.Message.Header.NumRequiredSignatures != 1 || len(tx.Signatures) != 1 ||
		len(tx.Message.AccountKeys) == 0 || !tx.Message.AccountKeys[0].Equals(wallet) ||
		!tx.Signatures[0].IsZero() {
		return jupiterValidatedTransactionV2{}, errors.New("reviewed typed transaction signer layout is invalid")
	}
	expected, err := buildTypedUnsignedTransactionV2(rpcURLs, wallet, intent, &tx.Message.RecentBlockhash)
	if err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	expectedEnvelope, expectedRaw, err := typedTransactionEnvelopeV2(expected)
	if err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	if len(raw) != len(expectedRaw) || subtle.ConstantTimeCompare(raw, expectedRaw) != 1 {
		return jupiterValidatedTransactionV2{}, errors.New("stored typed transaction does not exactly match reviewed transfer semantics")
	}
	if !equalSortedStringsV2(envelope.Programs, expectedEnvelope.Programs) ||
		!equalSortedStringsV2(envelope.WritableAccounts, expectedEnvelope.WritableAccounts) {
		return jupiterValidatedTransactionV2{}, errors.New("stored typed transaction manifest does not match decoded transaction")
	}
	if err := simulateTypedTransferReviewV2(rpcURLs, tx); err != nil {
		return jupiterValidatedTransactionV2{}, err
	}
	return jupiterValidatedTransactionV2{
		Transaction:       tx,
		RawUnsigned:       raw,
		Programs:          expectedEnvelope.Programs,
		Writable:          expectedEnvelope.WritableAccounts,
		WalletSignerIndex: 0,
	}, nil
}

func simulateTypedTransferReviewV2(rpcURLs []string, tx *solana.Transaction) error {
	active, err := activeSolanaWriteRPCURLs(rpcURLs)
	if err != nil {
		return err
	}
	for _, rpcURL := range active {
		client := newSignerOwnedSolanaRPCClientV2(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		response, requestErr := client.SimulateTransactionWithOpts(ctx, tx, &rpc.SimulateTransactionOpts{
			SigVerify:  false,
			Commitment: rpc.CommitmentConfirmed,
		})
		cancel()
		if requestErr != nil || response == nil || response.Value == nil {
			markSolanaWriteRPCFailure(rpcURL, requestErr)
			continue
		}
		if response.Value.Err != nil {
			markSolanaWriteRPCFailure(rpcURL, fmt.Errorf("simulation failed: %v", response.Value.Err))
			return fmt.Errorf("reviewed typed transaction simulation failed: %v", response.Value.Err)
		}
		markSolanaWriteRPCSuccess(rpcURL)
		return nil
	}
	return errors.New("signer-owned Solana RPC simulation failed")
}
