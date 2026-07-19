package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	bolt "go.etcd.io/bbolt"
)

var (
	bucketSignerMetaV2                = []byte("meta")
	bucketSignerPoliciesV2            = []byte("policies")
	bucketSignerOperationsV2          = []byte("operations")
	bucketSignerOperationArchiveV2    = []byte("operation-replay-archive")
	bucketSignerUsageV2               = []byte("daily-usage")
	bucketSignerWalletsV2             = []byte("wallets")
	bucketSignerNetworksV2            = []byte("networks")
	bucketSignerWebAuthnCredentialsV2 = []byte("webauthn-credentials")
	bucketSignerWebAuthnChallengesV2  = []byte("webauthn-challenges")
	bucketSignerReviewProofsV2        = []byte("review-authorization-proofs")
	bucketSignerReviewsV2             = []byte("reviews")
	bucketSignerJupiterTriggerV2      = []byte("jupiter-trigger-workflows")
	bucketSignerRotationsV2           = []byte("wallet-rotations")
)

const signerExecutionLeaseV2 = 5 * time.Minute

var errSignerOperationNotFoundV2 = errors.New("signer operation not found")

type signerStoreV2 struct {
	db            *bolt.DB
	now           func() time.Time
	schemaVersion uint64
	retentionMu   sync.Mutex
	lastRetention time.Time
}

func openSignerStoreV2(path string) (*signerStoreV2, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("signer state database path is required")
	}
	path = filepath.Clean(path)
	existed, hadState, err := inspectSignerStateBeforeOpenV2(path)
	if err != nil {
		return nil, err
	}
	if existed && hadState {
		version, err := inspectSignerSchemaReadOnlyV2(path)
		if err != nil {
			return nil, err
		}
		if version > signerStateSchemaVersionV2 {
			return nil, fmt.Errorf(
				"signer state schema %d is newer than supported schema %d; refusing to mutate",
				version,
				signerStateSchemaVersionV2,
			)
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create signer state directory: %w", err)
	}
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: 2 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("open signer state database: %w", err)
	}
	store := &signerStoreV2{db: db, now: time.Now}
	version, err := readSignerSchemaVersionV2(db)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	if version > signerStateSchemaVersionV2 {
		_ = db.Close()
		return nil, fmt.Errorf(
			"signer state schema %d is newer than supported schema %d; refusing to mutate",
			version,
			signerStateSchemaVersionV2,
		)
	}
	if version < signerStateSchemaVersionV2 {
		if hadState {
			if _, err := backupSignerStateBeforeMigrationV2(db, path); err != nil {
				_ = db.Close()
				return nil, err
			}
		}
		if err := migrateSignerStateV2(db, version); err != nil {
			_ = db.Close()
			return nil, err
		}
		if err := syncSignerStateDirectoryV2(filepath.Dir(path)); err != nil {
			_ = db.Close()
			return nil, err
		}
		version = signerStateSchemaVersionV2
	} else if err := validateSignerSchemaBucketsV2(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	store.schemaVersion = version
	if err := store.maintainStateV2(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("maintain signer state retention: %w", err)
	}
	return store, nil
}

func validateSignerStateFileV2(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect signer state database: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errors.New("signer state database must be a regular non-symlink file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return errors.New("signer state database must not be group/world accessible")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
		return fmt.Errorf("signer state database must be owned by uid %d", os.Geteuid())
	}
	return nil
}

func (s *signerStoreV2) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *signerStoreV2) putPolicy(input signerPolicyV2, expectedVersion uint64) (signerPolicyV2, error) {
	if s == nil || s.db == nil {
		return signerPolicyV2{}, errors.New("signer state database is unavailable")
	}
	var stored signerPolicyV2
	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSignerPoliciesV2)
		walletID := normalizeWalletID(input.WalletID)
		retired, err := signerWalletIsRetiredInTxV2(tx, walletID)
		if err != nil {
			return err
		}
		if retired {
			return errors.New("retired signer wallet policy is permanently deny-all")
		}
		if tx.Bucket(bucketSignerWalletsV2).Get([]byte(walletID)) == nil {
			return errors.New("signer wallet not found")
		}
		currentVersion := uint64(0)
		if raw := bucket.Get([]byte(walletID)); raw != nil {
			var current signerPolicyV2
			if err := json.Unmarshal(raw, &current); err != nil {
				return fmt.Errorf("decode current signer policy: %w", err)
			}
			currentVersion = current.Version
			if strings.TrimSpace(input.Role) != "" && strings.ToLower(strings.TrimSpace(input.Role)) != current.Role {
				return errors.New("signer wallet role is immutable")
			}
		}
		if expectedVersion != currentVersion {
			return fmt.Errorf("signer policy version conflict: expected %d, current %d", expectedVersion, currentVersion)
		}
		input.WalletID = walletID
		input.Version = currentVersion + 1
		normalized, err := normalizeSignerPolicyV2(input)
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(normalized)
		if err != nil {
			return err
		}
		if err := bucket.Put([]byte(walletID), encoded); err != nil {
			return err
		}
		stored = normalized
		return nil
	})
	return stored, err
}

func (s *signerStoreV2) getPolicy(walletID string) (signerPolicyV2, error) {
	if s == nil || s.db == nil {
		return signerPolicyV2{}, errors.New("signer state database is unavailable")
	}
	var policy signerPolicyV2
	err := s.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSignerPoliciesV2).Get([]byte(normalizeWalletID(walletID)))
		if raw == nil {
			return errors.New("explicit signer policy required")
		}
		if err := json.Unmarshal(raw, &policy); err != nil {
			return fmt.Errorf("decode signer policy: %w", err)
		}
		return nil
	})
	return policy, err
}

func (s *signerStoreV2) listPolicies() ([]signerPolicyV2, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("signer state database is unavailable")
	}
	policies := []signerPolicyV2{}
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSignerPoliciesV2).ForEach(func(_, raw []byte) error {
			var policy signerPolicyV2
			if err := json.Unmarshal(raw, &policy); err != nil {
				return err
			}
			policies = append(policies, policy)
			return nil
		})
	})
	return policies, err
}

func (s *signerStoreV2) preflightPolicyForIntentV2(req signerExecuteRequestV2, intent normalizedIntentV2) error {
	if s == nil || s.db == nil {
		return errors.New("signer state database is unavailable")
	}
	if _, err := validateRequestIDV2(req.RequestID); err != nil {
		return err
	}
	walletID := normalizeWalletID(req.IntentWalletID())
	return s.db.View(func(tx *bolt.Tx) error {
		rawPolicy := tx.Bucket(bucketSignerPoliciesV2).Get([]byte(walletID))
		if rawPolicy == nil {
			return errors.New("explicit signer policy required")
		}
		var policy signerPolicyV2
		if err := json.Unmarshal(rawPolicy, &policy); err != nil {
			return fmt.Errorf("decode signer policy: %w", err)
		}
		if strings.TrimSpace(req.PolicyHash) == "" || req.PolicyHash != policy.Hash {
			return errors.New("signer policy hash mismatch")
		}
		reservations, err := policyReservationsForIntentV2(policy, intent)
		if err != nil {
			return err
		}
		for _, reservation := range reservations {
			assetPolicy, policyErr := policyAssetByNameV2(policy, reservation.Asset)
			if policyErr != nil {
				return policyErr
			}
			maxDaily, ok := new(big.Int).SetString(assetPolicy.MaxDaily, 10)
			if !ok || maxDaily.Sign() <= 0 {
				return fmt.Errorf("policy daily cap must be positive for %s", reservation.Asset)
			}
		}
		return nil
	})
}

func (s *signerStoreV2) reserveOperation(req signerExecuteRequestV2, intent normalizedIntentV2) (signerOperationV2, bool, error) {
	if s == nil || s.db == nil {
		return signerOperationV2{}, false, errors.New("signer state database is unavailable")
	}
	requestID, err := validateRequestIDV2(req.RequestID)
	if err != nil {
		return signerOperationV2{}, false, err
	}
	if err := s.maintainStateIfDueV2(); err != nil {
		return signerOperationV2{}, false, err
	}
	var liveLedgerAtCapacity bool
	if err := s.db.View(func(tx *bolt.Tx) error {
		liveLedgerAtCapacity = bucketKeyCountV2(tx.Bucket(bucketSignerOperationsV2)) >= maxSignerOperationsV2
		return nil
	}); err != nil {
		return signerOperationV2{}, false, err
	}
	if liveLedgerAtCapacity {
		if err := s.maintainStateV2(); err != nil {
			return signerOperationV2{}, false, err
		}
	}
	walletID := normalizeWalletID(req.IntentWalletID())
	var operation signerOperationV2
	existing := false
	err = s.db.Update(func(tx *bolt.Tx) error {
		operations := tx.Bucket(bucketSignerOperationsV2)
		if raw := operations.Get([]byte(requestID)); raw != nil {
			if err := json.Unmarshal(raw, &operation); err != nil {
				return fmt.Errorf("decode signer operation: %w", err)
			}
			if operation.WalletID != walletID || operation.IntentDigest != intent.Digest || operation.PolicyHash != strings.TrimSpace(req.PolicyHash) {
				return errors.New("requestId is already bound to a different immutable signer request")
			}
			if operation.State == operationReserved && len(operation.Reservations) == 0 {
				// A pre-multi-asset reservation accounted only the semantic
				// principal. It must never be grandfathered into execution without
				// the independent native fee/rent claim introduced by this signer.
				// Broadcast/unknown legacy operations are intentionally left
				// untouched because their outcome may already be on chain.
				if operation.ReservationActive {
					if err := releaseUsageReservationV2(tx, operation); err != nil {
						return err
					}
					operation.ReservationActive = false
				}
				operation.State = operationFailed
				operation.Error = "pre-upgrade signer reservation lacks atomic fee/rent accounting; submit a new requestId"
				operation.ExecutionLeaseUntil = ""
				operation.UpdatedAt = timestampV2(s.now())
				encoded, err := json.Marshal(operation)
				if err != nil {
					return err
				}
				if err := operations.Put([]byte(requestID), encoded); err != nil {
					return err
				}
			} else if operation.State == operationReserved {
				currentPolicyRaw := tx.Bucket(bucketSignerPoliciesV2).Get([]byte(walletID))
				var currentPolicy signerPolicyV2
				policyCurrent := currentPolicyRaw != nil && json.Unmarshal(currentPolicyRaw, &currentPolicy) == nil && currentPolicy.Hash == operation.PolicyHash
				if !policyCurrent {
					if operation.ReservationActive {
						if err := releaseUsageReservationV2(tx, operation); err != nil {
							return err
						}
						operation.ReservationActive = false
					}
					operation.State = operationFailed
					operation.Error = "reserved signer operation policy is no longer current"
					operation.UpdatedAt = timestampV2(s.now())
					encoded, err := json.Marshal(operation)
					if err != nil {
						return err
					}
					if err := operations.Put([]byte(requestID), encoded); err != nil {
						return err
					}
				}
			}
			existing = true
			return nil
		}
		if tx.Bucket(bucketSignerOperationArchiveV2).Get(operationReplayArchiveKeyV2(requestID)) != nil {
			return errors.New("requestId is in the durable replay archive and cannot be reused; submit a new requestId")
		}
		if err := requireBucketCapacityV2(operations, maxSignerOperationsV2, "signer operation store"); err != nil {
			return err
		}
		policies := tx.Bucket(bucketSignerPoliciesV2)
		rawPolicy := policies.Get([]byte(walletID))
		if rawPolicy == nil {
			return errors.New("explicit signer policy required")
		}
		var policy signerPolicyV2
		if err := json.Unmarshal(rawPolicy, &policy); err != nil {
			return fmt.Errorf("decode signer policy: %w", err)
		}
		if strings.TrimSpace(req.PolicyHash) == "" || req.PolicyHash != policy.Hash {
			return errors.New("signer policy hash mismatch")
		}
		reservationRequirements, err := policyReservationsForIntentV2(policy, intent)
		if err != nil {
			return err
		}
		now := s.now()
		usageBucket := currentDayBucket(now)
		usage := tx.Bucket(bucketSignerUsageV2)
		reservations := make([]signerOperationReservationV2, 0, len(reservationRequirements))
		for _, requirement := range reservationRequirements {
			assetPolicy, policyErr := policyAssetByNameV2(policy, requirement.Asset)
			if policyErr != nil {
				return policyErr
			}
			maxDaily, ok := new(big.Int).SetString(assetPolicy.MaxDaily, 10)
			if !ok || maxDaily.Sign() <= 0 {
				return fmt.Errorf("policy daily cap must be positive for %s", requirement.Asset)
			}
			usageKey := dailyUsageKeyV2(walletID, requirement.Asset, usageBucket)
			current := big.NewInt(0)
			if raw := usage.Get(usageKey); raw != nil {
				if _, ok := current.SetString(string(raw), 10); !ok {
					return errors.New("invalid durable signer usage counter")
				}
			}
			next := new(big.Int).Add(current, requirement.Amount)
			if next.Cmp(maxDaily) > 0 {
				return fmt.Errorf("policy daily cap exceeded for %s", requirement.Asset)
			}
			if err := usage.Put(usageKey, []byte(next.String())); err != nil {
				return err
			}
			reservations = append(reservations, signerOperationReservationV2{
				Asset: requirement.Asset, Amount: requirement.Amount.String(), UsageBucket: usageBucket,
			})
		}
		timestamp := timestampV2(now)
		operation = signerOperationV2{
			RequestID:         requestID,
			WalletID:          walletID,
			IntentType:        intent.Intent.Type,
			IntentDigest:      intent.Digest,
			PolicyHash:        policy.Hash,
			Asset:             intent.Asset,
			Amount:            intent.Amount.String(),
			Reservations:      reservations,
			State:             operationReserved,
			ReservationActive: true,
			UsageBucket:       usageBucket,
			ReservedAt:        timestamp,
			UpdatedAt:         timestamp,
		}
		encoded, err := json.Marshal(operation)
		if err != nil {
			return err
		}
		return operations.Put([]byte(requestID), encoded)
	})
	return operation, existing, err
}

// IntentWalletID is populated by the protocol handler immediately before reservation.
// Keeping wallet identity outside the intent prevents callers from presenting conflicting
// wallet IDs in two different fields.
func (r signerExecuteRequestV2) IntentWalletID() string {
	return r.intentWalletID
}

func (s *signerStoreV2) getOperation(requestID string) (signerOperationV2, error) {
	if s == nil || s.db == nil {
		return signerOperationV2{}, errors.New("signer state database is unavailable")
	}
	requestID, err := validateRequestIDV2(requestID)
	if err != nil {
		return signerOperationV2{}, err
	}
	var operation signerOperationV2
	err = s.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSignerOperationsV2).Get([]byte(requestID))
		if raw == nil {
			return errSignerOperationNotFoundV2
		}
		return json.Unmarshal(raw, &operation)
	})
	return operation, err
}

// claimReservedOperation grants one fenced execution attempt. A duplicate caller
// observes the live lease and returns the durable operation without building or
// sending. A later caller may recover a stale pre-broadcast reservation; the
// monotonically increasing attempt prevents the stale worker from persisting a
// broadcast after ownership has moved.
func (s *signerStoreV2) claimReservedOperation(requestID string) (signerOperationV2, uint64, bool, error) {
	if s == nil || s.db == nil {
		return signerOperationV2{}, 0, false, errors.New("signer state database is unavailable")
	}
	var operation signerOperationV2
	claimed := false
	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSignerOperationsV2)
		raw := bucket.Get([]byte(requestID))
		if raw == nil {
			return errors.New("signer operation not found")
		}
		if err := json.Unmarshal(raw, &operation); err != nil {
			return err
		}
		if operation.State != operationReserved {
			return nil
		}
		now := s.now().UTC()
		if expired, err := expirePriorDayReservationV2(tx, &operation, now); err != nil {
			return err
		} else if expired {
			encoded, err := json.Marshal(operation)
			if err != nil {
				return err
			}
			if err := bucket.Put([]byte(requestID), encoded); err != nil {
				return err
			}
			return nil
		}
		if operation.ExecutionLeaseUntil != "" {
			leaseUntil, err := time.Parse(time.RFC3339Nano, operation.ExecutionLeaseUntil)
			if err != nil {
				return errors.New("stored signer execution lease is invalid")
			}
			if leaseUntil.After(now) {
				return nil
			}
		}
		operation.ExecutionAttempt++
		operation.ExecutionLeaseUntil = timestampV2(now.Add(signerExecutionLeaseV2))
		operation.UpdatedAt = timestampV2(now)
		encoded, err := json.Marshal(operation)
		if err != nil {
			return err
		}
		if err := bucket.Put([]byte(requestID), encoded); err != nil {
			return err
		}
		claimed = true
		return nil
	})
	return operation, operation.ExecutionAttempt, claimed, err
}

// releaseReservedOperationClaim makes a transiently blocked exact request
// claimable again without releasing its already-accounted cap reservation.
// The execution-attempt fence prevents an older worker from clearing a newer
// claim.
func (s *signerStoreV2) releaseReservedOperationClaim(requestID string, attempt uint64, cause error) (signerOperationV2, error) {
	return s.updateOperation(requestID, func(operation *signerOperationV2, now string) error {
		if operation.State != operationReserved {
			return fmt.Errorf("cannot release signer execution claim in state %s", operation.State)
		}
		if operation.ExecutionAttempt != attempt {
			return errors.New("stale signer execution attempt cannot release the active claim")
		}
		operation.ExecutionLeaseUntil = ""
		operation.Error = safeOperationErrorV2(cause)
		operation.UpdatedAt = now
		return nil
	})
}

func (s *signerStoreV2) markBroadcast(requestID, signature string, signedRaw []byte) (signerOperationV2, error) {
	if len(signedRaw) == 0 {
		return signerOperationV2{}, errors.New("exact signed transaction bytes are required before broadcast")
	}
	digest := sha256.Sum256(signedRaw)
	return s.markBroadcastClaim(
		requestID,
		0,
		signature,
		"sha256:"+hex.EncodeToString(digest[:]),
		base64.StdEncoding.EncodeToString(signedRaw),
	)
}

func (s *signerStoreV2) markBroadcastClaim(requestID string, attempt uint64, signature, transactionDigest string, signedTxBase64 ...string) (signerOperationV2, error) {
	if len(signedTxBase64) != 1 {
		return signerOperationV2{}, errors.New("exact signed transaction artifact is required before broadcast")
	}
	return s.updateOperation(requestID, func(operation *signerOperationV2, now string) error {
		return applyBroadcastClaimV2(operation, attempt, signature, transactionDigest, signedTxBase64[0], now)
	})
}

func applyBroadcastClaimV2(operation *signerOperationV2, attempt uint64, signature, transactionDigest, signedTxBase64, now string) error {
	if operation.State != operationReserved {
		return fmt.Errorf("cannot broadcast signer operation in state %s", operation.State)
	}
	if attempt != 0 && operation.ExecutionAttempt != attempt {
		return errors.New("stale signer execution attempt cannot broadcast")
	}
	if strings.TrimSpace(signature) == "" {
		return errors.New("transaction signature is required before broadcast")
	}
	if !strings.HasPrefix(strings.TrimSpace(transactionDigest), "sha256:") {
		return errors.New("transaction digest is required before broadcast")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signedTxBase64))
	if err != nil || len(raw) == 0 || len(raw) > 1644 {
		return errors.New("signed transaction artifact is invalid")
	}
	digest := sha256.Sum256(raw)
	if "sha256:"+hex.EncodeToString(digest[:]) != strings.TrimSpace(transactionDigest) {
		return errors.New("signed transaction artifact digest mismatch")
	}
	operation.SignedTxBase64 = strings.TrimSpace(signedTxBase64)
	operation.State = operationBroadcast
	operation.Signature = strings.TrimSpace(signature)
	operation.TransactionDigest = strings.TrimSpace(transactionDigest)
	operation.BroadcastAt = now
	operation.UpdatedAt = now
	operation.ExecutionLeaseUntil = ""
	return nil
}

func (s *signerStoreV2) markConfirmed(requestID string) (signerOperationV2, error) {
	return s.updateOperation(requestID, func(operation *signerOperationV2, now string) error {
		if operation.State != operationBroadcast && operation.State != operationUnknown {
			return fmt.Errorf("cannot confirm signer operation in state %s", operation.State)
		}
		operation.State = operationConfirmed
		operation.SignedTxBase64 = ""
		operation.Error = ""
		operation.ConfirmedAt = now
		operation.UpdatedAt = now
		return nil
	})
}

// markCompletedClaim atomically records a deterministic, non-broadcast
// reviewed result such as a domain-separated federation signature. It keeps
// the same durable cap reservation semantics without pretending an off-chain
// signature was submitted to Solana.
func (s *signerStoreV2) markCompletedClaim(requestID string, attempt uint64, signature, artifactDigest string) (signerOperationV2, error) {
	return s.updateOperation(requestID, func(operation *signerOperationV2, now string) error {
		if operation.State != operationReserved {
			return fmt.Errorf("cannot complete signer operation in state %s", operation.State)
		}
		if operation.ExecutionAttempt != attempt {
			return errors.New("stale signer execution attempt cannot complete")
		}
		if operation.AuthorizationProof == "" || operation.AuthorizedAt == "" {
			return errors.New("reviewed signer operation has no durable authorization")
		}
		if strings.TrimSpace(signature) == "" {
			return errors.New("reviewed signature is required before completion")
		}
		if _, err := normalizeSHA256DigestV2(artifactDigest, "artifactDigest"); err != nil {
			return err
		}
		operation.State = operationConfirmed
		operation.SignedTxBase64 = ""
		operation.Signature = strings.TrimSpace(signature)
		operation.TransactionDigest = strings.TrimSpace(artifactDigest)
		operation.ConfirmedAt = now
		operation.UpdatedAt = now
		operation.ExecutionLeaseUntil = ""
		return nil
	})
}

func (s *signerStoreV2) markUnknown(requestID string, cause error) (signerOperationV2, error) {
	return s.updateOperation(requestID, func(operation *signerOperationV2, now string) error {
		if operation.State != operationBroadcast && operation.State != operationUnknown {
			return fmt.Errorf("cannot mark signer operation unknown in state %s", operation.State)
		}
		operation.State = operationUnknown
		operation.Error = safeOperationErrorV2(cause)
		operation.UpdatedAt = now
		return nil
	})
}

func (s *signerStoreV2) markFailed(requestID string, cause error) (signerOperationV2, error) {
	return s.markFailedClaim(requestID, 0, cause)
}

func (s *signerStoreV2) markFailedClaim(requestID string, attempt uint64, cause error) (signerOperationV2, error) {
	if s == nil || s.db == nil {
		return signerOperationV2{}, errors.New("signer state database is unavailable")
	}
	var updated signerOperationV2
	err := s.db.Update(func(tx *bolt.Tx) error {
		operations := tx.Bucket(bucketSignerOperationsV2)
		raw := operations.Get([]byte(requestID))
		if raw == nil {
			return errors.New("signer operation not found")
		}
		if err := json.Unmarshal(raw, &updated); err != nil {
			return err
		}
		if updated.State != operationReserved && updated.State != operationBroadcast && updated.State != operationUnknown {
			return fmt.Errorf("cannot fail signer operation in state %s", updated.State)
		}
		if attempt != 0 && updated.State == operationReserved && updated.ExecutionAttempt != attempt {
			return errors.New("stale signer execution attempt cannot fail the active reservation")
		}
		// Only a failure proven to occur before broadcast releases its reservation.
		if updated.State == operationReserved && updated.ReservationActive {
			if err := releaseUsageReservationV2(tx, updated); err != nil {
				return err
			}
			updated.ReservationActive = false
		}
		now := timestampV2(s.now())
		updated.State = operationFailed
		updated.SignedTxBase64 = ""
		updated.Error = safeOperationErrorV2(cause)
		updated.UpdatedAt = now
		updated.ExecutionLeaseUntil = ""
		encoded, err := json.Marshal(updated)
		if err != nil {
			return err
		}
		return operations.Put([]byte(requestID), encoded)
	})
	return updated, err
}

func (s *signerStoreV2) updateOperation(requestID string, mutate func(*signerOperationV2, string) error) (signerOperationV2, error) {
	if s == nil || s.db == nil {
		return signerOperationV2{}, errors.New("signer state database is unavailable")
	}
	var updated signerOperationV2
	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketSignerOperationsV2)
		raw := bucket.Get([]byte(requestID))
		if raw == nil {
			return errors.New("signer operation not found")
		}
		if err := json.Unmarshal(raw, &updated); err != nil {
			return err
		}
		if err := mutate(&updated, timestampV2(s.now())); err != nil {
			return err
		}
		encoded, err := json.Marshal(updated)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(requestID), encoded)
	})
	return updated, err
}

func releaseUsageReservationV2(tx *bolt.Tx, operation signerOperationV2) error {
	if len(operation.Reservations) > 0 {
		for _, reservation := range operation.Reservations {
			amount, ok := new(big.Int).SetString(reservation.Amount, 10)
			if !ok || amount.Sign() <= 0 || strings.TrimSpace(reservation.Asset) == "" || strings.TrimSpace(reservation.UsageBucket) == "" {
				return errors.New("invalid signer operation reservation")
			}
			usage := tx.Bucket(bucketSignerUsageV2)
			key := dailyUsageKeyV2(operation.WalletID, reservation.Asset, reservation.UsageBucket)
			current := big.NewInt(0)
			if raw := usage.Get(key); raw != nil {
				if _, ok := current.SetString(string(raw), 10); !ok {
					return errors.New("invalid durable signer usage counter")
				}
			}
			if current.Cmp(amount) < 0 {
				return errors.New("durable signer usage counter underflow")
			}
			current.Sub(current, amount)
			if err := usage.Put(key, []byte(current.String())); err != nil {
				return err
			}
		}
		return nil
	}
	amount, ok := new(big.Int).SetString(operation.Amount, 10)
	if !ok || amount.Sign() <= 0 {
		return errors.New("invalid signer operation reservation amount")
	}
	usage := tx.Bucket(bucketSignerUsageV2)
	key := dailyUsageKeyV2(operation.WalletID, operation.Asset, operation.UsageBucket)
	current := big.NewInt(0)
	if raw := usage.Get(key); raw != nil {
		if _, ok := current.SetString(string(raw), 10); !ok {
			return errors.New("invalid durable signer usage counter")
		}
	}
	if current.Cmp(amount) < 0 {
		return errors.New("durable signer usage counter underflow")
	}
	current.Sub(current, amount)
	return usage.Put(key, []byte(current.String()))
}

func dailyUsageKeyV2(walletID, asset, bucket string) []byte {
	return []byte(normalizeWalletID(walletID) + "\x00" + asset + "\x00" + bucket)
}

func safeOperationErrorV2(err error) string {
	if err == nil {
		return "operation failed"
	}
	message := strings.TrimSpace(err.Error())
	if len(message) > 240 {
		message = message[:240]
	}
	return message
}

func (s *signerStoreV2) dailyUsage(walletID, asset string, day time.Time) (*big.Int, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("signer state database is unavailable")
	}
	value := big.NewInt(0)
	err := s.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSignerUsageV2).Get(dailyUsageKeyV2(walletID, asset, currentDayBucket(day)))
		if raw == nil {
			return nil
		}
		if _, ok := value.SetString(string(raw), 10); !ok {
			return errors.New("invalid durable signer usage counter")
		}
		return nil
	})
	return value, err
}

func (s *signerStoreV2) putWalletAndPolicy(record signerWalletRecordV2, input signerPolicyV2, expectedVersion uint64) (signerPolicyV2, error) {
	if s == nil || s.db == nil {
		return signerPolicyV2{}, errors.New("signer state database is unavailable")
	}
	walletID := normalizeWalletID(record.WalletID)
	if walletID == "default" && strings.TrimSpace(record.WalletID) == "" {
		return signerPolicyV2{}, errors.New("walletId is required")
	}
	if expectedVersion != 0 {
		return signerPolicyV2{}, errors.New("new signer wallet policy must expect version 0")
	}
	input.WalletID = walletID
	input.Version = 1
	normalized, err := normalizeSignerPolicyV2(input)
	if err != nil {
		return signerPolicyV2{}, err
	}
	record.WalletID = walletID
	encodedRecord, err := json.Marshal(record)
	if err != nil {
		return signerPolicyV2{}, err
	}
	encodedPolicy, err := json.Marshal(normalized)
	if err != nil {
		return signerPolicyV2{}, err
	}
	err = s.db.Update(func(tx *bolt.Tx) error {
		wallets := tx.Bucket(bucketSignerWalletsV2)
		policies := tx.Bucket(bucketSignerPoliciesV2)
		if wallets.Get([]byte(walletID)) != nil {
			return errors.New("signer wallet already exists")
		}
		if policies.Get([]byte(walletID)) != nil {
			return errors.New("signer wallet policy already exists")
		}
		if err := requireBucketCapacityV2(wallets, maxSignerWalletsV2, "signer wallet store"); err != nil {
			return err
		}
		if err := wallets.Put([]byte(walletID), encodedRecord); err != nil {
			return err
		}
		return policies.Put([]byte(walletID), encodedPolicy)
	})
	return normalized, err
}
