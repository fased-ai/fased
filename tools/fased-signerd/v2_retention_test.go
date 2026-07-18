package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

func TestSignerStateRetentionCompactsTerminalArtifactsAndPrunesTransientState(t *testing.T) {
	store, _ := openTestSignerV2(t)
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	operation := signerOperationV2{
		RequestID: "terminal-operation", WalletID: "agent", IntentDigest: "sha256:test",
		PolicyHash: "sha256:policy", Asset: "solana:native", Amount: "1",
		State: operationConfirmed, SignedTxBase64: "sensitive-signed-bytes",
		AuthorizationProof: "single-use-proof", UpdatedAt: timestampV2(now.Add(-time.Hour)),
	}
	review := signerReviewV2{
		RequestID: "expired-review", WalletID: "agent", State: jupiterReviewPreparedV2,
		UpdatedAt: timestampV2(now.Add(-48 * time.Hour)),
		ExpiresAt: timestampV2(now.Add(-47 * time.Hour)),
	}
	workflow := signerJupiterTriggerWorkflowV2{
		RequestID: "terminal-workflow", WalletID: "agent", Phase: triggerPhaseConfirmedV2,
		SemanticIntent:   json.RawMessage(`{"type":"secret-shaped-request"}`),
		UnsignedTxBase64: "unsigned-transaction", UpdatedAt: timestampV2(now.Add(-31 * 24 * time.Hour)),
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		put := func(bucket []byte, key string, value any) error {
			encoded, err := json.Marshal(value)
			if err != nil {
				return err
			}
			return tx.Bucket(bucket).Put([]byte(key), encoded)
		}
		if err := put(bucketSignerOperationsV2, operation.RequestID, operation); err != nil {
			return err
		}
		if err := put(bucketSignerReviewsV2, review.RequestID, review); err != nil {
			return err
		}
		if err := put(bucketSignerJupiterTriggerV2, workflow.RequestID, workflow); err != nil {
			return err
		}
		return tx.Bucket(bucketSignerUsageV2).Put(
			dailyUsageKeyV2("agent", "solana:native", "2026-06-01"),
			[]byte("10"),
		)
	}); err != nil {
		t.Fatal(err)
	}

	if err := store.maintainStateV2(); err != nil {
		t.Fatal(err)
	}
	if err := store.db.View(func(tx *bolt.Tx) error {
		var compacted signerOperationV2
		if err := json.Unmarshal(
			tx.Bucket(bucketSignerOperationsV2).Get([]byte(operation.RequestID)),
			&compacted,
		); err != nil {
			return err
		}
		if compacted.SignedTxBase64 != "" || compacted.AuthorizationProof != operation.AuthorizationProof || compacted.IntentDigest != operation.IntentDigest {
			return errors.New("terminal operation did not retain only its durable idempotency evidence")
		}
		if tx.Bucket(bucketSignerReviewsV2).Get([]byte(review.RequestID)) != nil {
			return errors.New("expired signer review was retained")
		}
		if tx.Bucket(bucketSignerUsageV2).Get(dailyUsageKeyV2("agent", "solana:native", "2026-06-01")) != nil {
			return errors.New("old daily usage bucket was retained")
		}
		if tx.Bucket(bucketSignerJupiterTriggerV2).Get([]byte(workflow.RequestID)) != nil {
			return errors.New("expired terminal Trigger workflow was retained")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestSignerStateRetentionExpiresReservedOperationsAtUTCDayBoundary(t *testing.T) {
	store, keys := openTestSignerV2(t)
	destination := solana.NewWallet().PublicKey().String()
	dayOne := time.Date(2026, 7, 17, 23, 59, 0, 0, time.UTC)
	store.now = func() time.Time { return dayOne }
	_, policy := createTestSignerWalletV2(t, store, keys, "agent-day-boundary", destination, 100, 1_000_000)
	intent, err := normalizeSignerIntentV2(signerIntentV2{
		Type: intentSolanaNativeTransfer, Destination: destination, Lamports: "25",
	})
	if err != nil {
		t.Fatal(err)
	}
	request := signerExecuteRequestV2{
		RequestID: "day-boundary-reservation", PolicyHash: policy.Hash,
		Intent: intent.Intent, intentWalletID: "agent-day-boundary",
	}
	reserved, existing, err := store.reserveOperation(request, intent)
	if err != nil || existing || !reserved.ReservationActive {
		t.Fatalf("reserve prior-day operation: %#v existing=%v err=%v", reserved, existing, err)
	}
	store.now = func() time.Time { return dayOne.Add(2 * time.Minute) }
	if err := store.maintainStateV2(); err != nil {
		t.Fatal(err)
	}
	expired, err := store.getOperation(request.RequestID)
	if err != nil || expired.State != operationFailed || expired.ReservationActive ||
		!strings.Contains(expired.Error, "UTC day boundary") {
		t.Fatalf("prior-day reservation did not fail closed: %#v err=%v", expired, err)
	}
	for _, reservation := range reserved.Reservations {
		if usage, err := store.dailyUsage(reserved.WalletID, reservation.Asset, dayOne); err != nil || usage.Sign() != 0 {
			t.Fatalf("prior-day %s reservation was not released: usage=%v err=%v", reservation.Asset, usage, err)
		}
	}
	if _, _, claimed, err := store.claimReservedOperation(request.RequestID); err != nil || claimed {
		t.Fatalf("expired reservation became executable: claimed=%v err=%v", claimed, err)
	}
}

func TestRequireBucketCapacityV2FailsClosed(t *testing.T) {
	store, _ := openTestSignerV2(t)
	put := func(key string) error {
		return store.db.Update(func(tx *bolt.Tx) error {
			return tx.Bucket(bucketSignerOperationsV2).Put([]byte(key), []byte("value"))
		})
	}
	if err := put("one"); err != nil {
		t.Fatal(err)
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		return requireBucketCapacityV2(tx.Bucket(bucketSignerOperationsV2), 2, "test operation store")
	}); err != nil {
		t.Fatal(err)
	}
	if err := put("two"); err != nil {
		t.Fatal(err)
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSignerOperationsV2)
		err := requireBucketCapacityV2(bucket, 2, "test operation store")
		if err == nil || err.Error() != "test operation store reached its durable safety limit" {
			t.Fatalf("expected fail-closed capacity error, got %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestSignerTerminalOperationsMoveToReplaySafeArchive(t *testing.T) {
	store, keys := openTestSignerV2(t)
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	destination := solana.NewWallet().PublicKey().String()
	_, policy := createTestSignerWalletV2(t, store, keys, "agent-archive", destination, 100, 1_000_000)
	store.now = func() time.Time { return now }
	intent, err := normalizeSignerIntentV2(signerIntentV2{
		Type: intentSolanaNativeTransfer, Destination: destination, Lamports: "25",
	})
	if err != nil {
		t.Fatal(err)
	}
	request := signerExecuteRequestV2{
		RequestID: "archived-request-id", PolicyHash: policy.Hash,
		Intent: intent.Intent, intentWalletID: "agent-archive",
	}
	operation := signerOperationV2{
		RequestID: request.RequestID, WalletID: request.intentWalletID,
		IntentType: intent.Intent.Type, IntentDigest: intent.Digest, PolicyHash: policy.Hash,
		Asset: intent.Asset, Amount: intent.Amount.String(), State: operationConfirmed,
		UpdatedAt: timestampV2(now.Add(-signerOperationRetentionV2 - time.Hour)),
	}
	encoded, err := json.Marshal(operation)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSignerOperationsV2).Put([]byte(operation.RequestID), encoded)
	}); err != nil {
		t.Fatal(err)
	}

	if err := store.maintainStateV2(); err != nil {
		t.Fatal(err)
	}
	if err := store.db.View(func(tx *bolt.Tx) error {
		live := tx.Bucket(bucketSignerOperationsV2).Get([]byte(operation.RequestID))
		archived := tx.Bucket(bucketSignerOperationArchiveV2).Get(operationReplayArchiveKeyV2(operation.RequestID))
		if live != nil || archived == nil {
			return fmt.Errorf("terminal operation archive mismatch: live=%t archived=%t", live != nil, archived != nil)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.reserveOperation(request, intent); err == nil || !strings.Contains(err.Error(), "durable replay archive") {
		t.Fatalf("archived requestId was reusable: %v", err)
	}
	health, err := store.stateHealthV2()
	if err != nil || health.Operations != 0 || health.OperationReplayArchive != 1 {
		t.Fatalf("unexpected archived state health: %#v err=%v", health, err)
	}
}

func TestSignerCapacityWarningsStartAtEightyPercent(t *testing.T) {
	below := signerCapacityV2(79, 100)
	at := signerCapacityV2(80, 100)
	if below.WarnAt != 80 || below.Warning || at.WarnAt != 80 || !at.Warning {
		t.Fatalf("unexpected capacity warning boundary: below=%#v at=%#v", below, at)
	}
}
