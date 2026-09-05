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
	"strings"
	"time"
)

const (
	solanaNativeMintV2     = "So11111111111111111111111111111111111111112"
	jupiterAggregatorV6V2  = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" // public program ID; pragma: allowlist secret
	jupiterSubmissionRPCV2 = "rpc"

	jupiterReviewPreparedV2       = "prepared"
	jupiterReviewSignedV2         = "signed"
	jupiterReviewModeAutonomousV2 = "autonomous"
	jupiterReviewModeReviewedV2   = "reviewed"

	signerReviewArtifactSolanaTransactionV2 = "solana-transaction"
	signerReviewArtifactDomainMessageV2     = "domain-separated-message"
	signerReviewArtifactTriggerStateV2      = "jupiter-trigger-state"
)

var canonicalJupiterPriceV2 = regexp.MustCompile(`^(0|[1-9][0-9]*)(?:\.[0-9]+)?$`)

// signerJupiterIntentV2 is the stable, human-reviewable semantic intent. The
// signer persists it beside one exact validated transaction envelope and
// digest; review.execute never accepts replacement transaction bytes.
type signerJupiterIntentV2 struct {
	Owner                   string                        `json:"owner"`
	InputMint               string                        `json:"inputMint,omitempty"`
	OutputMint              string                        `json:"outputMint,omitempty"`
	InputAmount             string                        `json:"inputAmount,omitempty"`
	MaxInputAmount          string                        `json:"maxInputAmount,omitempty"`
	MinimumOutputAmount     string                        `json:"minimumOutputAmount,omitempty"`
	MaxFeeLamports          string                        `json:"maxFeeLamports"`
	SourceTokenAccount      string                        `json:"sourceTokenAccount,omitempty"`
	DestinationTokenAccount string                        `json:"destinationTokenAccount,omitempty"`
	Programs                []string                      `json:"programs"`
	Trigger                 *signerJupiterTriggerIntentV2 `json:"trigger,omitempty"`
}

type signerJupiterTriggerIntentV2 struct {
	Operation          string `json:"operation"`
	Program            string `json:"program"`
	Vault              string `json:"vault,omitempty"`
	Order              string `json:"order,omitempty"`
	RequestID          string `json:"requestId,omitempty"`
	TriggerMint        string `json:"triggerMint,omitempty"`
	Condition          string `json:"condition,omitempty"`
	TargetPriceUSD     string `json:"targetPriceUsd,omitempty"`
	SlippageBPS        uint16 `json:"slippageBps,omitempty"`
	ExpiresAt          string `json:"expiresAt,omitempty"`
	ExpectedOrderState string `json:"expectedOrderState,omitempty"`
}

type signerSolanaTransactionEnvelopeV2 struct {
	SerializedTxBase64 string   `json:"serializedTxBase64"`
	Programs           []string `json:"programs"`
	WritableAccounts   []string `json:"writableAccounts"`
	Submission         string   `json:"submission"`
}

type signerReviewPrepareRequestV2 struct {
	RequestID   string                             `json:"requestId"`
	PolicyHash  string                             `json:"policyHash"`
	Mode        string                             `json:"mode"`
	Intent      signerIntentV2                     `json:"intent"`
	Transaction *signerSolanaTransactionEnvelopeV2 `json:"transaction,omitempty"`
}

type signerReviewExecuteRequestV2 struct {
	RequestID     string                                 `json:"requestId"`
	Authorization *signerWebAuthnAuthorizationEnvelopeV2 `json:"authorization,omitempty"`
}

type signerReviewV2 struct {
	RequestID         string                             `json:"requestId"`
	WalletID          string                             `json:"walletId"`
	WalletPublicKey   string                             `json:"walletPublicKey,omitempty"`
	IntentType        string                             `json:"intentType"`
	IntentDigest      string                             `json:"intentDigest"`
	PolicyHash        string                             `json:"policyHash"`
	Mode              string                             `json:"mode"`
	Nonce             string                             `json:"nonce"`
	SemanticIntent    json.RawMessage                    `json:"semanticIntent"`
	ArtifactKind      string                             `json:"artifactKind"`
	ArtifactDigest    string                             `json:"artifactDigest"`
	VaultReference    *vaultReviewReferenceV1            `json:"vaultReference,omitempty"`
	Transaction       *signerSolanaTransactionEnvelopeV2 `json:"transaction,omitempty"`
	MessageBase64     string                             `json:"messageBase64,omitempty"`
	StateDigest       string                             `json:"stateDigest,omitempty"`
	StateSlot         uint64                             `json:"stateSlot,omitempty"`
	Asset             string                             `json:"asset"`
	Amount            string                             `json:"amount"`
	Destination       string                             `json:"destination"`
	PolicyOperation   string                             `json:"policyOperation"`
	RequiredPrograms  []string                           `json:"requiredPrograms"`
	RequiredRole      string                             `json:"requiredRole,omitempty"`
	IssuedAt          string                             `json:"issuedAt"`
	State             string                             `json:"state"`
	PreparedAt        string                             `json:"preparedAt"`
	ExpiresAt         string                             `json:"expiresAt"`
	UpdatedAt         string                             `json:"updatedAt"`
	TransactionDigest string                             `json:"transactionDigest,omitempty"`
	Signature         string                             `json:"signature,omitempty"`
}

type signerReviewExecutionResultV2 struct {
	Review          signerReviewV2     `json:"review"`
	Operation       *signerOperationV2 `json:"operation,omitempty"`
	SignatureBase64 string             `json:"signatureBase64,omitempty"`
	Signer          string             `json:"signer"`
}

func isJupiterIntentTypeV2(intentType string) bool {
	switch strings.TrimSpace(intentType) {
	case intentSolanaJupiterSwap,
		intentSolanaTriggerCreate,
		intentSolanaTriggerCancel:
		return true
	default:
		return false
	}
}

func parseNonNegativeAmountV2(raw, field string) (*big.Int, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		value = "0"
	}
	parsed, ok := new(big.Int).SetString(value, 10)
	if !ok || parsed.Sign() < 0 || parsed.BitLen() > 64 {
		return nil, fmt.Errorf("%s must be an unsigned integer", field)
	}
	return parsed, nil
}

func normalizeOptionalPublicKeyV2(raw, field string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", nil
	}
	return normalizePublicKeyV2(raw, field)
}

func normalizeJupiterExternalIDV2(raw, field string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	if len(value) > 256 {
		return "", fmt.Errorf("%s exceeds 256 characters", field)
	}
	for _, character := range []byte(value) {
		if character < 0x21 || character > 0x7e {
			return "", fmt.Errorf("%s must contain only visible ASCII characters", field)
		}
	}
	return value, nil
}

func normalizeJupiterTriggerPriceV2(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if len(value) == 0 || len(value) > 64 || !canonicalJupiterPriceV2.MatchString(value) {
		return "", errors.New("targetPriceUsd must be a positive plain decimal string")
	}
	integer, fraction, hasFraction := strings.Cut(value, ".")
	if hasFraction {
		fraction = strings.TrimRight(fraction, "0")
		if fraction == "" {
			value = integer
		} else {
			value = integer + "." + fraction
		}
	}
	if value == "0" {
		return "", errors.New("targetPriceUsd must be positive")
	}
	return value, nil
}

const jupiterTriggerExpiryLayoutV2 = "2006-01-02T15:04:05.000Z"

func normalizeJupiterTriggerExpiryV2(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	parsed, err := time.Parse(jupiterTriggerExpiryLayoutV2, value)
	if err != nil || parsed.Format(jupiterTriggerExpiryLayoutV2) != value {
		return "", errors.New("expiresAt must be canonical UTC RFC3339 with millisecond precision")
	}
	return value, nil
}

func isSupportedTriggerTransferProgramV2(program string) bool {
	return program == "11111111111111111111111111111111" ||
		program == "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" || // public program ID; pragma: allowlist secret
		program == "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" // public program ID; pragma: allowlist secret
}

func triggerTransferProgramMatchesMintV2(mint, program string) bool {
	if mint == solanaNativeMintV2 {
		return program == "11111111111111111111111111111111"
	}
	return isSPLTokenProgram(program)
}

func normalizeJupiterIntentV2(input signerIntentV2) (normalizedIntentV2, error) {
	intentType := strings.TrimSpace(input.Type)
	if input.Jupiter == nil {
		return normalizedIntentV2{}, errors.New("typed Jupiter intent is required")
	}
	owner, err := normalizePublicKeyV2(input.Jupiter.Owner, "Jupiter owner")
	if err != nil {
		return normalizedIntentV2{}, err
	}
	programs, err := normalizeSortedStringsV2(input.Jupiter.Programs, func(raw string) (string, error) {
		return normalizePublicKeyV2(raw, "Jupiter program")
	})
	if err != nil {
		return normalizedIntentV2{}, err
	}
	if len(programs) == 0 {
		return normalizedIntentV2{}, errors.New("typed Jupiter intent requires an explicit program list")
	}
	if intentType == intentSolanaJupiterSwap && !containsStringV2(programs, jupiterAggregatorV6V2) {
		return normalizedIntentV2{}, errors.New("Jupiter swap requires the reviewed Jupiter v6 aggregator program")
	}

	maxFee, err := parseNonNegativeAmountV2(input.Jupiter.MaxFeeLamports, "maxFeeLamports")
	if err != nil {
		return normalizedIntentV2{}, err
	}
	if maxFee.Sign() <= 0 {
		return normalizedIntentV2{}, errors.New("maxFeeLamports must be positive for every on-chain Jupiter action")
	}
	if maxFee.Cmp(new(big.Int).SetUint64(signerNativeFeeReservationV2)) > 0 {
		return normalizedIntentV2{}, fmt.Errorf("maxFeeLamports exceeds signer ceiling %d", signerNativeFeeReservationV2)
	}
	jupiter := signerJupiterIntentV2{
		Owner:          owner,
		MaxFeeLamports: maxFee.String(),
		Programs:       programs,
	}
	jupiter.InputMint, err = normalizeOptionalPublicKeyV2(input.Jupiter.InputMint, "inputMint")
	if err != nil {
		return normalizedIntentV2{}, err
	}
	jupiter.OutputMint, err = normalizeOptionalPublicKeyV2(input.Jupiter.OutputMint, "outputMint")
	if err != nil {
		return normalizedIntentV2{}, err
	}
	jupiter.SourceTokenAccount, err = normalizeOptionalPublicKeyV2(input.Jupiter.SourceTokenAccount, "sourceTokenAccount")
	if err != nil {
		return normalizedIntentV2{}, err
	}
	jupiter.DestinationTokenAccount, err = normalizeOptionalPublicKeyV2(input.Jupiter.DestinationTokenAccount, "destinationTokenAccount")
	if err != nil {
		return normalizedIntentV2{}, err
	}

	inputAmount, err := parseNonNegativeAmountV2(input.Jupiter.InputAmount, "inputAmount")
	if err != nil {
		return normalizedIntentV2{}, err
	}
	maxInput, err := parseNonNegativeAmountV2(input.Jupiter.MaxInputAmount, "maxInputAmount")
	if err != nil {
		return normalizedIntentV2{}, err
	}
	if maxInput.Sign() == 0 {
		maxInput.Set(inputAmount)
	}
	if maxInput.Cmp(inputAmount) < 0 {
		return normalizedIntentV2{}, errors.New("maxInputAmount cannot be lower than inputAmount")
	}
	minimumOutput, err := parseNonNegativeAmountV2(input.Jupiter.MinimumOutputAmount, "minimumOutputAmount")
	if err != nil {
		return normalizedIntentV2{}, err
	}
	jupiter.InputAmount = inputAmount.String()
	jupiter.MaxInputAmount = maxInput.String()
	jupiter.MinimumOutputAmount = minimumOutput.String()

	if input.Jupiter.Trigger != nil {
		trigger := &signerJupiterTriggerIntentV2{}
		trigger.Operation = strings.ToLower(strings.TrimSpace(input.Jupiter.Trigger.Operation))
		trigger.Program, err = normalizePublicKeyV2(input.Jupiter.Trigger.Program, "Trigger program")
		if err != nil {
			return normalizedIntentV2{}, err
		}
		trigger.Vault, err = normalizeOptionalPublicKeyV2(input.Jupiter.Trigger.Vault, "Trigger vault")
		if err != nil {
			return normalizedIntentV2{}, err
		}
		trigger.Order, err = normalizeJupiterExternalIDV2(input.Jupiter.Trigger.Order, "Trigger order")
		if err != nil {
			return normalizedIntentV2{}, err
		}
		trigger.RequestID, err = normalizeJupiterExternalIDV2(input.Jupiter.Trigger.RequestID, "Trigger requestId")
		if err != nil {
			return normalizedIntentV2{}, err
		}
		trigger.TriggerMint, err = normalizeOptionalPublicKeyV2(input.Jupiter.Trigger.TriggerMint, "Trigger mint")
		if err != nil {
			return normalizedIntentV2{}, err
		}
		trigger.Condition = strings.ToLower(strings.TrimSpace(input.Jupiter.Trigger.Condition))
		if strings.TrimSpace(input.Jupiter.Trigger.TargetPriceUSD) != "" {
			trigger.TargetPriceUSD, err = normalizeJupiterTriggerPriceV2(input.Jupiter.Trigger.TargetPriceUSD)
			if err != nil {
				return normalizedIntentV2{}, err
			}
		}
		trigger.SlippageBPS = input.Jupiter.Trigger.SlippageBPS
		if strings.TrimSpace(input.Jupiter.Trigger.ExpiresAt) != "" {
			trigger.ExpiresAt, err = normalizeJupiterTriggerExpiryV2(input.Jupiter.Trigger.ExpiresAt)
			if err != nil {
				return normalizedIntentV2{}, err
			}
		}
		trigger.ExpectedOrderState = strings.ToLower(strings.TrimSpace(input.Jupiter.Trigger.ExpectedOrderState))
		jupiter.Trigger = trigger
		if !containsStringV2(programs, trigger.Program) {
			return normalizedIntentV2{}, errors.New("Trigger action program is absent from the reviewed program manifest")
		}
	}

	capExempt := false
	asset := ""
	destination := owner
	amount := new(big.Int)
	switch intentType {
	case intentSolanaJupiterSwap:
		if jupiter.Trigger != nil || jupiter.InputMint == "" || jupiter.OutputMint == "" || jupiter.InputMint == jupiter.OutputMint {
			return normalizedIntentV2{}, errors.New("Jupiter swap requires distinct input/output mints and no Trigger metadata")
		}
		if inputAmount.Sign() <= 0 || minimumOutput.Sign() <= 0 || jupiter.SourceTokenAccount == "" || jupiter.DestinationTokenAccount == "" {
			return normalizedIntentV2{}, errors.New("Jupiter swap requires positive input/minimum output and exact source/destination accounts")
		}
		if maxInput.Cmp(inputAmount) != 0 {
			return normalizedIntentV2{}, errors.New("Jupiter exact-in swap requires maxInputAmount to equal inputAmount")
		}
		amount.Set(maxInput)
		asset = jupiterAssetV2(jupiter.InputMint)
	case intentSolanaTriggerCreate:
		if jupiter.Trigger == nil || jupiter.Trigger.Operation != "create" ||
			jupiter.Trigger.TriggerMint == "" ||
			(jupiter.Trigger.Condition != "above" && jupiter.Trigger.Condition != "below") ||
			jupiter.Trigger.TargetPriceUSD == "" || jupiter.Trigger.SlippageBPS == 0 ||
			jupiter.Trigger.SlippageBPS > 1000 || jupiter.Trigger.ExpiresAt == "" ||
			jupiter.Trigger.ExpectedOrderState != "new" {
			return normalizedIntentV2{}, errors.New("Trigger create requires exact single-order condition, price, slippage, expiry, trigger mint, and expected new state")
		}
		if jupiter.Trigger.Vault != "" || jupiter.Trigger.Order != "" || jupiter.Trigger.RequestID != "" ||
			jupiter.SourceTokenAccount != "" || jupiter.DestinationTokenAccount != "" {
			return normalizedIntentV2{}, errors.New("Trigger create vault, request identity, accounts, and transaction are signer-owned")
		}
		if !isSupportedTriggerTransferProgramV2(jupiter.Trigger.Program) {
			return normalizedIntentV2{}, errors.New("Trigger deposits support only exact System or SPL Token transfers")
		}
		if jupiter.InputMint == "" || jupiter.OutputMint == "" || jupiter.InputMint == jupiter.OutputMint || inputAmount.Sign() <= 0 {
			return normalizedIntentV2{}, errors.New("Trigger create requires distinct input/output mints and a positive exact input amount")
		}
		if !triggerTransferProgramMatchesMintV2(jupiter.InputMint, jupiter.Trigger.Program) {
			return normalizedIntentV2{}, errors.New("Trigger deposit program does not match the reviewed input mint")
		}
		if maxInput.Cmp(inputAmount) != 0 || minimumOutput.Sign() != 0 {
			return normalizedIntentV2{}, errors.New("Trigger create requires exact input and no caller-provided output amount")
		}
		amount.Set(maxInput)
		asset = jupiterAssetV2(jupiter.InputMint)
		// The policy destination is the signer-owned order identity. The native
		// client separately proves that the authenticated Jupiter vault belongs to
		// this wallet before any deposit is signed.
		destination = owner
	case intentSolanaTriggerCancel:
		if jupiter.Trigger == nil || jupiter.Trigger.Operation != "cancel" || jupiter.Trigger.Order == "" ||
			jupiter.Trigger.ExpectedOrderState != "open" {
			return normalizedIntentV2{}, errors.New("Trigger cancel requires an exact order and expected open state")
		}
		if jupiter.Trigger.Vault != "" || jupiter.Trigger.RequestID != "" || jupiter.SourceTokenAccount != "" ||
			jupiter.Trigger.TriggerMint != "" || jupiter.Trigger.Condition != "" || jupiter.Trigger.TargetPriceUSD != "" ||
			jupiter.Trigger.SlippageBPS != 0 || jupiter.Trigger.ExpiresAt != "" {
			return normalizedIntentV2{}, errors.New("Trigger cancel API state and withdrawal transaction are signer-owned")
		}
		if jupiter.OutputMint == "" || minimumOutput.Sign() <= 0 || jupiter.DestinationTokenAccount == "" {
			return normalizedIntentV2{}, errors.New("Trigger cancel requires exact refund mint, amount, and destination account")
		}
		if !isSupportedTriggerTransferProgramV2(jupiter.Trigger.Program) {
			return normalizedIntentV2{}, errors.New("Trigger withdrawals support only exact System or SPL Token transfers")
		}
		if !triggerTransferProgramMatchesMintV2(jupiter.OutputMint, jupiter.Trigger.Program) {
			return normalizedIntentV2{}, errors.New("Trigger withdrawal program does not match the reviewed refund mint")
		}
		amount.Set(maxFee)
		asset = "solana:native"
		destination = owner
	default:
		return normalizedIntentV2{}, fmt.Errorf("unsupported typed Jupiter intent %q", intentType)
	}

	canonicalIntent := signerIntentV2{Type: intentType, Jupiter: &jupiter}
	canonical, err := json.Marshal(canonicalIntent)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	digest := sha256.Sum256(canonical)
	return normalizedIntentV2{
		Intent:           canonicalIntent,
		Digest:           "sha256:" + hex.EncodeToString(digest[:]),
		Asset:            asset,
		Amount:           amount,
		PolicyOperation:  intentType,
		RequiredPrograms: append([]string(nil), programs...),
		RequiredRole:     "",
		Destination:      destination,
		CapExempt:        capExempt,
	}, nil
}

func jupiterAssetV2(mint string) string {
	if mint == solanaNativeMintV2 {
		return "solana:native"
	}
	return "solana:spl:" + mint
}

func normalizeTransactionEnvelopeV2(input signerSolanaTransactionEnvelopeV2) (signerSolanaTransactionEnvelopeV2, error) {
	serialized := strings.TrimSpace(input.SerializedTxBase64)
	if serialized == "" || len(serialized) > 4*1232 {
		return signerSolanaTransactionEnvelopeV2{}, errors.New("serialized Solana transaction is missing or too large")
	}
	programs, err := normalizeSortedStringsV2(input.Programs, func(raw string) (string, error) {
		return normalizePublicKeyV2(raw, "transaction program")
	})
	if err != nil || len(programs) == 0 {
		return signerSolanaTransactionEnvelopeV2{}, errors.New("transaction program manifest is invalid or empty")
	}
	writable, err := normalizeSortedStringsV2(input.WritableAccounts, func(raw string) (string, error) {
		return normalizePublicKeyV2(raw, "writable account")
	})
	if err != nil || len(writable) == 0 {
		return signerSolanaTransactionEnvelopeV2{}, errors.New("transaction writable-account manifest is invalid or empty")
	}
	submission := strings.TrimSpace(input.Submission)
	if submission != jupiterSubmissionRPCV2 {
		return signerSolanaTransactionEnvelopeV2{}, errors.New("application-provided transactions support only signer-owned rpc submission")
	}
	return signerSolanaTransactionEnvelopeV2{
		SerializedTxBase64: serialized,
		Programs:           programs,
		WritableAccounts:   writable,
		Submission:         submission,
	}, nil
}

func normalizeReviewModeV2(raw string) (string, error) {
	mode := strings.TrimSpace(raw)
	if mode != jupiterReviewModeAutonomousV2 && mode != jupiterReviewModeReviewedV2 {
		return "", errors.New("review mode must be autonomous or reviewed")
	}
	return mode, nil
}

func equalSortedStringsV2(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	a := append([]string(nil), left...)
	b := append([]string(nil), right...)
	sort.Strings(a)
	sort.Strings(b)
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}

func reviewExpiryV2(now time.Time) time.Time {
	return now.Add(15 * time.Minute)
}
