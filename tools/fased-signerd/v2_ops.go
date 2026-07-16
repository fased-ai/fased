package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	Schema       signerSchemaHealthV2    `json:"schema"`
	Network      signerNetworkHealthV2   `json:"network"`
	Capabilities signerCapabilitiesV2    `json:"capabilities"`
	Policies     []signerPolicySummaryV2 `json:"policies"`
	WebAuthn     signerWebAuthnHealthV2  `json:"webAuthn"`
}

func marshalSignerResultV2(result any) ([]byte, error) {
	return json.Marshal(map[string]any{"ok": true, "result": result})
}

func (s *signerServiceV2) health(cfg signerConfig) (signerHealthResultV2, error) {
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
	return signerHealthResultV2{
		Details:      "fased-signerd protocol-v2 ready",
		ReadOnly:     cfg.readOnly,
		KeystoreType: "signer-owned-v2",
		Chains:       cfg.chains,
		Ready:        schemaHealth.Ready,
		Schema:       schemaHealth,
		Network:      networkHealth,
		Capabilities: signerV2Capabilities,
		Policies:     summaries,
		WebAuthn:     webauthnHealth,
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
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return errors.New("invalid signer-v2 request")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
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
		credentials, err := s.webauthn.listCredentials()
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(credentials)
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
	case "v2.execute":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		var body signerExecuteRequestV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
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
	case "v2.review.execute":
		if cfg.readOnly {
			return nil, errors.New("read-only signer mode")
		}
		var body signerReviewExecuteRequestV2
		if err := decodeSignerRequestV2(req.Request, &body); err != nil {
			return nil, err
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
	intent, err := normalizeSignerIntentForWalletV2(req.Intent, &walletPublicKey)
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
		return signerOperationV2{}, errors.New("Vault wallets require review.prepare, signer-owned WebAuthn authorization, and review.execute")
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
		if operation.State != operationReserved {
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
	digest := sha256.Sum256(raw)
	signature := tx.Signatures[0].String()
	operation, err = s.store.markBroadcastClaim(operation.RequestID, executionAttempt, signature, "sha256:"+hex.EncodeToString(digest[:]))
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
		return []solana.Instruction{solana.NewInstruction(
			solana.SystemProgramID,
			solana.AccountMetaSlice{
				&solana.AccountMeta{PublicKey: from, IsSigner: true, IsWritable: true},
				&solana.AccountMeta{PublicKey: to, IsWritable: true},
			},
			data,
		)}, nil
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
		createATA := solana.NewInstruction(
			solana.SPLAssociatedTokenAccountProgramID,
			solana.AccountMetaSlice{
				&solana.AccountMeta{PublicKey: from, IsSigner: true, IsWritable: true},
				&solana.AccountMeta{PublicKey: destinationATA, IsWritable: true},
				&solana.AccountMeta{PublicKey: destinationOwner},
				&solana.AccountMeta{PublicKey: mint},
				&solana.AccountMeta{PublicKey: solana.SystemProgramID},
				&solana.AccountMeta{PublicKey: tokenProgram},
			},
			[]byte{1},
		)
		transferData := make([]byte, 10)
		transferData[0] = 12
		binary.LittleEndian.PutUint64(transferData[1:9], amount)
		transferData[9] = *decimals
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
		return []solana.Instruction{createATA, transfer}, nil
	case intentSolanaSATAction, intentSolanaVaultBondAction:
		if len(intent.Instructions) == 0 || len(intent.Instructions) > 6 {
			return nil, errors.New("typed SAT action has an invalid instruction count")
		}
		return intent.Instructions, nil
	default:
		return nil, errors.New("unsupported typed signer intent")
	}
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
		if result.Value == nil || !result.Value.Owner.Equals(tokenProgram) {
			return 0, errors.New("SPL mint account owner does not match the typed token program")
		}
		data := result.GetBinary()
		if len(data) < 82 || data[45] == 0 {
			return 0, errors.New("SPL mint account is invalid or uninitialized")
		}
		return data[44], nil
	}
	return 0, fmt.Errorf("resolve SPL mint metadata failed: %s", strings.Join(failures, "; "))
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
