package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"

	solana "github.com/gagliardetto/solana-go"
	rpc "github.com/gagliardetto/solana-go/rpc"
)

type signerServiceV2 struct {
	store    *signerStoreV2
	keys     *signerKeyManagerV2
	webauthn *signerWebAuthnServiceV2
	trigger  *signerJupiterTriggerClientV2
	audit    *auditWriter
}

type signerWalletPolicyResultV2 struct {
	Wallet signerWalletRecordV2 `json:"wallet"`
	Policy signerPolicyV2       `json:"policy"`
}

type signerPolicySummaryV2 struct {
	WalletID string `json:"walletId"`
	Role     string `json:"role"`
	Version  uint64 `json:"version"`
	Hash     string `json:"hash"`
}

type signerHealthResultV2 struct {
	Details      string                  `json:"details"`
	ReadOnly     bool                    `json:"readOnly"`
	KeystoreType string                  `json:"keystoreType"`
	Chains       []string                `json:"chains"`
	Ready        bool                    `json:"ready"`
	Release      signerReleaseIdentityV2 `json:"release"`
	Schema       signerSchemaHealthV2    `json:"schema"`
	Network      signerNetworkHealthV2   `json:"network"`
	Capabilities signerCapabilitiesV2    `json:"capabilities"`
	Policies     []signerPolicySummaryV2 `json:"policies"`
	WebAuthn     signerWebAuthnHealthV2  `json:"webAuthn"`
	Jupiter      signerJupiterHealthV2   `json:"jupiter"`
	Audit        signerAuditHealthV2     `json:"audit"`
	State        signerStateHealthV2     `json:"state"`
}

type signerJupiterHealthV2 struct {
	TriggerConfigured bool `json:"triggerConfigured"`
	LiveEnabled       bool `json:"liveEnabled"`
}

func requireJupiterLiveExecutionV2(enabled bool, intentType string) error {
	if isJupiterIntentTypeV2(strings.TrimSpace(intentType)) && !enabled {
		return errors.New("Jupiter and Trigger execution is preview-only until live qualification; signer execution is disabled")
	}
	return nil
}

func marshalSignerResultV2(result any) ([]byte, error) {
	switch value := result.(type) {
	case signerOperationV2:
		value.SignedTxBase64 = ""
		result = value
	case signerReviewExecutionResultV2:
		if value.Operation != nil {
			operation := *value.Operation
			operation.SignedTxBase64 = ""
			value.Operation = &operation
		}
		result = value
	}
	return json.Marshal(map[string]any{"ok": true, "result": result})
}

func (s *signerServiceV2) health(cfg signerConfig) (signerHealthResultV2, error) {
	releaseIdentity, err := signerReleaseIdentity()
	if err != nil {
		return signerHealthResultV2{}, err
	}
	policies, err := s.store.listPolicies()
	if err != nil {
		return signerHealthResultV2{}, err
	}
	summaries := make([]signerPolicySummaryV2, 0, len(policies))
	for _, policy := range policies {
		summaries = append(summaries, signerPolicySummaryV2{
			WalletID: policy.WalletID,
			Role:     policy.Role,
			Version:  policy.Version,
			Hash:     policy.Hash,
		})
	}
	webauthnHealth, err := s.webauthn.health()
	if err != nil {
		return signerHealthResultV2{}, err
	}
	networkHealth, err := s.keys.NetworkHealthV2()
	if err != nil {
		return signerHealthResultV2{}, err
	}
	schemaHealth := s.store.schemaHealth()
	stateHealth, err := s.store.stateHealthV2()
	if err != nil {
		return signerHealthResultV2{}, err
	}
	return signerHealthResultV2{
		Details:      "fased-signerd protocol-v2 ready",
		ReadOnly:     cfg.readOnly,
		KeystoreType: "signer-owned-v2",
		Chains:       cfg.chains,
		Ready:        schemaHealth.Ready,
		Release:      releaseIdentity,
		Schema:       schemaHealth,
		Network:      networkHealth,
		Capabilities: signerV2Capabilities,
		Policies:     summaries,
		WebAuthn:     webauthnHealth,
		Jupiter:      signerJupiterHealthV2{TriggerConfigured: s.trigger != nil, LiveEnabled: cfg.jupiterLive},
		Audit:        s.audit.health(),
		State:        stateHealth,
	}, nil
}

func requireControlSocketV2(control bool) error {
	if !control {
		return errors.New("signer administrative operation requires the control socket")
	}
	return nil
}

func decodeSignerRequestV2(raw json.RawMessage, out any) error {
	if len(raw) == 0 {
		return errors.New("signer-v2 request body is required")
	}
	if err := decodeStrictJSONV2(raw, out); err != nil {
		return errors.New("invalid signer-v2 request")
	}
	return nil
}

func (s *signerServiceV2) handle(req request, cfg signerConfig, control bool) ([]byte, error) {
	switch req.Op {
	case "health", "v2.capabilities":
		health, err := s.health(cfg)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(health)
	case "getAddresses":
		wallet, err := s.keys.PublicRecord(req.WalletID)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(map[string]string{"solana": wallet.PublicKey})
	case "getBalance":
		wallet, err := s.keys.PublicRecord(req.WalletID)
		if err != nil {
			return nil, err
		}
		address, err := solana.PublicKeyFromBase58(wallet.PublicKey)
		if err != nil {
			return nil, errors.New("signer-owned wallet record has an invalid public key")
		}
		rpcURLs, err := s.keys.SolanaRPCURLsV2(req.WalletID)
		if err != nil {
			return nil, errSignerNetworkPendingV2
		}
		lamports, err := signerOwnedSolanaBalanceV2(rpcURLs, address)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(map[string]any{
			"ok":      true,
			"chain":   "solana",
			"address": wallet.PublicKey,
			"balance": strconv.FormatUint(lamports, 10),
			"unit":    "lamports",
		})
	case "v2.webauthn.registration.begin":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		if err := requireControlSocketV2(control); err != nil {
			return nil, err
		}
		var body signerWebAuthnRegistrationBeginRequestV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		result, err := s.webauthn.beginRegistration(body.Label)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(result)
	case "v2.webauthn.registration.finish":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		if err := requireControlSocketV2(control); err != nil {
			return nil, err
		}
		var body signerWebAuthnRegistrationFinishRequestV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		result, err := s.webauthn.finishRegistration(body)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(result)
	case "v2.webauthn.credentials.list":
		if err := requireControlSocketV2(control); err != nil {
			return nil, err
		}
		credentials, err := s.webauthn.credentialSummary()
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(credentials)
	case "v2.webauthn.credentials.revoke":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		if err := requireControlSocketV2(control); err != nil {
			return nil, err
		}
		var body signerWebAuthnCredentialRevokeRequestV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		result, err := s.webauthn.revokeCredential(body)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(result)
	case "v2.review.authorization.begin":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		var body signerReviewAuthorizationBeginRequestV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		result, err := s.webauthn.beginReviewAuthorization(req.WalletID, body)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(result)
	case "v2.review.authorization.finish":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		var body signerReviewAuthorizationFinishRequestV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		result, err := s.webauthn.finishReviewAuthorization(req.WalletID, body)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(result)
	case "v2.network.get":
		if err := requireControlSocketV2(control); err != nil {
			return nil, err
		}
		summary, err := s.keys.NetworkSummaryV2(req.WalletID)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(summary)
	case "v2.network.put":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		if err := requireControlSocketV2(control); err != nil {
			return nil, err
		}
		var body signerNetworkPutRequestV2
		if err := decodeSignerNetworkPutRequestV2(req.Request, &body); err != nil {
			return nil, errors.New("invalid signer-v2 request")
		}
		summary, err := s.keys.PutNetworkV2(req.WalletID, body)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(summary)
	case "v2.policy.get":
		policy, err := s.store.getPolicy(req.WalletID)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(policy)
	case "v2.policy.put":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		if err := requireControlSocketV2(control); err != nil {
			return nil, err
		}
		var body signerPolicyPutRequestV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		body.Policy.WalletID = req.WalletID
		policy, err := s.store.putPolicy(body.Policy, body.ExpectedVersion)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(policy)
	case "v2.policy.tighten":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		var body signerPolicyPutRequestV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		body.Policy.WalletID = req.WalletID
		policy, err := s.store.tightenPolicy(body.Policy, body.ExpectedVersion)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(policy)
	case "v2.wallet.get":
		wallet, err := s.keys.PublicRecord(req.WalletID)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(wallet)
	case "v2.wallet.create":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		var body signerWalletCreateRequestV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		body.WalletID = req.WalletID
		body.Policy.WalletID = req.WalletID
		if !control && (len(body.Policy.Operations) != 0 || len(body.Policy.Programs) != 0 || len(body.Policy.Assets) != 0) {
			return nil, errors.New("application socket may create only a locked wallet with an explicit deny-all policy")
		}
		wallet, policy, err := s.keys.CreateWithPolicy(body)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(signerWalletPolicyResultV2{Wallet: wallet, Policy: policy})
	case "v2.wallet.import":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		if err := requireControlSocketV2(control); err != nil {
			return nil, err
		}
		var body signerWalletImportRequestV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		body.WalletID = req.WalletID
		body.Policy.WalletID = req.WalletID
		wallet, policy, err := s.keys.ImportFromFileWithPolicy(body)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(signerWalletPolicyResultV2{Wallet: wallet, Policy: policy})
	case "v2.wallet.importLegacy":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		if err := requireControlSocketV2(control); err != nil {
			return nil, err
		}
		var body signerWalletLegacyImportRequestV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		body.WalletID = req.WalletID
		body.Policy.WalletID = req.WalletID
		wallet, policy, err := s.keys.ImportLegacyWithPolicy(body)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(signerWalletPolicyResultV2{Wallet: wallet, Policy: policy})
	case "v2.wallet.reencrypt":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		if err := requireControlSocketV2(control); err != nil {
			return nil, err
		}
		wallet, err := s.keys.RotateEncryption(req.WalletID)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(wallet)
	case "v2.wallet.rotation.create":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		if err := requireControlSocketV2(control); err != nil {
			return nil, err
		}
		var body signerWalletRotationCreateRequestV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		rotation, err := s.keys.CreateSuccessorRotation(req.WalletID, body)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(rotation)
	case "v2.wallet.rotation.status":
		if err := requireControlSocketV2(control); err != nil {
			return nil, err
		}
		rotation, err := s.keys.SuccessorRotationStatus(req.WalletID)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(rotation)
	case "v2.wallet.rotation.commit":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		if err := requireControlSocketV2(control); err != nil {
			return nil, err
		}
		var body signerWalletRotationCommitRequestV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		rotation, err := s.keys.CommitSuccessorRotation(req.WalletID, body)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(rotation)
	case "v2.jupiter.trigger.history":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		history, err := s.jupiterTriggerPublicHistoryV2(req.WalletID)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(history)
	case "v2.execute":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		var body signerExecuteRequestV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		if err := requireJupiterLiveExecutionV2(cfg.jupiterLive, body.Intent.Type); err != nil {
			return nil, err
		}
		body.intentWalletID = req.WalletID
		operation, err := s.execute(body)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(operation)
	case "v2.review.prepare":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		var body signerReviewPrepareRequestV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		review, err := s.prepareJupiterReviewV2(req.WalletID, body)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(review)
	case "v2.review.get":
		var body signerOperationLookupV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		review, _, err := s.store.getReviewV2(req.WalletID, body.RequestID)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(review)
	case "v2.review.execute":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		var body signerReviewExecuteRequestV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		if !cfg.jupiterLive {
			_, intent, reviewErr := s.store.getReviewV2(req.WalletID, body.RequestID)
			if reviewErr != nil {
				return nil, reviewErr
			}
			if err := requireJupiterLiveExecutionV2(false, intent.Intent.Type); err != nil {
				return nil, err
			}
		}
		result, err := s.executeJupiterReviewV2(req.WalletID, body)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(result)
	case "v2.operation.get":
		var body signerOperationLookupV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		operation, err := s.store.getOperation(body.RequestID)
		if err != nil {
			return nil, err
		}
		if normalizeWalletID(req.WalletID) != operation.WalletID {
			return nil, errors.New("signer operation wallet mismatch")
		}
		return marshalSignerResultV2(operation)
	case "v2.operation.reconcile":
		var body signerOperationLookupV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
		}
		operation, err := s.reconcile(body.RequestID, req.WalletID)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(operation)
	default:
		return nil, errors.New("unsupported signer-v2 op")
	}
}

func (s *signerServiceV2) execute(req signerExecuteRequestV2) (signerOperationV2, error) {
	switch strings.TrimSpace(req.Intent.Type) {
	case intentSolanaVaultBondAction, intentFederationBondChallenge:
		return signerOperationV2{}, errors.New("Vault bond and federation challenge intents require signer-owned reviewed authorization")
	}
	walletRecord, err := s.keys.PublicRecord(req.IntentWalletID())
	if err != nil {
		return signerOperationV2{}, err
	}
	walletPublicKey, err := solana.PublicKeyFromBase58(walletRecord.PublicKey)
	if err != nil {
		return signerOperationV2{}, errors.New("signer-owned wallet record has an invalid public key")
	}
	hydratedIntent, err := s.hydrateTypedTransferIntentV2(req.Intent, req.IntentWalletID())
	if err != nil {
		return signerOperationV2{}, err
	}
	intent, err := normalizeSignerIntentForWalletV2(hydratedIntent, &walletPublicKey)
	if err != nil {
		return signerOperationV2{}, err
	}
	policy, err := s.store.getPolicy(req.IntentWalletID())
	if err != nil {
		return signerOperationV2{}, err
	}
	if strings.TrimSpace(req.PolicyHash) == "" || req.PolicyHash != policy.Hash {
		return signerOperationV2{}, errors.New("signer policy hash mismatch")
	}
	if policy.Role == "vault" {
		return signerOperationV2{}, errors.New("Vault direct execution requires signer-reviewed authorization through review.prepare, signer-owned WebAuthn, and review.execute")
	}
	operation, lookupErr := s.store.getOperation(req.RequestID)
	existing := lookupErr == nil
	if lookupErr != nil && !errors.Is(lookupErr, errSignerOperationNotFoundV2) {
		return signerOperationV2{}, lookupErr
	}
	if existing {
		operation, _, err = s.store.reserveOperation(req, intent)
		if err != nil {
			return signerOperationV2{}, err
		}
		if operation.State != operationReserved && !isSignerOwnedTriggerIntentV2(intent) {
			return operation, nil
		}
	} else if err := s.store.preflightPolicyForIntentV2(req, intent); err != nil {
		return signerOperationV2{}, err
	}
	if roleErr := requireAutonomousRoleV2(policy, intent); roleErr != nil {
		if existing && operation.State == operationReserved {
			_, _ = s.store.markFailed(operation.RequestID, roleErr)
		}
		return signerOperationV2{}, roleErr
	}
	if isSignerOwnedTriggerIntentV2(intent) {
		return s.executeAutonomousJupiterTriggerV2(req, intent, policy, walletPublicKey)
	}
	rpcURLs, err := s.keys.SolanaRPCURLsV2(req.IntentWalletID())
	if err != nil {
		return signerOperationV2{}, errSignerNetworkPendingV2
	}
	if !existing {
		operation, _, err = s.store.reserveOperation(req, intent)
		if err != nil {
			return signerOperationV2{}, err
		}
	}
	operation, executionAttempt, claimed, err := s.store.claimReservedOperation(operation.RequestID)
	if err != nil {
		return signerOperationV2{}, err
	}
	if !claimed {
		return operation, nil
	}

	privateKey, _, err := s.keys.privateKey(req.IntentWalletID())
	if err != nil {
		_, _ = s.store.markFailedClaim(operation.RequestID, executionAttempt, err)
		return signerOperationV2{}, err
	}
	defer zeroBytes(privateKey)
	tx, err := buildTypedTransactionV2(rpcURLs, privateKey, intent)
	if err != nil {
		safeErr := errors.New("signer-owned Solana RPC transaction preparation failed")
		failed, markErr := s.store.markFailedClaim(operation.RequestID, executionAttempt, safeErr)
		if markErr != nil {
			return signerOperationV2{}, fmt.Errorf("%v; persist signer failure: %w", safeErr, markErr)
		}
		return failed, safeErr
	}
	raw, err := tx.MarshalBinary()
	if err != nil {
		failed, _ := s.store.markFailedClaim(operation.RequestID, executionAttempt, err)
		return failed, err
	}
	if len(tx.Signatures) == 0 || tx.Signatures[0].IsZero() {
		err := errors.New("typed signer transaction is missing its wallet signature")
		failed, _ := s.store.markFailedClaim(operation.RequestID, executionAttempt, err)
		return failed, err
	}
	if err := validateSignerNativeSpendV2(rpcURLs, tx, walletPublicKey, intent); err != nil {
		safeErr := fmt.Errorf("signer transaction native spend validation failed: %w", err)
		failed, markErr := s.store.markFailedClaim(operation.RequestID, executionAttempt, safeErr)
		if markErr != nil {
			return signerOperationV2{}, fmt.Errorf("%v; persist signer failure: %w", safeErr, markErr)
		}
		return failed, safeErr
	}
	digest := sha256.Sum256(raw)
	signature := tx.Signatures[0].String()
	signedTxBase64 := base64.StdEncoding.EncodeToString(raw)
	operation, err = s.store.markBroadcastClaim(
		operation.RequestID,
		executionAttempt,
		signature,
		"sha256:"+hex.EncodeToString(digest[:]),
		signedTxBase64,
	)
	if err != nil {
		return signerOperationV2{}, err
	}

	if err := broadcastSignedOnceV2(rpcURLs, raw, tx.Signatures[0]); err != nil {
		safeErr := errors.New("signer-owned Solana RPC broadcast result is ambiguous")
		unknown, markErr := s.store.markUnknown(operation.RequestID, safeErr)
		if markErr != nil {
			return operation, fmt.Errorf("%v; persist ambiguous signer result: %w", safeErr, markErr)
		}
		return unknown, nil
	}
	if err := confirmSignerSolanaSignatureAcrossRPCsV2(rpcURLs, tx.Signatures[0]); err != nil {
		status, statusErr := lookupSignatureStatusV2(rpcURLs, tx.Signatures[0])
		if statusErr == nil {
			switch status {
			case "confirmed":
				return s.store.markConfirmed(operation.RequestID)
			case "failed":
				failed, markErr := s.store.markFailed(operation.RequestID, errors.New("Solana transaction failed on chain"))
				if markErr != nil {
					return operation, markErr
				}
				return failed, nil
			}
		}
		unknown, markErr := s.store.markUnknown(operation.RequestID, errors.New("signer-owned Solana RPC confirmation remains ambiguous"))
		if markErr != nil {
			return operation, markErr
		}
		return unknown, nil
	}
	return s.store.markConfirmed(operation.RequestID)
}

func (s *signerServiceV2) hydrateTypedTransferIntentV2(input signerIntentV2, walletID string) (signerIntentV2, error) {
	if strings.TrimSpace(input.Type) != intentSolanaSPLTransferChecked || strings.TrimSpace(input.TokenProgram) != "" {
		return input, nil
	}
	mint, err := solana.PublicKeyFromBase58(strings.TrimSpace(input.Mint))
	if err != nil {
		return signerIntentV2{}, errors.New("invalid SPL mint")
	}
	rpcURLs, err := s.keys.SolanaRPCURLsV2(walletID)
	if err != nil {
		return signerIntentV2{}, errSignerNetworkPendingV2
	}
	tokenProgram, err := resolveMintTokenProgramV2(rpcURLs, mint)
	if err != nil {
		return signerIntentV2{}, err
	}
	input.TokenProgram = tokenProgram.String()
	return input, nil
}

func buildTypedTransactionV2(
	rpcURLs []string,
	privateKey solana.PrivateKey,
	intent normalizedIntentV2,
) (*solana.Transaction, error) {
	from := privateKey.PublicKey()
	var decimals *uint8
	if intent.Intent.Type == intentSolanaSPLTransferChecked {
		tokenProgram := solana.MustPublicKeyFromBase58(intent.Intent.TokenProgram)
		mint := solana.MustPublicKeyFromBase58(intent.Intent.Mint)
		resolvedDecimals, err := resolveMintDecimalsV2(rpcURLs, mint, tokenProgram)
		if err != nil {
			return nil, err
		}
		decimals = &resolvedDecimals
		if err := validateSPLTransferAccountsV2(
			rpcURLs,
			from,
			solana.MustPublicKeyFromBase58(intent.Intent.Destination),
			mint,
			tokenProgram,
		); err != nil {
			return nil, err
		}
	}
	instructions, err := buildTypedInstructionsV2(from, intent, decimals)
	if err != nil {
		return nil, err
	}

	blockhash, err := signerLatestBlockhashWithFallbackV2(rpcURLs)
	if err != nil {
		return nil, err
	}
	tx, err := solana.NewTransaction(instructions, blockhash, solana.TransactionPayer(from))
	if err != nil {
		return nil, err
	}
	_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(from) {
			copy := privateKey
			return &copy
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return tx, nil
}

func buildTypedInstructionsV2(
	from solana.PublicKey,
	intent normalizedIntentV2,
	decimals *uint8,
) ([]solana.Instruction, error) {
	appendMemo := func(instructions []solana.Instruction) []solana.Instruction {
		if intent.Intent.Memo == "" {
			return instructions
		}
		return append(instructions, solana.NewInstruction(
			memoProgramV2V2,
			solana.AccountMetaSlice{&solana.AccountMeta{PublicKey: from, IsSigner: true}},
			[]byte(intent.Intent.Memo),
		))
	}
	switch intent.Intent.Type {
	case intentSolanaNativeTransfer:
		to := solana.MustPublicKeyFromBase58(intent.Intent.Destination)
		amount, err := uint64FromBigV2(intent.Amount)
		if err != nil {
			return nil, err
		}
		data := make([]byte, 12)
		binary.LittleEndian.PutUint32(data[:4], 2)
		binary.LittleEndian.PutUint64(data[4:], amount)
		return appendMemo([]solana.Instruction{solana.NewInstruction(
			solana.SystemProgramID,
			solana.AccountMetaSlice{
				&solana.AccountMeta{PublicKey: from, IsSigner: true, IsWritable: true},
				&solana.AccountMeta{PublicKey: to, IsWritable: true},
			},
			data,
		)}), nil
	case intentSolanaSPLTransferChecked:
		if decimals == nil {
			return nil, errors.New("SPL mint decimals are required")
		}
		tokenProgram := solana.MustPublicKeyFromBase58(intent.Intent.TokenProgram)
		mint := solana.MustPublicKeyFromBase58(intent.Intent.Mint)
		destinationOwner := solana.MustPublicKeyFromBase58(intent.Intent.Destination)
		sourceATA, err := findAssociatedTokenAddressV2(from, mint, tokenProgram)
		if err != nil {
			return nil, err
		}
		destinationATA, err := findAssociatedTokenAddressV2(destinationOwner, mint, tokenProgram)
		if err != nil {
			return nil, err
		}
		amount, err := uint64FromBigV2(intent.Amount)
		if err != nil {
			return nil, err
		}
		transferData := make([]byte, 10)
		transferData[0] = 12
		binary.LittleEndian.PutUint64(transferData[1:9], amount)
		transferData[9] = *decimals
		createDestinationATA := solana.NewInstruction(
			solana.SPLAssociatedTokenAccountProgramID,
			solana.AccountMetaSlice{
				&solana.AccountMeta{PublicKey: from, IsSigner: true, IsWritable: true},
				&solana.AccountMeta{PublicKey: destinationATA, IsWritable: true},
				&solana.AccountMeta{PublicKey: destinationOwner},
				&solana.AccountMeta{PublicKey: mint},
				&solana.AccountMeta{PublicKey: solana.SystemProgramID},
				&solana.AccountMeta{PublicKey: tokenProgram},
			},
			[]byte{1}, // CreateIdempotent: safe whether the canonical ATA already exists or not.
		)
		transfer := solana.NewInstruction(
			tokenProgram,
			solana.AccountMetaSlice{
				&solana.AccountMeta{PublicKey: sourceATA, IsWritable: true},
				&solana.AccountMeta{PublicKey: mint},
				&solana.AccountMeta{PublicKey: destinationATA, IsWritable: true},
				&solana.AccountMeta{PublicKey: from, IsSigner: true},
			},
			transferData,
		)
		return appendMemo([]solana.Instruction{createDestinationATA, transfer}), nil
	case intentSolanaSATAction, intentSolanaVaultBondAction:
		if len(intent.Instructions) == 0 || len(intent.Instructions) > 6 {
			return nil, errors.New("typed SAT action has an invalid instruction count")
		}
		return intent.Instructions, nil
	default:
		return nil, errors.New("unsupported typed signer intent")
	}
}

func validateSPLTransferAccountsV2(
	rpcURLs []string,
	owner solana.PublicKey,
	destinationOwner solana.PublicKey,
	mint solana.PublicKey,
	tokenProgram solana.PublicKey,
) error {
	sourceATA, err := findAssociatedTokenAddressV2(owner, mint, tokenProgram)
	if err != nil {
		return err
	}
	destinationATA, err := findAssociatedTokenAddressV2(destinationOwner, mint, tokenProgram)
	if err != nil {
		return err
	}
	active, err := activeSolanaWriteRPCURLs(rpcURLs)
	if err != nil {
		return err
	}
	for _, rpcURL := range active {
		client := newSignerOwnedSolanaRPCClientV2(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		response, requestErr := client.GetMultipleAccounts(ctx, sourceATA, destinationATA)
		cancel()
		if requestErr != nil || response == nil || len(response.Value) != 2 {
			if requestErr == nil {
				requestErr = errors.New("missing SPL transfer account response")
			}
			markSolanaWriteRPCFailure(rpcURL, requestErr)
			continue
		}
		if err := validateSPLTransferAccountResponseV2(
			response.Value,
			owner,
			destinationOwner,
			mint,
			tokenProgram,
		); err != nil {
			return err
		}
		markSolanaWriteRPCSuccess(rpcURL)
		return nil
	}
	return errors.New("signer-owned Solana RPC could not verify existing SPL transfer accounts")
}

func validateSPLTransferAccountResponseV2(
	accounts []*rpc.Account,
	owner solana.PublicKey,
	destinationOwner solana.PublicKey,
	mint solana.PublicKey,
	tokenProgram solana.PublicKey,
) error {
	if len(accounts) != 2 {
		return errors.New("SPL transfer account response must contain source and destination accounts")
	}
	source := accounts[0]
	decodedSource, ok := parseJupiterTokenAccountV2(source)
	if !ok || source == nil || !source.Owner.Equals(tokenProgram) ||
		!decodedSource.Mint.Equals(mint) || !decodedSource.Owner.Equals(owner) {
		return errors.New("SPL transfer requires an existing canonical source associated-token account")
	}
	// A missing destination is expected for a first transfer. The signer always
	// includes the canonical CreateIdempotent instruction. If an account already
	// exists at that address, validate it before signing as defense in depth.
	destination := accounts[1]
	if destination == nil {
		return nil
	}
	decodedDestination, ok := parseJupiterTokenAccountV2(destination)
	if !ok || !destination.Owner.Equals(tokenProgram) ||
		!decodedDestination.Mint.Equals(mint) || !decodedDestination.Owner.Equals(destinationOwner) {
		return errors.New("existing SPL destination associated-token account has the wrong mint, owner, or token program")
	}
	return nil
}

func findAssociatedTokenAddressV2(owner, mint, tokenProgram solana.PublicKey) (solana.PublicKey, error) {
	address, _, err := solana.FindProgramAddress(
		[][]byte{owner[:], tokenProgram[:], mint[:]},
		solana.SPLAssociatedTokenAccountProgramID,
	)
	return address, err
}

func resolveMintDecimalsV2(rpcURLs []string, mint, tokenProgram solana.PublicKey) (uint8, error) {
	active, err := activeSolanaWriteRPCURLs(rpcURLs)
	if err != nil {
		return 0, err
	}
	var failures []string
	for index, rpcURL := range active {
		client := newSignerOwnedSolanaRPCClientV2(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		result, requestErr := client.GetAccountInfo(ctx, mint)
		cancel()
		if requestErr != nil {
			markSolanaWriteRPCFailure(rpcURL, requestErr)
			failures = append(failures, fmt.Sprintf("endpoint %d: %v", index+1, requestErr))
			continue
		}
		markSolanaWriteRPCSuccess(rpcURL)
		return validatePlainSPLMintAccountV2(result.Value, tokenProgram)
	}
	return 0, fmt.Errorf("resolve SPL mint metadata failed: %s", strings.Join(failures, "; "))
}

func resolveMintTokenProgramV2(rpcURLs []string, mint solana.PublicKey) (solana.PublicKey, error) {
	active, err := activeSolanaWriteRPCURLs(rpcURLs)
	if err != nil {
		return solana.PublicKey{}, err
	}
	for _, rpcURL := range active {
		client := newSignerOwnedSolanaRPCClientV2(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		result, requestErr := client.GetAccountInfo(ctx, mint)
		cancel()
		if requestErr != nil || result == nil || result.Value == nil {
			if requestErr == nil {
				requestErr = errors.New("SPL mint account is unavailable")
			}
			markSolanaWriteRPCFailure(rpcURL, requestErr)
			continue
		}
		owner := result.Value.Owner
		if !owner.Equals(solana.TokenProgramID) && !owner.Equals(solana.Token2022ProgramID) {
			return solana.PublicKey{}, errors.New("SPL mint uses an unsupported token program")
		}
		if _, err := validatePlainSPLMintAccountV2(result.Value, owner); err != nil {
			return solana.PublicKey{}, err
		}
		markSolanaWriteRPCSuccess(rpcURL)
		return owner, nil
	}
	return solana.PublicKey{}, errors.New("signer-owned Solana RPC could not resolve SPL mint metadata")
}

func validatePlainSPLMintAccountV2(account *rpc.Account, tokenProgram solana.PublicKey) (uint8, error) {
	if !tokenProgram.Equals(solana.TokenProgramID) && !tokenProgram.Equals(solana.Token2022ProgramID) {
		return 0, errors.New("SPL mint uses an unsupported token program")
	}
	if account == nil || account.Executable || account.Data == nil || !account.Owner.Equals(tokenProgram) {
		return 0, errors.New("SPL mint account owner does not match the typed token program")
	}
	data := account.Data.GetBinary()
	if len(data) != 82 {
		if tokenProgram.Equals(solana.Token2022ProgramID) {
			return 0, errors.New("Token-2022 mint extensions are not supported by typed transfers")
		}
		return 0, errors.New("SPL mint account has an unsupported data layout")
	}
	if data[45] == 0 {
		return 0, errors.New("SPL mint account is invalid or uninitialized")
	}
	return data[44], nil
}

func signerOwnedSolanaBalanceV2(rpcURLs []string, address solana.PublicKey) (uint64, error) {
	active, err := activeSolanaWriteRPCURLs(rpcURLs)
	if err != nil {
		return 0, err
	}
	for _, rpcURL := range active {
		client := newSignerOwnedSolanaRPCClientV2(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		result, requestErr := client.GetBalance(ctx, address, rpc.CommitmentConfirmed)
		cancel()
		if requestErr != nil || result == nil {
			if requestErr == nil {
				requestErr = errors.New("missing Solana balance result")
			}
			markSolanaWriteRPCFailure(rpcURL, requestErr)
			continue
		}
		markSolanaWriteRPCSuccess(rpcURL)
		return result.Value, nil
	}
	return 0, errors.New("signer-owned Solana RPC balance lookup failed")
}

func validateSignerNativeSpendV2(
	rpcURLs []string,
	tx *solana.Transaction,
	wallet solana.PublicKey,
	intent normalizedIntentV2,
) error {
	if tx == nil {
		return errors.New("signed transaction is missing")
	}
	// A signer-built native transfer has one static System instruction and no
	// account creation, so its exact principal is already signer-derived. SPL
	// transfers may fund one canonical destination ATA and therefore continue
	// through simulation below to enforce the signer-owned fee/rent ceiling.
	if intent.Intent.Type == intentSolanaNativeTransfer {
		return nil
	}
	feeCeiling, err := signerFeeReservationForIntentV2(intent)
	if err != nil {
		return err
	}
	principal := big.NewInt(0)
	if intent.Asset == "solana:native" {
		principal.Set(intent.Amount)
	}
	maximum := new(big.Int).Add(principal, feeCeiling)
	active, err := activeSolanaWriteRPCURLs(rpcURLs)
	if err != nil {
		return err
	}
	for _, rpcURL := range active {
		client := newSignerOwnedSolanaRPCClientV2(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		preResponse, preErr := client.GetAccountInfo(ctx, wallet)
		if preErr != nil || preResponse == nil || preResponse.Value == nil {
			cancel()
			if preErr == nil {
				preErr = errors.New("wallet account is missing")
			}
			markSolanaWriteRPCFailure(rpcURL, preErr)
			continue
		}
		simulation, simulationErr := client.SimulateTransactionWithOpts(ctx, tx, &rpc.SimulateTransactionOpts{
			SigVerify:  false,
			Commitment: rpc.CommitmentConfirmed,
			Accounts: &rpc.SimulateTransactionAccountsOpts{
				Encoding:  solana.EncodingBase64,
				Addresses: []solana.PublicKey{wallet},
			},
		})
		cancel()
		if simulationErr != nil || simulation == nil || simulation.Value == nil || simulation.Value.Err != nil || len(simulation.Value.Accounts) != 1 || simulation.Value.Accounts[0] == nil {
			if simulationErr == nil {
				simulationErr = errors.New("wallet spend simulation failed or omitted the wallet account")
			}
			markSolanaWriteRPCFailure(rpcURL, simulationErr)
			continue
		}
		pre := preResponse.Value
		post := simulation.Value.Accounts[0]
		if pre.Executable || post.Executable || !pre.Owner.Equals(solana.SystemProgramID) || !post.Owner.Equals(solana.SystemProgramID) {
			return errors.New("wallet payer is not a canonical System account")
		}
		spent := big.NewInt(0)
		if pre.Lamports > post.Lamports {
			spent.SetUint64(pre.Lamports - post.Lamports)
		}
		if spent.Cmp(maximum) > 0 {
			return fmt.Errorf("wallet native spend %s exceeds principal plus signer fee/rent ceiling %s", spent, maximum)
		}
		if principal.Sign() > 0 && spent.Cmp(principal) < 0 {
			return errors.New("simulation did not apply the exact reviewed native principal")
		}
		markSolanaWriteRPCSuccess(rpcURL)
		return nil
	}
	return errors.New("signer-owned Solana RPC native spend validation failed")
}

func broadcastSignedOnceV2(rpcURLs []string, signedRaw []byte, expectedSignature solana.Signature) error {
	active, err := activeSolanaWriteRPCURLs(rpcURLs)
	if err != nil {
		return err
	}
	rpcURL := active[0]
	client := newSignerOwnedSolanaRPCClientV2(rpcURL)
	ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
	defer cancel()
	signature, err := client.SendRawTransactionWithOpts(ctx, signedRaw, rpc.TransactionOpts{
		SkipPreflight:       false,
		PreflightCommitment: rpc.CommitmentConfirmed,
	})
	if err != nil {
		markSolanaWriteRPCFailure(rpcURL, err)
		return fmt.Errorf("Solana transaction broadcast result is ambiguous: %w", err)
	}
	markSolanaWriteRPCSuccess(rpcURL)
	if signature != expectedSignature {
		return errors.New("Solana RPC returned a different signature for the signed transaction")
	}
	return nil
}

func lookupSignatureStatusV2(rpcURLs []string, signature solana.Signature) (string, error) {
	active, err := activeSolanaWriteRPCURLs(rpcURLs)
	if err != nil {
		return "unknown", err
	}
	for _, rpcURL := range active {
		client := newSignerOwnedSolanaRPCClientV2(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		status, requestErr := client.GetSignatureStatuses(ctx, true, signature)
		cancel()
		if requestErr != nil {
			markSolanaWriteRPCFailure(rpcURL, requestErr)
			continue
		}
		markSolanaWriteRPCSuccess(rpcURL)
		if status == nil || status.Value == nil || len(status.Value) == 0 || status.Value[0] == nil {
			continue
		}
		if status.Value[0].Err != nil {
			return "failed", nil
		}
		if status.Value[0].ConfirmationStatus == rpc.ConfirmationStatusConfirmed ||
			status.Value[0].ConfirmationStatus == rpc.ConfirmationStatusFinalized {
			return "confirmed", nil
		}
		return "pending", nil
	}
	return "unknown", nil
}

func signerLatestBlockhashWithFallbackV2(rpcURLs []string) (solana.Hash, error) {
	active, err := activeSolanaWriteRPCURLs(rpcURLs)
	if err != nil {
		return solana.Hash{}, err
	}
	for _, rpcURL := range active {
		client := newSignerOwnedSolanaRPCClientV2(rpcURL)
		ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
		result, requestErr := client.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
		cancel()
		if requestErr == nil {
			markSolanaWriteRPCSuccess(rpcURL)
			return result.Value.Blockhash, nil
		}
		markSolanaWriteRPCFailure(rpcURL, requestErr)
	}
	return solana.Hash{}, errors.New("signer-owned Solana RPC latest-blockhash lookup failed")
}

func confirmSignerSolanaSignatureAcrossRPCsV2(rpcURLs []string, signature solana.Signature) error {
	confirmCtx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCConfirmTimeout())
	defer cancel()
	tick := time.NewTicker(750 * time.Millisecond)
	defer tick.Stop()
	for {
		active, activeErr := activeSolanaWriteRPCURLs(rpcURLs)
		if activeErr == nil {
			for _, rpcURL := range active {
				client := newSignerOwnedSolanaRPCClientV2(rpcURL)
				requestCtx, requestCancel := context.WithTimeout(confirmCtx, solanaWriteRPCRequestTimeout())
				status, err := client.GetSignatureStatuses(requestCtx, true, signature)
				requestCancel()
				if err != nil {
					markSolanaWriteRPCFailure(rpcURL, err)
					continue
				}
				markSolanaWriteRPCSuccess(rpcURL)
				if status == nil || status.Value == nil || len(status.Value) == 0 || status.Value[0] == nil {
					continue
				}
				if status.Value[0].Err != nil {
					return errors.New("Solana transaction failed on chain")
				}
				if status.Value[0].ConfirmationStatus == rpc.ConfirmationStatusConfirmed ||
					status.Value[0].ConfirmationStatus == rpc.ConfirmationStatusFinalized {
					return nil
				}
			}
		}
		select {
		case <-confirmCtx.Done():
			return errors.New("signer-owned Solana RPC confirmation timed out")
		case <-tick.C:
		}
	}
}

func (s *signerServiceV2) reconcile(requestID, walletID string) (signerOperationV2, error) {
	operation, err := s.store.getOperation(requestID)
	if err != nil {
		return signerOperationV2{}, err
	}
	if operation.WalletID != normalizeWalletID(walletID) {
		return signerOperationV2{}, errors.New("signer operation wallet mismatch")
	}
	if operation.State != operationBroadcast && operation.State != operationUnknown {
		return operation, nil
	}
	if operation.IntentType == intentSolanaTriggerCreate || operation.IntentType == intentSolanaTriggerCancel {
		workflow, workflowErr := s.store.getJupiterTriggerWorkflowV2(requestID)
		if workflowErr != nil {
			return operation, workflowErr
		}
		var semantic signerIntentV2
		if json.Unmarshal(workflow.SemanticIntent, &semantic) != nil {
			return operation, errors.New("stored Jupiter Trigger semantic intent is invalid")
		}
		walletRecord, walletErr := s.keys.PublicRecord(walletID)
		if walletErr != nil {
			return operation, walletErr
		}
		walletPublicKey, walletErr := solana.PublicKeyFromBase58(walletRecord.PublicKey)
		if walletErr != nil {
			return operation, errors.New("signer-owned wallet record has an invalid public key")
		}
		intent, intentErr := normalizeSignerIntentForWalletV2(semantic, &walletPublicKey)
		if intentErr != nil || intent.Digest != workflow.IntentDigest || intent.Digest != operation.IntentDigest {
			return operation, errors.New("stored Jupiter Trigger semantic intent is inconsistent")
		}
		privateKey, _, keyErr := s.keys.privateKey(walletID)
		if keyErr != nil {
			return operation, keyErr
		}
		defer zeroBytes(privateKey)
		return s.reconcileJupiterTriggerWorkflowV2(
			signerExecuteRequestV2{
				RequestID: requestID, PolicyHash: operation.PolicyHash,
				Intent: intent.Intent, intentWalletID: walletID,
			},
			intent,
			walletPublicKey,
			privateKey,
			operation,
			workflow,
		)
	}
	signature, err := solana.SignatureFromBase58(operation.Signature)
	if err != nil {
		return signerOperationV2{}, errors.New("stored signer operation signature is invalid")
	}
	rpcURLs, err := s.keys.SolanaRPCURLsV2(walletID)
	if err != nil {
		return operation, errSignerNetworkPendingV2
	}
	status, err := lookupSignatureStatusV2(rpcURLs, signature)
	if err != nil {
		return operation, errors.New("signer-owned Solana RPC reconciliation failed")
	}
	switch status {
	case "confirmed":
		return s.store.markConfirmed(requestID)
	case "failed":
		return s.store.markFailed(requestID, errors.New("Solana transaction failed on chain"))
	default:
		return s.store.markUnknown(requestID, errors.New("Solana transaction status remains ambiguous"))
	}
}
