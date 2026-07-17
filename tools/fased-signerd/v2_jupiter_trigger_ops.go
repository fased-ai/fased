package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	solana "github.com/gagliardetto/solana-go"
)

type signerJupiterTriggerCancelSnapshotV2 struct {
	OrderID           string `json:"orderId"`
	Wallet            string `json:"wallet"`
	Vault             string `json:"vault"`
	RefundMint        string `json:"refundMint"`
	RefundAmount      string `json:"refundAmount"`
	RefundDestination string `json:"refundDestination"`
	OrderState        string `json:"orderState"`
}

type signerJupiterTriggerPublicCancelV2 struct {
	ExpectedOrderState      string `json:"expectedOrderState"`
	RefundMint              string `json:"refundMint"`
	RefundAmount            string `json:"refundAmount"`
	DestinationTokenAccount string `json:"destinationTokenAccount"`
	Program                 string `json:"program"`
}

type signerJupiterTriggerPublicOrderV2 struct {
	OrderID              string                              `json:"orderId"`
	OrderState           string                              `json:"orderState"`
	OrderType            string                              `json:"orderType"`
	InputMint            string                              `json:"inputMint"`
	InitialInputAmount   string                              `json:"initialInputAmount"`
	RemainingInputAmount string                              `json:"remainingInputAmount"`
	OutputMint           string                              `json:"outputMint"`
	TriggerMint          string                              `json:"triggerMint"`
	Condition            string                              `json:"condition"`
	TargetPriceUSD       string                              `json:"targetPriceUsd"`
	SlippageBPS          uint16                              `json:"slippageBps"`
	ExpiresAt            string                              `json:"expiresAt"`
	Cancel               *signerJupiterTriggerPublicCancelV2 `json:"cancel,omitempty"`
}

type signerJupiterTriggerPublicHistoryV2 struct {
	Orders []signerJupiterTriggerPublicOrderV2 `json:"orders"`
}

func jupiterTriggerDigestV2(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}

func jupiterTriggerArtifactDigestV2(intentDigest, stateDigest string) string {
	digest := sha256.Sum256([]byte(intentDigest + "\x00" + stateDigest))
	return "sha256:" + hex.EncodeToString(digest[:])
}

func normalizeJupiterTriggerOrderStateV2(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "active", "open":
		return triggerOrderStateOpenV2
	case "cancelled":
		return triggerOrderStateCancelledV2
	default:
		return strings.ToLower(strings.TrimSpace(raw))
	}
}

func resolveJupiterTriggerTransferProgramV2(rpcURLs []string, mint string) (string, error) {
	if mint == solanaNativeMintV2 {
		return solana.SystemProgramID.String(), nil
	}
	mintKey, err := solana.PublicKeyFromBase58(mint)
	if err != nil {
		return "", errors.New("Jupiter Trigger history contains an invalid refund mint")
	}
	active, err := activeSolanaWriteRPCURLs(rpcURLs)
	if err != nil {
		return "", errSignerNetworkPendingV2
	}
	for _, rpcURL := range active {
		client := newSignerOwnedSolanaRPCClientV2(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		result, requestErr := client.GetAccountInfo(ctx, mintKey)
		cancel()
		if requestErr != nil {
			markSolanaWriteRPCFailure(rpcURL, requestErr)
			continue
		}
		markSolanaWriteRPCSuccess(rpcURL)
		if result.Value == nil || result.Value.Executable || result.Value.Data == nil {
			return "", errors.New("Jupiter Trigger refund mint account is missing or invalid")
		}
		program := result.Value.Owner
		if !program.Equals(solana.TokenProgramID) && !program.Equals(solana.Token2022ProgramID) {
			return "", errors.New("Jupiter Trigger refund mint is not owned by an allowed token program")
		}
		data := result.GetBinary()
		if len(data) < 82 || data[45] == 0 {
			return "", errors.New("Jupiter Trigger refund mint is not initialized")
		}
		return program.String(), nil
	}
	return "", errors.New("signer-owned Solana RPC refund-mint lookup failed")
}

func (s *signerServiceV2) jupiterTriggerPublicHistoryV2(walletID string) (signerJupiterTriggerPublicHistoryV2, error) {
	if s.trigger == nil {
		return signerJupiterTriggerPublicHistoryV2{}, errors.New("signer-owned Jupiter Trigger API key is not configured")
	}
	walletRecord, err := s.keys.PublicRecord(walletID)
	if err != nil {
		return signerJupiterTriggerPublicHistoryV2{}, err
	}
	wallet, err := solana.PublicKeyFromBase58(walletRecord.PublicKey)
	if err != nil {
		return signerJupiterTriggerPublicHistoryV2{}, errors.New("signer-owned wallet record has an invalid public key")
	}
	privateKey, _, err := s.keys.privateKey(walletID)
	if err != nil {
		return signerJupiterTriggerPublicHistoryV2{}, err
	}
	defer zeroBytes(privateKey)
	token, err := s.trigger.authenticate(walletID, wallet, privateKey)
	if err != nil {
		return signerJupiterTriggerPublicHistoryV2{}, err
	}
	orders, err := s.trigger.history(token)
	if err != nil {
		return signerJupiterTriggerPublicHistoryV2{}, err
	}
	result := signerJupiterTriggerPublicHistoryV2{Orders: make([]signerJupiterTriggerPublicOrderV2, 0, len(orders))}
	var rpcURLs []string
	for _, order := range orders {
		if strings.TrimSpace(order.UserPublicKey) != wallet.String() {
			return signerJupiterTriggerPublicHistoryV2{}, errors.New("Jupiter Trigger history contains an order for a different wallet")
		}
		orderType := strings.ToLower(strings.TrimSpace(order.OrderType))
		if orderType != "single" {
			continue
		}
		orderID, idErr := normalizeJupiterExternalIDV2(order.ID, "Jupiter Trigger order")
		inputMint, inputErr := normalizePublicKeyV2(order.InputMint, "Jupiter Trigger input mint")
		outputMint, outputErr := normalizePublicKeyV2(order.OutputMint, "Jupiter Trigger output mint")
		triggerMint, triggerErr := normalizePublicKeyV2(order.TriggerMint, "Jupiter Trigger trigger mint")
		initial, initialErr := parsePositiveAmountV2(order.InitialInputAmount, "Jupiter Trigger initial amount")
		remaining, remainingErr := parseNonNegativeAmountV2(order.RemainingInputAmount, "Jupiter Trigger remaining amount")
		price, priceErr := normalizeJupiterTriggerPriceV2(order.TriggerPriceUSD.String())
		condition := strings.ToLower(strings.TrimSpace(order.TriggerCondition))
		state := normalizeJupiterTriggerOrderStateV2(order.OrderState)
		expiresAt := time.UnixMilli(order.ExpiresAt).UTC()
		if idErr != nil || orderID == "" || inputErr != nil || outputErr != nil || triggerErr != nil ||
			initialErr != nil || remainingErr != nil || priceErr != nil || inputMint == outputMint ||
			(condition != "above" && condition != "below") || order.SlippageBPS == 0 || order.SlippageBPS > 1000 ||
			order.ExpiresAt <= 0 || expiresAt.UnixMilli() != order.ExpiresAt || state == "" {
			return signerJupiterTriggerPublicHistoryV2{}, errors.New("Jupiter Trigger history contains malformed single-order semantics")
		}
		public := signerJupiterTriggerPublicOrderV2{
			OrderID: orderID, OrderState: state, OrderType: orderType,
			InputMint: inputMint, InitialInputAmount: initial.String(), RemainingInputAmount: remaining.String(),
			OutputMint: outputMint, TriggerMint: triggerMint, Condition: condition, TargetPriceUSD: price,
			SlippageBPS: order.SlippageBPS, ExpiresAt: expiresAt.Format(jupiterTriggerExpiryLayoutV2),
		}
		if state == triggerOrderStateOpenV2 &&
			(strings.TrimSpace(order.RawState) == "" || normalizeJupiterTriggerOrderStateV2(order.RawState) == triggerOrderStateOpenV2) &&
			remaining.Sign() > 0 {
			if rpcURLs == nil && inputMint != solanaNativeMintV2 {
				rpcURLs, err = s.keys.SolanaRPCURLsV2(walletID)
				if err != nil {
					return signerJupiterTriggerPublicHistoryV2{}, errSignerNetworkPendingV2
				}
			}
			program, programErr := resolveJupiterTriggerTransferProgramV2(rpcURLs, inputMint)
			if programErr != nil {
				return signerJupiterTriggerPublicHistoryV2{}, programErr
			}
			destination := wallet.String()
			if inputMint != solanaNativeMintV2 {
				destinationKey, addressErr := findAssociatedTokenAddressV2(wallet, solana.MustPublicKeyFromBase58(inputMint), solana.MustPublicKeyFromBase58(program))
				if addressErr != nil {
					return signerJupiterTriggerPublicHistoryV2{}, addressErr
				}
				destination = destinationKey.String()
			}
			public.Cancel = &signerJupiterTriggerPublicCancelV2{
				ExpectedOrderState: triggerOrderStateOpenV2,
				RefundMint:         inputMint, RefundAmount: remaining.String(),
				DestinationTokenAccount: destination, Program: program,
			}
		}
		result.Orders = append(result.Orders, public)
	}
	return result, nil
}

func (s *signerServiceV2) jupiterTriggerReviewStateV2(
	walletID string,
	wallet solana.PublicKey,
	intent normalizedIntentV2,
	privateKey solana.PrivateKey,
) (string, *signerJupiterTriggerCancelSnapshotV2, error) {
	if !isSignerOwnedTriggerIntentV2(intent) || intent.Intent.Jupiter == nil || intent.Intent.Jupiter.Trigger == nil {
		return "", nil, errors.New("signer-owned Jupiter Trigger semantics are required")
	}
	trigger := intent.Intent.Jupiter.Trigger
	if intent.Intent.Type == intentSolanaTriggerCreate {
		expiresAt, err := time.Parse(jupiterTriggerExpiryLayoutV2, trigger.ExpiresAt)
		if err != nil || !expiresAt.After(s.store.now().Add(time.Minute)) || expiresAt.After(s.store.now().Add(30*24*time.Hour)) {
			return "", nil, errors.New("Trigger create expiry must be between one minute and 30 days in the future")
		}
		digest, err := jupiterTriggerDigestV2(struct {
			IntentDigest       string `json:"intentDigest"`
			ExpectedOrderState string `json:"expectedOrderState"`
		}{IntentDigest: intent.Digest, ExpectedOrderState: "new"})
		return digest, nil, err
	}
	if s.trigger == nil {
		return "", nil, errors.New("signer-owned Jupiter Trigger API key is not configured")
	}
	token, err := s.trigger.authenticate(walletID, wallet, privateKey)
	if err != nil {
		return "", nil, err
	}
	orders, err := s.trigger.history(token)
	if err != nil {
		return "", nil, err
	}
	order, err := findJupiterTriggerOrderV2(orders, trigger.Order)
	if err != nil {
		return "", nil, err
	}
	snapshot, err := exactJupiterTriggerCancelSnapshotV2(wallet, intent, order)
	if err != nil {
		return "", nil, err
	}
	digest, err := jupiterTriggerDigestV2(snapshot)
	return digest, &snapshot, err
}

func exactJupiterTriggerCancelSnapshotV2(
	wallet solana.PublicKey,
	intent normalizedIntentV2,
	order signerJupiterTriggerOrderV2,
) (signerJupiterTriggerCancelSnapshotV2, error) {
	jupiter := intent.Intent.Jupiter
	trigger := jupiter.Trigger
	if strings.TrimSpace(order.ID) != trigger.Order || strings.TrimSpace(order.UserPublicKey) != wallet.String() ||
		strings.ToLower(strings.TrimSpace(order.OrderType)) != "single" ||
		normalizeJupiterTriggerOrderStateV2(order.OrderState) != triggerOrderStateOpenV2 ||
		(strings.TrimSpace(order.RawState) != "" && normalizeJupiterTriggerOrderStateV2(order.RawState) != triggerOrderStateOpenV2) {
		return signerJupiterTriggerCancelSnapshotV2{}, errors.New("Jupiter Trigger cancellation requires the exact signer-owned open single order")
	}
	vault, err := normalizePublicKeyV2(order.VaultPublicKey, "Jupiter Trigger vault")
	if err != nil || vault == wallet.String() {
		return signerJupiterTriggerCancelSnapshotV2{}, errors.New("Jupiter Trigger order has an invalid vault")
	}
	refundMint, err := normalizePublicKeyV2(order.InputMint, "Jupiter Trigger refund mint")
	if err != nil || refundMint != jupiter.OutputMint {
		return signerJupiterTriggerCancelSnapshotV2{}, errors.New("Jupiter Trigger order refund mint does not match the reviewed cancellation")
	}
	refundAmount, err := parsePositiveAmountV2(order.RemainingInputAmount, "Jupiter Trigger remaining refund")
	if err != nil || refundAmount.String() != jupiter.MinimumOutputAmount {
		return signerJupiterTriggerCancelSnapshotV2{}, errors.New("Jupiter Trigger remaining refund does not match the reviewed cancellation")
	}
	expectedDestination := wallet.String()
	if refundMint != solanaNativeMintV2 {
		program := solana.MustPublicKeyFromBase58(trigger.Program)
		if !isSPLTokenProgram(program.String()) {
			return signerJupiterTriggerCancelSnapshotV2{}, errors.New("Jupiter Trigger refund token program is invalid")
		}
		expected, err := findAssociatedTokenAddressV2(wallet, solana.MustPublicKeyFromBase58(refundMint), program)
		if err != nil {
			return signerJupiterTriggerCancelSnapshotV2{}, err
		}
		expectedDestination = expected.String()
	}
	if jupiter.DestinationTokenAccount != expectedDestination {
		return signerJupiterTriggerCancelSnapshotV2{}, errors.New("Jupiter Trigger refund destination is not the canonical signer-owned account")
	}
	return signerJupiterTriggerCancelSnapshotV2{
		OrderID: trigger.Order, Wallet: wallet.String(), Vault: vault,
		RefundMint: refundMint, RefundAmount: refundAmount.String(),
		RefundDestination: expectedDestination, OrderState: triggerOrderStateOpenV2,
	}, nil
}

func extractJupiterTriggerTransferAccountsV2(serializedTxBase64, actionProgram string) (string, string, error) {
	raw, err := base64.StdEncoding.Strict().DecodeString(strings.TrimSpace(serializedTxBase64))
	if err != nil || len(raw) == 0 || base64.StdEncoding.EncodeToString(raw) != strings.TrimSpace(serializedTxBase64) {
		return "", "", errors.New("Jupiter Trigger transaction is not canonical base64")
	}
	tx, err := solana.TransactionFromBytes(raw)
	if err != nil || len(tx.Message.GetAddressTableLookups()) != 0 {
		return "", "", errors.New("Jupiter Trigger transaction is invalid or uses denied address lookups")
	}
	var source, destination string
	for index := range tx.Message.Instructions {
		instruction := &tx.Message.Instructions[index]
		program, err := tx.Message.Program(instruction.ProgramIDIndex)
		if err != nil || program.String() != actionProgram {
			continue
		}
		metas, err := instruction.ResolveInstructionAccounts(&tx.Message)
		if err != nil {
			return "", "", errors.New("Jupiter Trigger action accounts cannot be resolved")
		}
		candidateSource, candidateDestination := "", ""
		if program.Equals(solana.SystemProgramID) && len(metas) == 2 {
			candidateSource, candidateDestination = metas[0].PublicKey.String(), metas[1].PublicKey.String()
		} else if isSPLTokenProgram(program.String()) && len(instruction.Data) > 0 {
			switch instruction.Data[0] {
			case 3:
				if len(metas) == 3 {
					candidateSource, candidateDestination = metas[0].PublicKey.String(), metas[1].PublicKey.String()
				}
			case 12:
				if len(metas) == 4 {
					candidateSource, candidateDestination = metas[0].PublicKey.String(), metas[2].PublicKey.String()
				}
			}
		}
		if candidateSource == "" || source != "" {
			return "", "", errors.New("Jupiter Trigger transaction must contain exactly one typed transfer")
		}
		source, destination = candidateSource, candidateDestination
	}
	if source == "" || destination == "" {
		return "", "", errors.New("Jupiter Trigger transaction omits its exact typed transfer")
	}
	return source, destination, nil
}

func enrichJupiterTriggerIntentV2(
	intent normalizedIntentV2,
	vault string,
	externalRequestID string,
	source string,
	destination string,
) normalizedIntentV2 {
	enriched := intent
	jupiter := *intent.Intent.Jupiter
	trigger := *intent.Intent.Jupiter.Trigger
	jupiter.Trigger = &trigger
	enriched.Intent.Jupiter = &jupiter
	trigger.Vault = vault
	trigger.RequestID = externalRequestID
	jupiter.SourceTokenAccount = source
	jupiter.DestinationTokenAccount = destination
	return enriched
}

func validateJupiterTriggerProgramsV2(policy signerPolicyV2, validated jupiterValidatedTransactionV2) error {
	if len(validated.Programs) == 0 {
		return errors.New("signer-owned Trigger transaction has no decoded programs")
	}
	for _, program := range validated.Programs {
		if !containsStringV2(policy.Programs, program) {
			return fmt.Errorf("policy denies signer-decoded Trigger program %s", program)
		}
	}
	return nil
}

func validateJupiterTriggerDepositResponseV2(
	wallet solana.PublicKey,
	intent normalizedIntentV2,
	vault signerJupiterTriggerVaultV2,
	deposit signerJupiterTriggerDepositV2,
) (string, string, string, error) {
	jupiter := intent.Intent.Jupiter
	vaultKey, err := normalizePublicKeyV2(vault.VaultPublicKey, "Jupiter Trigger vault")
	if err != nil || strings.TrimSpace(vault.UserPublicKey) != wallet.String() || vaultKey == wallet.String() {
		return "", "", "", errors.New("Jupiter Trigger vault is not bound to the signer-owned wallet")
	}
	requestID, err := normalizeJupiterExternalIDV2(deposit.RequestID, "Jupiter deposit requestId")
	if err != nil || requestID == "" || strings.TrimSpace(deposit.Transaction) == "" {
		return "", "", "", errors.New("Jupiter Trigger deposit response lacks an exact transaction and request identity")
	}
	if strings.TrimSpace(deposit.ReceiverAddress) != vaultKey || strings.TrimSpace(deposit.Mint) != jupiter.InputMint ||
		strings.TrimSpace(deposit.Amount) != jupiter.InputAmount {
		return "", "", "", errors.New("Jupiter Trigger deposit response does not match the reviewed vault, mint, and amount")
	}
	source, destination, err := extractJupiterTriggerTransferAccountsV2(deposit.Transaction, jupiter.Trigger.Program)
	if err != nil {
		return "", "", "", err
	}
	if strings.TrimSpace(deposit.InputTokenAccount) != "" && strings.TrimSpace(deposit.InputTokenAccount) != source {
		return "", "", "", errors.New("Jupiter Trigger deposit source account does not match the crafted transaction")
	}
	return requestID, source, destination, nil
}

func (s *signerServiceV2) prepareSignerOwnedTriggerReviewV2(
	walletID string,
	req signerReviewPrepareRequestV2,
	wallet solana.PublicKey,
	intent normalizedIntentV2,
) (signerReviewV2, error) {
	if req.Transaction != nil {
		return signerReviewV2{}, errors.New("Jupiter Trigger review rejects caller-provided transaction bytes")
	}
	if req.Mode != jupiterReviewModeReviewedV2 {
		return signerReviewV2{}, errors.New("autonomous Jupiter Trigger execution uses v2.execute; review.prepare is reviewed-only")
	}
	privateKey, _, err := s.keys.privateKey(walletID)
	if err != nil {
		return signerReviewV2{}, err
	}
	defer zeroBytes(privateKey)
	stateDigest, _, err := s.jupiterTriggerReviewStateV2(walletID, wallet, intent, privateKey)
	if err != nil {
		return signerReviewV2{}, err
	}
	artifact := signerReviewArtifactInputV2{
		WalletPublicKey: wallet.String(), Kind: signerReviewArtifactTriggerStateV2,
		Digest: jupiterTriggerArtifactDigestV2(intent.Digest, stateDigest), StateDigest: stateDigest,
	}
	return s.store.prepareArtifactReviewV2(walletID, req, intent, artifact)
}

func (s *signerServiceV2) executeAutonomousJupiterTriggerV2(
	req signerExecuteRequestV2,
	intent normalizedIntentV2,
	policy signerPolicyV2,
	wallet solana.PublicKey,
) (signerOperationV2, error) {
	if s.trigger == nil {
		return signerOperationV2{}, errors.New("signer-owned Jupiter Trigger API key is not configured")
	}
	if policy.Role != "agent" || !containsStringV2(policy.Operations, intent.PolicyOperation) {
		return signerOperationV2{}, errors.New("autonomous Jupiter Trigger requires an Agent wallet and explicit operation policy")
	}
	privateKey, _, err := s.keys.privateKey(req.IntentWalletID())
	if err != nil {
		return signerOperationV2{}, err
	}
	defer zeroBytes(privateKey)

	operation, lookupErr := s.store.getOperation(req.RequestID)
	if lookupErr == nil {
		if operation.WalletID != normalizeWalletID(req.IntentWalletID()) || operation.IntentDigest != intent.Digest || operation.PolicyHash != policy.Hash {
			return signerOperationV2{}, errors.New("requestId is already bound to a different immutable signer request")
		}
		if operation.State != operationReserved {
			return s.continueJupiterTriggerWorkflowV2(req, intent, policy, wallet, privateKey, operation, 0)
		}
	} else if !errors.Is(lookupErr, errSignerOperationNotFoundV2) {
		return signerOperationV2{}, lookupErr
	}

	stateDigest, _, err := s.jupiterTriggerReviewStateV2(req.IntentWalletID(), wallet, intent, privateKey)
	if err != nil {
		return signerOperationV2{}, err
	}
	if lookupErr != nil {
		if err := s.store.preflightPolicyForIntentV2(req, intent); err != nil {
			return signerOperationV2{}, err
		}
		operation, _, err = s.store.reserveOperation(req, intent)
		if err != nil {
			return signerOperationV2{}, err
		}
	}
	if _, err := s.store.ensureJupiterTriggerWorkflowV2(req, intent, stateDigest); err != nil {
		return signerOperationV2{}, err
	}
	operation, attempt, claimed, err := s.store.claimReservedOperation(req.RequestID)
	if err != nil || !claimed {
		return operation, err
	}
	return s.continueJupiterTriggerWorkflowV2(req, intent, policy, wallet, privateKey, operation, attempt)
}

func (s *signerServiceV2) persistJupiterTriggerPreSignUnknownV2(
	requestID string,
	current signerOperationV2,
	cause error,
	publicError error,
) (signerOperationV2, error) {
	unknown, err := s.store.markJupiterTriggerPreSignUnknownV2(requestID, cause)
	if err != nil {
		return current, fmt.Errorf("persist Jupiter Trigger unknown state: %w", err)
	}
	return unknown, publicError
}

func (s *signerServiceV2) persistJupiterTriggerFailedClaimV2(
	requestID string,
	attempt uint64,
	current signerOperationV2,
	cause error,
) (signerOperationV2, error) {
	failed, err := s.store.markFailedClaim(requestID, attempt, cause)
	if err != nil {
		return current, fmt.Errorf("persist rejected Jupiter Trigger operation: %w", err)
	}
	return failed, cause
}

func (s *signerServiceV2) continueJupiterTriggerWorkflowV2(
	req signerExecuteRequestV2,
	intent normalizedIntentV2,
	policy signerPolicyV2,
	wallet solana.PublicKey,
	privateKey solana.PrivateKey,
	operation signerOperationV2,
	attempt uint64,
) (signerOperationV2, error) {
	workflow, err := s.store.getJupiterTriggerWorkflowV2(req.RequestID)
	if err != nil {
		return signerOperationV2{}, err
	}
	if operation.State == operationConfirmed || operation.State == operationFailed {
		return operation, nil
	}
	if workflow.Phase == triggerPhaseSubmittingV2 || workflow.Phase == triggerPhaseUnknownV2 || operation.State == operationUnknown {
		return s.reconcileJupiterTriggerWorkflowV2(req, intent, wallet, privateKey, operation, workflow)
	}
	token, err := s.trigger.authenticate(req.IntentWalletID(), wallet, privateKey)
	if err != nil {
		return operation, err
	}

	if intent.Intent.Type == intentSolanaTriggerCreate {
		operation, workflow, err = s.prepareJupiterTriggerCreateV2(req, intent, policy, wallet, privateKey, token, operation, workflow, attempt)
	} else {
		operation, workflow, err = s.prepareJupiterTriggerCancelV2(req, intent, policy, wallet, privateKey, token, operation, workflow, attempt)
	}
	if err != nil {
		return operation, err
	}
	if workflow.Phase != triggerPhaseSignedV2 || operation.State != operationBroadcast {
		return operation, errors.New("Jupiter Trigger workflow did not reach its durable signed phase")
	}
	workflow, err = s.store.updateJupiterTriggerWorkflowV2(req.RequestID, []string{triggerPhaseSignedV2}, func(record *signerJupiterTriggerWorkflowV2) error {
		record.Phase = triggerPhaseSubmittingV2
		return nil
	})
	if err != nil {
		return operation, err
	}
	var submitted signerJupiterTriggerSubmitResultV2
	if intent.Intent.Type == intentSolanaTriggerCreate {
		submitted, err = s.trigger.createOrder(token, intent.Intent.Jupiter, workflow.ExternalRequestID, operation.SignedTxBase64)
	} else {
		submitted, err = s.trigger.confirmCancel(token, intent.Intent.Jupiter.Trigger.Order, workflow.ExternalRequestID, operation.SignedTxBase64)
	}
	if err != nil {
		unknown, markErr := s.store.markJupiterTriggerUnknownV2(req.RequestID, errors.New("Jupiter Trigger submission response is ambiguous"))
		if markErr != nil {
			return operation, markErr
		}
		return unknown, nil
	}
	if strings.TrimSpace(submitted.ID) == "" || strings.TrimSpace(submitted.TxSignature) != operation.Signature ||
		(intent.Intent.Type == intentSolanaTriggerCancel && strings.TrimSpace(submitted.ID) != intent.Intent.Jupiter.Trigger.Order) {
		unknown, markErr := s.store.markJupiterTriggerUnknownV2(req.RequestID, errors.New("Jupiter Trigger response did not bind the exact order and signed transaction"))
		if markErr != nil {
			return operation, markErr
		}
		return unknown, nil
	}
	state := triggerOrderStateOpenV2
	if intent.Intent.Type == intentSolanaTriggerCancel {
		state = triggerOrderStateCancelledV2
	}
	return s.store.markJupiterTriggerConfirmedV2(req.RequestID, submitted.ID, state)
}

func (s *signerServiceV2) prepareJupiterTriggerCreateV2(
	req signerExecuteRequestV2,
	intent normalizedIntentV2,
	policy signerPolicyV2,
	wallet solana.PublicKey,
	privateKey solana.PrivateKey,
	token string,
	operation signerOperationV2,
	workflow signerJupiterTriggerWorkflowV2,
	attempt uint64,
) (signerOperationV2, signerJupiterTriggerWorkflowV2, error) {
	_ = privateKey
	var err error
	if workflow.Phase == triggerPhaseReservedV2 {
		workflow, err = s.store.updateJupiterTriggerWorkflowV2(req.RequestID, []string{triggerPhaseReservedV2}, func(record *signerJupiterTriggerWorkflowV2) error {
			record.Phase = triggerPhaseVaultRegisteringV2
			return nil
		})
		if err != nil {
			return operation, workflow, err
		}
		vault, vaultErr := s.trigger.vault(token, true)
		if vaultErr != nil {
			unknown, persistErr := s.persistJupiterTriggerPreSignUnknownV2(
				req.RequestID, operation,
				errors.New("Jupiter Trigger vault registration response is ambiguous"),
				errors.New("Jupiter Trigger vault registration is ambiguous; it will not be repeated"),
			)
			return unknown, workflow, persistErr
		}
		vaultKey, keyErr := normalizePublicKeyV2(vault.VaultPublicKey, "Jupiter Trigger vault")
		if keyErr != nil || vault.UserPublicKey != wallet.String() || vaultKey == wallet.String() {
			failed, persistErr := s.persistJupiterTriggerFailedClaimV2(
				req.RequestID, attempt, operation,
				errors.New("Jupiter Trigger returned an invalid signer-bound vault"),
			)
			return failed, workflow, persistErr
		}
		workflow, err = s.store.updateJupiterTriggerWorkflowV2(req.RequestID, []string{triggerPhaseVaultRegisteringV2}, func(record *signerJupiterTriggerWorkflowV2) error {
			record.Phase = triggerPhaseVaultReadyV2
			record.Vault = vaultKey
			return nil
		})
		if err != nil {
			return operation, workflow, err
		}
	}
	if workflow.Phase == triggerPhaseVaultRegisteringV2 {
		vault, vaultErr := s.trigger.vault(token, false)
		if vaultErr != nil || vault.UserPublicKey != wallet.String() {
			unknown, persistErr := s.persistJupiterTriggerPreSignUnknownV2(
				req.RequestID, operation,
				errors.New("Jupiter Trigger vault registration remains ambiguous"),
				errors.New("Jupiter Trigger vault registration remains ambiguous; it will not be repeated"),
			)
			return unknown, workflow, persistErr
		}
		vaultKey, keyErr := normalizePublicKeyV2(vault.VaultPublicKey, "Jupiter Trigger vault")
		if keyErr != nil || vaultKey == wallet.String() {
			unknown, persistErr := s.persistJupiterTriggerPreSignUnknownV2(
				req.RequestID, operation,
				errors.New("Jupiter Trigger registered an invalid signer-bound vault"),
				errors.New("Jupiter Trigger vault registration remains ambiguous; it will not be repeated"),
			)
			return unknown, workflow, persistErr
		}
		workflow, err = s.store.updateJupiterTriggerWorkflowV2(req.RequestID, []string{triggerPhaseVaultRegisteringV2}, func(record *signerJupiterTriggerWorkflowV2) error {
			record.Phase, record.Vault = triggerPhaseVaultReadyV2, vaultKey
			return nil
		})
		if err != nil {
			return operation, workflow, err
		}
	}
	if workflow.Phase == triggerPhaseVaultReadyV2 {
		workflow, err = s.store.updateJupiterTriggerWorkflowV2(req.RequestID, []string{triggerPhaseVaultReadyV2}, func(record *signerJupiterTriggerWorkflowV2) error {
			record.Phase = triggerPhaseCraftingV2
			return nil
		})
		if err != nil {
			return operation, workflow, err
		}
		deposit, craftErr := s.trigger.craftDeposit(token, wallet.String(), intent.Intent.Jupiter)
		if craftErr != nil {
			unknown, persistErr := s.persistJupiterTriggerPreSignUnknownV2(
				req.RequestID, operation,
				errors.New("Jupiter Trigger deposit craft response is ambiguous"),
				errors.New("Jupiter Trigger deposit craft is ambiguous; it will not be repeated"),
			)
			return unknown, workflow, persistErr
		}
		requestID, source, destination, validateErr := validateJupiterTriggerDepositResponseV2(
			wallet,
			intent,
			signerJupiterTriggerVaultV2{UserPublicKey: wallet.String(), VaultPublicKey: workflow.Vault},
			deposit,
		)
		if validateErr != nil {
			failed, persistErr := s.persistJupiterTriggerFailedClaimV2(req.RequestID, attempt, operation, validateErr)
			return failed, workflow, persistErr
		}
		enriched := enrichJupiterTriggerIntentV2(intent, workflow.Vault, requestID, source, destination)
		rpcURLs, networkErr := s.keys.SolanaRPCURLsV2(req.IntentWalletID())
		if networkErr != nil {
			unknown, persistErr := s.persistJupiterTriggerPreSignUnknownV2(
				req.RequestID, operation, errSignerNetworkPendingV2,
				errors.New("Jupiter Trigger deposit was crafted before signer-owned RPC validation became unavailable; the request will not be repeated"),
			)
			return unknown, workflow, persistErr
		}
		validated, validateErr := validateSignerOwnedJupiterTriggerTransactionV2(rpcURLs, wallet, enriched, deposit.Transaction)
		if validateErr == nil {
			validateErr = validateJupiterTriggerProgramsV2(policy, validated)
		}
		if validateErr != nil {
			unknown, persistErr := s.persistJupiterTriggerPreSignUnknownV2(
				req.RequestID, operation, validateErr,
				errors.New("Jupiter Trigger deposit was crafted but failed signer validation; the request will not be repeated"),
			)
			return unknown, workflow, persistErr
		}
		workflow, err = s.store.updateJupiterTriggerWorkflowV2(req.RequestID, []string{triggerPhaseCraftingV2}, func(record *signerJupiterTriggerWorkflowV2) error {
			record.Phase = triggerPhasePreparedV2
			record.ExternalRequestID = requestID
			record.SourceTokenAccount, record.DestinationTokenAccount = source, destination
			record.UnsignedTxBase64 = deposit.Transaction
			return nil
		})
		if err != nil {
			unknown, markErr := s.store.markJupiterTriggerPreSignUnknownV2(
				req.RequestID,
				errors.New("persist Jupiter Trigger crafted deposit"),
			)
			if markErr != nil {
				return operation, workflow, fmt.Errorf("persist crafted deposit (%v) and unknown state: %w", err, markErr)
			}
			return unknown, workflow, errors.New("Jupiter Trigger deposit was crafted but its exact transaction could not be persisted; the request will not be repeated")
		}
	}
	return s.signPreparedJupiterTriggerV2(req, intent, policy, wallet, operation, workflow, attempt)
}

func (s *signerServiceV2) prepareJupiterTriggerCancelV2(
	req signerExecuteRequestV2,
	intent normalizedIntentV2,
	policy signerPolicyV2,
	wallet solana.PublicKey,
	privateKey solana.PrivateKey,
	token string,
	operation signerOperationV2,
	workflow signerJupiterTriggerWorkflowV2,
	attempt uint64,
) (signerOperationV2, signerJupiterTriggerWorkflowV2, error) {
	if workflow.Phase == triggerPhaseReservedV2 {
		stateDigest, snapshot, err := s.jupiterTriggerReviewStateV2(req.IntentWalletID(), wallet, intent, privateKey)
		if err != nil || stateDigest != workflow.StateDigest || snapshot == nil {
			if err == nil {
				err = errors.New("Jupiter Trigger cancellation state changed after authorization")
			}
			failed, persistErr := s.persistJupiterTriggerFailedClaimV2(req.RequestID, attempt, operation, err)
			return failed, workflow, persistErr
		}
		workflow, err = s.store.updateJupiterTriggerWorkflowV2(req.RequestID, []string{triggerPhaseReservedV2}, func(record *signerJupiterTriggerWorkflowV2) error {
			record.Phase = triggerPhaseCancelInitiatingV2
			record.Vault = snapshot.Vault
			return nil
		})
		if err != nil {
			return operation, workflow, err
		}
		cancel, cancelErr := s.trigger.initiateCancel(token, intent.Intent.Jupiter.Trigger.Order)
		if cancelErr != nil {
			unknown, persistErr := s.persistJupiterTriggerPreSignUnknownV2(
				req.RequestID, operation,
				errors.New("Jupiter Trigger cancel initiation response is ambiguous"),
				errors.New("Jupiter Trigger cancel initiation is ambiguous; it will not be repeated"),
			)
			return unknown, workflow, persistErr
		}
		if strings.TrimSpace(cancel.ID) != "" && strings.TrimSpace(cancel.ID) != intent.Intent.Jupiter.Trigger.Order {
			unknown, persistErr := s.persistJupiterTriggerPreSignUnknownV2(
				req.RequestID, operation,
				errors.New("Jupiter Trigger initiated cancellation but returned a different order identity"),
				errors.New("Jupiter Trigger cancellation state is ambiguous and will not be repeated"),
			)
			return unknown, workflow, persistErr
		}
		externalRequestID, requestErr := normalizeJupiterExternalIDV2(cancel.RequestID, "Jupiter cancel requestId")
		if requestErr != nil || externalRequestID == "" || strings.TrimSpace(cancel.Transaction) == "" {
			unknown, persistErr := s.persistJupiterTriggerPreSignUnknownV2(
				req.RequestID, operation,
				errors.New("Jupiter Trigger cancel response omitted its exact withdrawal"),
				errors.New("Jupiter Trigger cancel response is ambiguous; it will not be repeated"),
			)
			return unknown, workflow, persistErr
		}
		source, destination, extractErr := extractJupiterTriggerTransferAccountsV2(cancel.Transaction, intent.Intent.Jupiter.Trigger.Program)
		if extractErr != nil || destination != intent.Intent.Jupiter.DestinationTokenAccount {
			if extractErr == nil {
				extractErr = errors.New("Jupiter Trigger withdrawal destination changed")
			}
			unknown, persistErr := s.persistJupiterTriggerPreSignUnknownV2(
				req.RequestID, operation, extractErr,
				errors.New("Jupiter Trigger initiated cancellation but returned an unsafe withdrawal; the request will not be repeated"),
			)
			return unknown, workflow, persistErr
		}
		enriched := enrichJupiterTriggerIntentV2(intent, snapshot.Vault, externalRequestID, source, destination)
		rpcURLs, networkErr := s.keys.SolanaRPCURLsV2(req.IntentWalletID())
		if networkErr != nil {
			unknown, persistErr := s.persistJupiterTriggerPreSignUnknownV2(
				req.RequestID, operation, errSignerNetworkPendingV2,
				errors.New("Jupiter Trigger cancellation was initiated before signer-owned RPC validation became unavailable; the request will not be repeated"),
			)
			return unknown, workflow, persistErr
		}
		validated, validateErr := validateSignerOwnedJupiterTriggerTransactionV2(rpcURLs, wallet, enriched, cancel.Transaction)
		if validateErr == nil {
			validateErr = validateJupiterTriggerProgramsV2(policy, validated)
		}
		if validateErr != nil {
			unknown, persistErr := s.persistJupiterTriggerPreSignUnknownV2(
				req.RequestID, operation, validateErr,
				errors.New("Jupiter Trigger initiated cancellation but its withdrawal failed signer validation; the request will not be repeated"),
			)
			return unknown, workflow, persistErr
		}
		workflow, err = s.store.updateJupiterTriggerWorkflowV2(req.RequestID, []string{triggerPhaseCancelInitiatingV2}, func(record *signerJupiterTriggerWorkflowV2) error {
			record.Phase = triggerPhasePreparedV2
			record.ExternalRequestID = externalRequestID
			record.SourceTokenAccount, record.DestinationTokenAccount = source, destination
			record.UnsignedTxBase64 = cancel.Transaction
			return nil
		})
		if err != nil {
			unknown, markErr := s.store.markJupiterTriggerPreSignUnknownV2(
				req.RequestID,
				errors.New("persist Jupiter Trigger cancellation withdrawal"),
			)
			if markErr != nil {
				return operation, workflow, fmt.Errorf("persist exact cancellation withdrawal (%v) and unknown state: %w", err, markErr)
			}
			return unknown, workflow, errors.New("Jupiter Trigger cancellation was initiated but its exact withdrawal could not be persisted; the request will not be repeated")
		}
	}
	return s.signPreparedJupiterTriggerV2(req, intent, policy, wallet, operation, workflow, attempt)
}

func (s *signerServiceV2) signPreparedJupiterTriggerV2(
	req signerExecuteRequestV2,
	intent normalizedIntentV2,
	policy signerPolicyV2,
	wallet solana.PublicKey,
	operation signerOperationV2,
	workflow signerJupiterTriggerWorkflowV2,
	attempt uint64,
) (signerOperationV2, signerJupiterTriggerWorkflowV2, error) {
	if workflow.Phase == triggerPhaseSignedV2 {
		return operation, workflow, nil
	}
	if workflow.Phase != triggerPhasePreparedV2 {
		return operation, workflow, fmt.Errorf("Jupiter Trigger workflow cannot sign in phase %s", workflow.Phase)
	}
	enriched := enrichJupiterTriggerIntentV2(
		intent,
		workflow.Vault,
		workflow.ExternalRequestID,
		workflow.SourceTokenAccount,
		workflow.DestinationTokenAccount,
	)
	rpcURLs, err := s.keys.SolanaRPCURLsV2(req.IntentWalletID())
	if err != nil {
		return operation, workflow, errSignerNetworkPendingV2
	}
	validated, err := validateSignerOwnedJupiterTriggerTransactionV2(rpcURLs, wallet, enriched, workflow.UnsignedTxBase64)
	if err == nil {
		err = validateJupiterTriggerProgramsV2(policy, validated)
	}
	if err != nil {
		failed, persistErr := s.persistJupiterTriggerFailedClaimV2(req.RequestID, attempt, operation, err)
		return failed, workflow, persistErr
	}
	privateKey, _, err := s.keys.privateKey(req.IntentWalletID())
	if err != nil {
		return operation, workflow, err
	}
	defer zeroBytes(privateKey)
	signedRaw, signature, err := signValidatedJupiterTransactionV2(validated, privateKey)
	if err != nil {
		failed, persistErr := s.persistJupiterTriggerFailedClaimV2(req.RequestID, attempt, operation, err)
		return failed, workflow, persistErr
	}
	return s.store.markJupiterTriggerSignedV2(
		req.RequestID,
		attempt,
		workflow.UnsignedTxBase64,
		signedRaw,
		signature.String(),
		workflow.ExternalRequestID,
	)
}

func (s *signerServiceV2) reconcileJupiterTriggerWorkflowV2(
	req signerExecuteRequestV2,
	intent normalizedIntentV2,
	wallet solana.PublicKey,
	privateKey solana.PrivateKey,
	operation signerOperationV2,
	workflow signerJupiterTriggerWorkflowV2,
) (signerOperationV2, error) {
	if operation.State == operationConfirmed || operation.State == operationFailed {
		return operation, nil
	}
	if strings.TrimSpace(operation.Signature) == "" {
		return operation, errors.New("Jupiter Trigger workflow is ambiguous before a transaction signature was durably recorded; no request will be repeated")
	}
	token, err := s.trigger.authenticate(req.IntentWalletID(), wallet, privateKey)
	if err != nil {
		return operation, err
	}
	orders, err := s.trigger.history(token)
	if err != nil {
		return operation, errors.New("Jupiter Trigger history reconciliation failed")
	}
	if intent.Intent.Type == intentSolanaTriggerCreate {
		matches := make([]signerJupiterTriggerOrderV2, 0, 1)
		trigger := intent.Intent.Jupiter.Trigger
		expiresAt, _ := time.Parse(jupiterTriggerExpiryLayoutV2, trigger.ExpiresAt)
		for _, order := range orders {
			price, priceErr := normalizeJupiterTriggerPriceV2(order.TriggerPriceUSD.String())
			if priceErr == nil && order.UserPublicKey == wallet.String() && order.OrderType == "single" &&
				normalizeJupiterTriggerOrderStateV2(order.OrderState) == triggerOrderStateOpenV2 &&
				(strings.TrimSpace(order.RawState) == "" || normalizeJupiterTriggerOrderStateV2(order.RawState) == triggerOrderStateOpenV2) &&
				order.InputMint == intent.Intent.Jupiter.InputMint && order.OutputMint == intent.Intent.Jupiter.OutputMint &&
				order.InitialInputAmount == intent.Intent.Jupiter.InputAmount && order.TriggerMint == trigger.TriggerMint &&
				order.TriggerCondition == trigger.Condition && price == trigger.TargetPriceUSD &&
				order.SlippageBPS == trigger.SlippageBPS && order.ExpiresAt == expiresAt.UnixMilli() &&
				triggerOrderHasSignatureV2(order, "deposit", operation.Signature) {
				matches = append(matches, order)
			}
		}
		if len(matches) > 1 {
			return operation, errors.New("multiple Jupiter Trigger orders matched one immutable deposit signature")
		}
		if len(matches) == 1 {
			return s.store.markJupiterTriggerConfirmedV2(req.RequestID, matches[0].ID, triggerOrderStateOpenV2)
		}
	} else {
		order, findErr := findJupiterTriggerOrderV2(orders, intent.Intent.Jupiter.Trigger.Order)
		if findErr == nil && order.UserPublicKey == wallet.String() &&
			normalizeJupiterTriggerOrderStateV2(order.OrderState) == triggerOrderStateCancelledV2 &&
			(strings.TrimSpace(order.RawState) == "" || normalizeJupiterTriggerOrderStateV2(order.RawState) == triggerOrderStateCancelledV2) &&
			triggerOrderHasSignatureV2(order, "withdrawal", operation.Signature) {
			return s.store.markJupiterTriggerConfirmedV2(req.RequestID, order.ID, triggerOrderStateCancelledV2)
		}
	}
	if workflow.Phase == triggerPhaseSubmittingV2 {
		return s.store.markJupiterTriggerUnknownV2(req.RequestID, errors.New("Jupiter Trigger history does not yet contain the exact signed result"))
	}
	return operation, nil
}
