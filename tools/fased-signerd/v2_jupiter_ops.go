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
	hydratedIntent, err := s.hydrateTypedTransferIntentV2(req.Intent, walletID)
	if err != nil {
		return signerReviewV2{}, err
	}
	intent, err := normalizeSignerIntentForWalletV2(hydratedIntent, &walletPublicKey)
	if err != nil {
		return signerReviewV2{}, err
	}
	var validated jupiterValidatedTransactionV2
	var transaction signerSolanaTransactionEnvelopeV2
	var artifact signerReviewArtifactInputV2
	switch {
	case intent.Intent.Type == intentSolanaJupiterSwap:
		rpcURLs, networkErr := s.keys.SolanaRPCURLsV2(walletID)
		if networkErr != nil {
			return signerReviewV2{}, errSignerNetworkPendingV2
		}
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
		if err == nil {
			digest := sha256.Sum256(validated.RawUnsigned)
			artifact = signerReviewArtifactInputV2{
				WalletPublicKey: wallet.PublicKey, Kind: signerReviewArtifactSolanaTransactionV2,
				Digest: "sha256:" + hex.EncodeToString(digest[:]), Transaction: &transaction,
			}
		}
	case isSignerOwnedTriggerIntentV2(intent):
		return s.prepareSignerOwnedTriggerReviewV2(walletID, req, walletPublicKey, intent)
	case isTypedTransferIntentV2(intent.Intent.Type):
		rpcURLs, networkErr := s.keys.SolanaRPCURLsV2(walletID)
		if networkErr != nil {
			return signerReviewV2{}, errSignerNetworkPendingV2
		}
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
		if err == nil {
			digest := sha256.Sum256(validated.RawUnsigned)
			artifact = signerReviewArtifactInputV2{
				WalletPublicKey: wallet.PublicKey, Kind: signerReviewArtifactSolanaTransactionV2,
				Digest: "sha256:" + hex.EncodeToString(digest[:]), Transaction: &transaction,
			}
		}
	default:
		return signerReviewV2{}, errors.New("review.prepare supports typed Jupiter and signer-built SOL/SPL transfers")
	}
	if err != nil {
		return signerReviewV2{}, err
	}
	return s.store.prepareArtifactReviewV2(walletID, req, intent, artifact)
}

func (s *signerServiceV2) executeJupiterReviewV2(
	walletID string,
	req signerReviewExecuteRequestV2,
) (signerReviewExecutionResultV2, error) {
	if terminal, lookupErr := s.store.getOperation(req.RequestID); lookupErr == nil && terminal.State != operationReserved {
		review, intent, reviewErr := s.store.getReviewV2(walletID, req.RequestID)
		if reviewErr != nil {
			return signerReviewExecutionResultV2{}, reviewErr
		}
		if terminal.WalletID != normalizeWalletID(walletID) || terminal.IntentType != intent.Intent.Type ||
			terminal.IntentDigest != intent.Digest || terminal.PolicyHash != review.PolicyHash ||
			terminal.Asset != intent.Asset || terminal.Amount != intent.Amount.String() {
			return signerReviewExecutionResultV2{}, errors.New("terminal signer operation does not match its immutable review")
		}
		wallet, walletErr := s.keys.PublicRecord(walletID)
		if walletErr != nil {
			return signerReviewExecutionResultV2{}, walletErr
		}
		result := signerReviewExecutionResultV2{Review: review, Operation: &terminal, Signer: wallet.PublicKey}

		return result, nil
	} else if lookupErr != nil && !errors.Is(lookupErr, errSignerOperationNotFoundV2) {
		return signerReviewExecutionResultV2{}, lookupErr
	}
	review, intent, policy, err := s.store.requirePreparedReviewV2(walletID, req.RequestID)
	if err != nil {
		if _, terminalErr := s.store.terminalizeInvalidReviewedReservationV2(walletID, req.RequestID, err); terminalErr != nil {
			return signerReviewExecutionResultV2{}, fmt.Errorf("%v; recover invalid reviewed reservation: %w", err, terminalErr)
		}
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
	if review.WalletPublicKey != "" && review.WalletPublicKey != wallet.PublicKey {
		return signerReviewExecutionResultV2{}, errors.New("prepared signer review wallet key is no longer current")
	}
	walletPublicKey := solana.MustPublicKeyFromBase58(walletKey)
	artifact, err := normalizeStoredReviewArtifactV2(review)
	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	var validated jupiterValidatedTransactionV2
	var rpcURLs []string
	switch {
	case intent.Intent.Type == intentSolanaJupiterSwap:
		rpcURLs, err = s.keys.SolanaRPCURLsV2(walletID)
		if err != nil {
			return signerReviewExecutionResultV2{}, errSignerNetworkPendingV2
		}
		if intent.Intent.Jupiter == nil || wallet.PublicKey != intent.Intent.Jupiter.Owner {
			return signerReviewExecutionResultV2{}, errors.New("review intent owner does not match signer-owned wallet")
		}
		if artifact.Transaction == nil {
			return signerReviewExecutionResultV2{}, errors.New("stored signer review transaction is missing")
		}
		validated, err = validateAndSimulateJupiterTransactionV2(rpcURLs, walletPublicKey, intent, *artifact.Transaction)
	case isSignerOwnedTriggerIntentV2(intent):
		if artifact.Kind != signerReviewArtifactTriggerStateV2 || artifact.Transaction != nil || review.StateDigest == "" {
			return signerReviewExecutionResultV2{}, errors.New("stored Jupiter Trigger review is not bound to signer-owned state")
		}
	case isTypedTransferIntentV2(intent.Intent.Type):
		rpcURLs, err = s.keys.SolanaRPCURLsV2(walletID)
		if err != nil {
			return signerReviewExecutionResultV2{}, errSignerNetworkPendingV2
		}
		if artifact.Transaction == nil {
			return signerReviewExecutionResultV2{}, errors.New("stored signer review transaction is missing")
		}
		validated, err = validateAndSimulateTypedTransferReviewV2(rpcURLs, walletPublicKey, intent, *artifact.Transaction)
	default:
		return signerReviewExecutionResultV2{}, errors.New("stored signer review intent is unsupported")
	}
	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	if artifact.Kind == signerReviewArtifactSolanaTransactionV2 && !isJupiterIntentTypeV2(intent.Intent.Type) {
		if err := validateSignerNativeSpendV2(rpcURLs, validated.Transaction, walletPublicKey, intent); err != nil {
			return signerReviewExecutionResultV2{}, err
		}
	}
	if artifact.Kind == signerReviewArtifactSolanaTransactionV2 {
		unsignedDigestBytes := sha256.Sum256(validated.RawUnsigned)
		if artifact.Digest != "sha256:"+hex.EncodeToString(unsignedDigestBytes[:]) {
			return signerReviewExecutionResultV2{}, errors.New("stored signer review transaction digest mismatch")
		}
	}
	var reviewedBinding signerReviewBindingV2
	controlUIAuthorization := false
	if review.Mode == jupiterReviewModeAutonomousV2 {
		if err := requireAutonomousRoleV2(policy, intent); err != nil {
			return signerReviewExecutionResultV2{}, err
		}
		if req.Authorization != nil {
			return signerReviewExecutionResultV2{}, errors.New("autonomous execution cannot accept a WebAuthn authorization proof")
		}
	} else {
		if review.Mode != jupiterReviewModeReviewedV2 || req.Authorization == nil {
			return signerReviewExecutionResultV2{}, errors.New("reviewed signing requires an exact owner confirmation")
		}
		switch req.Authorization.Type {
		case "webauthn":
			if s.webauthn == nil {
				return signerReviewExecutionResultV2{}, errors.New("signer-owned WebAuthn is unavailable")
			}
			reviewedBinding, err = reviewBindingFromStoredReviewV2(review, policy)
			if err != nil {
				return signerReviewExecutionResultV2{}, err
			}
		case "control-ui":
			if !allowsControlUIReviewIntentV2(intent.Intent, policy.Role) {
				return signerReviewExecutionResultV2{}, errors.New("Control UI confirmation is restricted to exact reviewed transfers")
			}
			if s.webauthn != nil {
				health, healthErr := s.webauthn.health()
				if healthErr != nil {
					return signerReviewExecutionResultV2{}, healthErr
				}
				if health.CredentialCount > 0 {
					return signerReviewExecutionResultV2{}, errors.New("this wallet has a signer-owned approval device; WebAuthn authorization is required")
				}
			}
			controlUIAuthorization = true
		default:
			return signerReviewExecutionResultV2{}, errors.New("unsupported reviewed authorization type")
		}
	}

	operation, existing, err := s.store.reserveOperation(signerExecuteRequestV2{
		RequestID:      req.RequestID,
		PolicyHash:     review.PolicyHash,
		Intent:         intent.Intent,
		intentWalletID: walletID,
		reviewed:       review.Mode == jupiterReviewModeReviewedV2,
	}, intent)
	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	if existing && operation.State != operationReserved {
		return signerReviewExecutionResultV2{Review: review, Operation: &operation, Signer: wallet.PublicKey}, nil
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
		var proofErr error
		if controlUIAuthorization {
			proofErr = s.store.authorizeControlUIReviewOperationV2(
				review,
				policy,
				intent,
				req.Authorization.Proof.ProofID,
				operation.RequestID,
				attempt,
			)
		} else {
			proofErr = s.webauthn.authorizeReviewOperationV2(reviewedBinding, &req.Authorization.Proof, operation.RequestID, attempt)
		}
		if proofErr != nil {
			_, _ = s.store.markFailedClaim(operation.RequestID, attempt, proofErr)
			return signerReviewExecutionResultV2{}, proofErr
		}
	}

	if isSignerOwnedTriggerIntentV2(intent) {
		currentStateDigest, _, stateErr := s.jupiterTriggerReviewStateV2(walletID, walletPublicKey, intent, privateKey)
		if stateErr == nil && currentStateDigest != review.StateDigest {
			stateErr = errors.New("Jupiter Trigger state changed after reviewed authorization was prepared")
		}
		if stateErr != nil {
			_, _ = s.store.markFailedClaim(operation.RequestID, attempt, stateErr)
			return signerReviewExecutionResultV2{}, stateErr
		}
		triggerRequest := signerExecuteRequestV2{
			RequestID: req.RequestID, PolicyHash: review.PolicyHash,
			Intent: intent.Intent, intentWalletID: walletID,
		}
		if _, ensureErr := s.store.ensureJupiterTriggerWorkflowV2(triggerRequest, intent, review.StateDigest); ensureErr != nil {
			_, _ = s.store.markFailedClaim(operation.RequestID, attempt, ensureErr)
			return signerReviewExecutionResultV2{}, ensureErr
		}
		operation, err = s.continueJupiterTriggerWorkflowV2(
			triggerRequest,
			intent,
			policy,
			walletPublicKey,
			privateKey,
			operation,
			attempt,
		)
		if err != nil {
			return signerReviewExecutionResultV2{Review: review, Operation: &operation, Signer: wallet.PublicKey}, err
		}
		if operation.Signature != "" && review.State == jupiterReviewPreparedV2 {
			review, err = s.store.markReviewSignedV2(review.RequestID, artifact.Digest, operation.Signature)
			if err != nil {
				return signerReviewExecutionResultV2{Review: review, Operation: &operation, Signer: wallet.PublicKey}, err
			}
		}
		return signerReviewExecutionResultV2{Review: review, Operation: &operation, Signer: wallet.PublicKey}, nil
	}

	var signedRaw []byte
	var signature solana.Signature

	signedRaw, signature, err = signValidatedJupiterTransactionV2(validated, privateKey)

	if err != nil {
		failed, markErr := s.store.markFailedClaim(operation.RequestID, attempt, err)
		if markErr != nil {
			return signerReviewExecutionResultV2{}, fmt.Errorf("%v; persist signer failure: %w", err, markErr)
		}
		return signerReviewExecutionResultV2{Operation: &failed}, err
	}
	signedDigestBytes := sha256.Sum256(signedRaw)
	signedDigest := "sha256:" + hex.EncodeToString(signedDigestBytes[:])
	defer zeroBytes(signedRaw)

	signedTxBase64 := base64.StdEncoding.EncodeToString(signedRaw)
	operation, err = s.store.markBroadcastClaim(operation.RequestID, attempt, signature.String(), signedDigest, signedTxBase64)

	if err != nil {
		return signerReviewExecutionResultV2{}, err
	}
	review, err = s.store.markReviewSignedV2(review.RequestID, artifact.Digest, signature.String())
	if err != nil {
		return signerReviewExecutionResultV2{Operation: &operation}, err
	}
	result := signerReviewExecutionResultV2{
		Review:    review,
		Operation: &operation,
		Signer:    wallet.PublicKey,
	}

	envelope := review.Transaction
	if envelope == nil {
		return result, errors.New("signed signer review transaction envelope is missing")
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
