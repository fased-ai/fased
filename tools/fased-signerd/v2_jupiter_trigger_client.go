package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	solana "github.com/gagliardetto/solana-go"
)

const (
	jupiterTriggerProductionBaseURLV2 = "https://api.jup.ag/trigger/v2"
	jupiterTriggerHTTPTimeoutV2       = 20 * time.Second
	jupiterTriggerMaxResponseBytesV2  = 2 << 20
	jupiterTriggerMessagePrefixV2     = "Sign this message to authenticate with Jupiter Trigger Order API: "
)

func resolveSignerJupiterAPIKeyPathV2(configuredPath, stateDBPath string) string {
	if configured := strings.TrimSpace(configuredPath); configured != "" {
		return configured
	}
	return filepath.Join(filepath.Dir(strings.TrimSpace(stateDBPath)), "jupiter-trigger-api.key")
}

type signerJupiterTriggerTokenV2 struct {
	value     string
	expiresAt time.Time
}

type signerJupiterTriggerClientV2 struct {
	baseURL string
	apiKey  []byte
	http    *http.Client
	now     func() time.Time
	mu      sync.Mutex
	tokens  map[string]signerJupiterTriggerTokenV2
}

type signerJupiterTriggerHTTPErrorV2 struct {
	Status int
}

func (e signerJupiterTriggerHTTPErrorV2) Error() string {
	return fmt.Sprintf("Jupiter Trigger API returned HTTP %d", e.Status)
}

type signerJupiterTriggerVaultV2 struct {
	UserPublicKey  string `json:"userPubkey"`
	VaultPublicKey string `json:"vaultPubkey"`
}

type signerJupiterTriggerDepositV2 struct {
	Transaction       string `json:"transaction"`
	RequestID         string `json:"requestId"`
	ReceiverAddress   string `json:"receiverAddress"`
	Mint              string `json:"mint"`
	Amount            string `json:"amount"`
	InputTokenAccount string `json:"inputTokenAccount"`
}

type signerJupiterTriggerCancelV2 struct {
	ID          string `json:"id"`
	Transaction string `json:"transaction"`
	RequestID   string `json:"requestId"`
}

type signerJupiterTriggerSubmitResultV2 struct {
	ID          string `json:"id"`
	TxSignature string `json:"txSignature"`
}

type signerJupiterTriggerEventV2 struct {
	Type        string `json:"type"`
	TxSignature string `json:"txSignature"`
}

type signerJupiterTriggerOrderV2 struct {
	ID                   string                        `json:"id"`
	OrderType            string                        `json:"orderType"`
	OrderState           string                        `json:"orderState"`
	RawState             string                        `json:"rawState"`
	UserPublicKey        string                        `json:"userPubkey"`
	VaultPublicKey       string                        `json:"privyWalletPubkey"`
	InputMint            string                        `json:"inputMint"`
	InitialInputAmount   string                        `json:"initialInputAmount"`
	RemainingInputAmount string                        `json:"remainingInputAmount"`
	OutputMint           string                        `json:"outputMint"`
	TriggerMint          string                        `json:"triggerMint"`
	TriggerCondition     string                        `json:"triggerCondition"`
	TriggerPriceUSD      json.Number                   `json:"triggerPriceUsd"`
	SlippageBPS          uint16                        `json:"slippageBps"`
	ExpiresAt            int64                         `json:"expiresAt"`
	Events               []signerJupiterTriggerEventV2 `json:"events"`
}

type signerJupiterTriggerHistoryV2 struct {
	Orders     []signerJupiterTriggerOrderV2 `json:"orders"`
	Pagination struct {
		Total  int `json:"total"`
		Limit  int `json:"limit"`
		Offset int `json:"offset"`
	} `json:"pagination"`
}

func newSignerJupiterTriggerClientV2(apiKey []byte) (*signerJupiterTriggerClientV2, error) {
	return newSignerJupiterTriggerClientForTestV2(
		jupiterTriggerProductionBaseURLV2,
		apiKey,
		newSignerOwnedHTTPClientV2(),
	)
}

func readSignerJupiterAPIKeyFileV2(path string) ([]byte, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("signer-owned Jupiter API key file is not configured")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, errors.New("read signer-owned Jupiter API key file")
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > 4096 {
		return nil, errors.New("signer-owned Jupiter API key file must be a private regular non-symlink file")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
		return nil, fmt.Errorf("signer-owned Jupiter API key file must be owned by uid %d", os.Geteuid())
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("read signer-owned Jupiter API key file")
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil || !os.SameFile(info, openedInfo) || openedInfo.Mode()&os.ModeSymlink != 0 ||
		!openedInfo.Mode().IsRegular() || openedInfo.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("signer-owned Jupiter API key file changed while opening")
	}
	if stat, ok := openedInfo.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
		return nil, fmt.Errorf("signer-owned Jupiter API key file must be owned by uid %d", os.Geteuid())
	}
	raw, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil || len(raw) > 4096 {
		zeroBytes(raw)
		return nil, errors.New("read signer-owned Jupiter API key file")
	}
	key, err := normalizeSignerJupiterAPIKeyV2(raw)
	zeroBytes(raw)
	return key, err
}

func normalizeSignerJupiterAPIKeyV2(raw []byte) ([]byte, error) {
	key := bytes.TrimSpace(raw)
	if len(key) < 8 || len(key) > 4096 {
		return nil, errors.New("signer-owned Jupiter API key is missing or invalid")
	}
	for _, value := range key {
		if value < 0x21 || value > 0x7e {
			return nil, errors.New("signer-owned Jupiter API key must contain only printable non-space ASCII")
		}
	}
	return append([]byte(nil), key...), nil
}

// newSignerJupiterTriggerClientForTestV2 is the sole base URL injection seam.
// Production construction always pins api.jup.ag above.
func newSignerJupiterTriggerClientForTestV2(
	baseURL string,
	apiKey []byte,
	httpClient *http.Client,
) (*signerJupiterTriggerClientV2, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("Jupiter Trigger base URL is invalid")
	}
	key, err := normalizeSignerJupiterAPIKeyV2(apiKey)
	if err != nil {
		return nil, err
	}
	defer zeroBytes(key)
	if httpClient == nil {
		return nil, errors.New("Jupiter Trigger HTTP client is required")
	}
	return &signerJupiterTriggerClientV2{
		baseURL: strings.TrimRight(parsed.String(), "/"),
		apiKey:  append([]byte(nil), key...),
		http:    httpClient, now: time.Now,
		tokens: make(map[string]signerJupiterTriggerTokenV2),
	}, nil
}

func (c *signerJupiterTriggerClientV2) close() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	zeroBytes(c.apiKey)
	for walletID, token := range c.tokens {
		value := []byte(token.value)
		zeroBytes(value)
		delete(c.tokens, walletID)
	}
}

func (c *signerJupiterTriggerClientV2) doJSON(
	method string,
	path string,
	token string,
	body any,
	out any,
) error {
	if c == nil || len(c.apiKey) == 0 {
		return errors.New("signer-owned Jupiter Trigger client is unavailable")
	}
	if !strings.HasPrefix(path, "/") || strings.Contains(path, "..") {
		return errors.New("Jupiter Trigger API path is invalid")
	}
	var encoded io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return errors.New("encode Jupiter Trigger request")
		}
		encoded = bytes.NewReader(payload)
	}
	ctx, cancel := context.WithTimeout(context.Background(), jupiterTriggerHTTPTimeoutV2)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, encoded)
	if err != nil {
		return errors.New("create Jupiter Trigger request")
	}
	req.Header.Set("accept", "application/json")
	req.Header.Set("x-api-key", string(c.apiKey))
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	if strings.TrimSpace(token) != "" {
		req.Header.Set("authorization", "Bearer "+strings.TrimSpace(token))
	}
	response, err := c.http.Do(req)
	if err != nil {
		return errors.New("Jupiter Trigger API response is ambiguous")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, jupiterTriggerMaxResponseBytesV2))
		return signerJupiterTriggerHTTPErrorV2{Status: response.StatusCode}
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, jupiterTriggerMaxResponseBytesV2+1))
	if err != nil || len(payload) > jupiterTriggerMaxResponseBytesV2 {
		return errors.New("Jupiter Trigger API response is invalid or too large")
	}
	if err := validateJSONNoDuplicateKeysV2(payload); err != nil {
		return errors.New("Jupiter Trigger API returned ambiguous JSON")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	if err := decoder.Decode(out); err != nil {
		return errors.New("Jupiter Trigger API returned invalid JSON")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("Jupiter Trigger API returned trailing JSON data")
	}
	return nil
}

func (c *signerJupiterTriggerClientV2) authenticate(
	walletID string,
	wallet solana.PublicKey,
	privateKey solana.PrivateKey,
) (string, error) {
	cacheKey := normalizeWalletID(walletID) + "\x00" + wallet.String()
	c.mu.Lock()
	cached := c.tokens[cacheKey]
	c.mu.Unlock()
	if cached.value != "" && c.now().Add(time.Minute).Before(cached.expiresAt) {
		return cached.value, nil
	}
	var challenge struct {
		Type      string `json:"type"`
		Challenge string `json:"challenge"`
	}
	if err := c.doJSON(http.MethodPost, "/auth/challenge", "", map[string]string{
		"walletPubkey": wallet.String(),
		"type":         "message",
	}, &challenge); err != nil {
		return "", err
	}
	message := strings.TrimSpace(challenge.Challenge)
	nonce := strings.TrimPrefix(message, jupiterTriggerMessagePrefixV2)
	if challenge.Type != "message" || len(message) > 4096 ||
		nonce == message || len(nonce) < 8 || strings.ContainsAny(message, "\r\n\x00") {
		return "", errors.New("Jupiter Trigger returned an invalid wallet-bound message challenge")
	}
	signature, err := privateKey.Sign([]byte(message))
	if err != nil {
		return "", errors.New("sign Jupiter Trigger authentication challenge")
	}
	var verified struct {
		Token string `json:"token"`
	}
	if err := c.doJSON(http.MethodPost, "/auth/verify", "", map[string]string{
		"type":         "message",
		"walletPubkey": wallet.String(),
		"signature":    signature.String(),
	}, &verified); err != nil {
		return "", err
	}
	token := strings.TrimSpace(verified.Token)
	if len(token) < 16 || len(token) > 32*1024 || !isCanonicalJupiterJWTV2(token) {
		return "", errors.New("Jupiter Trigger returned an invalid JWT")
	}
	c.mu.Lock()
	c.tokens[cacheKey] = signerJupiterTriggerTokenV2{value: token, expiresAt: c.now().Add(23 * time.Hour)}
	c.mu.Unlock()
	return token, nil
}

func isCanonicalJupiterJWTV2(token string) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if part == "" {
			return false
		}
		for _, value := range []byte(part) {
			if !((value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
				(value >= '0' && value <= '9') || value == '-' || value == '_') {
				return false
			}
		}
	}
	return true
}

func (c *signerJupiterTriggerClientV2) vault(token string, register bool) (signerJupiterTriggerVaultV2, error) {
	var vault signerJupiterTriggerVaultV2
	err := c.doJSON(http.MethodGet, "/vault", token, nil, &vault)
	var status signerJupiterTriggerHTTPErrorV2
	if err != nil && register && errors.As(err, &status) && status.Status == http.StatusNotFound {
		err = c.doJSON(http.MethodGet, "/vault/register", token, nil, &vault)
	}
	return vault, err
}

func (c *signerJupiterTriggerClientV2) craftDeposit(
	token string,
	wallet string,
	intent *signerJupiterIntentV2,
) (signerJupiterTriggerDepositV2, error) {
	var deposit signerJupiterTriggerDepositV2
	err := c.doJSON(http.MethodPost, "/deposit/craft", token, map[string]any{
		"inputMint": intent.InputMint, "outputMint": intent.OutputMint,
		"userAddress": wallet, "amount": intent.InputAmount,
		"orderType": "price", "orderSubType": "single",
	}, &deposit)
	return deposit, err
}

func (c *signerJupiterTriggerClientV2) createOrder(
	token string,
	intent *signerJupiterIntentV2,
	depositRequestID string,
	signedTxBase64 string,
) (signerJupiterTriggerSubmitResultV2, error) {
	trigger := intent.Trigger
	expiresAt, err := time.Parse(jupiterTriggerExpiryLayoutV2, trigger.ExpiresAt)
	if err != nil {
		return signerJupiterTriggerSubmitResultV2{}, errors.New("stored Trigger expiry is invalid")
	}
	price := json.Number(trigger.TargetPriceUSD)
	var result signerJupiterTriggerSubmitResultV2
	err = c.doJSON(http.MethodPost, "/orders/price", token, map[string]any{
		"orderType": "single", "depositRequestId": depositRequestID,
		"depositSignedTx": signedTxBase64, "userPubkey": intent.Owner,
		"inputMint": intent.InputMint, "inputAmount": intent.InputAmount,
		"outputMint": intent.OutputMint, "triggerMint": trigger.TriggerMint,
		"triggerCondition": trigger.Condition, "triggerPriceUsd": price,
		"slippageBps": trigger.SlippageBPS, "expiresAt": expiresAt.UnixMilli(),
	}, &result)
	return result, err
}

func (c *signerJupiterTriggerClientV2) initiateCancel(token, orderID string) (signerJupiterTriggerCancelV2, error) {
	var result signerJupiterTriggerCancelV2
	err := c.doJSON(http.MethodPost, "/orders/price/cancel/"+url.PathEscape(orderID), token, nil, &result)
	return result, err
}

func (c *signerJupiterTriggerClientV2) confirmCancel(
	token string,
	orderID string,
	cancelRequestID string,
	signedTxBase64 string,
) (signerJupiterTriggerSubmitResultV2, error) {
	var result signerJupiterTriggerSubmitResultV2
	err := c.doJSON(http.MethodPost, "/orders/price/confirm-cancel/"+url.PathEscape(orderID), token, map[string]string{
		"signedTransaction": signedTxBase64,
		"cancelRequestId":   cancelRequestID,
	}, &result)
	return result, err
}

func (c *signerJupiterTriggerClientV2) history(token string) ([]signerJupiterTriggerOrderV2, error) {
	orders := make([]signerJupiterTriggerOrderV2, 0)
	for offset := 0; offset < 1000; offset += 100 {
		var page signerJupiterTriggerHistoryV2
		path := "/orders/history?limit=100&offset=" + strconv.Itoa(offset)
		if err := c.doJSON(http.MethodGet, path, token, nil, &page); err != nil {
			return nil, err
		}
		if len(page.Orders) > 100 || page.Pagination.Total < 0 || page.Pagination.Limit < 0 ||
			page.Pagination.Limit > 100 || page.Pagination.Offset < 0 ||
			(page.Pagination.Offset != 0 && page.Pagination.Offset != offset) || len(orders)+len(page.Orders) > 1000 {
			return nil, errors.New("Jupiter Trigger history pagination is invalid or exceeds the signer bound")
		}
		orders = append(orders, page.Orders...)
		if len(page.Orders) < 100 || (page.Pagination.Total > 0 && len(orders) >= page.Pagination.Total) {
			return orders, nil
		}
	}
	return nil, errors.New("Jupiter Trigger history exceeds the signer reconciliation bound")
}

func findJupiterTriggerOrderV2(orders []signerJupiterTriggerOrderV2, orderID string) (signerJupiterTriggerOrderV2, error) {
	for _, order := range orders {
		if strings.TrimSpace(order.ID) == strings.TrimSpace(orderID) {
			return order, nil
		}
	}
	return signerJupiterTriggerOrderV2{}, errors.New("Jupiter Trigger order not found in bounded history")
}

func triggerOrderHasSignatureV2(order signerJupiterTriggerOrderV2, eventType, signature string) bool {
	for _, event := range order.Events {
		if strings.TrimSpace(event.Type) == eventType && strings.TrimSpace(event.TxSignature) == signature {
			return true
		}
	}
	return false
}
