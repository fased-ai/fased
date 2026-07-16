package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"time"
)

const (
	solanaNativeMintV2        = "So11111111111111111111111111111111111111112"
	jupiterAggregatorV6V2     = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
	jupiterSubmissionRPCV2    = "rpc"
	jupiterSubmissionReturnV2 = "returnSigned"

	jupiterReviewPreparedV2       = "prepared"
	jupiterReviewSignedV2         = "signed"
	jupiterReviewModeAutonomousV2 = "autonomous"
	jupiterReviewModeReviewedV2   = "reviewed"
)

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
	Program   string `json:"program"`
	Vault     string `json:"vault,omitempty"`
	Order     string `json:"order,omitempty"`
	RequestID string `json:"requestId,omitempty"`
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
	RequestID         string                            `json:"requestId"`
	WalletID          string                            `json:"walletId"`
	IntentType        string                            `json:"intentType"`
	IntentDigest      string                            `json:"intentDigest"`
	PolicyHash        string                            `json:"policyHash"`
	Mode              string                            `json:"mode"`
	Nonce             string                            `json:"nonce"`
	SemanticIntent    json.RawMessage                   `json:"semanticIntent"`
	Transaction       signerSolanaTransactionEnvelopeV2 `json:"transaction"`
	IssuedAt          string                            `json:"issuedAt"`
	State             string                            `json:"state"`
	PreparedAt        string                            `json:"preparedAt"`
	ExpiresAt         string                            `json:"expiresAt"`
	UpdatedAt         string                            `json:"updatedAt"`
	TransactionDigest string                            `json:"transactionDigest"`
	Signature         string                            `json:"signature,omitempty"`
}

type signerReviewExecutionResultV2 struct {
	Review         signerReviewV2     `json:"review"`
	Operation      *signerOperationV2 `json:"operation,omitempty"`
	SignedTxBase64 string             `json:"signedTxBase64,omitempty"`
	Signer         string             `json:"signer"`
}

func isJupiterIntentTypeV2(intentType string) bool {
	switch strings.TrimSpace(intentType) {
	case intentSolanaJupiterSwap,
		intentSolanaTriggerAuth,
		intentSolanaTriggerCreate,
		intentSolanaTriggerDeposit,
		intentSolanaTriggerCancel,
		intentSolanaTriggerWithdraw:
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
	case intentSolanaTriggerCreate, intentSolanaTriggerDeposit:
		if jupiter.Trigger == nil || jupiter.Trigger.Vault == "" || jupiter.Trigger.RequestID == "" {
			return normalizedIntentV2{}, errors.New("Trigger deposit/create requires exact vault and request identity")
		}
		if jupiter.Trigger.Vault == owner {
			return normalizedIntentV2{}, errors.New("Trigger vault must be distinct from the signer-owned wallet")
		}
		if jupiter.Trigger.Program != "11111111111111111111111111111111" &&
			jupiter.Trigger.Program != "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" &&
			jupiter.Trigger.Program != "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" {
			return normalizedIntentV2{}, errors.New("Trigger deposits support only exact System or SPL Token transfers")
		}
		if jupiter.InputMint == "" || inputAmount.Sign() <= 0 || jupiter.SourceTokenAccount == "" || jupiter.DestinationTokenAccount == "" {
			return normalizedIntentV2{}, errors.New("Trigger deposit/create requires input mint, amount, and exact token accounts")
		}
		amount.Set(maxInput)
		asset = jupiterAssetV2(jupiter.InputMint)
		destination = jupiter.Trigger.Vault
	case intentSolanaTriggerCancel, intentSolanaTriggerWithdraw:
		if jupiter.Trigger == nil || jupiter.Trigger.Vault == "" || jupiter.Trigger.Order == "" || jupiter.Trigger.RequestID == "" {
			return normalizedIntentV2{}, errors.New("Trigger cancel/withdraw requires exact vault, order, and request identity")
		}
		if jupiter.OutputMint == "" || minimumOutput.Sign() <= 0 || jupiter.SourceTokenAccount == "" || jupiter.DestinationTokenAccount == "" {
			return normalizedIntentV2{}, errors.New("Trigger cancel/withdraw requires output mint, minimum output, and exact token accounts")
		}
		if jupiter.Trigger.Vault == owner {
			return normalizedIntentV2{}, errors.New("Trigger vault must be distinct from the signer-owned wallet")
		}
		if jupiter.Trigger.Program != "11111111111111111111111111111111" &&
			jupiter.Trigger.Program != "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" &&
			jupiter.Trigger.Program != "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" {
			return normalizedIntentV2{}, errors.New("Trigger withdrawals support only exact System or SPL Token transfers")
		}
		if maxFee.Sign() <= 0 {
			return normalizedIntentV2{}, errors.New("Trigger cancel/withdraw requires a positive fee ceiling")
		}
		amount.Set(maxFee)
		asset = "solana:native"
	case intentSolanaTriggerAuth:
		if jupiter.Trigger == nil || jupiter.Trigger.RequestID == "" {
			return normalizedIntentV2{}, errors.New("Trigger auth requires exact challenge identity")
		}
		if inputAmount.Sign() != 0 || minimumOutput.Sign() != 0 || maxFee.Sign() <= 0 {
			return normalizedIntentV2{}, errors.New("Trigger auth cannot authorize asset movement and requires a positive fee ceiling")
		}
		if jupiter.Trigger.Program != "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" &&
			jupiter.Trigger.Program != "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo" {
			return normalizedIntentV2{}, errors.New("Trigger auth requires a domain-bound Memo challenge")
		}
		amount.Set(maxFee)
		asset = "solana:native"
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
		RequiredPrograms: append([]string(nil), programs...),
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
	if submission != jupiterSubmissionRPCV2 && submission != jupiterSubmissionReturnV2 {
		return signerSolanaTransactionEnvelopeV2{}, errors.New("transaction submission must be rpc or returnSigned")
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
