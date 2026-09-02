package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	"fased-signerd/internal/networkverify"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
)

const (
	maxSignerRPCURLBytesV2        = networkverify.MaxRPCURLBytes
	maxSignerNetworkInputBytesV2  = 8192
	maxSignerNetworkRecordBytesV2 = 64 * 1024
)

var (
	errSignerNetworkNotConfiguredV2 = errors.New("signer-owned Solana network is not configured")
	errSignerNetworkRecordInvalidV2 = errors.New("stored signer network record is invalid")
	errSignerNetworkPendingV2       = errors.New("network-pending: signer-owned Solana RPC configuration is required")
	errSignerNetworkChangedV2       = errors.New("signer network configuration changed concurrently")
)

type signerNetworkPutRequestV2 struct {
	ExpectedVersion         *uint64 `json:"expectedVersion"`
	PrimaryRPCURL           string  `json:"primaryRpcUrl"`
	ExecutionFallbackRPCURL string  `json:"executionFallbackRpcUrl,omitempty"`
	VerificationRPCURL      string  `json:"verificationRpcUrl,omitempty"`
	LegacyFallbackRPCURL    string  `json:"fallbackRpcUrl,omitempty"`
}

type signerMigratedNetworkRepairRequestV1 struct {
	ExpectedVersion   uint64 `json:"expectedVersion"`
	ExpectedHash      string `json:"expectedHash"`
	ExpectedPublicKey string `json:"expectedPublicKey"`
	MigrationSource   string `json:"migrationSource"`
	PrimaryRPCURL     string `json:"primaryRpcUrl"`
}

type signerNetworkSecretV2 struct {
	SchemaVersion           uint8  `json:"schemaVersion"`
	PrimaryRPCURL           string `json:"primaryRpcUrl"`
	ExecutionFallbackRPCURL string `json:"executionFallbackRpcUrl,omitempty"`
	VerificationRPCURL      string `json:"verificationRpcUrl,omitempty"`
	GenesisHash             string `json:"genesisHash,omitempty"`
}

// signerLegacyNetworkSecretV2 is the exact encrypted v0.1.65 payload. Keep it
// separate so existing authenticated records can be verified without ever
// reinterpreting their fallback as a verification-only witness.
type signerLegacyNetworkSecretV2 struct {
	PrimaryRPCURL  string `json:"primaryRpcUrl"`
	FallbackRPCURL string `json:"fallbackRpcUrl,omitempty"`
}

type signerNetworkRecordV2 struct {
	WalletID  string `json:"walletId"`
	Version   uint64 `json:"version"`
	Hash      string `json:"hash"`
	UpdatedAt string `json:"updatedAt"`
	Nonce     string `json:"nonce"`
	Secret    string `json:"secret"`
}

type signerNetworkSummaryV2 struct {
	WalletID   string `json:"walletId"`
	Configured bool   `json:"configured"`
	Version    uint64 `json:"version"`
	Hash       string `json:"hash,omitempty"`
	Ready      bool   `json:"ready"`
}

type signerNetworkHealthV2 struct {
	Ready   bool                     `json:"ready"`
	Wallets []signerNetworkSummaryV2 `json:"wallets"`
}

func decodeSignerNetworkPutRequestV2(raw []byte, request *signerNetworkPutRequestV2) error {
	if request == nil {
		return errors.New("signer network request is unavailable")
	}
	*request = signerNetworkPutRequestV2{}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return errors.New("signer network request must be one JSON object")
	}
	seen := map[string]bool{}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return errors.New("invalid signer network request field")
		}
		key, ok := keyToken.(string)
		if !ok || seen[key] {
			return errors.New("invalid or duplicate signer network request field")
		}
		seen[key] = true
		switch key {
		case "expectedVersion":
			if err := decoder.Decode(&request.ExpectedVersion); err != nil {
				return errors.New("invalid signer network expectedVersion")
			}
		case "primaryRpcUrl":
			if err := decoder.Decode(&request.PrimaryRPCURL); err != nil {
				return errors.New("invalid signer network primaryRpcUrl")
			}
		case "executionFallbackRpcUrl":
			if err := decoder.Decode(&request.ExecutionFallbackRPCURL); err != nil {
				return errors.New("invalid signer network executionFallbackRpcUrl")
			}
		case "verificationRpcUrl":
			if err := decoder.Decode(&request.VerificationRPCURL); err != nil {
				return errors.New("invalid signer network verificationRpcUrl")
			}
		case "fallbackRpcUrl":
			if err := decoder.Decode(&request.LegacyFallbackRPCURL); err != nil {
				return errors.New("invalid signer network fallbackRpcUrl")
			}
		default:
			return errors.New("unknown signer network request field")
		}
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return errors.New("invalid signer network request object")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("trailing signer network request data")
	}
	return nil
}

func normalizeSignerNetworkInputV2(input signerNetworkPutRequestV2) (signerNetworkSecretV2, error) {
	primary, err := normalizeSignerRPCURLV2(input.PrimaryRPCURL, "primaryRpcUrl")
	if err != nil {
		return signerNetworkSecretV2{}, err
	}
	if input.ExecutionFallbackRPCURL != "" && input.LegacyFallbackRPCURL != "" {
		return signerNetworkSecretV2{}, errors.New("use executionFallbackRpcUrl instead of combining it with legacy fallbackRpcUrl")
	}
	executionFallbackInput := input.ExecutionFallbackRPCURL
	executionFallbackField := "executionFallbackRpcUrl"
	if executionFallbackInput == "" && input.LegacyFallbackRPCURL != "" {
		executionFallbackInput = input.LegacyFallbackRPCURL
		executionFallbackField = "fallbackRpcUrl"
	}
	executionFallback := ""
	if executionFallbackInput != "" {
		executionFallback, err = normalizeSignerRPCURLV2(executionFallbackInput, executionFallbackField)
		if err != nil {
			return signerNetworkSecretV2{}, err
		}
		if sameSignerRPCOriginV2(primary, executionFallback) {
			return signerNetworkSecretV2{}, fmt.Errorf("%s must use a different origin from primaryRpcUrl", executionFallbackField)
		}
	}
	verification := ""
	if input.VerificationRPCURL != "" {
		verification, err = normalizeSignerRPCURLV2(input.VerificationRPCURL, "verificationRpcUrl")
		if err != nil {
			return signerNetworkSecretV2{}, err
		}
		if sameSignerRPCOriginV2(primary, verification) {
			return signerNetworkSecretV2{}, errors.New("verificationRpcUrl must use a different origin from primaryRpcUrl")
		}
	}
	return signerNetworkSecretV2{
		SchemaVersion:           2,
		PrimaryRPCURL:           primary,
		ExecutionFallbackRPCURL: executionFallback,
		VerificationRPCURL:      verification,
	}, nil
}

func normalizeSignerGenesisHashV2(raw string) (string, error) {
	return networkverify.NormalizeGenesisHash(raw)
}

func (m *signerKeyManagerV2) resolveSignerGenesisHashV2(rpcURL string) (string, error) {
	resolver := signerRPCGenesisHashV2
	if m != nil && m.genesisHash != nil {
		resolver = m.genesisHash
	}
	hash, err := resolver(rpcURL)
	if err != nil {
		return "", errors.New("signer-owned Solana RPC genesis verification failed")
	}
	hash, err = normalizeSignerGenesisHashV2(hash)
	if err != nil {
		return "", errors.New("signer-owned Solana RPC returned an invalid genesis hash")
	}
	return hash, nil
}

func (m *signerKeyManagerV2) verifySignerNetworkGenesisV2(config signerNetworkSecretV2) (signerNetworkSecretV2, error) {
	primaryGenesis, err := m.resolveSignerGenesisHashV2(config.PrimaryRPCURL)
	if err != nil {
		return signerNetworkSecretV2{}, err
	}
	for _, candidate := range []string{config.ExecutionFallbackRPCURL, config.VerificationRPCURL} {
		if candidate == "" {
			continue
		}
		candidateGenesis, err := m.resolveSignerGenesisHashV2(candidate)
		if err != nil {
			return signerNetworkSecretV2{}, err
		}
		if subtle.ConstantTimeCompare([]byte(primaryGenesis), []byte(candidateGenesis)) != 1 {
			return signerNetworkSecretV2{}, errors.New("configured Solana RPC endpoints disagree on genesis hash")
		}
	}
	config.GenesisHash = primaryGenesis
	return config, nil
}

func (m *signerKeyManagerV2) ensureSignerExecutionGenesisV2(config signerNetworkSecretV2) (signerNetworkSecretV2, error) {
	pinnedGenesis := config.GenesisHash
	if pinnedGenesis != "" {
		var err error
		pinnedGenesis, err = normalizeSignerGenesisHashV2(pinnedGenesis)
		if err != nil {
			return signerNetworkSecretV2{}, errors.New("stored signer network genesis hash is invalid")
		}
	}
	verifiedURLs := make([]string, 0, 2)
	liveGenesis := ""
	for index, rpcURL := range []string{config.PrimaryRPCURL, config.ExecutionFallbackRPCURL} {
		if rpcURL == "" {
			continue
		}
		genesis, err := m.resolveSignerGenesisHashV2(rpcURL)
		if err != nil {
			if pinnedGenesis == "" && index == 0 {
				return signerNetworkSecretV2{}, errors.New("the primary Solana RPC must establish the initial genesis pin")
			}
			// A temporarily unavailable endpoint must not make its healthy,
			// already-pinned peer unusable. Ordinary execution will use the
			// write-RPC circuit only among endpoints that passed this operation's
			// live same-genesis verification.
			continue
		}
		if pinnedGenesis != "" && subtle.ConstantTimeCompare([]byte(pinnedGenesis), []byte(genesis)) != 1 {
			return signerNetworkSecretV2{}, errors.New("configured Solana execution RPC no longer agrees with the pinned genesis hash")
		}
		if liveGenesis != "" && subtle.ConstantTimeCompare([]byte(liveGenesis), []byte(genesis)) != 1 {
			return signerNetworkSecretV2{}, errors.New("configured Solana RPC endpoints disagree on genesis hash")
		}
		liveGenesis = genesis
		verifiedURLs = append(verifiedURLs, rpcURL)
	}
	if len(verifiedURLs) == 0 {
		return signerNetworkSecretV2{}, errors.New("signer-owned Solana RPC genesis verification failed")
	}
	if pinnedGenesis == "" {
		pinnedGenesis = liveGenesis
	}
	config.GenesisHash = pinnedGenesis
	config.PrimaryRPCURL = verifiedURLs[0]
	config.ExecutionFallbackRPCURL = ""
	if len(verifiedURLs) > 1 {
		config.ExecutionFallbackRPCURL = verifiedURLs[1]
	}
	return config, nil
}

func sameSignerRPCOriginV2(left, right string) bool {
	return networkverify.SameOrigin(left, right)
}

func normalizeSignerRPCURLV2(raw, field string) (string, error) {
	return networkverify.NormalizeRPCURL(raw, field)
}

func newSignerOwnedSolanaRPCClientV2(endpoint string) *rpc.Client {
	return networkverify.NewSolanaRPCClient(endpoint, solanaWriteRPCRequestTimeout())
}

func newSignerOwnedHTTPClientV2() *http.Client {
	return networkverify.NewHTTPClient(solanaWriteRPCRequestTimeout())
}

func validateSignerRPCJSONDepthV2(payload []byte) error {
	return networkverify.ValidateJSONDepth(payload)
}

func dialSignerOwnedRPCV2(ctx context.Context, network, address string) (net.Conn, error) {
	return networkverify.DialRPC(ctx, network, address, solanaWriteRPCRequestTimeout())
}

func deriveSignerNetworkKeyV2(masterKey []byte, purpose string) ([]byte, error) {
	if len(masterKey) != 32 {
		return nil, errors.New("signer master key is unavailable")
	}
	mac := hmac.New(sha256.New, masterKey)
	_, _ = mac.Write([]byte("fased-signerd:v2:network:" + purpose))
	return mac.Sum(nil), nil
}

func signerNetworkHashV2(masterKey []byte, walletID string, config signerNetworkSecretV2) (string, error) {
	return signerNetworkPayloadHashV2(masterKey, walletID, config)
}

func signerNetworkPayloadHashV2(masterKey []byte, walletID string, config any) (string, error) {
	encoded, err := json.Marshal(config)
	if err != nil {
		return "", errors.New("encode signer network configuration")
	}
	defer zeroBytes(encoded)
	key, err := deriveSignerNetworkKeyV2(masterKey, "hash")
	if err != nil {
		return "", err
	}
	defer zeroBytes(key)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(normalizeWalletID(walletID)))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write(encoded)
	return "hmac-sha256:" + hex.EncodeToString(mac.Sum(nil)), nil
}

func signerNetworkAADV2(record signerNetworkRecordV2) []byte {
	return []byte(fmt.Sprintf("fased-signerd:v2:network:%s:%d:%s:%s", record.WalletID, record.Version, record.Hash, record.UpdatedAt))
}

func (m *signerKeyManagerV2) encryptNetworkRecordV2(walletID string, version uint64, config signerNetworkSecretV2) (signerNetworkRecordV2, error) {
	hash, err := signerNetworkHashV2(m.masterKey, walletID, config)
	if err != nil {
		return signerNetworkRecordV2{}, err
	}
	record := signerNetworkRecordV2{
		WalletID:  normalizeWalletID(walletID),
		Version:   version,
		Hash:      hash,
		UpdatedAt: timestampV2(m.store.now()),
	}
	plaintext, err := json.Marshal(config)
	if err != nil {
		return signerNetworkRecordV2{}, errors.New("encode signer network configuration")
	}
	defer zeroBytes(plaintext)
	key, err := deriveSignerNetworkKeyV2(m.masterKey, "encryption")
	if err != nil {
		return signerNetworkRecordV2{}, err
	}
	defer zeroBytes(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return signerNetworkRecordV2{}, errors.New("initialize signer network encryption")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return signerNetworkRecordV2{}, errors.New("initialize signer network authenticated encryption")
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return signerNetworkRecordV2{}, errors.New("generate signer network encryption nonce")
	}
	defer zeroBytes(nonce)
	ciphertext := gcm.Seal(nil, nonce, plaintext, signerNetworkAADV2(record))
	record.Nonce = base64.RawURLEncoding.EncodeToString(nonce)
	record.Secret = base64.RawURLEncoding.EncodeToString(ciphertext)
	zeroBytes(ciphertext)
	return record, nil
}

func (m *signerKeyManagerV2) decryptNetworkRecordV2(record signerNetworkRecordV2) (signerNetworkSecretV2, error) {
	if err := validateSignerNetworkRecordMetadataV2(record); err != nil {
		return signerNetworkSecretV2{}, err
	}
	nonce, err := base64.RawURLEncoding.DecodeString(record.Nonce)
	if err != nil {
		return signerNetworkSecretV2{}, errors.New("invalid signer network record nonce")
	}
	defer zeroBytes(nonce)
	ciphertext, err := base64.RawURLEncoding.DecodeString(record.Secret)
	if err != nil {
		return signerNetworkSecretV2{}, errors.New("invalid signer network encrypted state")
	}
	defer zeroBytes(ciphertext)
	key, err := deriveSignerNetworkKeyV2(m.masterKey, "encryption")
	if err != nil {
		return signerNetworkSecretV2{}, err
	}
	defer zeroBytes(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return signerNetworkSecretV2{}, errors.New("initialize signer network decryption")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return signerNetworkSecretV2{}, errors.New("initialize signer network authenticated decryption")
	}
	if len(nonce) != gcm.NonceSize() {
		return signerNetworkSecretV2{}, errors.New("invalid signer network record nonce size")
	}
	if len(ciphertext) < gcm.Overhead() || len(ciphertext) > maxSignerNetworkRecordBytesV2 {
		return signerNetworkSecretV2{}, errors.New("invalid signer network encrypted state size")
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, signerNetworkAADV2(record))
	if err != nil {
		return signerNetworkSecretV2{}, errors.New("signer network encrypted state authentication failed")
	}
	defer zeroBytes(plaintext)
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(plaintext, &envelope); err != nil || envelope == nil {
		return signerNetworkSecretV2{}, errors.New("invalid signer network encrypted payload")
	}
	var normalized signerNetworkSecretV2
	var hashPayload any
	if _, legacy := envelope["fallbackRpcUrl"]; legacy || envelope["schemaVersion"] == nil {
		var config signerLegacyNetworkSecretV2
		decoder := json.NewDecoder(bytes.NewReader(plaintext))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&config); err != nil {
			return signerNetworkSecretV2{}, errors.New("invalid legacy signer network encrypted payload")
		}
		var trailing any
		if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
			return signerNetworkSecretV2{}, errors.New("invalid legacy signer network encrypted payload")
		}
		normalized, err = normalizeSignerNetworkInputV2(signerNetworkPutRequestV2{
			PrimaryRPCURL:        config.PrimaryRPCURL,
			LegacyFallbackRPCURL: config.FallbackRPCURL,
		})
		hashPayload = config
	} else {
		var config signerNetworkSecretV2
		decoder := json.NewDecoder(bytes.NewReader(plaintext))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&config); err != nil || config.SchemaVersion != 2 {
			return signerNetworkSecretV2{}, errors.New("invalid signer network encrypted payload")
		}
		var trailing any
		if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
			return signerNetworkSecretV2{}, errors.New("invalid signer network encrypted payload")
		}
		normalized, err = normalizeSignerNetworkInputV2(signerNetworkPutRequestV2{
			PrimaryRPCURL:           config.PrimaryRPCURL,
			ExecutionFallbackRPCURL: config.ExecutionFallbackRPCURL,
			VerificationRPCURL:      config.VerificationRPCURL,
		})
		if err == nil && config.GenesisHash != "" {
			normalized.GenesisHash, err = normalizeSignerGenesisHashV2(config.GenesisHash)
		}
		hashPayload = normalized
	}
	if err != nil {
		return signerNetworkSecretV2{}, errors.New("stored signer network configuration is invalid")
	}
	expectedHash, err := signerNetworkPayloadHashV2(m.masterKey, record.WalletID, hashPayload)
	if err != nil {
		return signerNetworkSecretV2{}, err
	}
	if subtle.ConstantTimeCompare([]byte(record.Hash), []byte(expectedHash)) != 1 {
		return signerNetworkSecretV2{}, errors.New("signer network configuration hash mismatch")
	}
	return normalized, nil
}

func (m *signerKeyManagerV2) PutNetworkV2(walletID string, request signerNetworkPutRequestV2) (signerNetworkSummaryV2, error) {
	if m == nil || m.store == nil || m.store.db == nil {
		return signerNetworkSummaryV2{}, errors.New("signer state database is unavailable")
	}
	if request.ExpectedVersion == nil {
		return signerNetworkSummaryV2{}, errors.New("expectedVersion is required")
	}
	walletID = normalizeWalletID(walletID)
	config, err := normalizeSignerNetworkInputV2(request)
	if err != nil {
		return signerNetworkSummaryV2{}, err
	}
	pinnedGenesis := ""
	legacyConfig := signerNetworkSecretV2{}
	hasUnpinnedLegacyConfig := false
	if err := m.store.db.View(func(tx *bolt.Tx) error {
		if tx.Bucket(bucketSignerWalletsV2).Get([]byte(walletID)) == nil {
			return errors.New("signer wallet not found")
		}
		currentVersion := uint64(0)
		if raw := tx.Bucket(bucketSignerNetworksV2).Get([]byte(walletID)); raw != nil {
			var current signerNetworkRecordV2
			if err := decodeSignerNetworkRecordV2(raw, &current); err != nil || current.WalletID != walletID {
				return errors.New("invalid stored signer network record")
			}
			currentConfig, err := m.decryptNetworkRecordV2(current)
			if err != nil {
				return errors.New("stored signer network record is not ready")
			}
			pinnedGenesis = currentConfig.GenesisHash
			if pinnedGenesis == "" {
				legacyConfig = currentConfig
				hasUnpinnedLegacyConfig = true
			}
			currentVersion = current.Version
		}
		if *request.ExpectedVersion != currentVersion {
			return fmt.Errorf("signer network version conflict: expected %d, current %d", *request.ExpectedVersion, currentVersion)
		}
		if currentVersion == math.MaxUint64 {
			return errors.New("signer network version is exhausted")
		}
		return nil
	}); err != nil {
		return signerNetworkSummaryV2{}, err
	}
	// Legacy v0.1.65 records predate the durable genesis pin. Before accepting a
	// replacement, resolve the old endpoint and use its genesis as the immutable
	// comparison point. If the old endpoint is unavailable, fail closed instead of
	// letting the lower-privilege application socket choose a new cluster.
	if hasUnpinnedLegacyConfig {
		verifiedLegacy, err := m.verifySignerNetworkGenesisV2(legacyConfig)
		if err != nil {
			return signerNetworkSummaryV2{}, errors.New("stored signer network genesis could not be verified")
		}
		pinnedGenesis = verifiedLegacy.GenesisHash
	}
	config, err = m.verifySignerNetworkGenesisV2(config)
	if err != nil {
		return signerNetworkSummaryV2{}, err
	}
	if pinnedGenesis != "" && subtle.ConstantTimeCompare([]byte(pinnedGenesis), []byte(config.GenesisHash)) != 1 {
		return signerNetworkSummaryV2{}, errors.New("replacement Solana RPC does not match the wallet's pinned genesis hash")
	}
	var stored signerNetworkRecordV2
	err = m.store.db.Update(func(tx *bolt.Tx) error {
		if tx.Bucket(bucketSignerWalletsV2).Get([]byte(walletID)) == nil {
			return errors.New("signer wallet not found")
		}
		networks := tx.Bucket(bucketSignerNetworksV2)
		currentVersion := uint64(0)
		if raw := networks.Get([]byte(walletID)); raw != nil {
			var current signerNetworkRecordV2
			if err := decodeSignerNetworkRecordV2(raw, &current); err != nil || current.WalletID != walletID {
				return errors.New("invalid stored signer network record")
			}
			if _, err := m.decryptNetworkRecordV2(current); err != nil {
				return errors.New("stored signer network record is not ready")
			}
			currentVersion = current.Version
		}
		if *request.ExpectedVersion != currentVersion {
			return fmt.Errorf("signer network version conflict: expected %d, current %d", *request.ExpectedVersion, currentVersion)
		}
		if currentVersion == math.MaxUint64 {
			return errors.New("signer network version is exhausted")
		}
		record, err := m.encryptNetworkRecordV2(walletID, currentVersion+1, config)
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(record)
		if err != nil {
			return errors.New("encode signer network record")
		}
		if err := networks.Put([]byte(walletID), encoded); err != nil {
			return err
		}
		stored = record
		return nil
	})
	if err != nil {
		return signerNetworkSummaryV2{}, err
	}
	return signerNetworkSummaryV2{
		WalletID:   walletID,
		Configured: true,
		Version:    stored.Version,
		Hash:       stored.Hash,
		Ready:      true,
	}, nil
}

// RepairMigratedPrimaryNetworkV1 is an explicit control-socket-only recovery for
// wallets imported from the legacy embedded keystore whose first network pin was
// recorded incorrectly by an older migration. Ordinary application RPC edits
// continue to reject cross-genesis changes. Exact wallet, network version, and
// authenticated network-hash fences make retries deterministic and auditable.
func (m *signerKeyManagerV2) RepairMigratedPrimaryNetworkV1(walletID string, request signerMigratedNetworkRepairRequestV1) (signerNetworkSummaryV2, error) {
	if m == nil || m.store == nil || m.store.db == nil {
		return signerNetworkSummaryV2{}, errors.New("signer state database is unavailable")
	}
	walletID = normalizeWalletID(walletID)
	if request.MigrationSource != "embedded-keystore" {
		return signerNetworkSummaryV2{}, errors.New("migrated network repair requires the embedded-keystore source marker")
	}
	if !isValidSignerNetworkHashV2(request.ExpectedHash) {
		return signerNetworkSummaryV2{}, errors.New("migrated network repair requires the exact current network hash")
	}
	expectedPublicKey, err := normalizeSignerGenesisHashV2(request.ExpectedPublicKey)
	if err != nil {
		return signerNetworkSummaryV2{}, errors.New("migrated network repair requires the exact wallet public key")
	}
	config, err := normalizeSignerNetworkInputV2(signerNetworkPutRequestV2{PrimaryRPCURL: request.PrimaryRPCURL})
	if err != nil {
		return signerNetworkSummaryV2{}, err
	}
	config, err = m.verifySignerNetworkGenesisV2(config)
	if err != nil {
		return signerNetworkSummaryV2{}, err
	}
	var stored signerNetworkRecordV2
	err = m.store.db.Update(func(tx *bolt.Tx) error {
		wallet, err := loadSignerWalletRecordFromTxV2(tx, walletID)
		if err != nil {
			return err
		}
		if subtle.ConstantTimeCompare([]byte(wallet.PublicKey), []byte(expectedPublicKey)) != 1 {
			return errors.New("migrated network repair wallet public key mismatch")
		}
		networks := tx.Bucket(bucketSignerNetworksV2)
		raw := networks.Get([]byte(walletID))
		if raw == nil {
			return errSignerNetworkNotConfiguredV2
		}
		var current signerNetworkRecordV2
		if err := decodeSignerNetworkRecordV2(raw, &current); err != nil || current.WalletID != walletID {
			return errors.New("invalid stored signer network record")
		}
		if current.Version != request.ExpectedVersion || subtle.ConstantTimeCompare([]byte(current.Hash), []byte(request.ExpectedHash)) != 1 {
			return errors.New("migrated network repair state changed; read the current signer network summary and retry")
		}
		if current.Version == math.MaxUint64 {
			return errors.New("signer network version is exhausted")
		}
		if _, err := m.decryptNetworkRecordV2(current); err != nil {
			return errors.New("stored signer network record is not ready")
		}
		next, err := m.encryptNetworkRecordV2(walletID, current.Version+1, config)
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(next)
		if err != nil {
			return errors.New("encode repaired signer network record")
		}
		if err := networks.Put([]byte(walletID), encoded); err != nil {
			return err
		}
		stored = next
		return nil
	})
	if err != nil {
		return signerNetworkSummaryV2{}, err
	}
	return signerNetworkSummaryV2{
		WalletID: walletID, Configured: true, Version: stored.Version, Hash: stored.Hash, Ready: true,
	}, nil
}

// PutApplicationNetworkV2 is the fixed-purpose application-socket broker for
// ordinary initial one-RPC onboarding. It cannot replace an existing network
// or set a fallback, witness, policy, key, path, or command. Replacements use
// the control or authenticated operator lifecycle socket.
func (m *signerKeyManagerV2) PutApplicationNetworkV2(walletID string, request signerNetworkPutRequestV2) (signerNetworkSummaryV2, error) {
	if request.ExpectedVersion == nil {
		return signerNetworkSummaryV2{}, errors.New("expectedVersion is required")
	}
	if request.ExecutionFallbackRPCURL != "" || request.VerificationRPCURL != "" || request.LegacyFallbackRPCURL != "" {
		return signerNetworkSummaryV2{}, errors.New("application network activation accepts exactly one primaryRpcUrl")
	}
	if *request.ExpectedVersion != 0 {
		return signerNetworkSummaryV2{}, errors.New("application network broker is limited to initial network activation; use the signer lifecycle socket for replacements")
	}
	walletID = normalizeWalletID(walletID)
	wallet, err := m.PublicRecord(walletID)
	if err != nil {
		return signerNetworkSummaryV2{}, err
	}
	if wallet.RetiredAt != "" {
		return signerNetworkSummaryV2{}, errors.New("signer wallet is permanently retired")
	}
	policy, err := m.store.getPolicy(walletID)
	if err != nil {
		return signerNetworkSummaryV2{}, err
	}
	if policy.Role != "agent" && policy.Role != "mining" && policy.Role != "vault" && policy.Role != "profile" && policy.Role != "strategy" {
		return signerNetworkSummaryV2{}, errors.New("signer wallet role is invalid")
	}
	freshDenyAll := policy.Version == 1 && policy.BaselineVersion == 0 &&
		len(policy.Operations) == 0 && len(policy.Programs) == 0 && len(policy.Assets) == 0
	baseline, baselineErr := compileSignerRoleBaselineV1(
		walletID,
		wallet.PublicKey,
		signerRoleBaselineRequestV1{Version: signerRoleBaselineVersionV1, Role: policy.Role},
		signerRoleBaselineRuntimeFromEnvV1(),
	)
	freshRoleBaseline := false
	if baselineErr == nil {
		baseline.Version = policy.Version
		if normalized, normalizeErr := normalizeSignerPolicyV2(baseline); normalizeErr == nil {
			freshRoleBaseline = policy.Version == 1 && policy.Hash == normalized.Hash
		}
	}
	if !freshDenyAll && !freshRoleBaseline {
		return signerNetworkSummaryV2{}, errors.New("initial application network activation requires a fresh deny-all wallet or exact signer-owned role baseline")
	}
	return m.PutNetworkV2(walletID, request)
}

func (m *signerKeyManagerV2) getNetworkRecordV2(walletID string) (signerNetworkRecordV2, error) {
	if m == nil || m.store == nil || m.store.db == nil {
		return signerNetworkRecordV2{}, errors.New("signer state database is unavailable")
	}
	walletID = normalizeWalletID(walletID)
	var record signerNetworkRecordV2
	err := m.store.db.View(func(tx *bolt.Tx) error {
		if tx.Bucket(bucketSignerWalletsV2).Get([]byte(walletID)) == nil {
			return errors.New("signer wallet not found")
		}
		raw := tx.Bucket(bucketSignerNetworksV2).Get([]byte(walletID))
		if raw == nil {
			return errSignerNetworkNotConfiguredV2
		}
		if err := decodeSignerNetworkRecordV2(raw, &record); err != nil || record.WalletID != walletID {
			return errSignerNetworkRecordInvalidV2
		}
		return nil
	})
	return record, err
}

func (m *signerKeyManagerV2) persistSignerNetworkGenesisV2(
	expected signerNetworkRecordV2,
	config signerNetworkSecretV2,
) (signerNetworkRecordV2, error) {
	if config.GenesisHash == "" {
		return signerNetworkRecordV2{}, errors.New("signer network genesis hash is required for migration")
	}
	if expected.Version == math.MaxUint64 {
		return signerNetworkRecordV2{}, errors.New("signer network version is exhausted")
	}
	updated, err := m.encryptNetworkRecordV2(expected.WalletID, expected.Version+1, config)
	if err != nil {
		return signerNetworkRecordV2{}, err
	}
	err = m.store.db.Update(func(tx *bolt.Tx) error {
		networks := tx.Bucket(bucketSignerNetworksV2)
		raw := networks.Get([]byte(expected.WalletID))
		if raw == nil {
			return errSignerNetworkChangedV2
		}
		var current signerNetworkRecordV2
		if err := decodeSignerNetworkRecordV2(raw, &current); err != nil || current != expected {
			return errSignerNetworkChangedV2
		}
		encoded, err := json.Marshal(updated)
		if err != nil {
			return errors.New("encode migrated signer network record")
		}
		return networks.Put([]byte(updated.WalletID), encoded)
	})
	if err != nil {
		return signerNetworkRecordV2{}, err
	}
	return updated, nil
}

func decodeSignerNetworkRecordV2(raw []byte, record *signerNetworkRecordV2) error {
	if record == nil || len(raw) == 0 || len(raw) > maxSignerNetworkRecordBytesV2 {
		return errors.New("invalid signer network record size")
	}
	*record = signerNetworkRecordV2{}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(record); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("invalid trailing signer network record data")
	}
	return validateSignerNetworkRecordMetadataV2(*record)
}

func validateSignerNetworkRecordMetadataV2(record signerNetworkRecordV2) error {
	if record.WalletID == "" || len(record.WalletID) > 64 || normalizeWalletID(record.WalletID) != record.WalletID || record.Version == 0 {
		return errors.New("invalid signer network record metadata")
	}
	if !isValidSignerNetworkHashV2(record.Hash) {
		return errors.New("invalid signer network record hash")
	}
	if _, err := time.Parse(time.RFC3339Nano, record.UpdatedAt); err != nil {
		return errors.New("invalid signer network record timestamp")
	}
	if len(record.Nonce) == 0 || len(record.Nonce) > 64 || len(record.Secret) == 0 || len(record.Secret) > maxSignerNetworkRecordBytesV2 {
		return errors.New("invalid signer network encrypted record")
	}
	return nil
}

func isValidSignerNetworkHashV2(hash string) bool {
	const hashPrefix = "hmac-sha256:"
	if !strings.HasPrefix(hash, hashPrefix) {
		return false
	}
	hashHex := strings.TrimPrefix(hash, hashPrefix)
	if len(hashHex) != sha256.Size*2 || hashHex != strings.ToLower(hashHex) {
		return false
	}
	digest, err := hex.DecodeString(hashHex)
	if err != nil || len(digest) != sha256.Size {
		return false
	}
	zeroBytes(digest)
	return true
}

func validateSignerNetworkSummaryV2(summary signerNetworkSummaryV2, expectedWalletID string) error {
	if summary.WalletID == "" || len(summary.WalletID) > 64 || normalizeWalletID(summary.WalletID) != summary.WalletID || summary.WalletID != normalizeWalletID(expectedWalletID) {
		return errors.New("invalid signer network summary wallet")
	}
	if !summary.Configured {
		if summary.Ready || summary.Version != 0 || summary.Hash != "" {
			return errors.New("invalid unconfigured signer network summary")
		}
		return nil
	}
	if summary.Version == 0 {
		if summary.Ready || summary.Hash != "" {
			return errors.New("invalid pending signer network summary")
		}
		return nil
	}
	if !isValidSignerNetworkHashV2(summary.Hash) {
		return errors.New("invalid signer network summary hash")
	}
	return nil
}

func (m *signerKeyManagerV2) NetworkSummaryV2(walletID string) (signerNetworkSummaryV2, error) {
	walletID = normalizeWalletID(walletID)
	record, err := m.getNetworkRecordV2(walletID)
	if errors.Is(err, errSignerNetworkNotConfiguredV2) {
		return signerNetworkSummaryV2{WalletID: walletID, Configured: false, Ready: false}, nil
	}
	if errors.Is(err, errSignerNetworkRecordInvalidV2) {
		return signerNetworkSummaryV2{WalletID: walletID, Configured: true, Ready: false}, nil
	}
	if err != nil {
		return signerNetworkSummaryV2{}, err
	}
	summary := signerNetworkSummaryV2{
		WalletID:   walletID,
		Configured: true,
		Version:    record.Version,
		Hash:       record.Hash,
		Ready:      false,
	}
	if config, err := m.decryptNetworkRecordV2(record); err == nil {
		hadPinnedGenesis := config.GenesisHash != ""
		if verified, err := m.ensureSignerExecutionGenesisV2(config); err == nil {
			if !hadPinnedGenesis {
				migrationConfig := config
				migrationConfig.GenesisHash = verified.GenesisHash
				if migrated, migrateErr := m.persistSignerNetworkGenesisV2(record, migrationConfig); migrateErr == nil {
					summary.Version = migrated.Version
					summary.Hash = migrated.Hash
				} else if errors.Is(migrateErr, errSignerNetworkChangedV2) {
					current, currentErr := m.getNetworkRecordV2(walletID)
					if currentErr != nil {
						return summary, nil
					}
					currentConfig, currentErr := m.decryptNetworkRecordV2(current)
					if currentErr != nil {
						return summary, nil
					}
					if _, currentErr = m.ensureSignerExecutionGenesisV2(currentConfig); currentErr != nil {
						return summary, nil
					}
					summary.Version = current.Version
					summary.Hash = current.Hash
				} else {
					return summary, nil
				}
			}
			summary.Ready = true
		}
	}
	return summary, nil
}

// NetworkStoredSummaryV2 reports the last signer-verified network binding without
// making an external RPC call. Live readiness remains a per-wallet operation.
func (m *signerKeyManagerV2) NetworkStoredSummaryV2(walletID string) (signerNetworkSummaryV2, error) {
	walletID = normalizeWalletID(walletID)
	record, err := m.getNetworkRecordV2(walletID)
	if errors.Is(err, errSignerNetworkNotConfiguredV2) {
		return signerNetworkSummaryV2{WalletID: walletID, Configured: false, Ready: false}, nil
	}
	if errors.Is(err, errSignerNetworkRecordInvalidV2) {
		return signerNetworkSummaryV2{WalletID: walletID, Configured: true, Ready: false}, nil
	}
	if err != nil {
		return signerNetworkSummaryV2{}, err
	}
	summary := signerNetworkSummaryV2{
		WalletID:   walletID,
		Configured: true,
		Version:    record.Version,
		Hash:       record.Hash,
	}
	config, decryptErr := m.decryptNetworkRecordV2(record)
	summary.Ready = decryptErr == nil && strings.TrimSpace(config.GenesisHash) != ""
	return summary, nil
}

func (m *signerKeyManagerV2) NetworkStoredHealthV2() (signerNetworkHealthV2, error) {
	if m == nil || m.store == nil || m.store.db == nil {
		return signerNetworkHealthV2{}, errors.New("signer state database is unavailable")
	}
	walletIDs := []string{}
	if err := m.store.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSignerWalletsV2).ForEach(func(walletID, value []byte) error {
			if value != nil {
				walletIDs = append(walletIDs, string(walletID))
			}
			return nil
		})
	}); err != nil {
		return signerNetworkHealthV2{}, err
	}
	sort.Strings(walletIDs)
	health := signerNetworkHealthV2{Ready: true, Wallets: make([]signerNetworkSummaryV2, 0, len(walletIDs))}
	for _, walletID := range walletIDs {
		summary, err := m.NetworkStoredSummaryV2(walletID)
		if err != nil {
			return signerNetworkHealthV2{}, err
		}
		if !summary.Ready {
			health.Ready = false
		}
		health.Wallets = append(health.Wallets, summary)
	}
	return health, nil
}

func (m *signerKeyManagerV2) NetworkHealthV2() (signerNetworkHealthV2, error) {
	if m == nil || m.store == nil || m.store.db == nil {
		return signerNetworkHealthV2{}, errors.New("signer state database is unavailable")
	}
	walletIDs := []string{}
	if err := m.store.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSignerWalletsV2).ForEach(func(walletID, value []byte) error {
			if value != nil {
				walletIDs = append(walletIDs, string(walletID))
			}
			return nil
		})
	}); err != nil {
		return signerNetworkHealthV2{}, err
	}
	sort.Strings(walletIDs)
	health := signerNetworkHealthV2{Ready: true, Wallets: make([]signerNetworkSummaryV2, 0, len(walletIDs))}
	for _, walletID := range walletIDs {
		summary, err := m.NetworkSummaryV2(walletID)
		if err != nil {
			return signerNetworkHealthV2{}, err
		}
		if !summary.Ready {
			health.Ready = false
		}
		health.Wallets = append(health.Wallets, summary)
	}
	return health, nil
}

func (m *signerKeyManagerV2) SolanaRPCURLsV2(walletID string) ([]string, error) {
	return m.SolanaExecutionRPCURLsV2(walletID)
}

func (m *signerKeyManagerV2) SolanaNetworkV2(walletID string) (signerNetworkSecretV2, error) {
	record, err := m.getNetworkRecordV2(walletID)
	if err != nil {
		return signerNetworkSecretV2{}, errSignerNetworkPendingV2
	}
	config, err := m.decryptNetworkRecordV2(record)
	if err != nil {
		return signerNetworkSecretV2{}, errSignerNetworkPendingV2
	}
	hadPinnedGenesis := config.GenesisHash != ""
	verified, err := m.ensureSignerExecutionGenesisV2(config)
	if err != nil {
		return signerNetworkSecretV2{}, errSignerNetworkPendingV2
	}
	if !hadPinnedGenesis {
		migrationConfig := config
		migrationConfig.GenesisHash = verified.GenesisHash
		if _, err := m.persistSignerNetworkGenesisV2(record, migrationConfig); err != nil {
			if !errors.Is(err, errSignerNetworkChangedV2) {
				return signerNetworkSecretV2{}, errSignerNetworkPendingV2
			}
			current, currentErr := m.getNetworkRecordV2(walletID)
			if currentErr != nil {
				return signerNetworkSecretV2{}, errSignerNetworkPendingV2
			}
			currentConfig, currentErr := m.decryptNetworkRecordV2(current)
			if currentErr != nil {
				return signerNetworkSecretV2{}, errSignerNetworkPendingV2
			}
			verified, currentErr = m.ensureSignerExecutionGenesisV2(currentConfig)
			if currentErr != nil {
				return signerNetworkSecretV2{}, errSignerNetworkPendingV2
			}
		}
	}
	return verified, nil
}

func (m *signerKeyManagerV2) SolanaExecutionRPCURLsV2(walletID string) ([]string, error) {
	config, err := m.SolanaNetworkV2(walletID)
	if err != nil {
		return nil, err
	}
	urls := []string{config.PrimaryRPCURL}
	if config.ExecutionFallbackRPCURL != "" {
		urls = append(urls, config.ExecutionFallbackRPCURL)
	}
	return urls, nil
}
