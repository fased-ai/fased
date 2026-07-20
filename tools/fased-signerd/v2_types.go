package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	solana "github.com/gagliardetto/solana-go"
)

const (
	signerProtocolVersion = 2

	// signerNativeFeeReservationV2 is a signer-owned upper bound for the
	// network fee and any explicitly validated rent paid by a signer-built
	// transaction. It is deliberately independent of caller input. Jupiter
	// requests may choose a lower ceiling, but can never raise this bound.
	signerNativeFeeReservationV2 = uint64(5_000_000)

	intentSolanaNativeTransfer     = "solana.nativeTransfer"
	intentSolanaSPLTransferChecked = "solana.splTransferChecked"
	intentSolanaSATAction          = "solana.satAction"
	intentSolanaSATLookupTable     = "solana.satLookupTable"
	intentSolanaVaultBondAction    = "solana.vaultBondAction"
	intentFederationBondChallenge  = "federation.bondChallenge"
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

type signerProtocolRangeV2 struct {
	Current int `json:"current"`
	Min     int `json:"min"`
	Max     int `json:"max"`
}

type signerCapabilitiesV2 struct {
	Protocol                     signerProtocolRangeV2 `json:"protocol"`
	NativeFeeReservationLamports uint64                `json:"nativeFeeReservationLamports"`
	IntentTypes                  []string              `json:"intentTypes"`
	OperationStates              []string              `json:"operationStates"`
	Features                     []string              `json:"features"`
}

type signerIntentV2 struct {
	Type                string                                 `json:"type"`
	Destination         string                                 `json:"destination,omitempty"`
	Lamports            string                                 `json:"lamports,omitempty"`
	TokenProgram        string                                 `json:"tokenProgram,omitempty"`
	Mint                string                                 `json:"mint,omitempty"`
	Amount              string                                 `json:"amount,omitempty"`
	Memo                string                                 `json:"memo,omitempty"`
	Action              string                                 `json:"action,omitempty"`
	ProgramID           string                                 `json:"programId,omitempty"`
	DataBase64          string                                 `json:"dataBase64,omitempty"`
	Keys                []signerSATAccountV2                   `json:"keys,omitempty"`
	Context             *signerSATContextV2                    `json:"context,omitempty"`
	Instructions        []signerSATInstructionV2               `json:"instructions,omitempty"`
	AddressLookupTables []string                               `json:"addressLookupTables,omitempty"`
	LookupTable         *signerSATLookupTableIntentV2          `json:"lookupTable,omitempty"`
	Jupiter             *signerJupiterIntentV2                 `json:"jupiter,omitempty"`
	Cluster             string                                 `json:"cluster,omitempty"`
	Federation          *signerFederationBondChallengeIntentV2 `json:"federation,omitempty"`
}

type signerExecuteRequestV2 struct {
	RequestID      string         `json:"requestId"`
	PolicyHash     string         `json:"policyHash"`
	Intent         signerIntentV2 `json:"intent"`
	intentWalletID string         `json:"-"`
	reviewed       bool           `json:"-"`
}

type signerOperationLookupV2 struct {
	RequestID string `json:"requestId"`
}

type signerPolicyAssetV2 struct {
	Asset                string   `json:"asset"`
	Destinations         []string `json:"destinations"`
	MaxPerTx             string   `json:"maxPerTx"`
	MaxDaily             string   `json:"maxDaily"`
	ReviewedDestinations bool     `json:"reviewedDestinations,omitempty"`
	TypedSATDestinations bool     `json:"typedSatDestinations,omitempty"`
}

type signerPolicyV2 struct {
	WalletID         string                `json:"walletId"`
	Role             string                `json:"role"`
	Version          uint64                `json:"version"`
	BaselineVersion  uint64                `json:"baselineVersion,omitempty"`
	Operations       []string              `json:"operations"`
	Programs         []string              `json:"programs"`
	TypedSATPrograms bool                  `json:"typedSatPrograms,omitempty"`
	Assets           []signerPolicyAssetV2 `json:"assets"`
	Hash             string                `json:"hash"`
}

type signerPolicyPutRequestV2 struct {
	ExpectedVersion uint64         `json:"expectedVersion"`
	Policy          signerPolicyV2 `json:"policy"`
}

type signerWalletCreateRequestV2 struct {
	WalletID        string                       `json:"-"`
	ExpectedVersion uint64                       `json:"expectedPolicyVersion"`
	Policy          signerPolicyV2               `json:"policy"`
	Baseline        *signerRoleBaselineRequestV1 `json:"baseline,omitempty"`
}

type signerWalletImportRequestV2 struct {
	WalletID        string                       `json:"-"`
	ExpectedVersion uint64                       `json:"expectedPolicyVersion"`
	Policy          signerPolicyV2               `json:"policy"`
	Baseline        *signerRoleBaselineRequestV1 `json:"baseline,omitempty"`
	Path            string                       `json:"path"`
}

type signerWalletLegacyImportRequestV2 struct {
	WalletID        string                       `json:"-"`
	ExpectedVersion uint64                       `json:"expectedPolicyVersion"`
	Policy          signerPolicyV2               `json:"policy"`
	Baseline        *signerRoleBaselineRequestV1 `json:"baseline,omitempty"`
	Path            string                       `json:"path"`
	PassphrasePath  string                       `json:"passphrasePath"`
}

type signerWalletRecoveryExportRequestV2 struct {
	ExpectedPublicKey string `json:"expectedPublicKey"`
	PasswordPath      string `json:"passwordPath"`
}

type signerWalletRecoveryImportRequestV2 struct {
	WalletID        string                       `json:"-"`
	ExpectedVersion uint64                       `json:"expectedPolicyVersion"`
	Policy          signerPolicyV2               `json:"policy"`
	Baseline        *signerRoleBaselineRequestV1 `json:"baseline,omitempty"`
	RecoveryPath    string                       `json:"recoveryPath"`
	PasswordPath    string                       `json:"passwordPath"`
}

type signerWalletRawExportRequestV2 struct {
	ExpectedPublicKey string `json:"expectedPublicKey"`
	Path              string `json:"path"`
}

type signerWalletRecoveryPackageV1 struct {
	Kind       string                           `json:"kind"`
	Version    uint8                            `json:"version"`
	WalletID   string                           `json:"walletId"`
	Role       string                           `json:"role"`
	PublicKey  string                           `json:"publicKey"`
	CreatedAt  string                           `json:"createdAt"`
	KDF        signerWalletRecoveryKDFV1        `json:"kdf"`
	Encryption signerWalletRecoveryEncryptionV1 `json:"encryption"`
}

type signerWalletRecoveryKDFV1 struct {
	Name        string `json:"name"`
	MemoryKiB   uint32 `json:"memoryKiB"`
	Iterations  uint32 `json:"iterations"`
	Parallelism uint8  `json:"parallelism"`
	Salt        string `json:"salt"`
}

type signerWalletRecoveryEncryptionV1 struct {
	Name       string `json:"name"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

type signerWalletRecoveryExportResultV2 struct {
	WalletID  string                        `json:"walletId"`
	Role      string                        `json:"role"`
	PublicKey string                        `json:"publicKey"`
	Package   signerWalletRecoveryPackageV1 `json:"package"`
}

type signerWalletRawExportResultV2 struct {
	WalletID  string `json:"walletId"`
	PublicKey string `json:"publicKey"`
	Written   bool   `json:"written"`
}

type signerWalletRotateRequestV2 struct {
	WalletID string `json:"walletId"`
}

type signerWalletRecordV2 struct {
	WalletID          string `json:"walletId"`
	PublicKey         string `json:"publicKey"`
	Version           uint64 `json:"version"`
	CreatedAt         string `json:"createdAt"`
	RotatedAt         string `json:"rotatedAt,omitempty"`
	RetiredAt         string `json:"retiredAt,omitempty"`
	SuccessorWalletID string `json:"successorWalletId,omitempty"`
	RotationID        string `json:"rotationId,omitempty"`
	Nonce             string `json:"nonce"`
	Secret            string `json:"secret"`
}

type signerOperationV2 struct {
	RequestID           string                         `json:"requestId"`
	WalletID            string                         `json:"walletId"`
	IntentType          string                         `json:"intentType"`
	IntentDigest        string                         `json:"intentDigest"`
	TransactionDigest   string                         `json:"transactionDigest,omitempty"`
	SignedTxBase64      string                         `json:"signedTxBase64,omitempty"`
	PolicyHash          string                         `json:"policyHash"`
	Asset               string                         `json:"asset"`
	Amount              string                         `json:"amount"`
	Reservations        []signerOperationReservationV2 `json:"reservations,omitempty"`
	State               string                         `json:"state"`
	ReservationActive   bool                           `json:"reservationActive"`
	UsageBucket         string                         `json:"usageBucket"`
	ReservedAt          string                         `json:"reservedAt"`
	BroadcastAt         string                         `json:"broadcastAt,omitempty"`
	ConfirmedAt         string                         `json:"confirmedAt,omitempty"`
	UpdatedAt           string                         `json:"updatedAt"`
	Signature           string                         `json:"signature,omitempty"`
	Error               string                         `json:"error,omitempty"`
	ExecutionAttempt    uint64                         `json:"executionAttempt,omitempty"`
	ExecutionLeaseUntil string                         `json:"executionLeaseUntil,omitempty"`
	AuthorizationProof  string                         `json:"authorizationProof,omitempty"`
	AuthorizedAt        string                         `json:"authorizedAt,omitempty"`
	ExternalResult      *signerExternalResultV2        `json:"externalResult,omitempty"`
}

// signerExternalResultV2 deliberately contains only public, non-secret
// identifiers that callers need to render a durable external workflow result.
// API keys, JWTs, unsigned/signed transaction bytes, and Jupiter request bodies
// are signer-internal and must never be represented here.
type signerExternalResultV2 struct {
	Provider   string `json:"provider"`
	Action     string `json:"action"`
	OrderID    string `json:"orderId,omitempty"`
	OrderState string `json:"orderState,omitempty"`
}

// signerOperationReservationV2 records every durable spend exposure claimed
// by an operation. Asset/Amount above remain the primary semantic effect for
// protocol compatibility; Reservations is the complete accounting record.
// Multiple reservations for one asset are coalesced before being persisted.
type signerOperationReservationV2 struct {
	Asset       string `json:"asset"`
	Amount      string `json:"amount"`
	UsageBucket string `json:"usageBucket"`
}

type signerReservationRequirementV2 struct {
	Asset       string
	Amount      *big.Int
	Destination string
	Primary     bool
}

type normalizedIntentV2 struct {
	Intent               signerIntentV2
	Digest               string
	Asset                string
	Amount               *big.Int
	RequiredPrograms     []string
	Destination          string
	Instructions         []solana.Instruction
	AddressLookupTables  []solana.PublicKey
	NativeFeeReservation *big.Int
	PolicyOperation      string
	CapExempt            bool
	RequiredRole         string
	Message              []byte
	ParentIntent         *normalizedIntentV2
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
		if strings.TrimSpace(input.TokenProgram) == "" {
			return normalizedIntentV2{}, errors.New("signer-owned SPL token program resolution is required")
		}
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
	case intentSolanaSATLookupTable:
		if wallet == nil || wallet.IsZero() {
			return normalizedIntentV2{}, errors.New("typed SAT lookup-table intent requires signer wallet context")
		}
		return normalizeSATLookupTableIntentV2(input, *wallet)
	case intentSolanaVaultBondAction:
		if wallet == nil || wallet.IsZero() {
			return normalizedIntentV2{}, errors.New("typed Vault bond intent requires signer wallet context")
		}
		return normalizeSATIntentV2(input, *wallet)
	case intentFederationBondChallenge:
		if wallet == nil || wallet.IsZero() {
			return normalizedIntentV2{}, errors.New("federation bond challenge requires signer wallet context")
		}
		return normalizeFederationBondChallengeIntentV2(input, *wallet)
	default:
		return normalizedIntentV2{}, fmt.Errorf("unsupported signer-v2 intent type %q", intent.Type)
	}
	if input.Memo != "" {
		intent.Memo = strings.TrimSpace(input.Memo)
		if !regexp.MustCompile(`^fased:a2a-(?:payment|refund):v1:[0-9a-f]{64}$`).MatchString(intent.Memo) {
			return normalizedIntentV2{}, errors.New("typed transfer memo must be a Fased A2A payment or refund challenge")
		}
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
		RequiredPrograms: requiredProgramsForIntentV2(intent.Type, program, intent.Memo != ""),
		Destination:      destination,
		PolicyOperation:  intent.Type,
	}, nil
}

func requiredProgramsForIntentV2(intentType string, primaryProgram string, hasMemo bool) []string {
	programs := []string{primaryProgram}
	if intentType == intentSolanaSPLTransferChecked {
		programs = append(
			programs,
			solana.SystemProgramID.String(),
			solana.SPLAssociatedTokenAccountProgramID.String(),
		)
	}
	if hasMemo {
		programs = append(programs, memoProgramV2V2.String())
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
		WalletID:         normalizeWalletID(input.WalletID),
		Version:          input.Version,
		BaselineVersion:  input.BaselineVersion,
		Role:             strings.TrimSpace(strings.ToLower(input.Role)),
		TypedSATPrograms: input.TypedSATPrograms,
		Assets:           make([]signerPolicyAssetV2, 0, len(input.Assets)),
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
		if strings.TrimSpace(raw) == federationBondPolicyDomainV2 {
			return federationBondPolicyDomainV2, nil
		}
		return normalizePublicKeyV2(raw, "policy program")
	})
	if err != nil {
		return signerPolicyV2{}, err
	}

	seenAssets := map[string]bool{}
	for _, rawAsset := range input.Assets {
		asset := signerPolicyAssetV2{
			Asset:                strings.TrimSpace(rawAsset.Asset),
			ReviewedDestinations: rawAsset.ReviewedDestinations,
			TypedSATDestinations: rawAsset.TypedSATDestinations,
		}
		if asset.Asset == "solana:native" || asset.Asset == "sat:action" || asset.Asset == "sat:capital:lamports" || asset.Asset == "federation:bond-challenge" {
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

func isTypedSATIntentV2(policy signerPolicyV2, intent normalizedIntentV2) bool {
	return policy.Role == "mining" &&
		(intent.Intent.Type == intentSolanaSATAction || intent.Intent.Type == intentSolanaSATLookupTable)
}

func policyAssetForIntentModeV2(
	policy signerPolicyV2,
	intent normalizedIntentV2,
	reviewed bool,
) (signerPolicyAssetV2, error) {
	if len(policy.Operations) == 0 {
		return signerPolicyAssetV2{}, errors.New("policy operations are empty; signing is denied")
	}
	if len(policy.Programs) == 0 {
		return signerPolicyAssetV2{}, errors.New("policy programs are empty; signing is denied")
	}
	if len(intent.RequiredPrograms) == 0 {
		return signerPolicyAssetV2{}, errors.New("intent has no explicit required program or signer domain")
	}
	if intent.RequiredRole != "" && policy.Role != intent.RequiredRole {
		return signerPolicyAssetV2{}, fmt.Errorf("policy role %s cannot authorize %s intent", policy.Role, intent.RequiredRole)
	}
	operation := intent.PolicyOperation
	if operation == "" {
		operation = intent.Intent.Type
	}
	if !containsStringV2(policy.Operations, operation) {
		return signerPolicyAssetV2{}, fmt.Errorf("policy denies operation %s", operation)
	}
	for _, program := range intent.RequiredPrograms {
		if !containsStringV2(policy.Programs, program) && !(policy.TypedSATPrograms && isTypedSATIntentV2(policy, intent)) {
			return signerPolicyAssetV2{}, fmt.Errorf("policy denies program %s", program)
		}
	}
	for _, asset := range policy.Assets {
		if asset.Asset != intent.Asset {
			continue
		}
		allowsReviewedDestination := reviewed && asset.ReviewedDestinations
		allowsTypedSATDestination := asset.TypedSATDestinations && isTypedSATIntentV2(policy, intent)
		if !containsStringV2(asset.Destinations, intent.Destination) && !allowsReviewedDestination && !allowsTypedSATDestination {
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

func policyAssetForIntentV2(policy signerPolicyV2, intent normalizedIntentV2) (signerPolicyAssetV2, error) {
	return policyAssetForIntentModeV2(policy, intent, false)
}

func policyAssetByNameV2(policy signerPolicyV2, assetName string) (signerPolicyAssetV2, error) {
	for _, asset := range policy.Assets {
		if asset.Asset == assetName {
			return asset, nil
		}
	}
	return signerPolicyAssetV2{}, fmt.Errorf("policy denies asset %s", assetName)
}

func signerFeeReservationForIntentV2(intent normalizedIntentV2) (*big.Int, error) {
	if intent.Intent.Type == intentFederationBondChallenge {
		return big.NewInt(0), nil
	}
	if isJupiterIntentTypeV2(intent.Intent.Type) {
		if intent.Intent.Jupiter == nil {
			return nil, errors.New("typed Jupiter intent is missing its fee ceiling")
		}
		fee, ok := new(big.Int).SetString(intent.Intent.Jupiter.MaxFeeLamports, 10)
		if !ok || fee.Sign() <= 0 {
			return nil, errors.New("typed Jupiter maxFeeLamports must be positive")
		}
		if fee.Cmp(new(big.Int).SetUint64(signerNativeFeeReservationV2)) > 0 {
			return nil, fmt.Errorf("typed Jupiter maxFeeLamports exceeds signer ceiling %d", signerNativeFeeReservationV2)
		}
		// Durable accounting uses the signer-owned ceiling, not the caller's
		// claimed maximum or an RPC's simulated fee. This remains conservative
		// if the base fee changes or a broadcast fails after fee collection.
		return new(big.Int).SetUint64(signerNativeFeeReservationV2), nil
	}
	if intent.NativeFeeReservation != nil {
		if intent.NativeFeeReservation.Sign() <= 0 || intent.NativeFeeReservation.BitLen() > 64 {
			return nil, errors.New("typed signer native fee/rent reservation is invalid")
		}
		return new(big.Int).Set(intent.NativeFeeReservation), nil
	}
	return new(big.Int).SetUint64(signerNativeFeeReservationV2), nil
}

// policyReservationsForIntentV2 validates the semantic asset and the
// independent SOL fee/rent exposure, then coalesces both by asset. This makes
// a native transfer consume amount+fee from one per-tx and daily SOL cap while
// an SPL transfer atomically consumes both its mint cap and the native cap.
func policyReservationsForIntentV2(policy signerPolicyV2, intent normalizedIntentV2) ([]signerReservationRequirementV2, error) {
	return policyReservationsForIntentModeV2(policy, intent, false)
}

func policyReservationsForIntentModeV2(
	policy signerPolicyV2,
	intent normalizedIntentV2,
	reviewed bool,
) ([]signerReservationRequirementV2, error) {
	primaryPolicy, err := policyAssetForIntentModeV2(policy, intent, reviewed)
	if err != nil {
		return nil, err
	}
	fee, err := signerFeeReservationForIntentV2(intent)
	if err != nil {
		return nil, err
	}
	requirements := make([]signerReservationRequirementV2, 0, 2)
	feeOnlyPrimary := false
	switch intent.Intent.Type {
	case intentSolanaTriggerAuth, intentSolanaTriggerCancel, intentSolanaTriggerWithdraw:
		// These operations historically expose maxFeeLamports as their primary
		// semantic amount. It is not an additional principal transfer; the
		// signer-owned fee reservation below replaces it for durable accounting.
		feeOnlyPrimary = true
	}
	if !feeOnlyPrimary {
		requirements = append(requirements, signerReservationRequirementV2{
			Asset: intent.Asset, Amount: new(big.Int).Set(intent.Amount), Destination: intent.Destination, Primary: true,
		})
	}
	policies := map[string]signerPolicyAssetV2{intent.Asset: primaryPolicy}
	if fee.Sign() > 0 {
		nativePolicy, policyErr := policyAssetByNameV2(policy, "solana:native")
		if policyErr != nil {
			return nil, errors.New("explicit positive solana:native policy is required for transaction fees and rent")
		}
		policies["solana:native"] = nativePolicy
		requirements = append(requirements, signerReservationRequirementV2{
			Asset: "solana:native", Amount: fee,
		})
	}

	coalesced := make(map[string]signerReservationRequirementV2, len(requirements))
	for _, requirement := range requirements {
		current, ok := coalesced[requirement.Asset]
		if !ok {
			current = signerReservationRequirementV2{Asset: requirement.Asset, Amount: big.NewInt(0)}
		}
		current.Amount.Add(current.Amount, requirement.Amount)
		if requirement.Primary {
			current.Primary = true
			current.Destination = requirement.Destination
		}
		coalesced[requirement.Asset] = current
	}
	assets := make([]string, 0, len(coalesced))
	for asset := range coalesced {
		assets = append(assets, asset)
	}
	sort.Strings(assets)
	out := make([]signerReservationRequirementV2, 0, len(assets))
	for _, asset := range assets {
		requirement := coalesced[asset]
		assetPolicy := policies[asset]
		maxPerTx, ok := new(big.Int).SetString(assetPolicy.MaxPerTx, 10)
		if !ok || maxPerTx.Sign() <= 0 || requirement.Amount.Sign() <= 0 || requirement.Amount.Cmp(maxPerTx) > 0 {
			return nil, fmt.Errorf("policy per-transaction cap exceeded for %s including fee/rent exposure", asset)
		}
		out = append(out, requirement)
	}
	return out, nil
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
