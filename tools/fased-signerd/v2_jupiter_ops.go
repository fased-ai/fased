package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"

	solana "github.com/gagliardetto/solana-go"
)

func (s *signerServiceV2) prepareJupiterReviewV2(walletID string, req signerReviewPrepareRequestV2) (signerReviewV2, error) {
	wallet, err := s.keys.PublicRecord(walletID)
	if err != nil {
		return signerReviewV2{}, err
	}
	walletKey, err := normalizePublicKeyV2(wallet.PublicKey, "signer wallet")
	if err != nil {
		return signerReviewV2{}, err
	}
	walletPublicKey := solana.MustPublicKeyFromBase58(walletKey)
	intent, err := normalizeSignerIntentForWalletV2(req.Intent, &walletPublicKey)
	if err != nil {
		return signerReviewV2{}, err
	}
	rpcURLs, err := s.keys.SolanaRPCURLsV2(walletID)
	if err != nil {
		return signerReviewV2{}, errSignerNetworkPendingV2
	}
	var validated jupiterValidatedTransactionV2
	var transaction signerSolanaTransactionEnvelopeV2
	switch {
	case isJupiterIntentTypeV2(intent.Intent.Type):
		if intent.Intent.Jupiter == nil || wallet.PublicKey != intent.Intent.Jupiter.Owner {
			return signerReviewV2{}, errors.New("review intent owner does not match signer-owned wallet")
		}
		if req.Transaction == nil {
			return signerReviewV2{}, errors.New("typed Jupiter review requires the exact serialized transaction")
		}
		validated, err = validateAndSimulateJupiterTransactionV2(rpcURLs, walletPublicKey, intent, *req.Transaction)
		if err == nil {
			transaction, err = normalizeTransactionEnvelopeV2(*req.Transaction)
		}
	case isTypedTransferIntentV2(intent.Intent.Type):
		if req.Transaction != nil {
			return signerReviewV2{}, errors.New("reviewed SOL/SPL transfers are built only by the signer")
		}
		if mode, modeErr := normalizeReviewModeV2(req.Mode); modeErr != nil || mode != jupiterReviewModeReviewedV2 {
			return signerReviewV2{}, errors.New("signer-built SOL/SPL transfers require reviewed mode")
		}
		unsigned, buildErr := buildTypedUnsignedTransactionV2(rpcURLs, walletPublicKey, intent, nil)
		if buildErr != nil {
			return signerReviewV2{}, buildErr
		}
		transaction, _, err = typedTransactionEnvelopeV2(unsigned)
		if err == nil {
			validated, err = validateAndSimulateTypedTransferReviewV2(rpcURLs, walletPublicKey, intent, transaction)
		}
	default:
		return signerReviewV2{}, errors.New("review.prepare supports typed Jupiter and signer-built SOL/SPL transfers")
	}
	if err != nil {
		return signerReviewV2{}, err
	}
	unsignedDigestBytes := sha256.Sum256(validated.RawUnsigned)
	unsignedDigest := "sha256:" + hex.EncodeToString(unsignedDigestBytes[:])
	return s.store.prepareReviewV2(walletID, req, intent, transaction, unsignedDigest)
}

func (s *signerServiceV2) executeJupiterReviewV2(
	walletID string,
	req signerReviewExecuteRequestV2,
) (signerReviewExecutionResultV2, error) {
	review, intent, policy, err := s.store.requirePreparedReviewV2(walletID, req.RequestID)
	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	wallet, err := s.keys.PublicRecord(walletID)
	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	walletKey, err := normalizePublicKeyV2(wallet.PublicKey, "signer wallet")
	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	rpcURLs, err := s.keys.SolanaRPCURLsV2(walletID)
	if err != nil {
		return signerReviewExecutionResultV2{}, errSignerNetworkPendingV2
	}
	walletPublicKey := solana.MustPublicKeyFromBase58(walletKey)
	var validated jupiterValidatedTransactionV2
	switch {
	case isJupiterIntentTypeV2(intent.Intent.Type):
		if intent.Intent.Jupiter == nil || wallet.PublicKey != intent.Intent.Jupiter.Owner {
			return signerReviewExecutionResultV2{}, errors.New("review intent owner does not match signer-owned wallet")
		}
		validated, err = validateAndSimulateJupiterTransactionV2(rpcURLs, walletPublicKey, intent, review.Transaction)
	case isTypedTransferIntentV2(intent.Intent.Type):
		validated, err = validateAndSimulateTypedTransferReviewV2(rpcURLs, walletPublicKey, intent, review.Transaction)
	default:
		return signerReviewExecutionResultV2{}, errors.New("stored signer review intent is unsupported")
	}
	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	unsignedDigestBytes := sha256.Sum256(validated.RawUnsigned)
	unsignedDigest := "sha256:" + hex.EncodeToString(unsignedDigestBytes[:])
	if review.TransactionDigest != unsignedDigest {
		return signerReviewExecutionResultV2{}, errors.New("stored signer review transaction digest mismatch")
	}
	var reviewedBinding signerReviewBindingV2
	if review.Mode == jupiterReviewModeAutonomousV2 {
		if policy.Role != "agent" {
			return signerReviewExecutionResultV2{}, errors.New("autonomous signer execution is restricted to Agent-role wallets")
		}
		if req.Authorization != nil {
			return signerReviewExecutionResultV2{}, errors.New("autonomous execution cannot accept a WebAuthn authorization proof")
		}
	} else {
		if review.Mode != jupiterReviewModeReviewedV2 || req.Authorization == nil || req.Authorization.Type != "webauthn" {
			return signerReviewExecutionResultV2{}, errors.New("reviewed signing requires a signer-owned WebAuthn authorization proof")
		}
		if s.webauthn == nil {
			return signerReviewExecutionResultV2{}, errors.New("signer-owned WebAuthn is unavailable")
		}
		reviewedBinding, err = reviewBindingFromStoredReviewV2(review, policy)
		if err != nil {
			return signerReviewExecutionResultV2{}, err
		}
	}

	operation, existing, err := s.store.reserveOperation(signerExecuteRequestV2{
		RequestID:      req.RequestID,
		PolicyHash:     review.PolicyHash,
		Intent:         intent.Intent,
		intentWalletID: walletID,
	}, intent)
	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	if existing && operation.State != operationReserved {
		return signerReviewExecutionResultV2{}, fmt.Errorf("signer operation is already %s; transaction will not be signed or submitted again", operation.State)
	}
	operation, attempt, claimed, err := s.store.claimReservedOperation(operation.RequestID)
	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	if !claimed {
		return signerReviewExecutionResultV2{}, errors.New("signer operation already has an active execution attempt")
	}

	privateKey, _, err := s.keys.privateKey(walletID)
	if err != nil {
		_, _ = s.store.markFailedClaim(operation.RequestID, attempt, err)
		return signerReviewExecutionResultV2{}, err
	}
	defer zeroBytes(privateKey)
	if review.Mode == jupiterReviewModeReviewedV2 {
		if proofErr := s.webauthn.verifyAndConsumeReviewProofV2(reviewedBinding, &req.Authorization.Proof); proofErr != nil {
			_, _ = s.store.markFailedClaim(operation.RequestID, attempt, proofErr)
			return signerReviewExecutionResultV2{}, proofErr
		}
	}
	signedRaw, signature, err := signValidatedJupiterTransactionV2(validated, privateKey)
	if err != nil {
		failed, markErr := s.store.markFailedClaim(operation.RequestID, attempt, err)
		if markErr != nil {
			return signerReviewExecutionResultV2{}, fmt.Errorf("%v; persist signer failure: %w", err, markErr)
		}
		return signerReviewExecutionResultV2{Operation: &failed}, err
	}
	signedDigestBytes := sha256.Sum256(signedRaw)
	signedDigest := "sha256:" + hex.EncodeToString(signedDigestBytes[:])
	operation, err = s.store.markBroadcastClaim(operation.RequestID, attempt, signature.String(), signedDigest)
	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	review, err = s.store.markReviewSignedV2(review.RequestID, unsignedDigest, signature.String())
	if err != nil {
		return signerReviewExecutionResultV2{Operation: &operation}, err
	}
	result := signerReviewExecutionResultV2{
		Review:    review,
		Operation: &operation,
		Signer:    wallet.PublicKey,
	}

	envelope := review.Transaction
	if envelope.Submission == jupiterSubmissionReturnV2 {
		// The operation is durably marked broadcast before signed bytes cross the
		// signer boundary. A lost/ambiguous Jupiter API response must be
		// reconciled by signature and must never trigger another signing attempt.
		result.SignedTxBase64 = base64.StdEncoding.EncodeToString(signedRaw)
		return result, nil
	}

	if err := broadcastSignedOnceV2(rpcURLs, signedRaw, signature); err != nil {
		safeErr := errors.New("signer-owned Solana RPC broadcast result is ambiguous")
		unknown, markErr := s.store.markUnknown(operation.RequestID, safeErr)
		result.Operation = &unknown
		if markErr != nil {
			return result, fmt.Errorf("%v; persist ambiguous Jupiter result: %w", safeErr, markErr)
		}
		return result, nil
	}
	if err := confirmSignerSolanaSignatureAcrossRPCsV2(rpcURLs, signature); err != nil {
		status, statusErr := lookupSignatureStatusV2(rpcURLs, signature)
		if statusErr == nil && status == "confirmed" {
			confirmed, markErr := s.store.markConfirmed(operation.RequestID)
			result.Operation = &confirmed
			return result, markErr
		}
		unknown, markErr := s.store.markUnknown(operation.RequestID, err)
		result.Operation = &unknown
		return result, markErr
	}
	confirmed, err := s.store.markConfirmed(operation.RequestID)
	result.Operation = &confirmed
	return result, err
}
