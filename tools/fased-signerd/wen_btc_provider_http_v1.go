package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	solana "github.com/gagliardetto/solana-go"
)

// Only the owner-configured key is supplied. Host and API version are fixed;
// callers cannot redirect credentials or introduce a generic HTTP proxy.
type signerWENBTCProviderHTTPV1 struct {
	http *http.Client
	key  string
}

func newWENBTCProviderHTTPV1(key string) (*signerWENBTCProviderHTTPV1, error) {
	if key == "" || strings.TrimSpace(key) != key || strings.ContainsAny(key, "\r\n") || len(key) > 4096 {
		return nil, errors.New("invalid WEN quote credential")
	}
	return &signerWENBTCProviderHTTPV1{key: key, http: &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (c *signerWENBTCProviderHTTPV1) request(ctx context.Context, method, path string, query url.Values, body []byte) ([]byte, error) {
	bad := errors.New("WEN quote provider request failed")
	if c == nil || c.http == nil || c.key == "" {
		return nil, bad
	}
	u := "https://api.jup.ag/swap/v1/" + path
	if path != "quote" && path != "swap-instructions" {
		return nil, bad
	}
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, bytes.NewReader(body))
	if err != nil {
		return nil, bad
	}
	req.Header.Set("x-api-key", c.key)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(req)
	if err != nil {
		return nil, bad
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, bad
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(raw) == 0 || len(raw) > 65536 || !json.Valid(raw) {
		return nil, bad
	}
	return raw, nil
}

// Produces a review candidate only; no active artifact is replaced. The caller
// must obtain fresh signer-owned chain readback again before installing/reusing it.
func (c *signerWENBTCProviderHTTPV1) candidate(ctx context.Context, a signerWENBTCArtifactsV1, wallet solana.PublicKey, review signerWENBTCReviewV1, referenceSlot, now, slippage uint64) (*signerWENBTCRouteCandidateV1, error) {
	bad := errors.New("WEN quote provider candidate rejected")
	if slippage > 50 || review.Intent.Operation != "acquisition" || wallet.String() != review.WalletPublicKey || a.program.String() != review.Pins.ProgramID || wenHashV1(a.offer[:]) != review.Pins.OfferSHA256 {
		return nil, bad
	}
	if err := review.checkRouteSlot(referenceSlot); err != nil {
		return nil, err
	}
	if err := a.validateTerms(0); err != nil {
		return nil, err
	}
	if now > a.numbers[15] {
		return nil, bad
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	q := url.Values{"inputMint": {a.keys[3].String()}, "outputMint": {a.keys[4].String()}, "amount": {strconv.FormatUint(a.numbers[10], 10)}, "swapMode": {"ExactIn"}, "slippageBps": {strconv.FormatUint(slippage, 10)}, "platformFeeBps": {"0"}, "maxAccounts": {"32"}, "restrictIntermediateTokens": {"true"}}
	quote, err := c.request(ctx, http.MethodGet, "quote", q, nil)
	if err != nil {
		return nil, err
	}
	// Reject economic substitutions before forwarding the quote for instruction
	// construction. Complete quote/serialized-route validation follows below.
	var terms struct {
		InputMint  string `json:"inputMint"`
		OutputMint string `json:"outputMint"`
		Amount     string `json:"inAmount"`
		Mode       string `json:"swapMode"`
		Slippage   uint64 `json:"slippageBps"`
	}
	if json.Unmarshal(quote, &terms) != nil || terms.InputMint != a.keys[3].String() || terms.OutputMint != a.keys[4].String() || terms.Amount != strconv.FormatUint(a.numbers[10], 10) || terms.Mode != "ExactIn" || terms.Slippage != slippage {
		return nil, bad
	}
	nonce := make([]byte, 8)
	binary.LittleEndian.PutUint64(nonce, a.numbers[0])
	record, _, err := solana.FindProgramAddress([][]byte{[]byte("wen-btc-subscription-v1"), a.keys[0][:], a.keys[2][:], nonce}, a.program)
	if err != nil {
		return nil, err
	}
	authority, _, err := solana.FindProgramAddress([][]byte{[]byte("wen-btc-swap-v1"), record[:]}, a.program)
	if err != nil {
		return nil, err
	}
	destination, _, err := solana.FindProgramAddress([][]byte{[]byte("wen-btc-sub-route-asset-v1"), record[:]}, a.program)
	if err != nil {
		return nil, err
	}
	body, _ := json.Marshal(map[string]any{"userPublicKey": authority.String(), "payer": wallet.String(), "quoteResponse": json.RawMessage(quote), "destinationTokenAccount": destination.String(), "wrapAndUnwrapSol": false, "useSharedAccounts": true, "asLegacyTransaction": false, "dynamicComputeUnitLimit": false, "dynamicSlippage": false, "skipUserAccountsRpcCalls": true})
	raw, err := c.request(ctx, http.MethodPost, "swap-instructions", nil, body)
	if err != nil {
		return nil, err
	}
	var response struct {
		Swap    json.RawMessage   `json:"swapInstruction"`
		Setup   []json.RawMessage `json:"setupInstructions"`
		Other   []json.RawMessage `json:"otherInstructions"`
		Cleanup json.RawMessage   `json:"cleanupInstruction"`
	}
	if json.Unmarshal(raw, &response) != nil || len(response.Setup) > 0 || len(response.Other) > 0 || (len(response.Cleanup) > 0 && string(response.Cleanup) != "null") {
		return nil, bad
	}
	// Provider compute instructions and ALT suggestions grant no authority. WEN
	// builds its own budget and admits lookup snapshots independently.
	return buildWENBTCRouteCandidateV1(a, wallet, review, quote, response.Swap, referenceSlot, now)
}
