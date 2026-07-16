package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	solana "github.com/gagliardetto/solana-go"
	rpc "github.com/gagliardetto/solana-go/rpc"
)

type signerServiceV2 struct {
	store *signerStoreV2
	keys  *signerKeyManagerV2
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
	Capabilities signerCapabilitiesV2    `json:"capabilities"`
	Policies     []signerPolicySummaryV2 `json:"policies"`
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
	return signerHealthResultV2{
		Details:      "fased-signerd protocol-v2 ready",
		ReadOnly:     cfg.readOnly,
		KeystoreType: "signer-owned-v2",
		Chains:       cfg.chains,
		Ready:        true,
		Capabilities: signerV2Capabilities,
		Policies:     summaries,
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
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
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
		operation, err := s.execute(body, cfg)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(operation)
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
		operation, err := s.reconcile(body.RequestID, req.WalletID, cfg)
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(operation)
	default:
		return nil, errors.New("unsupported signer-v2 op")
	}
}

func (s *signerServiceV2) execute(req signerExecuteRequestV2, cfg signerConfig) (signerOperationV2, error) {
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
	operation, _, err := s.store.reserveOperation(req, intent)
	if err != nil {
		return signerOperationV2{}, err
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
	rpcURLs := cfg.solanaWriteRPCURLsForWallet(req.IntentWalletID())
	tx, err := buildTypedTransactionV2(rpcURLs, privateKey, intent)
	if err != nil {
		failed, markErr := s.store.markFailedClaim(operation.RequestID, executionAttempt, err)
		if markErr != nil {
			return signerOperationV2{}, fmt.Errorf("%v; persist signer failure: %w", err, markErr)
		}
		return failed, err
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
		unknown, markErr := s.store.markUnknown(operation.RequestID, err)
		if markErr != nil {
			return operation, fmt.Errorf("%v; persist ambiguous signer result: %w", err, markErr)
		}
		return unknown, nil
	}
	if err := confirmSolanaSignatureAcrossRPCs(rpcURLs, tx.Signatures[0]); err != nil {
		status, statusErr := lookupSignatureStatusV2(rpcURLs, tx.Signatures[0])
		if statusErr == nil {
			switch status {
			case "confirmed":
				return s.store.markConfirmed(operation.RequestID)
			case "failed":
				failed, markErr := s.store.markFailed(operation.RequestID, err)
				if markErr != nil {
					return operation, markErr
				}
				return failed, nil
			}
		}
		unknown, markErr := s.store.markUnknown(operation.RequestID, err)
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

	blockhash, err := solanaLatestBlockhashWithFallback(rpcURLs)
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
	case intentSolanaSATAction:
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
		client := rpc.New(rpcURL)
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

func broadcastSignedOnceV2(rpcURLs []string, signedRaw []byte, expectedSignature solana.Signature) error {
	active, err := activeSolanaWriteRPCURLs(rpcURLs)
	if err != nil {
		return err
	}
	rpcURL := active[0]
	client := rpc.New(rpcURL)
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
		client := rpc.New(rpcURL)
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

func (s *signerServiceV2) reconcile(requestID, walletID string, cfg signerConfig) (signerOperationV2, error) {
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
	status, err := lookupSignatureStatusV2(cfg.solanaWriteRPCURLsForWallet(walletID), signature)
	if err != nil {
		return operation, err
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
