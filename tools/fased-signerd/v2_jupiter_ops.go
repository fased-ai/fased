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
	intent, err := normalizeSignerIntentV2(req.Intent)
	if err != nil {
		return signerReviewV2{}, err
	}
	if !isJupiterIntentTypeV2(intent.Intent.Type) {
		return signerReviewV2{}, errors.New("review.prepare currently accepts only typed Jupiter intents")
	}
	wallet, err := s.keys.PublicRecord(walletID)
	if err != nil {
		return signerReviewV2{}, err
	}
	if intent.Intent.Jupiter == nil || wallet.PublicKey != intent.Intent.Jupiter.Owner {
		return signerReviewV2{}, errors.New("review intent owner does not match signer-owned wallet")
	}
	return s.store.prepareReviewV2(walletID, req, intent)
}

func (s *signerServiceV2) executeJupiterReviewV2(
	walletID string,
	req signerReviewExecuteRequestV2,
) (signerReviewExecutionResultV2, error) {
	intent, err := normalizeSignerIntentV2(req.Intent)
	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	if !isJupiterIntentTypeV2(intent.Intent.Type) {
		return signerReviewExecutionResultV2{}, errors.New("review.execute currently accepts only typed Jupiter intents")
	}
	review, err := s.store.requirePreparedReviewV2(walletID, req, intent)
	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	wallet, err := s.keys.PublicRecord(walletID)
	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	if intent.Intent.Jupiter == nil || wallet.PublicKey != intent.Intent.Jupiter.Owner {
		return signerReviewExecutionResultV2{}, errors.New("review intent owner does not match signer-owned wallet")
	}
	walletKey, err := normalizePublicKeyV2(wallet.PublicKey, "signer wallet")
	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	rpcURLs, err := s.keys.SolanaRPCURLsV2(walletID)
	if err != nil {
		return signerReviewExecutionResultV2{}, errSignerNetworkPendingV2
	}
	validated, err := validateAndSimulateJupiterTransactionV2(
		rpcURLs,
		solana.MustPublicKeyFromBase58(walletKey),
		intent,
		req.Transaction,
	)
	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	unsignedDigestBytes := sha256.Sum256(validated.RawUnsigned)
	unsignedDigest := "sha256:" + hex.EncodeToString(unsignedDigestBytes[:])
	policy, err := s.store.getPolicy(walletID)
	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	if err := authorizeJupiterReviewExecutionV2(review, policy, unsignedDigest, req.Authorization); err != nil {
		return signerReviewExecutionResultV2{}, err
	}

	operation, existing, err := s.store.reserveOperation(signerExecuteRequestV2{
		RequestID:      req.RequestID,
		PolicyHash:     req.PolicyHash,
		Intent:         intent.Intent,
		intentWalletID: walletID,
	}, intent)
	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	if existing {
		return signerReviewExecutionResultV2{}, fmt.Errorf("signer operation is already %s; transaction will not be signed or submitted again", operation.State)
	}

	privateKey, _, err := s.keys.privateKey(walletID)
	if err != nil {
		_, _ = s.store.markFailed(operation.RequestID, err)
		return signerReviewExecutionResultV2{}, err
	}
	defer zeroBytes(privateKey)
	signedRaw, signature, err := signValidatedJupiterTransactionV2(validated, privateKey)
	if err != nil {
		failed, markErr := s.store.markFailed(operation.RequestID, err)
		if markErr != nil {
			return signerReviewExecutionResultV2{}, fmt.Errorf("%v; persist signer failure: %w", err, markErr)
		}
		return signerReviewExecutionResultV2{Operation: &failed}, err
	}
	signedDigestBytes := sha256.Sum256(signedRaw)
	signedDigest := "sha256:" + hex.EncodeToString(signedDigestBytes[:])
	operation, err = s.store.markBroadcast(operation.RequestID, signature.String(), signedDigest)
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

	envelope, _ := normalizeTransactionEnvelopeV2(req.Transaction)
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
