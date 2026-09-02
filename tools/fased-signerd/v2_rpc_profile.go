package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

const (
	signerRPCProfileCommitmentV1   = "finalized"
	maxSignerRPCProfilesV1         = 32
	maxSignerRPCProfileRecordBytes = 32 * 1024
)

var signerRPCProfileIDPatternV1 = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`)

type signerRPCProfileCreateRequestV1 struct {
	ProfileID               string `json:"profileId"`
	Name                    string `json:"name"`
	PrimaryRPCURL           string `json:"primaryRpcUrl"`
	WebSocketRPCURL         string `json:"websocketRpcUrl,omitempty"`
	ExecutionFallbackRPCURL string `json:"executionFallbackRpcUrl,omitempty"`
	VerificationRPCURL      string `json:"verificationRpcUrl,omitempty"`
	Commitment              string `json:"commitment"`
}

type signerRPCProfileGetRequestV1 struct {
	ProfileID string `json:"profileId"`
}

type signerRPCProfileBindRequestV1 struct {
	ProfileID              string `json:"profileId"`
	ExpectedProfileVersion uint64 `json:"expectedProfileVersion"`
	ExpectedProfileHash    string `json:"expectedProfileHash"`
	ExpectedNetworkVersion uint64 `json:"expectedNetworkVersion"`
}

type signerRPCProfileSecretV1 struct {
	SchemaVersion           uint8  `json:"schemaVersion"`
	PrimaryRPCURL           string `json:"primaryRpcUrl"`
	WebSocketRPCURL         string `json:"websocketRpcUrl,omitempty"`
	ExecutionFallbackRPCURL string `json:"executionFallbackRpcUrl,omitempty"`
	VerificationRPCURL      string `json:"verificationRpcUrl,omitempty"`
	GenesisHash             string `json:"genesisHash"`
}

type signerRPCProfileRecordV1 struct {
	ProfileID   string `json:"profileId"`
	Name        string `json:"name"`
	Version     uint64 `json:"version"`
	Hash        string `json:"hash"`
	GenesisHash string `json:"genesisHash"`
	Commitment  string `json:"commitment"`
	UpdatedAt   string `json:"updatedAt"`
	Nonce       string `json:"nonce"`
	Secret      string `json:"secret"`
}

type signerRPCProfileSummaryV1 struct {
	ProfileID     string `json:"profileId"`
	Name          string `json:"name"`
	Chain         string `json:"chain"`
	Cluster       string `json:"cluster"`
	GenesisHash   string `json:"genesisHash"`
	Commitment    string `json:"commitment"`
	Version       uint64 `json:"version"`
	Hash          string `json:"hash"`
	EndpointCount int    `json:"endpointCount"`
	Ready         bool   `json:"ready"`
}

type signerRPCProfileBindingSummaryV1 struct {
	WalletID       string `json:"walletId"`
	ProfileID      string `json:"profileId"`
	ProfileVersion uint64 `json:"profileVersion"`
	ProfileHash    string `json:"profileHash"`
	NetworkVersion uint64 `json:"networkVersion"`
	NetworkHash    string `json:"networkHash"`
	GenesisHash    string `json:"genesisHash"`
	Ready          bool   `json:"ready"`
}

func signerRPCProfileStorageKeyV1(profileID string) []byte {
	return []byte("rpc-profile/" + profileID)
}

func normalizeSignerRPCProfileIDV1(raw string) (string, error) {
	profileID := strings.ToLower(strings.TrimSpace(raw))
	if !signerRPCProfileIDPatternV1.MatchString(profileID) {
		return "", errors.New("RPC profileId must contain 1-64 lowercase letters, numbers, or interior hyphens")
	}
	return profileID, nil
}

func normalizeSignerRPCProfileNameV1(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || len(name) > 80 || strings.ContainsAny(name, "\r\n\t\x00") {
		return "", errors.New("RPC profile name must contain 1-80 safe characters")
	}
	return name, nil
}

func normalizeSignerWebSocketURLV1(raw, primary string) (string, error) {
	if raw == "" {
		return "", nil
	}
	if raw != strings.TrimSpace(raw) || len(raw) > maxSignerRPCURLBytesV2 {
		return "", errors.New("websocketRpcUrl is invalid")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return "", errors.New("websocketRpcUrl must be an absolute WSS URL")
	}
	originalScheme := strings.ToLower(parsed.Scheme)
	if originalScheme != "wss" && originalScheme != "ws" {
		return "", errors.New("websocketRpcUrl must use WSS")
	}
	parsed.Scheme = map[bool]string{true: "http", false: "https"}[originalScheme == "ws"]
	httpEquivalent, err := normalizeSignerRPCURLV2(parsed.String(), "websocketRpcUrl")
	if err != nil {
		return "", err
	}
	if !sameSignerRPCOriginV2(primary, httpEquivalent) {
		return "", errors.New("websocketRpcUrl must use the primaryRpcUrl origin")
	}
	canonical, _ := url.Parse(httpEquivalent)
	canonical.Scheme = originalScheme
	return canonical.String(), nil
}

func normalizeSignerRPCProfileInputV1(input signerRPCProfileCreateRequestV1) (string, string, signerRPCProfileSecretV1, error) {
	profileID, err := normalizeSignerRPCProfileIDV1(input.ProfileID)
	if err != nil {
		return "", "", signerRPCProfileSecretV1{}, err
	}
	name, err := normalizeSignerRPCProfileNameV1(input.Name)
	if err != nil {
		return "", "", signerRPCProfileSecretV1{}, err
	}
	if input.Commitment != signerRPCProfileCommitmentV1 {
		return "", "", signerRPCProfileSecretV1{}, errors.New("Solana RPC profiles require finalized commitment")
	}
	network, err := normalizeSignerNetworkInputV2(signerNetworkPutRequestV2{
		PrimaryRPCURL: input.PrimaryRPCURL, ExecutionFallbackRPCURL: input.ExecutionFallbackRPCURL,
		VerificationRPCURL: input.VerificationRPCURL,
	})
	if err != nil {
		return "", "", signerRPCProfileSecretV1{}, err
	}
	websocket, err := normalizeSignerWebSocketURLV1(input.WebSocketRPCURL, network.PrimaryRPCURL)
	if err != nil {
		return "", "", signerRPCProfileSecretV1{}, err
	}
	return profileID, name, signerRPCProfileSecretV1{
		SchemaVersion: 1, PrimaryRPCURL: network.PrimaryRPCURL, WebSocketRPCURL: websocket,
		ExecutionFallbackRPCURL: network.ExecutionFallbackRPCURL, VerificationRPCURL: network.VerificationRPCURL,
	}, nil
}

func signerRPCProfileAADV1(record signerRPCProfileRecordV1) []byte {
	return []byte(fmt.Sprintf("fased-signerd:v1:rpc-profile:%s:%s:%d:%s:%s:%s:%s", record.ProfileID, record.Name, record.Version, record.Hash, record.GenesisHash, record.Commitment, record.UpdatedAt))
}

func (m *signerKeyManagerV2) encryptRPCProfileV1(profileID, name string, secret signerRPCProfileSecretV1) (signerRPCProfileRecordV1, error) {
	hash, err := signerNetworkPayloadHashV2(m.masterKey, "rpc-profile:"+profileID, secret)
	if err != nil {
		return signerRPCProfileRecordV1{}, err
	}
	record := signerRPCProfileRecordV1{ProfileID: profileID, Name: name, Version: 1, Hash: hash, GenesisHash: secret.GenesisHash, Commitment: signerRPCProfileCommitmentV1, UpdatedAt: timestampV2(m.store.now())}
	plaintext, err := json.Marshal(secret)
	if err != nil {
		return signerRPCProfileRecordV1{}, errors.New("encode RPC profile")
	}
	defer zeroBytes(plaintext)
	key, err := deriveSignerNetworkKeyV2(m.masterKey, "rpc-profile-encryption")
	if err != nil {
		return signerRPCProfileRecordV1{}, err
	}
	defer zeroBytes(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return signerRPCProfileRecordV1{}, errors.New("initialize RPC profile encryption")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return signerRPCProfileRecordV1{}, errors.New("initialize RPC profile authenticated encryption")
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return signerRPCProfileRecordV1{}, errors.New("generate RPC profile nonce")
	}
	defer zeroBytes(nonce)
	ciphertext := gcm.Seal(nil, nonce, plaintext, signerRPCProfileAADV1(record))
	record.Nonce = base64.RawURLEncoding.EncodeToString(nonce)
	record.Secret = base64.RawURLEncoding.EncodeToString(ciphertext)
	zeroBytes(ciphertext)
	return record, nil
}

func (m *signerKeyManagerV2) decryptRPCProfileV1(record signerRPCProfileRecordV1) (signerRPCProfileSecretV1, error) {
	if err := validateSignerRPCProfileRecordV1(record); err != nil {
		return signerRPCProfileSecretV1{}, err
	}
	nonce, err := base64.RawURLEncoding.DecodeString(record.Nonce)
	if err != nil {
		return signerRPCProfileSecretV1{}, errors.New("invalid RPC profile nonce")
	}
	defer zeroBytes(nonce)
	ciphertext, err := base64.RawURLEncoding.DecodeString(record.Secret)
	if err != nil {
		return signerRPCProfileSecretV1{}, errors.New("invalid RPC profile encrypted state")
	}
	defer zeroBytes(ciphertext)
	key, err := deriveSignerNetworkKeyV2(m.masterKey, "rpc-profile-encryption")
	if err != nil {
		return signerRPCProfileSecretV1{}, err
	}
	defer zeroBytes(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return signerRPCProfileSecretV1{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil || len(nonce) != gcm.NonceSize() || len(ciphertext) < gcm.Overhead() {
		return signerRPCProfileSecretV1{}, errors.New("invalid RPC profile encrypted state")
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, signerRPCProfileAADV1(record))
	if err != nil {
		return signerRPCProfileSecretV1{}, errors.New("RPC profile authentication failed")
	}
	defer zeroBytes(plaintext)
	var secret signerRPCProfileSecretV1
	decoder := json.NewDecoder(bytes.NewReader(plaintext))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&secret); err != nil || secret.SchemaVersion != 1 {
		return signerRPCProfileSecretV1{}, errors.New("invalid RPC profile payload")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return signerRPCProfileSecretV1{}, errors.New("invalid RPC profile payload")
	}
	expected, err := signerNetworkPayloadHashV2(m.masterKey, "rpc-profile:"+record.ProfileID, secret)
	if err != nil || subtle.ConstantTimeCompare([]byte(expected), []byte(record.Hash)) != 1 {
		return signerRPCProfileSecretV1{}, errors.New("RPC profile hash mismatch")
	}
	return secret, nil
}

func validateSignerRPCProfileRecordV1(record signerRPCProfileRecordV1) error {
	if _, err := normalizeSignerRPCProfileIDV1(record.ProfileID); err != nil || record.Version != 1 || record.Commitment != signerRPCProfileCommitmentV1 || !isValidSignerNetworkHashV2(record.Hash) {
		return errors.New("invalid RPC profile metadata")
	}
	if _, err := normalizeSignerRPCProfileNameV1(record.Name); err != nil {
		return errors.New("invalid RPC profile metadata")
	}
	if _, err := normalizeSignerGenesisHashV2(record.GenesisHash); err != nil {
		return errors.New("invalid RPC profile genesis hash")
	}
	if _, err := time.Parse(time.RFC3339Nano, record.UpdatedAt); err != nil || record.Nonce == "" || record.Secret == "" {
		return errors.New("invalid RPC profile record")
	}
	return nil
}

func signerRPCProfileClusterV1(genesis string) string {
	switch genesis {
	case solanaMainnetGenesisHashV2:
		return "mainnet-beta"
	case solanaDevnetGenesisHashV2:
		return "devnet"
	default:
		return "custom"
	}
}

func signerRPCProfileSummaryFromRecordV1(record signerRPCProfileRecordV1, secret signerRPCProfileSecretV1) signerRPCProfileSummaryV1 {
	count := 1
	for _, endpoint := range []string{secret.WebSocketRPCURL, secret.ExecutionFallbackRPCURL, secret.VerificationRPCURL} {
		if endpoint != "" {
			count++
		}
	}
	return signerRPCProfileSummaryV1{ProfileID: record.ProfileID, Name: record.Name, Chain: "solana", Cluster: signerRPCProfileClusterV1(record.GenesisHash), GenesisHash: record.GenesisHash, Commitment: record.Commitment, Version: record.Version, Hash: record.Hash, EndpointCount: count, Ready: true}
}

func (m *signerKeyManagerV2) CreateRPCProfileV1(input signerRPCProfileCreateRequestV1) (signerRPCProfileSummaryV1, error) {
	if m == nil || m.store == nil || m.store.db == nil {
		return signerRPCProfileSummaryV1{}, errors.New("signer state database is unavailable")
	}
	profileID, name, secret, err := normalizeSignerRPCProfileInputV1(input)
	if err != nil {
		return signerRPCProfileSummaryV1{}, err
	}
	verified, err := m.verifySignerNetworkGenesisV2(signerNetworkSecretV2{SchemaVersion: 2, PrimaryRPCURL: secret.PrimaryRPCURL, ExecutionFallbackRPCURL: secret.ExecutionFallbackRPCURL, VerificationRPCURL: secret.VerificationRPCURL})
	if err != nil {
		return signerRPCProfileSummaryV1{}, err
	}
	secret.GenesisHash = verified.GenesisHash
	record, err := m.encryptRPCProfileV1(profileID, name, secret)
	if err != nil {
		return signerRPCProfileSummaryV1{}, err
	}
	err = m.store.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSignerNetworksV2)
		key := signerRPCProfileStorageKeyV1(profileID)
		if bucket.Get(key) != nil {
			return errors.New("RPC profile already exists; create a new versioned profile name")
		}
		prefix := []byte("rpc-profile/")
		count := 0
		cursor := bucket.Cursor()
		for existing, _ := cursor.Seek(prefix); existing != nil && bytes.HasPrefix(existing, prefix); existing, _ = cursor.Next() {
			count++
		}
		if count >= maxSignerRPCProfilesV1 {
			return fmt.Errorf("RPC profile limit reached (%d)", maxSignerRPCProfilesV1)
		}
		encoded, err := json.Marshal(record)
		if err != nil {
			return errors.New("encode RPC profile record")
		}
		if len(encoded) > maxSignerRPCProfileRecordBytes {
			return errors.New("RPC profile record exceeds size limit")
		}
		return bucket.Put(key, encoded)
	})
	if err != nil {
		return signerRPCProfileSummaryV1{}, err
	}
	return signerRPCProfileSummaryFromRecordV1(record, secret), nil
}

func (m *signerKeyManagerV2) getRPCProfileV1(profileID string) (signerRPCProfileRecordV1, signerRPCProfileSecretV1, error) {
	profileID, err := normalizeSignerRPCProfileIDV1(profileID)
	if err != nil {
		return signerRPCProfileRecordV1{}, signerRPCProfileSecretV1{}, err
	}
	var record signerRPCProfileRecordV1
	err = m.store.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSignerNetworksV2).Get(signerRPCProfileStorageKeyV1(profileID))
		if raw == nil {
			return errors.New("RPC profile not found")
		}
		if len(raw) > maxSignerRPCProfileRecordBytes {
			return errors.New("invalid stored RPC profile")
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&record); err != nil {
			return errors.New("invalid stored RPC profile")
		}
		var trailing any
		if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
			return errors.New("invalid stored RPC profile")
		}
		return nil
	})
	if err != nil {
		return signerRPCProfileRecordV1{}, signerRPCProfileSecretV1{}, err
	}
	secret, err := m.decryptRPCProfileV1(record)
	return record, secret, err
}

func (m *signerKeyManagerV2) RPCProfileSummaryV1(profileID string) (signerRPCProfileSummaryV1, error) {
	record, secret, err := m.getRPCProfileV1(profileID)
	if err != nil {
		return signerRPCProfileSummaryV1{}, err
	}
	return signerRPCProfileSummaryFromRecordV1(record, secret), nil
}

func (m *signerKeyManagerV2) ListRPCProfilesV1() ([]signerRPCProfileSummaryV1, error) {
	profileIDs := []string{}
	err := m.store.db.View(func(tx *bolt.Tx) error {
		prefix := []byte("rpc-profile/")
		cursor := tx.Bucket(bucketSignerNetworksV2).Cursor()
		for key, _ := cursor.Seek(prefix); key != nil && bytes.HasPrefix(key, prefix); key, _ = cursor.Next() {
			profileIDs = append(profileIDs, strings.TrimPrefix(string(key), string(prefix)))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(profileIDs)
	result := make([]signerRPCProfileSummaryV1, 0, len(profileIDs))
	for _, profileID := range profileIDs {
		summary, err := m.RPCProfileSummaryV1(profileID)
		if err != nil {
			return nil, err
		}
		result = append(result, summary)
	}
	return result, nil
}

func (m *signerKeyManagerV2) BindRPCProfileV1(walletID string, input signerRPCProfileBindRequestV1) (signerRPCProfileBindingSummaryV1, error) {
	record, secret, err := m.getRPCProfileV1(input.ProfileID)
	if err != nil {
		return signerRPCProfileBindingSummaryV1{}, err
	}
	if input.ExpectedProfileVersion != record.Version || subtle.ConstantTimeCompare([]byte(input.ExpectedProfileHash), []byte(record.Hash)) != 1 {
		return signerRPCProfileBindingSummaryV1{}, errors.New("RPC profile version/hash fence changed")
	}
	walletID = normalizeWalletID(walletID)
	verified, err := m.verifySignerNetworkGenesisV2(signerNetworkSecretV2{SchemaVersion: 2, PrimaryRPCURL: secret.PrimaryRPCURL, ExecutionFallbackRPCURL: secret.ExecutionFallbackRPCURL, VerificationRPCURL: secret.VerificationRPCURL})
	if err != nil {
		return signerRPCProfileBindingSummaryV1{}, err
	}
	if subtle.ConstantTimeCompare([]byte(verified.GenesisHash), []byte(record.GenesisHash)) != 1 {
		return signerRPCProfileBindingSummaryV1{}, errors.New("RPC profile no longer matches its pinned genesis hash")
	}
	expected := input.ExpectedNetworkVersion
	network, err := m.PutNetworkV2(walletID, signerNetworkPutRequestV2{ExpectedVersion: &expected, PrimaryRPCURL: verified.PrimaryRPCURL, ExecutionFallbackRPCURL: verified.ExecutionFallbackRPCURL, VerificationRPCURL: verified.VerificationRPCURL})
	if err != nil {
		return signerRPCProfileBindingSummaryV1{}, err
	}
	return signerRPCProfileBindingSummaryV1{WalletID: walletID, ProfileID: record.ProfileID, ProfileVersion: record.Version, ProfileHash: record.Hash, NetworkVersion: network.Version, NetworkHash: network.Hash, GenesisHash: record.GenesisHash, Ready: network.Ready}, nil
}
