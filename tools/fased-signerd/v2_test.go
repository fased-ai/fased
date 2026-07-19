package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
)

func testSignerPolicyV2(walletID, destination string, maxPerTx, maxDaily uint64) signerPolicyV2 {
	fee := new(big.Int).SetUint64(signerNativeFeeReservationV2)
	perTx := new(big.Int).Add(new(big.Int).SetUint64(maxPerTx), fee)
	daily := new(big.Int).Add(new(big.Int).SetUint64(maxDaily), fee)
	return signerPolicyV2{
		WalletID:   walletID,
		Role:       "agent",
		Operations: []string{intentSolanaNativeTransfer},
		Programs:   []string{solana.SystemProgramID.String()},
		Assets: []signerPolicyAssetV2{
			{
				Asset:        "solana:native",
				Destinations: []string{destination},
				MaxPerTx:     perTx.String(),
				MaxDaily:     daily.String(),
			},
		},
	}
}

func openTestSignerV2(t *testing.T) (*signerStoreV2, *signerKeyManagerV2) {
	t.Helper()
	dir := t.TempDir()
	store, err := openSignerStoreV2(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatalf("open signer store: %v", err)
	}
	keys, err := openSignerKeyManagerV2(store, filepath.Join(dir, "master.key"))
	if err != nil {
		_ = store.Close()
		t.Fatalf("open signer key manager: %v", err)
	}
	keys.genesisHash = func(string) (string, error) {
		return "11111111111111111111111111111111", nil
	}
	t.Cleanup(func() {
		keys.Close()
		_ = store.Close()
	})
	return store, keys
}

func createTestSignerWalletV2(
	t *testing.T,
	store *signerStoreV2,
	keys *signerKeyManagerV2,
	walletID string,
	destination string,
	maxPerTx uint64,
	maxDaily uint64,
) (signerWalletRecordV2, signerPolicyV2) {
	t.Helper()
	store.now = func() time.Time { return time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC) }
	wallet, policy, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{
		WalletID:        walletID,
		ExpectedVersion: 0,
		Policy:          testSignerPolicyV2(walletID, destination, maxPerTx, maxDaily),
	})
	if err != nil {
		t.Fatalf("create signer wallet: %v", err)
	}
	return wallet, policy
}

func TestSignerV2PolicyIsDeterministicAndFailClosed(t *testing.T) {
	destination := solana.NewWallet().PublicKey().String()
	policy := testSignerPolicyV2("agent", destination, 100, 500)
	normalizedA, err := normalizeSignerPolicyV2(policy)
	if err != nil {
		t.Fatalf("normalize policy: %v", err)
	}
	policy.Operations = []string{intentSolanaNativeTransfer, intentSolanaNativeTransfer}
	policy.Programs = []string{solana.SystemProgramID.String(), solana.SystemProgramID.String()}
	normalizedB, err := normalizeSignerPolicyV2(policy)
	if err != nil {
		t.Fatalf("normalize duplicate policy: %v", err)
	}
	if normalizedA.Hash != normalizedB.Hash || !strings.HasPrefix(normalizedA.Hash, "sha256:") {
		t.Fatalf("expected deterministic policy hash, got %q and %q", normalizedA.Hash, normalizedB.Hash)
	}

	empty, err := normalizeSignerPolicyV2(signerPolicyV2{WalletID: "agent", Role: "agent"})
	if err != nil {
		t.Fatalf("normalize explicit deny-all policy: %v", err)
	}
	encodedEmpty, err := json.Marshal(empty)
	if err != nil {
		t.Fatalf("marshal explicit deny-all policy: %v", err)
	}
	if bytes.Contains(encodedEmpty, []byte(`null`)) || !bytes.Contains(encodedEmpty, []byte(`"assets":[]`)) {
		t.Fatalf("explicit deny-all policy must use canonical empty arrays: %s", encodedEmpty)
	}
	intent, err := normalizeSignerIntentV2(signerIntentV2{
		Type:        intentSolanaNativeTransfer,
		Destination: destination,
		Lamports:    "1",
	})
	if err != nil {
		t.Fatalf("normalize intent: %v", err)
	}
	if _, err := policyAssetForIntentV2(empty, intent); err == nil || !strings.Contains(err.Error(), "operations are empty") {
		t.Fatalf("expected empty policy to deny operation, got %v", err)
	}

	store, _ := openTestSignerV2(t)
	if _, err := store.getPolicy("missing"); err == nil || !strings.Contains(err.Error(), "explicit signer policy required") {
		t.Fatalf("expected missing policy to fail closed, got %v", err)
	}
}

func TestSignerV2VaultCannotBypassReviewedWebAuthnWithDirectExecute(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	policyInput := testSignerPolicyV2("vault-direct-denied", destination, 10, 100)
	policyInput.Role = "vault"
	wallet, policy, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{
		WalletID:        "vault-direct-denied",
		ExpectedVersion: 0,
		Policy:          policyInput,
	})
	if err != nil {
		t.Fatalf("install Vault policy: %v", err)
	}
	service := &signerServiceV2{store: store, keys: keys}
	_, err = service.execute(signerExecuteRequestV2{
		RequestID:      "vault-direct-request",
		PolicyHash:     policy.Hash,
		Intent:         signerIntentV2{Type: intentSolanaNativeTransfer, Destination: destination, Lamports: "1"},
		intentWalletID: wallet.WalletID,
	})
	if err == nil || !strings.Contains(err.Error(), "review.prepare") || !strings.Contains(err.Error(), "WebAuthn") {
		t.Fatalf("Vault direct execute was not rejected by the reviewed authorization boundary: %v", err)
	}
	if _, getErr := store.getOperation("vault-direct-request"); !errors.Is(getErr, errSignerOperationNotFoundV2) {
		t.Fatalf("Vault direct execute mutated durable operation state: %v", getErr)
	}
	usage, usageErr := store.dailyUsage(wallet.WalletID, "solana:native", store.now())
	if usageErr != nil || usage.Sign() != 0 {
		t.Fatalf("Vault direct execute reserved spend: usage=%v err=%v", usage, usageErr)
	}
}

func TestSignerV2ApplicationSocketCreatesOnlyExplicitlyLockedWallet(t *testing.T) {
	store, keys := openTestSignerV2(t)
	service := &signerServiceV2{store: store, keys: keys}
	lockedBody, err := json.Marshal(signerWalletCreateRequestV2{
		ExpectedVersion: 0,
		Policy: signerPolicyV2{
			Role: "mining", Operations: []string{}, Programs: []string{}, Assets: []signerPolicyAssetV2{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.handle(request{Op: "v2.wallet.create", WalletID: "locked-mining", Request: lockedBody}, signerConfig{}, false); err != nil {
		t.Fatalf("create locked wallet on application socket: %v", err)
	}
	policy, err := store.getPolicy("locked-mining")
	if err != nil || policy.Hash == "" || len(policy.Operations) != 0 || len(policy.Programs) != 0 || len(policy.Assets) != 0 {
		t.Fatalf("expected durable explicit deny-all policy, policy=%#v err=%v", policy, err)
	}
	destination := solana.NewWallet().PublicKey().String()
	_, err = service.execute(signerExecuteRequestV2{
		RequestID: "locked-wallet-execute", PolicyHash: policy.Hash,
		Intent:         signerIntentV2{Type: intentSolanaNativeTransfer, Destination: destination, Lamports: "1"},
		intentWalletID: "locked-mining",
	})
	if err == nil || !strings.Contains(err.Error(), "policy operations are empty") {
		t.Fatalf("locked wallet execute must fail closed before RPC, got %v", err)
	}

	configuredBody, err := json.Marshal(signerWalletCreateRequestV2{
		ExpectedVersion: 0,
		Policy:          testSignerPolicyV2("configured", destination, 10, 20),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.handle(request{Op: "v2.wallet.create", WalletID: "configured", Request: configuredBody}, signerConfig{}, false); err == nil || !strings.Contains(err.Error(), "only a locked wallet") {
		t.Fatalf("application socket must reject configured wallet creation, got %v", err)
	}
}

func TestSignerV2WalletCreationStoresEncryptedKeyAndPolicyAtomically(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	wallet, policy := createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 500)
	if wallet.PublicKey == "" || wallet.Secret != "" || wallet.Nonce != "" {
		t.Fatalf("public wallet record leaked encrypted state: %#v", wallet)
	}
	if policy.Version != 1 || policy.Hash == "" {
		t.Fatalf("expected versioned policy hash, got %#v", policy)
	}

	privateKey, record, err := keys.privateKey("agent")
	if err != nil {
		t.Fatalf("decrypt signer-owned key: %v", err)
	}
	defer zeroBytes(privateKey)
	if privateKey.PublicKey().String() != wallet.PublicKey {
		t.Fatal("stored private key does not match public wallet record")
	}
	encodedPrivate := []byte(privateKey.String())
	encodedRecord, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("marshal encrypted record: %v", err)
	}
	if bytes.Contains(encodedRecord, privateKey) || bytes.Contains(encodedRecord, encodedPrivate) {
		t.Fatal("signer database record contains plaintext private key material")
	}

	rotated, err := keys.RotateEncryption("agent")
	if err != nil {
		t.Fatalf("rotate wallet encryption: %v", err)
	}
	if rotated.PublicKey != wallet.PublicKey || rotated.Version != 2 || rotated.RotatedAt == "" {
		t.Fatalf("unexpected re-encryption result: %#v", rotated)
	}
}

func TestSignerV2DurableAtomicCapsAndIdempotency(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	_, policy := createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 100)
	intent, err := normalizeSignerIntentV2(signerIntentV2{
		Type:        intentSolanaNativeTransfer,
		Destination: destination,
		Lamports:    "60",
	})
	if err != nil {
		t.Fatalf("normalize intent: %v", err)
	}
	req := signerExecuteRequestV2{
		RequestID:      "request-one",
		PolicyHash:     policy.Hash,
		Intent:         intent.Intent,
		intentWalletID: "agent",
	}
	operation, existing, err := store.reserveOperation(req, intent)
	if err != nil || existing {
		t.Fatalf("reserve operation: existing=%v err=%v", existing, err)
	}
	duplicate, existing, err := store.reserveOperation(req, intent)
	if err != nil || !existing || duplicate.RequestID != operation.RequestID {
		t.Fatalf("idempotent reservation: existing=%v err=%v operation=%#v", existing, err, duplicate)
	}
	usage, err := store.dailyUsage("agent", "solana:native", store.now())
	if expected := new(big.Int).Add(big.NewInt(60), new(big.Int).SetUint64(signerNativeFeeReservationV2)); err != nil || usage.Cmp(expected) != 0 {
		t.Fatalf("expected idempotent principal+fee usage %v, got %v err=%v", expected, usage, err)
	}

	secondIntent := intent
	secondIntent.Intent.Lamports = "50"
	secondIntent.Amount = big.NewInt(50)
	secondIntent.Digest = "sha256:" + strings.Repeat("b", 64)
	_, _, err = store.reserveOperation(signerExecuteRequestV2{
		RequestID:      "request-two",
		PolicyHash:     policy.Hash,
		Intent:         secondIntent.Intent,
		intentWalletID: "agent",
	}, secondIntent)
	if err == nil || !strings.Contains(err.Error(), "daily cap exceeded") {
		t.Fatalf("expected atomic daily cap rejection, got %v", err)
	}

	failed, err := store.markFailed(operation.RequestID, errors.New("blockhash unavailable"))
	if err != nil || failed.ReservationActive {
		t.Fatalf("release pre-broadcast reservation: %#v err=%v", failed, err)
	}
	usage, err = store.dailyUsage("agent", "solana:native", store.now())
	if err != nil || usage.Sign() != 0 {
		t.Fatalf("expected released usage 0, got %v err=%v", usage, err)
	}

	thirdIntent := intent
	thirdIntent.Intent.Lamports = "90"
	thirdIntent.Amount = big.NewInt(90)
	thirdIntent.Digest = "sha256:" + strings.Repeat("c", 64)
	third, _, err := store.reserveOperation(signerExecuteRequestV2{
		RequestID:      "request-three",
		PolicyHash:     policy.Hash,
		Intent:         thirdIntent.Intent,
		intentWalletID: "agent",
	}, thirdIntent)
	if err != nil {
		t.Fatalf("reserve third operation: %v", err)
	}
	third, err = store.markBroadcast(third.RequestID, "signature", []byte("signed-third-transaction"))
	if err != nil {
		t.Fatalf("mark broadcast: %v", err)
	}
	third, err = store.markUnknown(third.RequestID, errors.New("timeout"))
	if err != nil || third.State != operationUnknown || !third.ReservationActive {
		t.Fatalf("persist ambiguous operation: %#v err=%v", third, err)
	}
	usage, err = store.dailyUsage("agent", "solana:native", store.now())
	if expected := new(big.Int).Add(big.NewInt(90), new(big.Int).SetUint64(signerNativeFeeReservationV2)); err != nil || usage.Cmp(expected) != 0 {
		t.Fatalf("ambiguous broadcast must count against cap, got %v err=%v", usage, err)
	}
}

func TestSignerV2ConcurrentReservationsCannotOverspend(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	_, policy := createTestSignerWalletV2(t, store, keys, "agent", destination, 70, 100)
	intent, err := normalizeSignerIntentV2(signerIntentV2{
		Type:        intentSolanaNativeTransfer,
		Destination: destination,
		Lamports:    "60",
	})
	if err != nil {
		t.Fatalf("normalize intent: %v", err)
	}

	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, requestID := range []string{"concurrent-one", "concurrent-two"} {
		wg.Add(1)
		go func(requestID string) {
			defer wg.Done()
			_, _, reserveErr := store.reserveOperation(signerExecuteRequestV2{
				RequestID:      requestID,
				PolicyHash:     policy.Hash,
				Intent:         intent.Intent,
				intentWalletID: "agent",
			}, intent)
			results <- reserveErr
		}(requestID)
	}
	wg.Wait()
	close(results)
	successes := 0
	failures := 0
	for result := range results {
		if result == nil {
			successes++
		} else if strings.Contains(result.Error(), "daily cap exceeded") {
			failures++
		} else {
			t.Fatalf("unexpected concurrent reservation error: %v", result)
		}
	}
	if successes != 1 || failures != 1 {
		t.Fatalf("expected one reservation and one cap rejection, got success=%d failures=%d", successes, failures)
	}
}

func TestSignerV2SPLReservationAtomicallyConsumesNativeFeeBudget(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	mint := solana.NewWallet().PublicKey().String()
	fee := new(big.Int).SetUint64(signerNativeFeeReservationV2).String()
	wallet, policy, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{
		WalletID: "agent-spl-fees", ExpectedVersion: 0,
		Policy: signerPolicyV2{
			Role:       "agent",
			Operations: []string{intentSolanaSPLTransferChecked},
			Programs: []string{
				solana.SystemProgramID.String(),
				solana.SPLAssociatedTokenAccountProgramID.String(),
				solana.TokenProgramID.String(),
			},
			Assets: []signerPolicyAssetV2{
				{Asset: "solana:native", Destinations: []string{destination}, MaxPerTx: fee, MaxDaily: fee},
				{Asset: "solana:spl:" + mint, Destinations: []string{destination}, MaxPerTx: "10", MaxDaily: "20"},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	intent, err := normalizeSignerIntentV2(signerIntentV2{
		Type: intentSolanaSPLTransferChecked, TokenProgram: solana.TokenProgramID.String(),
		Mint: mint, Destination: destination, Amount: "10",
	})
	if err != nil {
		t.Fatal(err)
	}
	request := signerExecuteRequestV2{
		RequestID: "spl-native-fee-one", PolicyHash: policy.Hash, Intent: intent.Intent, intentWalletID: wallet.WalletID,
	}
	operation, _, err := store.reserveOperation(request, intent)
	if err != nil {
		t.Fatalf("reserve SPL amount and native fee atomically: %v", err)
	}
	if len(operation.Reservations) != 2 {
		t.Fatalf("SPL operation did not persist both reservation assets: %#v", operation.Reservations)
	}
	if usage, err := store.dailyUsage(wallet.WalletID, "solana:native", store.now()); err != nil || usage.String() != fee {
		t.Fatalf("native fee was not durably reserved: usage=%v err=%v", usage, err)
	}
	request.RequestID = "spl-native-fee-two"
	if _, _, err := store.reserveOperation(request, intent); err == nil || !strings.Contains(err.Error(), "daily cap exceeded for solana:native") {
		t.Fatalf("second SPL send bypassed the native daily fee cap: %v", err)
	}
	if _, err := store.markFailed(operation.RequestID, errors.New("pre-broadcast failure")); err != nil {
		t.Fatal(err)
	}
	if usage, err := store.dailyUsage(wallet.WalletID, "solana:native", store.now()); err != nil || usage.Sign() != 0 {
		t.Fatalf("multi-asset failure did not release native reservation: usage=%v err=%v", usage, err)
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, requestID := range []string{"spl-native-fee-race-a", "spl-native-fee-race-b"} {
		wg.Add(1)
		go func(requestID string) {
			defer wg.Done()
			candidate := request
			candidate.RequestID = requestID
			_, _, reserveErr := store.reserveOperation(candidate, intent)
			results <- reserveErr
		}(requestID)
	}
	wg.Wait()
	close(results)
	successes, rejected := 0, 0
	for result := range results {
		if result == nil {
			successes++
		} else if strings.Contains(result.Error(), "daily cap exceeded for solana:native") {
			rejected++
		} else {
			t.Fatalf("unexpected concurrent multi-asset reservation result: %v", result)
		}
	}
	if successes != 1 || rejected != 1 {
		t.Fatalf("native fee cap was not atomic across concurrent SPL sends: success=%d rejected=%d", successes, rejected)
	}

	withoutNative := policy
	withoutNative.Assets = withoutNative.Assets[1:]
	withoutNative.Hash = ""
	withoutNative, err = normalizeSignerPolicyV2(withoutNative)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := policyReservationsForIntentV2(withoutNative, intent); err == nil || !strings.Contains(err.Error(), "solana:native policy is required") {
		t.Fatalf("SPL signing accepted no explicit native fee policy: %v", err)
	}
}

func TestSignerV2ExecutionLeaseIsAtomicFencedAndNeverReclaimsBroadcast(t *testing.T) {
	store, keys := openTestSignerV2(t)
	now := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	destination := solana.NewWallet().PublicKey().String()
	_, policy := createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 500)
	store.now = func() time.Time { return now }
	intent, err := normalizeSignerIntentV2(signerIntentV2{
		Type: intentSolanaNativeTransfer, Destination: destination, Lamports: "25",
	})
	if err != nil {
		t.Fatalf("normalize intent: %v", err)
	}
	req := signerExecuteRequestV2{
		RequestID: "execution-lease-request", PolicyHash: policy.Hash, Intent: intent.Intent,
		intentWalletID: "agent",
	}
	operation, _, err := store.reserveOperation(req, intent)
	if err != nil {
		t.Fatalf("reserve operation: %v", err)
	}

	var wg sync.WaitGroup
	claims := make(chan struct {
		attempt uint64
		claimed bool
		err     error
	}, 12)
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, attempt, claimed, claimErr := store.claimReservedOperation(operation.RequestID)
			claims <- struct {
				attempt uint64
				claimed bool
				err     error
			}{attempt, claimed, claimErr}
		}()
	}
	wg.Wait()
	close(claims)
	claimCount := 0
	firstAttempt := uint64(0)
	for result := range claims {
		if result.err != nil {
			t.Fatalf("claim reserved operation: %v", result.err)
		}
		if result.claimed {
			claimCount++
			firstAttempt = result.attempt
		}
	}
	if claimCount != 1 || firstAttempt != 1 {
		t.Fatalf("expected exactly one fenced execution claim, got claims=%d attempt=%d", claimCount, firstAttempt)
	}

	now = now.Add(signerExecutionLeaseV2 + time.Second)
	_, secondAttempt, claimed, err := store.claimReservedOperation(operation.RequestID)
	if err != nil || !claimed || secondAttempt != 2 {
		t.Fatalf("expected stale pre-broadcast lease recovery, claimed=%v attempt=%d err=%v", claimed, secondAttempt, err)
	}
	staleRaw := []byte("stale-signed-transaction")
	staleDigest := sha256.Sum256(staleRaw)
	if _, err := store.markBroadcastClaim(operation.RequestID, firstAttempt, "stale-signature", "sha256:"+hex.EncodeToString(staleDigest[:]), base64.StdEncoding.EncodeToString(staleRaw)); err == nil || !strings.Contains(err.Error(), "stale") {
		t.Fatalf("expected stale worker fencing, got %v", err)
	}
	if _, err := store.markBroadcastClaim(operation.RequestID, secondAttempt, "missing-artifact", "sha256:"+strings.Repeat("a", 64)); err == nil || !strings.Contains(err.Error(), "exact signed transaction artifact") {
		t.Fatalf("broadcast state accepted without durable exact signed bytes: %v", err)
	}
	winningRaw := []byte("winning-signed-transaction")
	winningDigest := sha256.Sum256(winningRaw)
	broadcast, err := store.markBroadcastClaim(operation.RequestID, secondAttempt, "winning-signature", "sha256:"+hex.EncodeToString(winningDigest[:]), base64.StdEncoding.EncodeToString(winningRaw))
	if err != nil || broadcast.State != operationBroadcast {
		t.Fatalf("persist winning broadcast before network: %#v err=%v", broadcast, err)
	}
	if _, _, claimed, err := store.claimReservedOperation(operation.RequestID); err != nil || claimed {
		t.Fatalf("broadcast operation must never be reclaimed, claimed=%v err=%v", claimed, err)
	}
	unknown, err := store.markUnknown(operation.RequestID, errors.New("ambiguous RPC result"))
	if err != nil || unknown.State != operationUnknown {
		t.Fatalf("persist ambiguous broadcast: %#v err=%v", unknown, err)
	}
	now = now.Add(24 * time.Hour)
	if _, _, claimed, err := store.claimReservedOperation(operation.RequestID); err != nil || claimed {
		t.Fatalf("ambiguous operation must never be reclaimed or rebroadcast, claimed=%v err=%v", claimed, err)
	}
}

func TestSignerV2ReservationsSurviveRestart(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "state.db")
	masterKeyPath := filepath.Join(dir, "master.key")
	destination := solana.NewWallet().PublicKey().String()
	store, err := openSignerStoreV2(dbPath)
	if err != nil {
		t.Fatalf("open signer store: %v", err)
	}
	keys, err := openSignerKeyManagerV2(store, masterKeyPath)
	if err != nil {
		t.Fatalf("open signer keys: %v", err)
	}
	now := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	_, policy, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{
		WalletID:        "agent",
		ExpectedVersion: 0,
		Policy:          testSignerPolicyV2("agent", destination, 100, 100),
	})
	if err != nil {
		t.Fatalf("create signer wallet: %v", err)
	}
	intent, err := normalizeSignerIntentV2(signerIntentV2{
		Type:        intentSolanaNativeTransfer,
		Destination: destination,
		Lamports:    "75",
	})
	if err != nil {
		t.Fatalf("normalize intent: %v", err)
	}
	operation, _, err := store.reserveOperation(signerExecuteRequestV2{
		RequestID:      "restart-request",
		PolicyHash:     policy.Hash,
		Intent:         intent.Intent,
		intentWalletID: "agent",
	}, intent)
	if err != nil {
		t.Fatalf("reserve operation: %v", err)
	}
	operation, err = store.markBroadcast(operation.RequestID, "signature", []byte("signed-restart-transaction"))
	if err != nil {
		t.Fatalf("mark broadcast: %v", err)
	}
	operation, err = store.markUnknown(operation.RequestID, errors.New("timeout"))
	if err != nil {
		t.Fatalf("mark unknown: %v", err)
	}
	keys.Close()
	if err := store.Close(); err != nil {
		t.Fatalf("close signer store: %v", err)
	}

	reopened, err := openSignerStoreV2(dbPath)
	if err != nil {
		t.Fatalf("reopen signer store: %v", err)
	}
	defer reopened.Close()
	reopened.now = func() time.Time { return now }
	persisted, err := reopened.getOperation(operation.RequestID)
	if err != nil || persisted.State != operationUnknown || !persisted.ReservationActive {
		t.Fatalf("unexpected persisted operation: %#v err=%v", persisted, err)
	}
	usage, err := reopened.dailyUsage("agent", "solana:native", now)
	if expected := new(big.Int).Add(big.NewInt(75), new(big.Int).SetUint64(signerNativeFeeReservationV2)); err != nil || usage.Cmp(expected) != 0 {
		t.Fatalf("expected durable principal+fee cap usage %v, got %v err=%v", expected, usage, err)
	}
}

func TestSignerV2PolicyChangeRevokesUnbroadcastReservation(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	_, policy := createTestSignerWalletV2(t, store, keys, "agent", destination, 100, 100)
	intent, err := normalizeSignerIntentV2(signerIntentV2{
		Type:        intentSolanaNativeTransfer,
		Destination: destination,
		Lamports:    "50",
	})
	if err != nil {
		t.Fatalf("normalize intent: %v", err)
	}
	req := signerExecuteRequestV2{
		RequestID:      "revoked-request",
		PolicyHash:     policy.Hash,
		Intent:         intent.Intent,
		intentWalletID: "agent",
	}
	if _, _, err := store.reserveOperation(req, intent); err != nil {
		t.Fatalf("reserve operation: %v", err)
	}
	denyAll := signerPolicyV2{WalletID: "agent", Role: "agent"}
	if _, err := store.putPolicy(denyAll, 1); err != nil {
		t.Fatalf("replace policy with deny-all: %v", err)
	}
	operation, existing, err := store.reserveOperation(req, intent)
	if err != nil || !existing {
		t.Fatalf("look up revoked reservation: existing=%v err=%v", existing, err)
	}
	if operation.State != operationFailed || operation.ReservationActive {
		t.Fatalf("policy change did not revoke reservation: %#v", operation)
	}
	usage, err := store.dailyUsage("agent", "solana:native", store.now())
	if err != nil || usage.Sign() != 0 {
		t.Fatalf("revoked reservation did not release cap: %v err=%v", usage, err)
	}
}

func TestSignerV2PreUpgradePrimaryOnlyReservationCannotExecute(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	wallet, policy := createTestSignerWalletV2(t, store, keys, "agent-legacy-reservation", destination, 100, 1000)
	intent, err := normalizeSignerIntentV2(signerIntentV2{
		Type: intentSolanaNativeTransfer, Destination: destination, Lamports: "25",
	})
	if err != nil {
		t.Fatal(err)
	}
	day := currentDayBucket(store.now())
	request := signerExecuteRequestV2{
		RequestID: "legacy-primary-only", PolicyHash: policy.Hash, Intent: intent.Intent, intentWalletID: wallet.WalletID,
	}
	legacy := signerOperationV2{
		RequestID: request.RequestID, WalletID: request.intentWalletID, IntentType: intent.Intent.Type,
		IntentDigest: intent.Digest, PolicyHash: policy.Hash, Asset: intent.Asset, Amount: intent.Amount.String(),
		State: operationReserved, ReservationActive: true, UsageBucket: day,
		ReservedAt: timestampV2(store.now()), UpdatedAt: timestampV2(store.now()),
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		encoded, err := json.Marshal(legacy)
		if err != nil {
			return err
		}
		if err := tx.Bucket(bucketSignerUsageV2).Put(dailyUsageKeyV2(legacy.WalletID, legacy.Asset, day), []byte(legacy.Amount)); err != nil {
			return err
		}
		return tx.Bucket(bucketSignerOperationsV2).Put([]byte(legacy.RequestID), encoded)
	}); err != nil {
		t.Fatal(err)
	}
	operation, existing, err := store.reserveOperation(request, intent)
	if err != nil || !existing || operation.State != operationFailed || operation.ReservationActive || !strings.Contains(operation.Error, "pre-upgrade") {
		t.Fatalf("legacy primary-only reservation was grandfathered into execution: %#v existing=%v err=%v", operation, existing, err)
	}
	if usage, err := store.dailyUsage(legacy.WalletID, legacy.Asset, store.now()); err != nil || usage.Sign() != 0 {
		t.Fatalf("legacy unbroadcast principal reservation was not released: usage=%v err=%v", usage, err)
	}

	legacy.RequestID = "legacy-already-broadcast"
	legacy.State = operationBroadcast
	legacy.Signature = "legacy-signature"
	legacy.TransactionDigest = "sha256:" + strings.Repeat("a", 64)
	if err := store.db.Update(func(tx *bolt.Tx) error {
		encoded, err := json.Marshal(legacy)
		if err != nil {
			return err
		}
		if err := tx.Bucket(bucketSignerUsageV2).Put(dailyUsageKeyV2(legacy.WalletID, legacy.Asset, day), []byte(legacy.Amount)); err != nil {
			return err
		}
		return tx.Bucket(bucketSignerOperationsV2).Put([]byte(legacy.RequestID), encoded)
	}); err != nil {
		t.Fatal(err)
	}
	request.RequestID = legacy.RequestID
	operation, existing, err = store.reserveOperation(request, intent)
	if err != nil || !existing || operation.State != operationBroadcast || !operation.ReservationActive {
		t.Fatalf("ambiguous legacy broadcast accounting was incorrectly released: %#v existing=%v err=%v", operation, existing, err)
	}
}

func TestSignerV2BuildsOnlyTypedNativeAndSPLInstructions(t *testing.T) {
	from := solana.NewWallet().PublicKey()
	destination := solana.NewWallet().PublicKey()
	native, err := normalizeSignerIntentV2(signerIntentV2{
		Type:        intentSolanaNativeTransfer,
		Destination: destination.String(),
		Lamports:    "42",
	})
	if err != nil {
		t.Fatalf("normalize native intent: %v", err)
	}
	nativeInstructions, err := buildTypedInstructionsV2(from, native, nil)
	if err != nil || len(nativeInstructions) != 1 {
		t.Fatalf("build typed native instruction: count=%d err=%v", len(nativeInstructions), err)
	}
	nativeData, _ := nativeInstructions[0].Data()
	if nativeInstructions[0].ProgramID() != solana.SystemProgramID || binary.LittleEndian.Uint64(nativeData[4:12]) != 42 {
		t.Fatalf("unexpected native instruction: program=%s data=%x", nativeInstructions[0].ProgramID(), nativeData)
	}

	mint := solana.NewWallet().PublicKey()
	spl, err := normalizeSignerIntentV2(signerIntentV2{
		Type:         intentSolanaSPLTransferChecked,
		Destination:  destination.String(),
		TokenProgram: solana.TokenProgramID.String(),
		Mint:         mint.String(),
		Amount:       "1234",
	})
	if err != nil {
		t.Fatalf("normalize SPL intent: %v", err)
	}
	decimals := uint8(6)
	splInstructions, err := buildTypedInstructionsV2(from, spl, &decimals)
	if err != nil || len(splInstructions) != 2 {
		t.Fatalf("build typed SPL instructions: count=%d err=%v", len(splInstructions), err)
	}
	if splInstructions[0].ProgramID() != solana.SPLAssociatedTokenAccountProgramID {
		t.Fatalf("typed SPL transfer omitted canonical ATA creation: %s", splInstructions[0].ProgramID())
	}
	createData, _ := splInstructions[0].Data()
	if !bytes.Equal(createData, []byte{1}) {
		t.Fatalf("typed SPL transfer must use CreateIdempotent, got %x", createData)
	}
	if splInstructions[1].ProgramID() != solana.TokenProgramID {
		t.Fatalf("typed SPL transfer uses the wrong token program: %s", splInstructions[1].ProgramID())
	}
	transferData, _ := splInstructions[1].Data()
	if len(transferData) != 10 || transferData[0] != 12 || binary.LittleEndian.Uint64(transferData[1:9]) != 1234 || transferData[9] != decimals {
		t.Fatalf("unexpected transferChecked data: %x", transferData)
	}
	sourceATA, _ := findAssociatedTokenAddressV2(from, mint, solana.TokenProgramID)
	destinationATA, _ := findAssociatedTokenAddressV2(destination, mint, solana.TokenProgramID)
	createAccounts := splInstructions[0].Accounts()
	if len(createAccounts) != 6 || createAccounts[0].PublicKey != from || !createAccounts[0].IsSigner || !createAccounts[0].IsWritable ||
		createAccounts[1].PublicKey != destinationATA || !createAccounts[1].IsWritable ||
		createAccounts[2].PublicKey != destination || createAccounts[3].PublicKey != mint ||
		createAccounts[4].PublicKey != solana.SystemProgramID || createAccounts[5].PublicKey != solana.TokenProgramID {
		t.Fatalf("typed SPL ATA accounts were not signer-derived: %#v", createAccounts)
	}
	accounts := splInstructions[1].Accounts()
	if len(accounts) != 4 || accounts[0].PublicKey != sourceATA || accounts[2].PublicKey != destinationATA || accounts[3].PublicKey != from || !accounts[3].IsSigner {
		t.Fatalf("typed SPL accounts were not signer-derived: %#v", accounts)
	}
	if !containsStringV2(spl.RequiredPrograms, solana.SystemProgramID.String()) ||
		!containsStringV2(spl.RequiredPrograms, solana.SPLAssociatedTokenAccountProgramID.String()) ||
		!containsStringV2(spl.RequiredPrograms, solana.TokenProgramID.String()) || len(spl.RequiredPrograms) != 3 {
		t.Fatalf("typed SPL policy omitted exact required programs: %#v", spl.RequiredPrograms)
	}
}

func TestSignerV2SPLTransferAllowsMissingDestinationATAOnly(t *testing.T) {
	owner := solana.NewWallet().PublicKey()
	destinationOwner := solana.NewWallet().PublicKey()
	mint := solana.NewWallet().PublicKey()
	source := splTokenTestAccountV2(mint, owner, 99)
	if err := validateSPLTransferAccountResponseV2(
		[]*rpc.Account{source, nil}, owner, destinationOwner, mint, solana.TokenProgramID,
	); err != nil {
		t.Fatalf("first transfer to a missing canonical destination ATA must be allowed: %v", err)
	}
	if err := validateSPLTransferAccountResponseV2(
		[]*rpc.Account{nil, nil}, owner, destinationOwner, mint, solana.TokenProgramID,
	); err == nil || !strings.Contains(err.Error(), "existing canonical source") {
		t.Fatalf("missing source ATA must fail closed, got %v", err)
	}
	wrongDestination := splTokenTestAccountV2(mint, owner, 0)
	if err := validateSPLTransferAccountResponseV2(
		[]*rpc.Account{source, wrongDestination}, owner, destinationOwner, mint, solana.TokenProgramID,
	); err == nil || !strings.Contains(err.Error(), "wrong mint, owner, or token program") {
		t.Fatalf("wrong existing destination ATA must fail closed, got %v", err)
	}
}

func TestSignerV2SocketModeRejectsWorldAccess(t *testing.T) {
	if _, err := parseModeV2("0666"); err == nil {
		t.Fatal("expected world-accessible signer socket mode to be rejected")
	}
	mode, err := parseModeV2("0660")
	if err != nil || mode != 0o660 {
		t.Fatalf("expected private-group socket mode, got %o err=%v", mode, err)
	}
}

func TestSignerV2CreatesPrivateApplicationSocket(t *testing.T) {
	socketPath := filepath.Join(signerAdminShortTempDir(t), "app.sock")
	listener, err := listenUnixSocketV2(socketPath, 0o600, "")
	if err != nil {
		t.Fatalf("listen on signer application socket: %v", err)
	}
	defer listener.Close()
	defer os.Remove(socketPath)
	info, err := os.Lstat(socketPath)
	if err != nil {
		t.Fatalf("inspect signer application socket: %v", err)
	}
	if info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0o600 {
		t.Fatalf("unexpected signer application socket mode: %v", info.Mode())
	}
}
