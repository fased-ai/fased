package main

import (
	"context"
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"reflect"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
)

// Private admission owns the exact simulated bytes. It is neither a signature
// nor a client-redeemable ticket. Actual signing still requires immediate chain,
// policy and review revalidation and durable signature/outcome journaling.
type signerWENBTCExecutionAdmissionV1 struct {
	prepared                          *signerWENBTCPreparedMessageV1
	simulation                        signerWENBTCSimulationV1
	reservationDigest                 string
	requestID, walletID, reviewDigest string
	semanticIntent                    signerWENBTCIntentV1
}

func (s *signerStoreV2) admitWENBTCExecutionV1(ctx context.Context, client signerWENBTCSimulationRPCV1, requestID, walletID, policyHash string, intent signerWENBTCIntentV1, wallet solana.PublicKey, nowHint uint64) (*signerWENBTCExecutionAdmissionV1, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("WEN store unavailable")
	}
	if _, err := validateRequestIDV2(requestID); err != nil {
		return nil, err
	}
	// Reject a crossed fence before new network work. The atomic transition at
	// the end remains authoritative against concurrent workers.
	if err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return nil
		}
		raw := b.Get([]byte("request:" + requestID))
		if raw == nil {
			return nil
		}
		var r wenBudgetReservationV1
		if json.Unmarshal(raw, &r) != nil || r.State != "reserved" {
			return errors.New("WEN execution request already fenced or requires reconciliation")
		}
		return nil
	}); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	root, review, route, err := loadWENBTCReviewV1(s.db.Path(), walletID, intent)
	if err != nil {
		return nil, err
	}
	if review.WalletPublicKey != wallet.String() {
		return nil, errors.New("WEN review wallet mismatch")
	}
	lookups, err := review.preparationPins()
	if err != nil {
		return nil, err
	}
	load := loadWENBTCAcceptanceV1
	if intent.Operation == "acquisition" {
		load = loadWENBTCAcquisitionV1
	}
	min, _ := strconv.ParseUint(intent.MinFinalizedSlot, 10, 64)
	a, err := load(root, review.Pins, intent, wallet, min, nowHint)
	if err != nil {
		return nil, err
	}
	p, err := prepareWENBTCFromRPCV1(ctx, client, root, review.Pins, intent, wallet, nowHint, review.MaxSlotLag, review.Preparation.ComputeUnits, lookups, route)
	if err != nil {
		return nil, err
	}
	fee, _ := strconv.ParseUint(intent.MaxFeeLamports, 10, 64)
	rent, _ := strconv.ParseUint(intent.MaxRentLamports, 10, 64)
	simulation, err := simulateWENBTCPreparedV1(ctx, client, p, review.Pins.Genesis, fee, rent)
	if err != nil {
		return nil, err
	}
	// Review changes during network work invalidate admission rather than silently
	// substituting a new route or limits into the already simulated transaction.
	_, latest, latestRoute, err := loadWENBTCReviewV1(s.db.Path(), walletID, intent)
	if err != nil {
		return nil, err
	}
	if !reflect.DeepEqual(review, latest) || !reflect.DeepEqual(route, latestRoute) {
		return nil, errors.New("WEN review changed during admission")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	exposure, err := wenBTCExposureV1(a, intent, wallet)
	if err != nil {
		return nil, err
	}
	digest := wenBudgetDigestV1(policyHash, walletID, wallet, intent, wenBudgetScopesV1(walletID, intent, exposure))
	if _, err := s.reserveWENPolicyBudgetV1(requestID, walletID, policyHash, a, intent, wallet); err != nil {
		return nil, err
	}
	// No automatic cancellation here: another worker may already have crossed the
	// fence. A failed fence leaves durable state for explicit reconciliation.
	if err := s.beginWENSigningAccountsV1(requestID, digest, wenHashV1(p.message), p.accountKeys, simulation.slot); err != nil {
		return nil, err
	}
	return &signerWENBTCExecutionAdmissionV1{prepared: p, simulation: *simulation, reservationDigest: digest, requestID: requestID, walletID: walletID, reviewDigest: wenReviewDigestV1(review), semanticIntent: intent}, nil
}

func wenReviewDigestV1(r signerWENBTCReviewV1) string {
	raw, _ := json.Marshal(r)
	return wenHashV1(raw)
}
