package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"

	"fased-signerd/internal/execution"

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
	case intent.Intent.Type == intentSolanaVaultBondAction:
		if req.Transaction != nil {
			return signerReviewV2{}, errors.New("reviewed Vault bond transactions are built only by the signer")
		}
		if mode, modeErr := normalizeReviewModeV2(req.Mode); modeErr != nil || mode != jupiterReviewModeReviewedV2 {
			return signerReviewV2{}, errors.New("Vault bond actions require reviewed mode")
		}
		rpcURLs, networkErr := s.keys.SolanaRPCURLsV2(walletID)
		if networkErr != nil {
			return signerReviewV2{}, errSignerNetworkPendingV2
		}
		var snapshot signerOwnedAccountSnapshotV2
		var verifiedRPCs []string
		intent, snapshot, verifiedRPCs, err = resolveVaultBondReviewStateV2(rpcURLs, walletPublicKey, intent)
		if err == nil {
			var unsigned *solana.Transaction
			unsigned, err = buildVaultBondUnsignedTransactionV2(verifiedRPCs, walletPublicKey, intent, nil)
			if err == nil {
				transaction, _, err = typedTransactionEnvelopeV2(unsigned)
			}
		}
		if err == nil {
			validated, err = validateAndSimulateVaultBondReviewV2(verifiedRPCs, walletPublicKey, intent, transaction)
		}
		if err == nil {
			artifact = signerReviewArtifactInputV2{
				WalletPublicKey: wallet.PublicKey, Kind: signerReviewArtifactSolanaTransactionV2,
				Digest: vaultBondReviewArtifactDigestV2(validated), Transaction: &transaction,
				StateDigest: snapshot.Digest, StateSlot: snapshot.Slot,
			}
		}
	case intent.Intent.Type == intentSolanaAgentCapitalAction:
		if req.Transaction != nil {
			return signerReviewV2{}, errors.New("reviewed Agent Capital transactions are built only by the signer")
		}
		if mode, modeErr := normalizeReviewModeV2(req.Mode); modeErr != nil || mode != jupiterReviewModeReviewedV2 {
			return signerReviewV2{}, errors.New("Agent Capital actions require reviewed mode")
		}
		rpcURLs, networkErr := s.keys.SolanaRPCURLsV2(walletID)
		if networkErr != nil {
			return signerReviewV2{}, errSignerNetworkPendingV2
		}
		var snapshot signerOwnedAccountSnapshotV2
		var verifiedRPCs []string
		intent, snapshot, verifiedRPCs, err = resolveAgentCapitalReviewStateV2(rpcURLs, walletPublicKey, intent)
		if err == nil {
			var unsigned *solana.Transaction
			unsigned, err = buildAgentCapitalUnsignedTransactionV2(verifiedRPCs, walletPublicKey, intent, nil)
			if err == nil {
				transaction, _, err = typedTransactionEnvelopeV2(unsigned)
			}
		}
		if err == nil {
			validated, err = validateAndSimulateAgentCapitalReviewV2(verifiedRPCs, walletPublicKey, intent, transaction)
		}
		if err == nil {
			artifact = signerReviewArtifactInputV2{WalletPublicKey: wallet.PublicKey, Kind: signerReviewArtifactSolanaTransactionV2, Digest: agentCapitalArtifactDigestV2(validated), Transaction: &transaction, StateDigest: snapshot.Digest, StateSlot: snapshot.Slot}
		}
	case intent.Intent.Type == intentFederationBondChallenge:
		if req.Transaction != nil {
			return signerReviewV2{}, errors.New("federation bond challenge rejects transaction artifacts")
		}
		if mode, modeErr := normalizeReviewModeV2(req.Mode); modeErr != nil || mode != jupiterReviewModeReviewedV2 {
			return signerReviewV2{}, errors.New("federation bond challenges require reviewed mode")
		}
		if intent.Intent.Federation == nil || req.RequestID != federationBondChallengeRequestIDV2(intent.Intent.Federation.ChallengeID) {
			return signerReviewV2{}, errors.New("federation bond review requestId must be derived from the exact challengeId")
		}
		_, payload, decodeErr := federationPayloadFromIntentV2(intent)
		if decodeErr != nil {
			return signerReviewV2{}, decodeErr
		}
		if err = validateFederationBondChallengeTimeV2(payload, s.store.now()); err == nil {
			artifact, err = federationMessageArtifactV2(intent)
			artifact.WalletPublicKey = wallet.PublicKey
		}
	default:
		return signerReviewV2{}, errors.New("review.prepare supports typed Jupiter, signer-built SOL/SPL transfers, Vault bond actions, and federation bond challenges")
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
		if review.IntentType == intentFederationBondChallenge {
			result.SignatureBase64 = terminal.Signature
		}
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
	var message []byte
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
	case intent.Intent.Type == intentSolanaVaultBondAction:
		configuredRPCs, networkErr := s.keys.SolanaRPCURLsV2(walletID)
		if networkErr != nil {
			return signerReviewExecutionResultV2{}, errSignerNetworkPendingV2
		}
		var currentIntent normalizedIntentV2
		var snapshot signerOwnedAccountSnapshotV2
		currentIntent, snapshot, rpcURLs, err = resolveVaultBondReviewStateV2(configuredRPCs, walletPublicKey, intent)
		if err == nil {
			err = compareVaultBondReviewStateV2(review, currentIntent, snapshot)
		}
		if err == nil {
			intent = currentIntent
			if artifact.Transaction == nil {
				err = errors.New("stored Vault bond review transaction is missing")
			} else {
				validated, err = validateAndSimulateVaultBondReviewV2(rpcURLs, walletPublicKey, intent, *artifact.Transaction)
			}
		}
	case intent.Intent.Type == intentSolanaAgentCapitalAction:
		configuredRPCs, networkErr := s.keys.SolanaRPCURLsV2(walletID)
		if networkErr != nil {
			return signerReviewExecutionResultV2{}, errSignerNetworkPendingV2
		}
		var currentIntent normalizedIntentV2
		var snapshot signerOwnedAccountSnapshotV2
		currentIntent, snapshot, rpcURLs, err = resolveAgentCapitalReviewStateV2(configuredRPCs, walletPublicKey, intent)
		if err == nil {
			err = compareAgentCapitalReviewStateV2(review, currentIntent, snapshot)
		}
		if err == nil {
			intent = currentIntent
			if artifact.Transaction == nil {
				err = errors.New("stored Agent Capital review transaction is missing")
			} else {
				validated, err = validateAndSimulateAgentCapitalReviewV2(rpcURLs, walletPublicKey, intent, *artifact.Transaction)
			}
		}
	case intent.Intent.Type == intentFederationBondChallenge:
		if artifact.Kind != signerReviewArtifactDomainMessageV2 {
			return signerReviewExecutionResultV2{}, errors.New("federation review is not bound to a domain message")
		}
		message, err = decodeFederationReviewMessageV2(review)
		if err == nil && (len(message) != len(intent.Message) || subtle.ConstantTimeCompare(message, intent.Message) != 1) {
			err = errors.New("stored federation review payload does not match the exact semantic challenge")
		}
		if err == nil {
			_, payload, decodeErr := federationPayloadFromIntentV2(intent)
			if decodeErr != nil {
				err = decodeErr
			} else {
				err = validateFederationBondChallengeTimeV2(payload, s.store.now())
			}
		}
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
		if policy.Role != "agent" {
			return signerReviewExecutionResultV2{}, errors.New("autonomous signer execution is restricted to Agent-role wallets")
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
			if !isTypedTransferIntentV2(intent.Intent.Type) || (policy.Role != "agent" && policy.Role != "vault") {
				return signerReviewExecutionResultV2{}, errors.New("Control UI confirmation is restricted to exact reviewed Agent or Vault transfers")
			}
			if policy.Role == "vault" && s.webauthn != nil {
				health, healthErr := s.webauthn.health()
				if healthErr != nil {
					return signerReviewExecutionResultV2{}, healthErr
				}
				if health.CredentialCount > 0 {
					return signerReviewExecutionResultV2{}, errors.New("this Vault has a signer-owned approval device; WebAuthn authorization is required")
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
	if intent.Intent.Type == intentSolanaVaultBondAction {
		configuredRPCs, networkErr := s.keys.SolanaRPCURLsV2(walletID)
		if networkErr != nil {
			_, _ = s.store.markFailedClaim(operation.RequestID, attempt, errSignerNetworkPendingV2)
			return signerReviewExecutionResultV2{}, errSignerNetworkPendingV2
		}
		currentIntent, snapshot, verifiedRPCs, stateErr := resolveVaultBondReviewStateV2(configuredRPCs, walletPublicKey, intent)
		if stateErr == nil {
			stateErr = compareVaultBondReviewStateV2(review, currentIntent, snapshot)
		}
		if stateErr == nil && artifact.Transaction != nil {
			validated, stateErr = validateAndSimulateVaultBondReviewV2(verifiedRPCs, walletPublicKey, currentIntent, *artifact.Transaction)
		}
		if stateErr != nil {
			_, _ = s.store.markFailedClaim(operation.RequestID, attempt, stateErr)
			return signerReviewExecutionResultV2{}, stateErr
		}
		intent, rpcURLs = currentIntent, verifiedRPCs
	}
	if intent.Intent.Type == intentSolanaAgentCapitalAction {
		configuredRPCs, networkErr := s.keys.SolanaRPCURLsV2(walletID)
		if networkErr != nil {
			_, _ = s.store.markFailedClaim(operation.RequestID, attempt, errSignerNetworkPendingV2)
			return signerReviewExecutionResultV2{}, errSignerNetworkPendingV2
		}
		currentIntent, snapshot, verifiedRPCs, stateErr := resolveAgentCapitalReviewStateV2(configuredRPCs, walletPublicKey, intent)
		if stateErr == nil {
			stateErr = compareAgentCapitalReviewStateV2(review, currentIntent, snapshot)
		}
		if stateErr == nil && artifact.Transaction != nil {
			validated, stateErr = validateAndSimulateAgentCapitalReviewV2(verifiedRPCs, walletPublicKey, currentIntent, *artifact.Transaction)
		}
		if stateErr != nil {
			_, _ = s.store.markFailedClaim(operation.RequestID, attempt, stateErr)
			return signerReviewExecutionResultV2{}, stateErr
		}
		intent, rpcURLs = currentIntent, verifiedRPCs
	}
	if intent.Intent.Type == intentFederationBondChallenge {
		_, payload, payloadErr := federationPayloadFromIntentV2(intent)
		if payloadErr == nil {
			payloadErr = validateFederationBondChallengeTimeV2(payload, s.store.now())
		}
		if payloadErr != nil {
			_, _ = s.store.markFailedClaim(operation.RequestID, attempt, payloadErr)
			return signerReviewExecutionResultV2{}, payloadErr
		}
		signatureBase64, signErr := execution.SignDomainMessageBase64(privateKey, message)
		if signErr != nil {
			failed, markErr := s.store.markFailedClaim(operation.RequestID, attempt, signErr)
			if markErr != nil {
				return signerReviewExecutionResultV2{}, fmt.Errorf("%v; persist signer failure: %w", signErr, markErr)
			}
			return signerReviewExecutionResultV2{Operation: &failed}, signErr
		}
		operation, err = s.store.markCompletedClaim(operation.RequestID, attempt, signatureBase64, artifact.Digest)
		if err != nil {
			return signerReviewExecutionResultV2{}, err
		}
		review, err = s.store.markReviewSignedV2(review.RequestID, artifact.Digest, signatureBase64)
		return signerReviewExecutionResultV2{
			Review: review, Operation: &operation, SignatureBase64: signatureBase64, Signer: wallet.PublicKey,
		}, err
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
