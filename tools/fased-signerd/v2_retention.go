package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

const (
	maxSignerWalletsV2          = 64
	maxSignerOperationsV2       = 100_000
	maxSignerOperationArchiveV2 = 1_000_000
	maxSignerReviewsV2          = 10_000
	maxSignerTriggerWorkflowsV2 = 10_000
	signerCapacityWarnPercentV2 = 80
	signerUsageRetentionV2      = 14 * 24 * time.Hour
	signerOperationRetentionV2  = 90 * 24 * time.Hour
	signerReviewRetentionV2     = 30 * 24 * time.Hour
	signerWorkflowRetentionV2   = 30 * 24 * time.Hour
	signerRetentionIntervalV2   = time.Hour
)

type signerCapacityHealthV2 struct {
	Used    int  `json:"used"`
	Maximum int  `json:"maximum"`
	WarnAt  int  `json:"warnAt"`
	Warning bool `json:"warning"`
}

type signerStateHealthV2 struct {
	DatabaseBytes          int64                             `json:"databaseBytes"`
	Wallets                int                               `json:"wallets"`
	Operations             int                               `json:"operations"`
	OperationReplayArchive int                               `json:"operationReplayArchive"`
	Reviews                int                               `json:"reviews"`
	TriggerWorkflows       int                               `json:"triggerWorkflows"`
	DailyUsage             int                               `json:"dailyUsageBuckets"`
	Capacities             map[string]signerCapacityHealthV2 `json:"capacities"`
	CapacityWarnings       []string                          `json:"capacityWarnings"`
}

func (s *signerStoreV2) stateHealthV2() (signerStateHealthV2, error) {
	if s == nil || s.db == nil {
		return signerStateHealthV2{}, errors.New("signer state database is unavailable")
	}
	var result signerStateHealthV2
	err := s.db.View(func(tx *bolt.Tx) error {
		result.DatabaseBytes = tx.Size()
		result.Wallets = bucketKeyCountV2(tx.Bucket(bucketSignerWalletsV2))
		result.Operations = bucketKeyCountV2(tx.Bucket(bucketSignerOperationsV2))
		result.OperationReplayArchive = bucketKeyCountV2(tx.Bucket(bucketSignerOperationArchiveV2))
		result.Reviews = bucketKeyCountV2(tx.Bucket(bucketSignerReviewsV2))
		result.TriggerWorkflows = bucketKeyCountV2(tx.Bucket(bucketSignerJupiterTriggerV2))
		result.DailyUsage = bucketKeyCountV2(tx.Bucket(bucketSignerUsageV2))
		return nil
	})
	result.Capacities = map[string]signerCapacityHealthV2{
		"wallets":                signerCapacityV2(result.Wallets, maxSignerWalletsV2),
		"operations":             signerCapacityV2(result.Operations, maxSignerOperationsV2),
		"operationReplayArchive": signerCapacityV2(result.OperationReplayArchive, maxSignerOperationArchiveV2),
		"reviews":                signerCapacityV2(result.Reviews, maxSignerReviewsV2),
		"triggerWorkflows":       signerCapacityV2(result.TriggerWorkflows, maxSignerTriggerWorkflowsV2),
	}
	result.CapacityWarnings = make([]string, 0)
	for _, label := range []string{"wallets", "operations", "operationReplayArchive", "reviews", "triggerWorkflows"} {
		capacity := result.Capacities[label]
		if capacity.Warning {
			result.CapacityWarnings = append(result.CapacityWarnings, fmt.Sprintf(
				"%s signer state is at %d/%d records; investigate retention and archive readiness before the fail-closed limit",
				label,
				capacity.Used,
				capacity.Maximum,
			))
		}
	}
	return result, err
}

func signerCapacityV2(used, maximum int) signerCapacityHealthV2 {
	warnAt := (maximum*signerCapacityWarnPercentV2 + 99) / 100
	return signerCapacityHealthV2{
		Used: used, Maximum: maximum, WarnAt: warnAt, Warning: used >= warnAt,
	}
}

func bucketKeyCountV2(bucket *bolt.Bucket) int {
	if bucket == nil {
		return 0
	}
	return bucket.Stats().KeyN
}

func requireBucketCapacityV2(bucket *bolt.Bucket, maximum int, label string) error {
	if bucketKeyCountV2(bucket) >= maximum {
		return errors.New(label + " reached its durable safety limit")
	}
	return nil
}

func operationReplayArchiveKeyV2(requestID string) []byte {
	digest := sha256.Sum256([]byte(requestID))
	return digest[:]
}

func reservationUsesPriorDayV2(operation signerOperationV2, today string) bool {
	if !operation.ReservationActive || operation.State != operationReserved {
		return false
	}
	if len(operation.Reservations) == 0 {
		return strings.TrimSpace(operation.UsageBucket) != today
	}
	for _, reservation := range operation.Reservations {
		if strings.TrimSpace(reservation.UsageBucket) != today {
			return true
		}
	}
	return false
}

func expirePriorDayReservationV2(tx *bolt.Tx, operation *signerOperationV2, now time.Time) (bool, error) {
	if operation == nil || !reservationUsesPriorDayV2(*operation, currentDayBucket(now)) {
		return false, nil
	}
	if err := releaseUsageReservationV2(tx, *operation); err != nil {
		return false, err
	}
	operation.ReservationActive = false
	operation.State = operationFailed
	operation.Error = "signer reservation expired at the UTC day boundary; submit a new requestId"
	operation.ExecutionLeaseUntil = ""
	operation.UpdatedAt = timestampV2(now)
	return true, nil
}

// maintainStateV2 runs only inside signer-owned bbolt transactions. Operation
// request IDs remain durable idempotency tombstones, but terminal Trigger
// workflow payloads are deleted after their result has been copied into the
// operation tombstone. Broadcast/unknown signed bytes remain available for
// reconciliation. A reserved operation may not cross a UTC accounting day.
func (s *signerStoreV2) maintainStateV2() error {
	return s.maintainStateAtV2(true)
}

func (s *signerStoreV2) maintainStateIfDueV2() error {
	return s.maintainStateAtV2(false)
}

func (s *signerStoreV2) maintainStateAtV2(force bool) error {
	if s == nil || s.db == nil {
		return errors.New("signer state database is unavailable")
	}
	now := s.now().UTC()
	s.retentionMu.Lock()
	defer s.retentionMu.Unlock()
	if !force && !s.lastRetention.IsZero() {
		elapsed := now.Sub(s.lastRetention)
		if elapsed >= 0 && elapsed < signerRetentionIntervalV2 {
			return nil
		}
	}
	err := s.db.Update(func(tx *bolt.Tx) error {
		operations := tx.Bucket(bucketSignerOperationsV2)
		archive := tx.Bucket(bucketSignerOperationArchiveV2)
		archivedOperationKeys := make([][]byte, 0)
		cursor := operations.Cursor()
		for key, raw := cursor.First(); key != nil; key, raw = cursor.Next() {
			var operation signerOperationV2
			if err := json.Unmarshal(raw, &operation); err != nil {
				return errors.New("invalid stored signer operation during retention")
			}
			expired, err := expirePriorDayReservationV2(tx, &operation, now)
			if err != nil {
				return err
			}
			if expired {
				encoded, err := json.Marshal(operation)
				if err != nil {
					return err
				}
				if err := operations.Put(key, encoded); err != nil {
					return err
				}
			}
			if operation.State != operationConfirmed && operation.State != operationFailed {
				continue
			}
			updatedAt, err := time.Parse(time.RFC3339Nano, operation.UpdatedAt)
			if err != nil {
				return errors.New("invalid stored signer operation timestamp during retention")
			}
			if now.Sub(updatedAt) > signerOperationRetentionV2 {
				operationKey := []byte(operation.RequestID)
				archiveKey := operationReplayArchiveKeyV2(operation.RequestID)
				if archive.Get(archiveKey) == nil {
					if err := requireBucketCapacityV2(archive, maxSignerOperationArchiveV2, "signer operation replay archive"); err != nil {
						return err
					}
					if err := archive.Put(archiveKey, []byte{1}); err != nil {
						return err
					}
				}
				archivedOperationKeys = append(archivedOperationKeys, operationKey)
				continue
			}
			if operation.SignedTxBase64 != "" {
				operation.SignedTxBase64 = ""
				encoded, err := json.Marshal(operation)
				if err != nil {
					return err
				}
				if err := operations.Put(key, encoded); err != nil {
					return err
				}
			}
		}
		for _, key := range archivedOperationKeys {
			if err := operations.Delete(key); err != nil {
				return err
			}
		}

		reviews := tx.Bucket(bucketSignerReviewsV2)
		reviewCursor := reviews.Cursor()
		for key, raw := reviewCursor.First(); key != nil; key, raw = reviewCursor.Next() {
			var review signerReviewV2
			if err := json.Unmarshal(raw, &review); err != nil {
				return errors.New("invalid stored signer review during retention")
			}
			updatedAt, updatedErr := time.Parse(time.RFC3339Nano, review.UpdatedAt)
			expiresAt, expiresErr := time.Parse(time.RFC3339Nano, review.ExpiresAt)
			deleteReview :=
				(updatedErr == nil && review.State == jupiterReviewSignedV2 && now.Sub(updatedAt) > signerReviewRetentionV2) ||
					(expiresErr == nil && now.After(expiresAt) && now.Sub(expiresAt) > 24*time.Hour)
			if deleteReview {
				if err := reviewCursor.Delete(); err != nil {
					return err
				}
			}
		}

		usage := tx.Bucket(bucketSignerUsageV2)
		usageCursor := usage.Cursor()
		for key, _ := usageCursor.First(); key != nil; key, _ = usageCursor.Next() {
			parts := bytes.Split(key, []byte{0})
			if len(parts) != 3 {
				return errors.New("invalid durable signer usage key")
			}
			day, err := time.Parse("2006-01-02", string(parts[2]))
			if err != nil {
				return errors.New("invalid durable signer usage day")
			}
			if now.Sub(day) > signerUsageRetentionV2 {
				if err := usageCursor.Delete(); err != nil {
					return err
				}
			}
		}

		workflows := tx.Bucket(bucketSignerJupiterTriggerV2)
		workflowCursor := workflows.Cursor()
		for key, raw := workflowCursor.First(); key != nil; key, raw = workflowCursor.Next() {
			var workflow signerJupiterTriggerWorkflowV2
			if err := json.Unmarshal(raw, &workflow); err != nil {
				return errors.New("invalid stored Jupiter Trigger workflow during retention")
			}
			if workflow.Phase != triggerPhaseConfirmedV2 && workflow.Phase != triggerPhaseFailedV2 {
				continue
			}
			updatedAt, err := time.Parse(time.RFC3339Nano, workflow.UpdatedAt)
			if err != nil {
				return errors.New("invalid stored Jupiter Trigger workflow timestamp during retention")
			}
			if now.Sub(updatedAt) > signerWorkflowRetentionV2 {
				if err := workflowCursor.Delete(); err != nil {
					return err
				}
				continue
			}
			if workflow.UnsignedTxBase64 == "" && len(workflow.SemanticIntent) == 0 {
				continue
			}
			workflow.UnsignedTxBase64 = ""
			workflow.SemanticIntent = nil
			encoded, err := json.Marshal(workflow)
			if err != nil {
				return err
			}
			if err := workflows.Put(key, encoded); err != nil {
				return err
			}
		}
		return nil
	})
	if err == nil {
		s.lastRetention = now
	}
	return err
}
