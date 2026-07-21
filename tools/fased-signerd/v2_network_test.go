package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
)

func signerUint64PointerV2(value uint64) *uint64 {
	return &value
}

func TestSignerApplicationNetworkBrokerIsOneRPCRoleBoundAndGenesisPinned(t *testing.T) {
	_, keys := openTestSignerV2(t)
	if _, _, err := keys.CreateWithRoleBaseline(
		"agent",
		0,
		signerRoleBaselineRequestV1{Version: signerRoleBaselineVersionV1, Role: "agent"},
		signerRoleBaselineRuntimeV1{},
	); err != nil {
		t.Fatal(err)
	}
	genesis := solana.NewWallet().PublicKey().String()
	primaryA := "https://rpc-a.example/solana"
	primaryB := "https://rpc-b.example/solana"
	currentGenesis := genesis
	keys.genesisHash = func(string) (string, error) { return currentGenesis, nil }

	summary, err := keys.PutApplicationNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: primaryA,
	})
	if err != nil || !summary.Ready || summary.Version != 1 {
		t.Fatalf("initial one-RPC activation failed: summary=%#v err=%v", summary, err)
	}
	if _, err := keys.PutApplicationNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: primaryB,
		VerificationRPCURL: "https://witness.example/solana",
	}); err == nil || !strings.Contains(err.Error(), "exactly one") {
		t.Fatalf("application broker accepted witness/fallback input: %v", err)
	}
	currentGenesis = solana.NewWallet().PublicKey().String()
	if _, err := keys.PutApplicationNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: primaryB,
	}); err == nil || !strings.Contains(err.Error(), "pinned genesis") {
		t.Fatalf("application broker allowed a network change: %v", err)
	}
	ready, err := keys.NetworkSummaryV2("agent")
	if err != nil || ready.Version != 1 {
		t.Fatalf("rejected replacement mutated network state: summary=%#v err=%v", ready, err)
	}

	configuredPolicy := testSignerPolicyV2("configured_agent", solana.NewWallet().PublicKey().String(), 100, 1000)
	if _, _, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{WalletID: "configured_agent", ExpectedVersion: 0, Policy: configuredPolicy}); err != nil {
		t.Fatal(err)
	}
	currentGenesis = genesis
	if _, err := keys.PutApplicationNetworkV2("configured_agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: primaryA,
	}); err == nil || !strings.Contains(err.Error(), "exact signer-owned role baseline") {
		t.Fatalf("application broker activated a pre-expanded wallet: %v", err)
	}
}

func TestSignerMigratedNetworkRepairRequiresExactFencesAndRepinsOnceRequested(t *testing.T) {
	_, keys := openTestSignerV2(t)
	wallet, _, err := keys.CreateWithRoleBaseline(
		"legacy_agent",
		0,
		signerRoleBaselineRequestV1{Version: signerRoleBaselineVersionV1, Role: "agent"},
		signerRoleBaselineRuntimeV1{},
	)
	if err != nil {
		t.Fatal(err)
	}
	oldGenesis := solana.NewWallet().PublicKey().String()
	newGenesis := solana.NewWallet().PublicKey().String()
	keys.genesisHash = func(endpoint string) (string, error) {
		if strings.Contains(endpoint, "new.example") {
			return newGenesis, nil
		}
		return oldGenesis, nil
	}
	initial, err := keys.PutApplicationNetworkV2("legacy_agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: "https://old.example/rpc",
	})
	if err != nil {
		t.Fatal(err)
	}
	request := signerMigratedNetworkRepairRequestV1{
		ExpectedVersion: initial.Version, ExpectedHash: initial.Hash, ExpectedPublicKey: wallet.PublicKey,
		MigrationSource: "embedded-keystore", PrimaryRPCURL: "https://new.example/rpc",
	}
	bad := request
	bad.ExpectedPublicKey = solana.NewWallet().PublicKey().String()
	if _, err := keys.RepairMigratedPrimaryNetworkV1("legacy_agent", bad); err == nil || !strings.Contains(err.Error(), "public key mismatch") {
		t.Fatalf("repair accepted the wrong wallet fence: %v", err)
	}
	unchanged, err := keys.NetworkStoredSummaryV2("legacy_agent")
	if err != nil || unchanged.Version != initial.Version || unchanged.Hash != initial.Hash {
		t.Fatalf("rejected repair mutated network state: summary=%#v err=%v", unchanged, err)
	}
	repaired, err := keys.RepairMigratedPrimaryNetworkV1("legacy_agent", request)
	if err != nil || !repaired.Ready || repaired.Version != initial.Version+1 || repaired.Hash == initial.Hash {
		t.Fatalf("exact migrated repair failed: summary=%#v err=%v", repaired, err)
	}
	if _, err := keys.RepairMigratedPrimaryNetworkV1("legacy_agent", request); err == nil || !strings.Contains(err.Error(), "state changed") {
		t.Fatalf("stale migrated repair was accepted: %v", err)
	}
	if _, err := keys.PutApplicationNetworkV2("legacy_agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(repaired.Version), PrimaryRPCURL: "https://old.example/rpc",
	}); err == nil || !strings.Contains(err.Error(), "pinned genesis") {
		t.Fatalf("ordinary application edit changed the repaired genesis: %v", err)
	}
}

func encryptLegacySignerNetworkRecordForTestV2(t *testing.T, keys *signerKeyManagerV2, walletID string, version uint64, config signerLegacyNetworkSecretV2) signerNetworkRecordV2 {
	t.Helper()
	hash, err := signerNetworkPayloadHashV2(keys.masterKey, walletID, config)
	if err != nil {
		t.Fatal(err)
	}
	record := signerNetworkRecordV2{
		WalletID: normalizeWalletID(walletID), Version: version, Hash: hash,
		UpdatedAt: timestampV2(keys.store.now()),
	}
	plaintext, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	key, err := deriveSignerNetworkKeyV2(keys.masterKey, "encryption")
	if err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	var gcm cipher.AEAD
	gcm, err = cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	ciphertext := gcm.Seal(nil, nonce, plaintext, signerNetworkAADV2(record))
	record.Nonce = base64.RawURLEncoding.EncodeToString(nonce)
	record.Secret = base64.RawURLEncoding.EncodeToString(ciphertext)
	return record
}

func TestSignerNetworkLegacyFallbackMigratesOnlyAsExecutionFallback(t *testing.T) {
	store, keys := openTestSignerV2(t)
	createTestSignerWalletV2(t, store, keys, "agent", solana.NewWallet().PublicKey().String(), 100, 1000)
	record := encryptLegacySignerNetworkRecordForTestV2(t, keys, "agent", 1, signerLegacyNetworkSecretV2{
		PrimaryRPCURL: "https://primary.example/rpc", FallbackRPCURL: "https://backup.example/rpc",
	})
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSignerNetworksV2).Put([]byte("agent"), encoded)
	}); err != nil {
		t.Fatal(err)
	}
	config, err := keys.SolanaNetworkV2("agent")
	if err != nil {
		t.Fatalf("read legacy network record: %v", err)
	}
	if config.ExecutionFallbackRPCURL != "https://backup.example/rpc" || config.VerificationRPCURL != "" || config.SchemaVersion != 2 || config.GenesisHash == "" {
		t.Fatalf("legacy fallback was not migrated strictly as execution fallback: %#v", config)
	}
	migratedSummary, err := keys.NetworkSummaryV2("agent")
	if err != nil || !migratedSummary.Ready || migratedSummary.Version != 2 {
		t.Fatalf("legacy network genesis pin was not durably migrated: summary=%#v err=%v", migratedSummary, err)
	}
	if _, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(2), PrimaryRPCURL: config.PrimaryRPCURL,
		ExecutionFallbackRPCURL: config.ExecutionFallbackRPCURL,
	}); err != nil {
		t.Fatalf("rewrite migrated network record: %v", err)
	}
}

func TestSignerApplicationNetworkBrokerPinsLegacyGenesisBeforeReplacement(t *testing.T) {
	store, keys := openTestSignerV2(t)
	createTestSignerWalletV2(t, store, keys, "legacy_agent", solana.NewWallet().PublicKey().String(), 100, 1000)
	legacyPrimary := "https://legacy-primary.example/rpc"
	replacementPrimary := "https://replacement.example/rpc"
	record := encryptLegacySignerNetworkRecordForTestV2(t, keys, "legacy_agent", 1, signerLegacyNetworkSecretV2{
		PrimaryRPCURL: legacyPrimary,
	})
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSignerNetworksV2).Put([]byte("legacy_agent"), encoded)
	}); err != nil {
		t.Fatal(err)
	}
	legacyGenesis := solana.NewWallet().PublicKey().String()
	replacementGenesis := solana.NewWallet().PublicKey().String()
	keys.genesisHash = func(rpcURL string) (string, error) {
		switch rpcURL {
		case legacyPrimary:
			return legacyGenesis, nil
		case replacementPrimary:
			return replacementGenesis, nil
		default:
			return "", errors.New("unexpected RPC")
		}
	}

	if _, err := keys.PutApplicationNetworkV2("legacy_agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: replacementPrimary,
	}); err == nil || !strings.Contains(err.Error(), "pinned genesis") {
		t.Fatalf("application broker repinned an unmigrated legacy wallet: %v", err)
	}
	stored, err := keys.getNetworkRecordV2("legacy_agent")
	if err != nil || stored.Version != 1 || stored.Hash != record.Hash {
		t.Fatalf("rejected legacy replacement mutated state: stored=%#v err=%v", stored, err)
	}

	replacementGenesis = legacyGenesis
	summary, err := keys.PutApplicationNetworkV2("legacy_agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: replacementPrimary,
	})
	if err != nil || !summary.Ready || summary.Version != 2 {
		t.Fatalf("same-genesis legacy replacement failed: summary=%#v err=%v", summary, err)
	}
}

func TestSignerNetworkPutRejectsCrossGenesisExecutionFallbackBeforeReady(t *testing.T) {
	store, keys := openTestSignerV2(t)
	createTestSignerWalletV2(t, store, keys, "agent", solana.NewWallet().PublicKey().String(), 100, 1000)
	primary := "https://primary.example/solana?token=primary-secret"
	fallback := "https://fallback.example/solana?token=fallback-secret"
	keys.genesisHash = func(rpcURL string) (string, error) {
		switch rpcURL {
		case primary:
			return "11111111111111111111111111111111", nil
		case fallback:
			return solana.NewWallet().PublicKey().String(), nil
		default:
			return "", errors.New("unexpected RPC")
		}
	}

	_, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion:         signerUint64PointerV2(0),
		PrimaryRPCURL:           primary,
		ExecutionFallbackRPCURL: fallback,
	})
	if err == nil || !strings.Contains(err.Error(), "disagree on genesis hash") {
		t.Fatalf("cross-genesis execution fallback was not rejected: %v", err)
	}
	for _, secret := range []string{primary, fallback, "primary-secret", "fallback-secret"} {
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("cross-genesis error leaked RPC material %q: %v", secret, err)
		}
	}
	summary, summaryErr := keys.NetworkSummaryV2("agent")
	if summaryErr != nil || summary.Configured || summary.Ready {
		t.Fatalf("rejected cross-genesis network became configured: summary=%#v err=%v", summary, summaryErr)
	}
}

func TestSignerNetworkPutPinsMatchingGenesisForExecutionAndVerificationRPCs(t *testing.T) {
	store, keys := openTestSignerV2(t)
	createTestSignerWalletV2(t, store, keys, "agent", solana.NewWallet().PublicKey().String(), 100, 1000)
	genesis := solana.NewWallet().PublicKey().String()
	keys.genesisHash = func(string) (string, error) { return genesis, nil }

	summary, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion:         signerUint64PointerV2(0),
		PrimaryRPCURL:           "https://primary.example/solana",
		ExecutionFallbackRPCURL: "https://fallback.example/solana",
		VerificationRPCURL:      "https://witness.example/solana",
	})
	if err != nil || !summary.Ready {
		t.Fatalf("matching genesis endpoints were not accepted: summary=%#v err=%v", summary, err)
	}
	config, err := keys.SolanaNetworkV2("agent")
	if err != nil || config.GenesisHash != genesis {
		t.Fatalf("matching genesis was not pinned in encrypted state: config=%#v err=%v", config, err)
	}
}

func TestSignerNetworkExecutionFallbackIsRecheckedAgainstPinnedGenesisBeforeUse(t *testing.T) {
	store, keys := openTestSignerV2(t)
	createTestSignerWalletV2(t, store, keys, "agent", solana.NewWallet().PublicKey().String(), 100, 1000)
	primary := "https://primary.example/solana"
	fallback := "https://fallback.example/solana"
	genesis := solana.NewWallet().PublicKey().String()
	fallbackGenesis := genesis
	keys.genesisHash = func(rpcURL string) (string, error) {
		if rpcURL == fallback {
			return fallbackGenesis, nil
		}
		return genesis, nil
	}
	if _, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion:         signerUint64PointerV2(0),
		PrimaryRPCURL:           primary,
		ExecutionFallbackRPCURL: fallback,
	}); err != nil {
		t.Fatalf("configure matching execution fallback: %v", err)
	}
	fallbackGenesis = solana.NewWallet().PublicKey().String()
	if _, err := keys.SolanaExecutionRPCURLsV2("agent"); !errors.Is(err, errSignerNetworkPendingV2) {
		t.Fatalf("retargeted execution fallback remained usable: %v", err)
	}
	summary, err := keys.NetworkSummaryV2("agent")
	if err != nil || summary.Ready {
		t.Fatalf("retargeted execution fallback reported ready: summary=%#v err=%v", summary, err)
	}
}

func TestSignerNetworkExecutionGenesisAllowsOnePinnedEndpointOutage(t *testing.T) {
	store, keys := openTestSignerV2(t)
	createTestSignerWalletV2(t, store, keys, "agent", solana.NewWallet().PublicKey().String(), 100, 1000)
	primary := "https://primary.example/solana"
	fallback := "https://fallback.example/solana"
	genesis := solana.NewWallet().PublicKey().String()
	primaryAvailable := true
	fallbackAvailable := true
	keys.genesisHash = func(rpcURL string) (string, error) {
		if rpcURL == primary && !primaryAvailable {
			return "", errors.New("primary unavailable")
		}
		if rpcURL == fallback && !fallbackAvailable {
			return "", errors.New("fallback unavailable")
		}
		return genesis, nil
	}
	if _, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion:         signerUint64PointerV2(0),
		PrimaryRPCURL:           primary,
		ExecutionFallbackRPCURL: fallback,
	}); err != nil {
		t.Fatalf("configure matching execution endpoints: %v", err)
	}

	primaryAvailable = false
	if urls, err := keys.SolanaExecutionRPCURLsV2("agent"); err != nil || len(urls) != 1 || urls[0] != fallback {
		t.Fatalf("healthy fallback did not keep execution available: urls=%#v err=%v", urls, err)
	}
	primaryAvailable = true
	fallbackAvailable = false
	if urls, err := keys.SolanaExecutionRPCURLsV2("agent"); err != nil || len(urls) != 1 || urls[0] != primary {
		t.Fatalf("healthy primary did not keep execution available: urls=%#v err=%v", urls, err)
	}
	primaryAvailable = false
	if _, err := keys.SolanaExecutionRPCURLsV2("agent"); !errors.Is(err, errSignerNetworkPendingV2) {
		t.Fatalf("execution remained ready with no live endpoint: %v", err)
	}
}

func TestSignerNetworkLegacyGenesisMigrationRequiresPrimaryAnchor(t *testing.T) {
	store, keys := openTestSignerV2(t)
	createTestSignerWalletV2(t, store, keys, "agent", solana.NewWallet().PublicKey().String(), 100, 1000)
	primary := "https://legacy-primary.example/rpc"
	fallback := "https://legacy-fallback.example/rpc"
	record := encryptLegacySignerNetworkRecordForTestV2(t, keys, "agent", 1, signerLegacyNetworkSecretV2{
		PrimaryRPCURL: primary, FallbackRPCURL: fallback,
	})
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSignerNetworksV2).Put([]byte("agent"), encoded)
	}); err != nil {
		t.Fatal(err)
	}
	keys.genesisHash = func(rpcURL string) (string, error) {
		if rpcURL == primary {
			return "", errors.New("primary unavailable")
		}
		return solana.NewWallet().PublicKey().String(), nil
	}
	if _, err := keys.SolanaExecutionRPCURLsV2("agent"); !errors.Is(err, errSignerNetworkPendingV2) {
		t.Fatalf("legacy fallback established a genesis pin without the primary: %v", err)
	}
	stored, err := keys.getNetworkRecordV2("agent")
	if err != nil || stored.Version != 1 || stored.Hash != record.Hash {
		t.Fatalf("failed legacy migration mutated the authenticated record: stored=%#v err=%v", stored, err)
	}
}

func TestSignerNetworkPrimaryOnlyIsRecheckedAgainstPinnedGenesis(t *testing.T) {
	store, keys := openTestSignerV2(t)
	createTestSignerWalletV2(t, store, keys, "agent", solana.NewWallet().PublicKey().String(), 100, 1000)
	genesis := solana.NewWallet().PublicKey().String()
	currentGenesis := genesis
	keys.genesisHash = func(string) (string, error) { return currentGenesis, nil }
	if _, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0),
		PrimaryRPCURL:   "https://primary.example/solana",
	}); err != nil {
		t.Fatalf("configure primary-only network: %v", err)
	}
	currentGenesis = solana.NewWallet().PublicKey().String()
	if _, err := keys.SolanaExecutionRPCURLsV2("agent"); !errors.Is(err, errSignerNetworkPendingV2) {
		t.Fatalf("retargeted primary-only endpoint remained usable: %v", err)
	}
	summary, err := keys.NetworkSummaryV2("agent")
	if err != nil || summary.Ready {
		t.Fatalf("retargeted primary-only endpoint reported ready: summary=%#v err=%v", summary, err)
	}
}

func TestSignerNetworkLegacyFallbackVerifiesGenesisBeforeExecutionUse(t *testing.T) {
	store, keys := openTestSignerV2(t)
	createTestSignerWalletV2(t, store, keys, "agent", solana.NewWallet().PublicKey().String(), 100, 1000)
	primary := "https://legacy-primary.example/rpc"
	fallback := "https://legacy-fallback.example/rpc"
	record := encryptLegacySignerNetworkRecordForTestV2(t, keys, "agent", 1, signerLegacyNetworkSecretV2{
		PrimaryRPCURL: primary, FallbackRPCURL: fallback,
	})
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSignerNetworksV2).Put([]byte("agent"), encoded)
	}); err != nil {
		t.Fatal(err)
	}
	keys.genesisHash = func(rpcURL string) (string, error) {
		if rpcURL == primary {
			return "11111111111111111111111111111111", nil
		}
		return solana.NewWallet().PublicKey().String(), nil
	}

	if _, err := keys.SolanaExecutionRPCURLsV2("agent"); !errors.Is(err, errSignerNetworkPendingV2) {
		t.Fatalf("legacy cross-genesis fallback was usable for execution: %v", err)
	}
	summary, err := keys.NetworkSummaryV2("agent")
	if err != nil || summary.Ready {
		t.Fatalf("legacy cross-genesis network reported ready: summary=%#v err=%v", summary, err)
	}
}

func TestSignerNetworkConfigurationIsEncryptedAndMetadataOnly(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)
	primary := "https://rpc.example.com/solana?api-key=primary-secret-token"
	fallback := "https://fallback.example.com/rpc/fallback-secret-token"

	summary, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion:         signerUint64PointerV2(0),
		PrimaryRPCURL:           primary,
		ExecutionFallbackRPCURL: fallback,
	})
	if err != nil {
		t.Fatalf("put encrypted signer network: %v", err)
	}
	if !summary.Configured || !summary.Ready || summary.Version != 1 || !strings.HasPrefix(summary.Hash, "hmac-sha256:") {
		t.Fatalf("unexpected signer network summary: %#v", summary)
	}
	encodedSummary, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{primary, fallback, "primary-secret-token", "fallback-secret-token"} {
		if bytes.Contains(encodedSummary, []byte(secret)) {
			t.Fatalf("network summary exposed RPC material %q: %s", secret, encodedSummary)
		}
	}

	var stored []byte
	if err := store.db.View(func(tx *bolt.Tx) error {
		stored = append([]byte(nil), tx.Bucket(bucketSignerNetworksV2).Get([]byte("agent"))...)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(stored) == 0 {
		t.Fatal("encrypted signer network record was not stored")
	}
	for _, secret := range []string{primary, fallback, "primary-secret-token", "fallback-secret-token"} {
		if bytes.Contains(stored, []byte(secret)) {
			t.Fatalf("bbolt signer network record contains plaintext RPC material %q", secret)
		}
	}
	databaseBytes, err := os.ReadFile(store.db.Path())
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{primary, fallback, "primary-secret-token", "fallback-secret-token"} {
		if bytes.Contains(databaseBytes, []byte(secret)) {
			t.Fatalf("bbolt signer state file contains plaintext RPC material %q", secret)
		}
	}
	var record signerNetworkRecordV2
	if err := json.Unmarshal(stored, &record); err != nil || record.Nonce == "" || record.Secret == "" {
		t.Fatalf("invalid encrypted signer network record: %#v err=%v", record, err)
	}

	urls, err := keys.SolanaRPCURLsV2("agent")
	if err != nil || len(urls) != 2 || urls[0] != primary || urls[1] != fallback {
		t.Fatalf("decrypt signer-owned RPC URLs: urls=%#v err=%v", urls, err)
	}
	readSummary, err := keys.NetworkSummaryV2("agent")
	if err != nil || readSummary != summary {
		t.Fatalf("read signer network metadata: %#v err=%v", readSummary, err)
	}
	webauthn, err := newSignerWebAuthnServiceV2(store, "", "")
	if err != nil {
		t.Fatal(err)
	}
	health, err := (&signerServiceV2{store: store, keys: keys, webauthn: webauthn}).health(signerConfig{chains: []string{"solana"}})
	if err != nil || !health.Schema.Ready || health.Schema.Version != signerStateSchemaVersionV2 || !health.Network.Ready || len(health.Network.Wallets) != 1 {
		t.Fatalf("health did not report schema/network readiness: %#v err=%v", health, err)
	}
	if !health.Release.Development || health.Release.Version != "dev" || health.Release.Commit != "unknown" || health.Release.BuildInputDigest != "unknown" {
		t.Fatalf("source-test health did not expose its explicit development identity: %#v", health.Release)
	}
	if health.Capabilities.NativeFeeReservationLamports != signerNativeFeeReservationV2 {
		t.Fatalf("health did not expose the signer-owned native fee reserve: %#v", health.Capabilities)
	}
	if health.Jupiter.LiveEnabled || health.State.Capacities["operations"].Maximum != maxSignerOperationsV2 || health.State.CapacityWarnings == nil {
		t.Fatalf("health did not expose fail-closed Jupiter mode and capacity metadata: jupiter=%#v state=%#v", health.Jupiter, health.State)
	}
	encodedHealth, err := json.Marshal(health)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{primary, fallback, "primary-secret-token", "fallback-secret-token"} {
		if bytes.Contains(encodedHealth, []byte(secret)) {
			t.Fatalf("health exposed RPC material %q: %s", secret, encodedHealth)
		}
	}

	if _, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0),
		PrimaryRPCURL:   "https://new.example.com",
	}); err == nil || !strings.Contains(err.Error(), "version conflict") {
		t.Fatalf("expected stale signer network version rejection, got %v", err)
	}
	updated, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(1),
		PrimaryRPCURL:   "https://new.example.com",
	})
	if err != nil || updated.Version != 2 || updated.Hash == summary.Hash {
		t.Fatalf("versioned signer network replacement failed: %#v err=%v", updated, err)
	}
}

func TestSignerNetworkHashIsWalletBoundAndSurvivesRestart(t *testing.T) {
	directory := t.TempDir()
	dbPath := filepath.Join(directory, "state.db")
	masterPath := filepath.Join(directory, "master.key")
	store, err := openSignerStoreV2(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := openSignerKeyManagerV2(store, masterPath)
	if err != nil {
		t.Fatal(err)
	}
	keys.genesisHash = func(string) (string, error) {
		return "11111111111111111111111111111111", nil
	}
	destination := solana.NewWallet().PublicKey().String()
	createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)
	createTestSignerWalletV2(t, store, keys, "mining", destination, 100, 1000)
	input := signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0),
		PrimaryRPCURL:   "https://rpc.example.com?token=shared-secret",
	}
	agent, err := keys.PutNetworkV2("agent", input)
	if err != nil {
		t.Fatal(err)
	}
	mining, err := keys.PutNetworkV2("mining", input)
	if err != nil {
		t.Fatal(err)
	}
	if agent.Hash == mining.Hash {
		t.Fatal("signer network hash was not bound to wallet identity")
	}
	keys.Close()
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := openSignerStoreV2(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	reopenedKeys, err := openSignerKeyManagerV2(reopened, masterPath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopenedKeys.Close()
	reopenedKeys.genesisHash = func(string) (string, error) {
		return "11111111111111111111111111111111", nil
	}
	urls, err := reopenedKeys.SolanaRPCURLsV2("agent")
	if err != nil || len(urls) != 1 || !strings.Contains(urls[0], "shared-secret") {
		t.Fatalf("encrypted signer network did not survive restart: %#v err=%v", urls, err)
	}
	health, err := reopenedKeys.NetworkHealthV2()
	if err != nil || !health.Ready || len(health.Wallets) != 2 {
		t.Fatalf("unexpected signer network health after restart: %#v err=%v", health, err)
	}
}

func TestSignerNetworkPendingAndCorruptionFailClosed(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)
	summary, err := keys.NetworkSummaryV2("agent")
	if err != nil || summary.Configured || summary.Ready {
		t.Fatalf("missing signer network must be pending: %#v err=%v", summary, err)
	}
	if _, err := keys.SolanaRPCURLsV2("agent"); !errors.Is(err, errSignerNetworkPendingV2) {
		t.Fatalf("expected network-pending error, got %v", err)
	}
	health, err := keys.NetworkHealthV2()
	if err != nil || health.Ready || len(health.Wallets) != 1 || health.Wallets[0].Ready {
		t.Fatalf("missing network health did not fail closed: %#v err=%v", health, err)
	}

	if err := store.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSignerNetworksV2).Put([]byte("agent"), []byte(`{"not":"a valid record"}`))
	}); err != nil {
		t.Fatal(err)
	}
	corrupt, err := keys.NetworkSummaryV2("agent")
	if err != nil || !corrupt.Configured || corrupt.Ready {
		t.Fatalf("corrupt signer network should expose metadata readiness only: %#v err=%v", corrupt, err)
	}
	if _, err := keys.SolanaRPCURLsV2("agent"); !errors.Is(err, errSignerNetworkPendingV2) {
		t.Fatalf("corrupt network did not fail network-pending: %v", err)
	}

	record, err := keys.encryptNetworkRecordV2("agent", 1, signerNetworkSecretV2{PrimaryRPCURL: "https://rpc.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	record.Nonce = "AA"
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSignerNetworksV2).Put([]byte("agent"), encoded)
	}); err != nil {
		t.Fatal(err)
	}
	badNonce, err := keys.NetworkSummaryV2("agent")
	if err != nil || !badNonce.Configured || badNonce.Ready || badNonce.Version != 1 {
		t.Fatalf("invalid encrypted nonce did not fail readiness safely: %#v err=%v", badNonce, err)
	}

	record.Hash = "https://must-not-escape.example/?token=record-secret"
	encoded, err = json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSignerNetworksV2).Put([]byte("agent"), encoded)
	}); err != nil {
		t.Fatal(err)
	}
	unsafeMetadata, err := keys.NetworkSummaryV2("agent")
	if err != nil || !unsafeMetadata.Configured || unsafeMetadata.Ready || unsafeMetadata.Hash != "" || unsafeMetadata.Version != 0 {
		t.Fatalf("unsafe record metadata was exposed: %#v err=%v", unsafeMetadata, err)
	}
	public, err := json.Marshal(unsafeMetadata)
	if err != nil || bytes.Contains(public, []byte("record-secret")) || bytes.Contains(public, []byte("must-not-escape")) {
		t.Fatalf("unsafe stored metadata escaped network summary: %s err=%v", public, err)
	}
}

func TestSignerNetworkWrongMasterKeyAndCrossWalletRecordFailClosed(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)
	createTestSignerWalletV2(t, store, keys, "mining", destination, 100, 1000)
	for _, walletID := range []string{"agent", "mining"} {
		if _, err := keys.PutNetworkV2(walletID, signerNetworkPutRequestV2{
			ExpectedVersion: signerUint64PointerV2(0),
			PrimaryRPCURL:   "https://" + walletID + ".example.com/?token=" + walletID + "-secret",
		}); err != nil {
			t.Fatal(err)
		}
	}

	wrongKey := &signerKeyManagerV2{store: store, masterKey: bytes.Repeat([]byte{0x42}, 32)}
	summary, err := wrongKey.NetworkSummaryV2("agent")
	if err != nil || !summary.Configured || summary.Ready {
		t.Fatalf("wrong signer master key did not fail network readiness: %#v err=%v", summary, err)
	}
	if _, err := wrongKey.SolanaRPCURLsV2("agent"); !errors.Is(err, errSignerNetworkPendingV2) {
		t.Fatalf("wrong signer master key did not fail network-pending: %v", err)
	}

	if err := store.db.Update(func(tx *bolt.Tx) error {
		networks := tx.Bucket(bucketSignerNetworksV2)
		copied := append([]byte(nil), networks.Get([]byte("mining"))...)
		return networks.Put([]byte("agent"), copied)
	}); err != nil {
		t.Fatal(err)
	}
	summary, err = keys.NetworkSummaryV2("agent")
	if err != nil || !summary.Configured || summary.Ready {
		t.Fatalf("cross-wallet encrypted network record did not fail closed: %#v err=%v", summary, err)
	}
	if _, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(1), PrimaryRPCURL: "https://replacement.example.com",
	}); err == nil || !strings.Contains(err.Error(), "invalid stored") {
		t.Fatalf("network put silently replaced cross-wallet record: %v", err)
	}
}

func TestSignerRPCURLValidationRejectsUnsafeTargets(t *testing.T) {
	valid := []string{
		"https://api.mainnet-beta.solana.com",
		"https://abc.def",
		"https://rpc.example.com/v1?token=secret",
		"http://localhost:8899",
		"http://node.localhost:8899/rpc",
		"http://127.0.0.1:8899",
		"http://[::1]:8899",
	}
	for _, candidate := range valid {
		if _, err := normalizeSignerRPCURLV2(candidate, "primaryRpcUrl"); err != nil {
			t.Errorf("valid signer RPC URL rejected: %s: %v", candidate, err)
		}
	}
	tooLong := "https://example.com/" + strings.Repeat("a", maxSignerRPCURLBytesV2)
	invalid := []string{
		"http://rpc.example.com",
		"ftp://rpc.example.com",
		"https://user:password@rpc.example.com",
		"https://rpc.example.com/#secret-fragment",
		"https://rpc.example.com#",
		"https://169.254.169.254/latest/meta-data",
		"https://169.254.170.2/v2/credentials",
		"https://100.100.100.200/latest/meta-data",
		"https://168.63.129.16/metadata",
		"https://192.0.0.192/metadata",
		"https://[fd00:ec2::254]/latest/meta-data",
		"https://[fd20:ce::254]/computeMetadata/v1",
		"https://224.0.0.1/rpc",
		"https://[ff02::1]/rpc",
		"https://[fe80::1]/rpc",
		"https://0.0.0.0/rpc",
		"https://[::]/rpc",
		"https://10.0.0.5:443/private-rpc",
		"https://metadata.google.internal/computeMetadata/v1",
		"https://2130706433/rpc",
		"https://127.1/rpc",
		"https://rpc_example.com",
		" https://rpc.example.com",
		tooLong,
	}
	for _, candidate := range invalid {
		if _, err := normalizeSignerRPCURLV2(candidate, "primaryRpcUrl"); err == nil {
			t.Errorf("unsafe signer RPC URL accepted: %s", candidate)
		} else if strings.Contains(err.Error(), candidate) || strings.Contains(err.Error(), "secret-fragment") {
			t.Errorf("RPC validation error reflected secret URL material: %v", err)
		}
	}
	if _, err := normalizeSignerNetworkInputV2(signerNetworkPutRequestV2{
		PrimaryRPCURL:           "https://rpc.example.com",
		ExecutionFallbackRPCURL: "https://rpc.example.com",
	}); err == nil || !strings.Contains(err.Error(), "different origin") {
		t.Fatalf("expected duplicate fallback rejection, got %v", err)
	}
	canonicalPort, err := normalizeSignerRPCURLV2("https://api.mainnet-beta.solana.com:0443/rpc", "primaryRpcUrl")
	if err != nil || canonicalPort != "https://api.mainnet-beta.solana.com:443/rpc" {
		t.Fatalf("equivalent port spelling was not canonicalized: %q err=%v", canonicalPort, err)
	}
	canonicalIP, err := normalizeSignerRPCURLV2("http://[0:0:0:0:0:0:0:1]:08899/rpc", "primaryRpcUrl")
	if err != nil || canonicalIP != "http://[::1]:8899/rpc" {
		t.Fatalf("equivalent IP/port spelling was not canonicalized: %q err=%v", canonicalIP, err)
	}
	if _, err := normalizeSignerNetworkInputV2(signerNetworkPutRequestV2{
		PrimaryRPCURL:           "https://api.mainnet-beta.solana.com:0443",
		ExecutionFallbackRPCURL: "https://api.mainnet-beta.solana.com",
	}); err == nil || !strings.Contains(err.Error(), "different origin") {
		t.Fatalf("equivalent default-port origins were accepted as distinct: %v", err)
	}
}

func TestSignerOwnedRPCTransportIgnoresProxyAndRedirects(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	httpClient := newSignerOwnedHTTPClientV2()
	transport, ok := httpClient.Transport.(*http.Transport)
	if !ok || transport.Proxy != nil {
		t.Fatalf("signer-owned RPC transport inherited an environment proxy: %#v", httpClient.Transport)
	}
	var redirectedRequests atomic.Int64
	destination := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		redirectedRequests.Add(1)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":{"blockhash":"11111111111111111111111111111111","lastValidBlockHeight":1}}}`))
	}))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := newSignerOwnedSolanaRPCClientV2(redirect.URL).GetLatestBlockhash(ctx, rpc.CommitmentFinalized); err == nil {
		t.Fatal("signer-owned RPC client followed or accepted an HTTP redirect")
	}
	if redirectedRequests.Load() != 0 {
		t.Fatalf("signer-owned RPC client followed redirect to another endpoint %d times", redirectedRequests.Load())
	}
	for _, address := range []string{"169.254.169.254:443", "224.0.0.1:443", "[fd00:ec2::254]:443"} {
		if connection, err := dialSignerOwnedRPCV2(ctx, "tcp", address); err == nil || connection != nil || !strings.Contains(err.Error(), "unsafe") {
			t.Fatalf("signer-owned RPC dialer accepted unsafe address %s: connection=%#v err=%v", address, connection, err)
		}
	}
}

func TestSignerNetworkProtocolKeepsSecretsControlOnlyAndNeverReturnsURLs(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)
	service := &signerServiceV2{store: store, keys: keys}
	secret := "protocol-secret-token"
	body, err := json.Marshal(signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0),
		PrimaryRPCURL:   "https://rpc.example.com?token=" + secret,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.handle(request{Op: "v2.network.put", WalletID: "agent", Request: body}, signerConfig{}, false); err == nil || !strings.Contains(err.Error(), "control socket") {
		t.Fatalf("application socket accepted network put: %v", err)
	}
	response, err := service.handle(request{Op: "v2.network.get", WalletID: "agent"}, signerConfig{}, false)
	if err != nil {
		t.Fatalf("application network summary rejected: %v", err)
	}
	if bytes.Contains(response, []byte(secret)) || bytes.Contains(response, []byte("rpc.example.com")) {
		t.Fatalf("application network summary exposed RPC URL: %s", response)
	}
	response, err = service.handle(request{Op: "v2.network.put", WalletID: "agent", Request: body}, signerConfig{}, true)
	if err != nil {
		t.Fatalf("control network put: %v", err)
	}
	if bytes.Contains(response, []byte(secret)) || bytes.Contains(response, []byte("rpc.example.com")) {
		t.Fatalf("network put response exposed RPC URL: %s", response)
	}
	response, err = service.handle(request{Op: "v2.network.get", WalletID: "agent"}, signerConfig{}, true)
	if err != nil {
		t.Fatalf("control network get: %v", err)
	}
	if bytes.Contains(response, []byte(secret)) || bytes.Contains(response, []byte("rpc.example.com")) {
		t.Fatalf("network get response exposed RPC URL: %s", response)
	}
	if _, err := service.handle(request{Op: "v2.network.put", WalletID: "agent", Request: body}, signerConfig{readOnly: true}, true); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("read-only signer accepted network put: %v", err)
	}
	missingVersion := json.RawMessage(`{"primaryRpcUrl":"https://rpc.example.com"}`)
	if _, err := service.handle(request{Op: "v2.network.put", WalletID: "agent", Request: missingVersion}, signerConfig{}, true); err == nil || !strings.Contains(err.Error(), "expectedVersion") {
		t.Fatalf("network put accepted missing expectedVersion: %v", err)
	}
	trailing := append(append([]byte(nil), body...), []byte(` {}`)...)
	if _, err := service.handle(request{Op: "v2.network.put", WalletID: "agent", Request: trailing}, signerConfig{}, true); err == nil || !strings.Contains(err.Error(), "invalid signer-v2") {
		t.Fatalf("network put accepted trailing JSON: %v", err)
	}
	duplicate := json.RawMessage(`{"expectedVersion":0,"expectedVersion":1,"primaryRpcUrl":"https://rpc.example.com"}`)
	if _, err := service.handle(request{Op: "v2.network.put", WalletID: "agent", Request: duplicate}, signerConfig{}, true); err == nil || !strings.Contains(err.Error(), "invalid signer-v2") {
		t.Fatalf("network put accepted duplicate JSON fields: %v", err)
	}
}

func TestSignerV2ExecutionUsesOnlySignerOwnedNetwork(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	_, policy := createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)
	service := &signerServiceV2{store: store, keys: keys}
	intent := signerIntentV2{Type: intentSolanaNativeTransfer, Destination: destination, Lamports: "1"}
	var gatewayRequests atomic.Int64
	gatewayRPC := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		gatewayRequests.Add(1)
		writer.WriteHeader(http.StatusInternalServerError)
	}))
	defer gatewayRPC.Close()
	t.Setenv("FASED_WALLET_SOLANA_RPC_URL", gatewayRPC.URL)
	t.Setenv("FASED_WALLET_RPC_URL", gatewayRPC.URL)
	gatewayConfig := signerConfig{}
	pendingBody, err := json.Marshal(signerExecuteRequestV2{
		RequestID: "network-pending-request", PolicyHash: policy.Hash, Intent: intent,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.handle(request{Op: "v2.execute", WalletID: "agent", Request: pendingBody}, gatewayConfig, false); !errors.Is(err, errSignerNetworkPendingV2) {
		t.Fatalf("Gateway RPC environment bypassed network-pending: err=%v", err)
	}
	if _, err := store.getOperation("network-pending-request"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("network-pending request mutated durable operation state: %v", err)
	}
	usage, err := store.dailyUsage("agent", "solana:native", store.now())
	if err != nil || usage.Sign() != 0 {
		t.Fatalf("network-pending request reserved spend: usage=%v err=%v", usage, err)
	}

	var signerRequests atomic.Int64
	signerRPC := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		signerRequests.Add(1)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"intentional"}}`))
	}))
	defer signerRPC.Close()
	secret := "signer-rpc-secret-token"
	if _, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0),
		PrimaryRPCURL:   signerRPC.URL + "?api-key=" + secret,
	}); err != nil {
		t.Fatalf("configure signer-owned test network: %v", err)
	}
	executeBody, err := json.Marshal(signerExecuteRequestV2{
		RequestID: "signer-network-request", PolicyHash: policy.Hash, Intent: intent,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.handle(request{Op: "v2.execute", WalletID: "agent", Request: executeBody}, gatewayConfig, false); err == nil || signerRequests.Load() == 0 || gatewayRequests.Load() != 0 {
		t.Fatalf("v2 execution did not exclusively use signer-owned RPC: signer=%d gateway=%d err=%v", signerRequests.Load(), gatewayRequests.Load(), err)
	}
	operation, getErr := store.getOperation("signer-network-request")
	if getErr != nil {
		t.Fatalf("read failed signer operation: %v", getErr)
	}
	if strings.Contains(err.Error(), secret) || strings.Contains(operation.Error, secret) || strings.Contains(err.Error(), signerRPC.URL) {
		t.Fatalf("v2 RPC failure exposed encrypted endpoint material: operation=%#v err=%v", operation, err)
	}
}

func TestSignerV2TerminalIdempotencyDoesNotDependOnCurrentNetwork(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	wallet, policy := createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)
	publicKey, err := solana.PublicKeyFromBase58(wallet.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	request := signerExecuteRequestV2{
		RequestID: "terminal-idempotency-request", PolicyHash: policy.Hash,
		Intent:         signerIntentV2{Type: intentSolanaNativeTransfer, Destination: destination, Lamports: "1"},
		intentWalletID: "agent",
	}
	intent, err := normalizeSignerIntentForWalletV2(request.Intent, &publicKey)
	if err != nil {
		t.Fatal(err)
	}
	reserved, _, err := store.reserveOperation(request, intent)
	if err != nil {
		t.Fatal(err)
	}
	failed, err := store.markFailed(reserved.RequestID, errors.New("test terminal state"))
	if err != nil {
		t.Fatal(err)
	}
	result, err := (&signerServiceV2{store: store, keys: keys}).execute(request)
	if err != nil || result.State != operationFailed || result.RequestID != failed.RequestID {
		t.Fatalf("terminal idempotent result required signer network: result=%#v err=%v", result, err)
	}
}

func TestSignerV2ReconcileUsesOnlySignerOwnedNetwork(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	wallet, policy := createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 1000)
	publicKey, err := solana.PublicKeyFromBase58(wallet.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	executeRequest := signerExecuteRequestV2{
		RequestID: "reconcile-network-request", PolicyHash: policy.Hash,
		Intent:         signerIntentV2{Type: intentSolanaNativeTransfer, Destination: destination, Lamports: "1"},
		intentWalletID: "agent",
	}
	intent, err := normalizeSignerIntentForWalletV2(executeRequest.Intent, &publicKey)
	if err != nil {
		t.Fatal(err)
	}
	operation, _, err := store.reserveOperation(executeRequest, intent)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := solana.NewWallet().PrivateKey.Sign([]byte("reconcile signer-owned RPC test"))
	if err != nil {
		t.Fatal(err)
	}
	operation, err = store.markBroadcast(operation.RequestID, signature.String(), []byte("signed-reconcile-transaction"))
	if err != nil {
		t.Fatal(err)
	}
	service := &signerServiceV2{store: store, keys: keys}
	if result, err := service.reconcile(operation.RequestID, "agent"); !errors.Is(err, errSignerNetworkPendingV2) || result.RequestID != operation.RequestID {
		t.Fatalf("reconcile without signer network did not fail pending: result=%#v err=%v", result, err)
	}

	var signerRequests atomic.Int64
	signerRPC := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		signerRequests.Add(1)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"intentional"}}`))
	}))
	defer signerRPC.Close()
	secret := "reconcile-rpc-secret-token"
	if _, err := keys.PutNetworkV2("agent", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: signerRPC.URL + "?token=" + secret,
	}); err != nil {
		t.Fatal(err)
	}
	var gatewayRequests atomic.Int64
	gatewayRPC := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		gatewayRequests.Add(1)
		writer.WriteHeader(http.StatusInternalServerError)
	}))
	defer gatewayRPC.Close()
	t.Setenv("FASED_WALLET_SOLANA_RPC_URL", gatewayRPC.URL)
	t.Setenv("FASED_WALLET_RPC_URL", gatewayRPC.URL)
	body, err := json.Marshal(signerOperationLookupV2{RequestID: operation.RequestID})
	if err != nil {
		t.Fatal(err)
	}
	response, err := service.handle(
		request{Op: "v2.operation.reconcile", WalletID: "agent", Request: body},
		signerConfig{},
		false,
	)
	if err != nil || signerRequests.Load() == 0 || gatewayRequests.Load() != 0 {
		t.Fatalf("reconcile did not exclusively use signer-owned RPC: signer=%d gateway=%d err=%v", signerRequests.Load(), gatewayRequests.Load(), err)
	}
	if bytes.Contains(response, []byte(secret)) || bytes.Contains(response, []byte(signerRPC.URL)) {
		t.Fatalf("reconcile exposed encrypted endpoint material: %s", response)
	}
	reconciled, err := store.getOperation(operation.RequestID)
	if err != nil || reconciled.State != operationUnknown {
		t.Fatalf("reconcile did not preserve an ambiguous result safely: result=%#v err=%v", reconciled, err)
	}
}

func TestSignerNetworkRejectsMissingWalletAndUnsafePort(t *testing.T) {
	_, keys := openTestSignerV2(t)
	if _, err := keys.PutNetworkV2("missing", signerNetworkPutRequestV2{
		ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: "https://rpc.example.com",
	}); err == nil || !strings.Contains(err.Error(), "wallet not found") {
		t.Fatalf("network config accepted missing wallet: %v", err)
	}
	if _, err := normalizeSignerRPCURLV2("https://rpc.example.com:99999", "primaryRpcUrl"); err == nil {
		t.Fatal("network config accepted invalid port")
	}
}
