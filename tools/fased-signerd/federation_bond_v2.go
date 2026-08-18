package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	signerpolicy "fased-signerd/internal/policy"
	solana "github.com/gagliardetto/solana-go"
)

const (
	federationBondChallengeSchemaV2   = "https://schemas.fased.ai/fased-bond-challenge-v1.json"
	federationBondPolicyDomainV2      = signerpolicy.FederationBondProgramDomain
	federationBondSignatureDomainV2   = "fased:federation-bond-challenge-signature:v2"
	federationBondChallengeMaxBytesV2 = 16 << 10
	federationBondChallengeMaxTTL     = 10 * time.Minute
)

type federationBondSigningMessageV2 struct {
	Domain           string `json:"domain"`
	ChallengeID      string `json:"challengeId"`
	FederationOrigin string `json:"federationOrigin"`
	PayloadBase64    string `json:"payloadBase64"`
}

type signerFederationBondChallengeIntentV2 struct {
	ChallengeID      string `json:"challengeId"`
	FederationOrigin string `json:"federationOrigin"`
	Handle           string `json:"handle"`
	NodeID           string `json:"nodeId"`
	TokenID          string `json:"tokenId"`
	BondID           string `json:"bondId"`
	Tier             string `json:"tier"`
	AmountRaw        string `json:"amountRaw,omitempty"`
	ExpiresAt        string `json:"expiresAt"`
	PayloadBase64    string `json:"payloadBase64"`
}

type federationBondChallengePayloadV2 struct {
	Schema    string
	Handle    string
	NodeID    string
	TokenID   string
	BondID    string
	Wallet    federationBondChallengeWalletV2
	Tier      string
	AmountRaw string
	Nonce     string
	IssuedAt  string
	ExpiresAt string
	HasAmount bool
}

type federationBondChallengeWalletV2 struct {
	Chain   string
	Address string
}

func normalizeBoundedFederationTextV2(raw, field string, max int) (string, error) {
	if raw == "" || raw != strings.TrimSpace(raw) || len(raw) > max || !utf8.ValidString(raw) || strings.ContainsAny(raw, "\x00\r\n\t") {
		return "", fmt.Errorf("federation challenge %s is invalid", field)
	}
	return raw, nil
}

func normalizeFederationOriginV2(raw string) (string, error) {
	value, err := normalizeBoundedFederationTextV2(raw, "origin", 2048)
	if err != nil {
		return "", err
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", errors.New("federation challenge origin must be an HTTPS origin without path, credentials, query, or fragment")
	}
	if parsed.Port() == "0" {
		return "", errors.New("federation challenge origin contains an invalid port")
	}
	return "https://" + strings.ToLower(parsed.Host), nil
}

func strictFederationJSONMapV2(raw []byte, label string) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	value, err := decodeReviewJSONValueV2(decoder, 0)
	if err != nil {
		return nil, fmt.Errorf("invalid %s: %w", label, err)
	}
	if token, err := decoder.Token(); !errors.Is(err, io.EOF) || token != nil {
		return nil, fmt.Errorf("%s must contain exactly one JSON object", label)
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s must be a JSON object", label)
	}
	return object, nil
}

func federationStringFieldV2(object map[string]any, field string, max int) (string, error) {
	value, ok := object[field].(string)
	if !ok {
		return "", fmt.Errorf("federation challenge %s must be a string", field)
	}
	return normalizeBoundedFederationTextV2(value, field, max)
}

func rejectUnexpectedFederationFieldsV2(object map[string]any, allowed map[string]bool, label string) error {
	for field := range object {
		if !allowed[field] {
			return fmt.Errorf("%s contains unsupported field %q", label, field)
		}
	}
	return nil
}

func decodeFederationBondChallengePayloadV2(raw []byte) (federationBondChallengePayloadV2, error) {
	if len(raw) == 0 || len(raw) > federationBondChallengeMaxBytesV2 || !utf8.Valid(raw) || raw[0] != '{' || raw[len(raw)-1] != '}' {
		return federationBondChallengePayloadV2{}, fmt.Errorf("federation challenge payload must be one UTF-8 JSON object no larger than %d bytes", federationBondChallengeMaxBytesV2)
	}
	object, err := strictFederationJSONMapV2(raw, "federation challenge payload")
	if err != nil {
		return federationBondChallengePayloadV2{}, err
	}
	allowed := map[string]bool{
		"schema": true, "handle": true, "nodeId": true, "tokenId": true,
		"bondId": true, "wallet": true, "tier": true, "amountRaw": true,
		"nonce": true, "issuedAt": true, "expiresAt": true,
	}
	if err := rejectUnexpectedFederationFieldsV2(object, allowed, "federation challenge payload"); err != nil {
		return federationBondChallengePayloadV2{}, err
	}
	var payload federationBondChallengePayloadV2
	if payload.Schema, err = federationStringFieldV2(object, "schema", 256); err != nil {
		return payload, err
	}
	if payload.Schema != federationBondChallengeSchemaV2 {
		return payload, errors.New("federation challenge schema/domain is not supported")
	}
	for field, target := range map[string]*string{
		"handle": &payload.Handle, "nodeId": &payload.NodeID, "tokenId": &payload.TokenID,
		"bondId": &payload.BondID, "tier": &payload.Tier, "nonce": &payload.Nonce,
		"issuedAt": &payload.IssuedAt, "expiresAt": &payload.ExpiresAt,
	} {
		*target, err = federationStringFieldV2(object, field, 512)
		if err != nil {
			return payload, err
		}
	}
	switch payload.Tier {
	case "none", "basic-bond", "operator-bond":
	default:
		return payload, errors.New("federation challenge tier is invalid")
	}
	if rawAmount, exists := object["amountRaw"]; exists {
		amount, ok := rawAmount.(string)
		if !ok {
			return payload, errors.New("federation challenge amountRaw must be a string")
		}
		parsed, ok := new(big.Int).SetString(amount, 10)
		if !ok || parsed.Sign() < 0 || parsed.BitLen() > 64 || (len(amount) > 1 && strings.HasPrefix(amount, "0")) {
			return payload, errors.New("federation challenge amountRaw must be a canonical unsigned integer")
		}
		payload.AmountRaw, payload.HasAmount = parsed.String(), true
	}
	walletObject, ok := object["wallet"].(map[string]any)
	if !ok {
		return payload, errors.New("federation challenge wallet must be an object")
	}
	if err := rejectUnexpectedFederationFieldsV2(walletObject, map[string]bool{"chain": true, "address": true}, "federation challenge wallet"); err != nil {
		return payload, err
	}
	payload.Wallet.Chain, err = federationStringFieldV2(walletObject, "chain", 32)
	if err != nil {
		return payload, err
	}
	if payload.Wallet.Chain != "solana" {
		return payload, errors.New("federation challenge wallet chain must be solana")
	}
	payload.Wallet.Address, err = federationStringFieldV2(walletObject, "address", 64)
	if err != nil {
		return payload, err
	}
	payload.Wallet.Address, err = normalizePublicKeyV2(payload.Wallet.Address, "federation challenge wallet address")
	return payload, err
}

func validateFederationBondChallengeTimeV2(payload federationBondChallengePayloadV2, now time.Time) error {
	issuedAt, err := time.Parse(time.RFC3339Nano, payload.IssuedAt)
	if err != nil {
		return errors.New("federation challenge issuedAt must be RFC3339")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, payload.ExpiresAt)
	if err != nil {
		return errors.New("federation challenge expiresAt must be RFC3339")
	}
	if !expiresAt.After(issuedAt) || expiresAt.Sub(issuedAt) > federationBondChallengeMaxTTL {
		return errors.New("federation challenge lifetime is invalid")
	}
	now = now.UTC()
	if issuedAt.After(now.Add(2 * time.Minute)) {
		return errors.New("federation challenge issuedAt is in the future")
	}
	if !now.Before(expiresAt) {
		return errors.New("federation challenge expired")
	}
	return nil
}

func federationPayloadFromIntentV2(intent normalizedIntentV2) ([]byte, federationBondChallengePayloadV2, error) {
	if intent.Intent.Federation == nil {
		return nil, federationBondChallengePayloadV2{}, errors.New("federation challenge intent is missing")
	}
	payloadBytes, err := base64.StdEncoding.Strict().DecodeString(intent.Intent.Federation.PayloadBase64)
	if err != nil || base64.StdEncoding.EncodeToString(payloadBytes) != intent.Intent.Federation.PayloadBase64 {
		return nil, federationBondChallengePayloadV2{}, errors.New("federation challenge payloadBase64 must be canonical base64")
	}
	payload, err := decodeFederationBondChallengePayloadV2(payloadBytes)
	return payloadBytes, payload, err
}

func federationBondSigningMessageBytesV2(outer signerFederationBondChallengeIntentV2) ([]byte, error) {
	message := federationBondSigningMessageV2{
		Domain:           federationBondSignatureDomainV2,
		ChallengeID:      outer.ChallengeID,
		FederationOrigin: outer.FederationOrigin,
		PayloadBase64:    outer.PayloadBase64,
	}
	return json.Marshal(message)
}

func normalizeFederationBondChallengeIntentV2(input signerIntentV2, wallet solana.PublicKey) (normalizedIntentV2, error) {
	if input.Federation == nil {
		return normalizedIntentV2{}, errors.New("federation bond challenge details are required")
	}
	if input.Destination != "" || input.Lamports != "" || input.TokenProgram != "" || input.Mint != "" || input.Amount != "" || input.Action != "" || input.ProgramID != "" || input.DataBase64 != "" || len(input.Keys) != 0 || input.Context != nil || len(input.Instructions) != 0 || input.Jupiter != nil || input.Cluster != "" {
		return normalizedIntentV2{}, errors.New("federation bond challenge rejects transaction and raw-instruction fields")
	}
	outer := *input.Federation
	var err error
	if outer.ChallengeID, err = normalizeBoundedFederationTextV2(outer.ChallengeID, "challengeId", 256); err != nil {
		return normalizedIntentV2{}, err
	}
	if outer.FederationOrigin, err = normalizeFederationOriginV2(outer.FederationOrigin); err != nil {
		return normalizedIntentV2{}, err
	}
	for field, target := range map[string]*string{
		"handle": &outer.Handle, "nodeId": &outer.NodeID, "tokenId": &outer.TokenID,
		"bondId": &outer.BondID, "tier": &outer.Tier, "expiresAt": &outer.ExpiresAt,
	} {
		*target, err = normalizeBoundedFederationTextV2(*target, field, 512)
		if err != nil {
			return normalizedIntentV2{}, err
		}
	}
	if outer.AmountRaw != "" {
		parsed, ok := new(big.Int).SetString(outer.AmountRaw, 10)
		if !ok || parsed.Sign() < 0 || parsed.BitLen() > 64 || parsed.String() != outer.AmountRaw {
			return normalizedIntentV2{}, errors.New("federation challenge expected amountRaw must be a canonical unsigned integer")
		}
	}
	payloadBytes, err := base64.StdEncoding.Strict().DecodeString(outer.PayloadBase64)
	if err != nil || base64.StdEncoding.EncodeToString(payloadBytes) != outer.PayloadBase64 {
		return normalizedIntentV2{}, errors.New("federation challenge payloadBase64 must be canonical base64")
	}
	payload, err := decodeFederationBondChallengePayloadV2(payloadBytes)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	if payload.Wallet.Address != wallet.String() {
		return normalizedIntentV2{}, errors.New("federation challenge wallet does not match signer-owned Vault")
	}
	if payload.Handle != outer.Handle || payload.NodeID != outer.NodeID || payload.TokenID != outer.TokenID || payload.BondID != outer.BondID || payload.Tier != outer.Tier || payload.ExpiresAt != outer.ExpiresAt {
		return normalizedIntentV2{}, errors.New("federation challenge payload does not match the requested immutable binding")
	}
	if payload.HasAmount != (outer.AmountRaw != "") || (payload.HasAmount && payload.AmountRaw != outer.AmountRaw) {
		return normalizedIntentV2{}, errors.New("federation challenge payload amount does not match the requested immutable binding")
	}
	canonicalIntent := signerIntentV2{Type: intentFederationBondChallenge, Federation: &outer}
	canonical, err := json.Marshal(canonicalIntent)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	digest := sha256.Sum256(canonical)
	signingMessage, err := federationBondSigningMessageBytesV2(outer)
	if err != nil {
		return normalizedIntentV2{}, err
	}
	return normalizedIntentV2{
		Intent: canonicalIntent, Digest: "sha256:" + hex.EncodeToString(digest[:]),
		Asset: "federation:bond-challenge", Amount: big.NewInt(1), Destination: wallet.String(),
		PolicyOperation: intentFederationBondChallenge, RequiredPrograms: []string{federationBondPolicyDomainV2},
		RequiredRole: "vault", Message: signingMessage,
	}, nil
}

func federationBondChallengeRequestIDV2(challengeID string) string {
	digest := sha256.Sum256([]byte(challengeID))
	return "federation-bond:" + hex.EncodeToString(digest[:])
}
