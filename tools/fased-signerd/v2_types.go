package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"time"

	solana "github.com/gagliardetto/solana-go"
)

const (
	signerProtocolVersion = 2

	intentSolanaNativeTransfer     = "solana.nativeTransfer"
	intentSolanaSPLTransferChecked = "solana.splTransferChecked"
	intentSolanaSATAction          = "solana.satAction"
	intentSolanaJupiterSwap        = "solana.jupiter.swap"
	intentSolanaTriggerAuth        = "solana.jupiter.trigger.auth"
	intentSolanaTriggerCreate      = "solana.jupiter.trigger.create"
	intentSolanaTriggerDeposit     = "solana.jupiter.trigger.deposit"
	intentSolanaTriggerCancel      = "solana.jupiter.trigger.cancel"
	intentSolanaTriggerWithdraw    = "solana.jupiter.trigger.withdraw"

	operationReserved  = "reserved"
	operationBroadcast = "broadcast"
	operationConfirmed = "confirmed"
	operationFailed    = "failed"
	operationUnknown   = "unknown"
)

var signerV2Capabilities = signerCapabilitiesV2{
	Protocol: signerProtocolRangeV2{Current: signerProtocolVersion, Min: signerProtocolVersion, Max: signerProtocolVersion},
	IntentTypes: []string{
		intentSolanaNativeTransfer,
		intentSolanaSPLTransferChecked,
		intentSolanaSATAction,
		intentSolanaJupiterSwap,
		intentSolanaTriggerAuth,
		intentSolanaTriggerCreate,
		intentSolanaTriggerDeposit,
		intentSolanaTriggerCancel,
		intentSolanaTriggerWithdraw,
	},
	OperationStates: []string{
		operationReserved,
		operationBroadcast,
		operationConfirmed,
		operationFailed,
		operationUnknown,
	},
	Features: []string{
		"failClosedPolicies",
		"policyHashes",
		"durableCaps",
		"atomicIdempotency",
		"ambiguousBroadcastReconciliation",
		"signerOwnedKeys",
		"signerOwnedRPC",
		"typedSolanaTransactions",
		"typedSATActions",
		"signerOwnedWebAuthn",
		"singleUseReviewedAuthorization",
		"typedJupiterSemantics",
		"signerOwnedReviewPrepareExecute",
		"verifiedAddressLookupTables",
	},
}

type signerProtocolRangeV2 struct {
	Current int `json:"current"`
	Min     int `json:"min"`
	Max     int `json:"max"`
}

type signerCapabilitiesV2 struct {
	Protocol        signerProtocolRangeV2 `json:"protocol"`
	IntentTypes     []string              `json:"intentTypes"`
	OperationStates []string              `json:"operationStates"`
	Features        []string              `json:"features"`
}

type signerIntentV2 struct {
	Type         string                   `json:"type"`
	Destination  string                   `json:"destination,omitempty"`
	Lamports     string                   `json:"lamports,omitempty"`
	TokenProgram string                   `json:"tokenProgram,omitempty"`
	Mint         string                   `json:"mint,omitempty"`
	Amount       string                   `json:"amount,omitempty"`
	Action       string                   `json:"action,omitempty"`
	ProgramID    string                   `json:"programId,omitempty"`
	DataBase64   string                   `json:"dataBase64,omitempty"`
	Keys         []signerSATAccountV2     `json:"keys,omitempty"`
	Context      *signerSATContextV2      `json:"context,omitempty"`
	Instructions []signerSATInstructionV2 `json:"instructions,omitempty"`
	Jupiter      *signerJupiterIntentV2   `json:"jupiter,omitempty"`
}

type signerExecuteRequestV2 struct {
	RequestID      string         `json:"requestId"`
	PolicyHash     string         `json:"policyHash"`
	Intent         signerIntentV2 `json:"intent"`
	intentWalletID string         `json:"-"`
}

type signerOperationLookupV2 struct {
	RequestID string `json:"requestId"`
}

type signerPolicyAssetV2 struct {
	Asset        string   `json:"asset"`
	Destinations []string `json:"destinations"`
	MaxPerTx     string   `json:"maxPerTx"`
	MaxDaily     string   `json:"maxDaily"`
}

type signerPolicyV2 struct {
	WalletID   string                `json:"walletId"`
	Role       string                `json:"role"`
	Version    uint64                `json:"version"`
	Operations []string              `json:"operations"`
	Programs   []string              `json:"programs"`
	Assets     []signerPolicyAssetV2 `json:"assets"`
	Hash       string                `json:"hash"`
}

type signerPolicyPutRequestV2 struct {
	ExpectedVersion uint64         `json:"expectedVersion"`
	Policy          signerPolicyV2 `json:"policy"`
}

type signerWalletCreateRequestV2 struct {
	WalletID        string         `json:"-"`
	ExpectedVersion uint64         `json:"expectedPolicyVersion"`
	Policy          signerPolicyV2 `json:"policy"`
}

type signerWalletImportRequestV2 struct {
	WalletID        string         `json:"-"`
	ExpectedVersion uint64         `json:"expectedPolicyVersion"`
	Policy          signerPolicyV2 `json:"policy"`
	Path            string         `json:"path"`
}

type signerWalletLegacyImportRequestV2 struct {
	WalletID        string         `json:"-"`
	ExpectedVersion uint64         `json:"expectedPolicyVersion"`
	Policy          signerPolicyV2 `json:"policy"`
	Path            string         `json:"path"`
	PassphrasePath  string         `json:"passphrasePath"`
}

type signerWalletRotateRequestV2 struct {
	WalletID string `json:"walletId"`
}

type signerWalletRecordV2 struct {
	WalletID  string `json:"walletId"`
	PublicKey string `json:"publicKey"`
	Version   uint64 `json:"version"`
	CreatedAt string `json:"createdAt"`
	RotatedAt string `json:"rotatedAt,omitempty"`
	Nonce     string `json:"nonce"`
	Secret    string `json:"secret"`
}

type signerOperationV2 struct {
	RequestID           string `json:"requestId"`
	WalletID            string `json:"walletId"`
	IntentType          string `json:"intentType"`
	IntentDigest        string `json:"intentDigest"`
	TransactionDigest   string `json:"transactionDigest,omitempty"`
	PolicyHash          string `json:"policyHash"`
	Asset               string `json:"asset"`
	Amount              string `json:"amount"`
	State               string `json:"state"`
	ReservationActive   bool   `json:"reservationActive"`
	UsageBucket         string `json:"usageBucket"`
	ReservedAt          string `json:"reservedAt"`
	BroadcastAt         string `json:"broadcastAt,omitempty"`
	ConfirmedAt         string `json:"confirmedAt,omitempty"`
	UpdatedAt           string `json:"updatedAt"`
	Signature           string `json:"signature,omitempty"`
	Error               string `json:"error,omitempty"`
	ExecutionAttempt    uint64 `json:"executionAttempt,omitempty"`
	ExecutionLeaseUntil string `json:"executionLeaseUntil,omitempty"`
}

type normalizedIntentV2 struct {
	Intent           signerIntentV2
	Digest           string
	Asset            string
	Amount           *big.Int
	RequiredPrograms []string
	Destination      string
	Instructions     []solana.Instruction
	PolicyOperation  string
	CapExempt        bool
}

func isSPLTokenProgram(programID string) bool {
	return programID == solana.TokenProgramID.String() || programID == solana.Token2022ProgramID.String()
}

func normalizePublicKeyV2(raw, field string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", fmt.Errorf("%s is required", field)
	}
	key, err := solana.PublicKeyFromBase58(value)
	if err != nil {
		return "", fmt.Errorf("invalid %s", field)
	}
	return key.String(), nil
}

func parsePositiveAmountV2(raw, field string) (*big.Int, error) {
	value, ok := new(big.Int).SetString(strings.TrimSpace(raw), 10)
	if !ok || value.Sign() <= 0 {
		return nil, fmt.Errorf("%s must be a positive integer", field)
	}
	if value.BitLen() > 64 {
		return nil, fmt.Errorf("%s exceeds uint64", field)
	}
	return value, nil
}

func normalizeSignerIntentV2(input signerIntentV2) (normalizedIntentV2, error) {
	return normalizeSignerIntentForWalletV2(input, nil)
}

func normalizeSignerIntentForWalletV2(input signerIntentV2, wallet *solana.PublicKey) (normalizedIntentV2, error) {
	if isJupiterIntentTypeV2(strings.TrimSpace(input.Type)) {
		return normalizeJupiterIntentV2(input)
	}
	intent := signerIntentV2{Type: strings.TrimSpace(input.Type)}
	var program string
	var asset string
	var destination string
	var amount *big.Int
	var err error

	switch intent.Type {
	case intentSolanaNativeTransfer:
		intent.Destination, err = normalizePublicKeyV2(input.Destination, "destination")
		if err != nil {
			return normalizedIntentV2{}, err
		}
		amount, err = parsePositiveAmountV2(input.Lamports, "lamports")
		if err != nil {
			return normalizedIntentV2{}, err
		}
		intent.Lamports = amount.String()
		program = solana.SystemProgramID.String()
		asset = "solana:native"
		destination = intent.Destination
	case intentSolanaSPLTransferChecked:
		intent.TokenProgram, err = normalizePublicKeyV2(input.TokenProgram, "tokenProgram")
		if err != nil {
			return normalizedIntentV2{}, err
		}
		if !isSPLTokenProgram(intent.TokenProgram) {
			return normalizedIntentV2{}, errors.New("tokenProgram must be SPL Token or Token-2022")
		}
		intent.Mint, err = normalizePublicKeyV2(input.Mint, "mint")
		if err != nil {
			return normalizedIntentV2{}, err
		}
		intent.Destination, err = normalizePublicKeyV2(input.Destination, "destination")
		if err != nil {
			return normalizedIntentV2{}, err
		}
		amount, err = parsePositiveAmountV2(input.Amount, "amount")
		if err != nil {
			return normalizedIntentV2{}, err
		}
		intent.Amount = amount.String()
		program = intent.TokenProgram
		asset = "solana:spl:" + intent.Mint
		destination = intent.Destination
	case intentSolanaSATAction:
		if wallet == nil || wallet.IsZero() {
			return normalizedIntentV2{}, errors.New("typed SAT intent requires signer wallet context")
		}
		return normalizeSATIntentV2(input, *wallet)
	default:
		return normalizedIntentV2{}, fmt.Errorf("unsupported signer-v2 intent type %q", intent.Type)
	}

	canonical, err := json.Marshal(intent)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	digest := sha256.Sum256(canonical)
	return normalizedIntentV2{
		Intent:           intent,
		Digest:           "sha256:" + hex.EncodeToString(digest[:]),
		Asset:            asset,
		Amount:           amount,
		RequiredPrograms: requiredProgramsForIntentV2(intent.Type, program),
		Destination:      destination,
		PolicyOperation:  intent.Type,
	}, nil
}

func requiredProgramsForIntentV2(intentType, primaryProgram string) []string {
	programs := []string{primaryProgram}
	if intentType == intentSolanaSPLTransferChecked {
		programs = append(programs, solana.SystemProgramID.String(), solana.SPLAssociatedTokenAccountProgramID.String())
	}
	programs, _ = normalizeSortedStringsV2(programs, func(raw string) (string, error) {
		return normalizePublicKeyV2(raw, "required program")
	})
	return programs
}

func normalizeSortedStringsV2(values []string, normalize func(string) (string, error)) ([]string, error) {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, raw := range values {
		value, err := normalize(raw)
		if err != nil {
			return nil, err
		}
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	sort.Strings(out)
	return out, nil
}

func normalizeSignerPolicyV2(input signerPolicyV2) (signerPolicyV2, error) {
	policy := signerPolicyV2{
		WalletID: normalizeWalletID(input.WalletID),
		Version:  input.Version,
		Role:     strings.TrimSpace(strings.ToLower(input.Role)),
	}
	if strings.TrimSpace(input.WalletID) == "" {
		return signerPolicyV2{}, errors.New("walletId is required")
	}
	switch policy.Role {
	case "agent", "mining", "vault":
	default:
		return signerPolicyV2{}, errors.New("policy role must be agent, mining, or vault")
	}
	var err error
	policy.Operations, err = normalizeSortedStringsV2(input.Operations, func(raw string) (string, error) {
		value := strings.TrimSpace(raw)
		if value == "" {
			return "", errors.New("policy operation cannot be empty")
		}
		return value, nil
	})
	if err != nil {
		return signerPolicyV2{}, err
	}
	policy.Programs, err = normalizeSortedStringsV2(input.Programs, func(raw string) (string, error) {
		return normalizePublicKeyV2(raw, "policy program")
	})
	if err != nil {
		return signerPolicyV2{}, err
	}

	seenAssets := map[string]bool{}
	for _, rawAsset := range input.Assets {
		asset := signerPolicyAssetV2{Asset: strings.TrimSpace(rawAsset.Asset)}
		if asset.Asset == "solana:native" || asset.Asset == "sat:action" || asset.Asset == "sat:capital:lamports" {
			// canonical as-is
		} else if strings.HasPrefix(asset.Asset, "solana:spl:") {
			mint, err := normalizePublicKeyV2(strings.TrimPrefix(asset.Asset, "solana:spl:"), "policy asset mint")
			if err != nil {
				return signerPolicyV2{}, err
			}
			asset.Asset = "solana:spl:" + mint
		} else if strings.HasPrefix(asset.Asset, "sat:mint:") {
			mint, err := normalizePublicKeyV2(strings.TrimPrefix(asset.Asset, "sat:mint:"), "SAT policy asset mint")
			if err != nil {
				return signerPolicyV2{}, err
			}
			asset.Asset = "sat:mint:" + mint
		} else {
			return signerPolicyV2{}, fmt.Errorf("unsupported policy asset %q", asset.Asset)
		}
		if seenAssets[asset.Asset] {
			return signerPolicyV2{}, fmt.Errorf("duplicate policy asset %s", asset.Asset)
		}
		seenAssets[asset.Asset] = true
		asset.Destinations, err = normalizeSortedStringsV2(rawAsset.Destinations, func(raw string) (string, error) {
			return normalizePublicKeyV2(raw, "policy destination")
		})
		if err != nil {
			return signerPolicyV2{}, err
		}
		maxPerTx, err := parsePositiveAmountV2(rawAsset.MaxPerTx, "policy maxPerTx")
		if err != nil {
			return signerPolicyV2{}, err
		}
		maxDaily, err := parsePositiveAmountV2(rawAsset.MaxDaily, "policy maxDaily")
		if err != nil {
			return signerPolicyV2{}, err
		}
		asset.MaxPerTx = maxPerTx.String()
		asset.MaxDaily = maxDaily.String()
		policy.Assets = append(policy.Assets, asset)
	}
	sort.Slice(policy.Assets, func(i, j int) bool { return policy.Assets[i].Asset < policy.Assets[j].Asset })

	policy.Hash = ""
	canonical, err := json.Marshal(policy)
	if err != nil {
		return signerPolicyV2{}, err
	}
	hash := sha256.Sum256(canonical)
	policy.Hash = "sha256:" + hex.EncodeToString(hash[:])
	return policy, nil
}

func policyAssetForIntentV2(policy signerPolicyV2, intent normalizedIntentV2) (signerPolicyAssetV2, error) {
	operation := intent.PolicyOperation
	if operation == "" {
		operation = intent.Intent.Type
	}
	if !containsStringV2(policy.Operations, operation) {
		return signerPolicyAssetV2{}, fmt.Errorf("policy denies operation %s", operation)
	}
	for _, program := range intent.RequiredPrograms {
		if !containsStringV2(policy.Programs, program) {
			return signerPolicyAssetV2{}, fmt.Errorf("policy denies program %s", program)
		}
	}
	for _, asset := range policy.Assets {
		if asset.Asset != intent.Asset {
			continue
		}
		if !containsStringV2(asset.Destinations, intent.Destination) {
			return signerPolicyAssetV2{}, fmt.Errorf("policy denies destination %s", intent.Destination)
		}
		maxPerTx, _ := new(big.Int).SetString(asset.MaxPerTx, 10)
		if maxPerTx == nil || maxPerTx.Sign() <= 0 || intent.Amount.Cmp(maxPerTx) > 0 {
			return signerPolicyAssetV2{}, errors.New("policy per-transaction cap exceeded")
		}
		return asset, nil
	}
	return signerPolicyAssetV2{}, fmt.Errorf("policy denies asset %s", intent.Asset)
}

func containsStringV2(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func validateRequestIDV2(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if len(value) < 8 || len(value) > 128 {
		return "", errors.New("requestId must contain 8 to 128 characters")
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune("-_:.", r) {
			continue
		}
		return "", errors.New("requestId contains unsupported characters")
	}
	return value, nil
}

func timestampV2(now time.Time) string {
	return now.UTC().Format(time.RFC3339Nano)
}

func uint64FromBigV2(value *big.Int) (uint64, error) {
	if value == nil || value.Sign() <= 0 || value.BitLen() > 64 {
		return 0, errors.New("amount is outside uint64 range")
	}
	return value.Uint64(), nil
}

func parseModeV2(raw string) (uint32, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return 0o600, nil
	}
	parsed, err := strconv.ParseUint(value, 8, 32)
	if err != nil || parsed > 0o777 {
		return 0, errors.New("socket mode must be an octal permission such as 0600 or 0660")
	}
	mode := uint32(parsed)
	if mode&0o600 != 0o600 {
		return 0, errors.New("socket mode must grant owner read and write access")
	}
	if mode&0o007 != 0 {
		return 0, errors.New("socket mode must not grant world access")
	}
	return mode, nil
}
