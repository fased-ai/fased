package main

import (
	"context"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

type wenStakingDurableObservationV1 struct {
	BindingSHA256 string
	Observation   wenStakingPoststateObservationV1
}

// Freeze the reservation, receipt and pre-state identity across asynchronous RPC.
func wenStakingObservationBindingV1(r wenBudgetReservationV1) (string, error) {
	if r.StakingPrepared == nil || r.StakingPrepared.Evidence == nil || r.StakingIntent == nil {
		return "", errors.New("staking pre-state not recorded")
	}
	w, e := solana.PublicKeyFromBase58(r.WalletPublicKey)
	if e != nil {
		return "", e
	}
	if e = validateWENStakingMessageBindingV1(*r.StakingIntent, w, r.WalletClaims["solana:native"], *r.StakingPrepared); e != nil {
		return "", e
	}
	// Observation itself is excluded; all other journal/accounting fields are bound.
	r.StakingObservation = nil
	raw, e := json.Marshal(r)
	if e != nil {
		return "", e
	}
	return wenHashV1(raw), nil
}

func (s *signerStoreV2) observeWENStakingPoststateV1(ctx context.Context, client signerWENBTCReadRPCV1, request, digest string, maxSlotLag uint64) (wenStakingPoststateObservationV1, error) {
	var out wenStakingPoststateObservationV1
	bad := errors.New("staking observation journal changed")
	if s == nil || s.db == nil {
		return out, bad
	}
	var saved wenBudgetReservationV1
	if e := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return bad
		}
		return json.Unmarshal(b.Get([]byte("request:"+request)), &saved)
	}); e != nil {
		return out, e
	}
	if saved.Digest != digest {
		return out, bad
	}
	binding, e := wenStakingObservationBindingV1(saved)
	if e != nil {
		return out, e
	}
	evidence := saved.StakingPrepared.Evidence
	observed, e := readWENStakingPoststateRPCV1(ctx, client, evidence.Pins, saved, evidence.Before, maxSlotLag)
	if e != nil {
		return out, e
	}
	if e = ctx.Err(); e != nil {
		return out, e
	}
	record := wenStakingDurableObservationV1{BindingSHA256: binding, Observation: observed}
	e = s.changeWENReservationV1(request, digest, func(_ *bolt.Tx, r *wenBudgetReservationV1) error {
		current, e := wenStakingObservationBindingV1(*r)
		if e != nil {
			return e
		}
		if current != binding {
			return bad
		}
		if r.StakingObservation != nil {
			a, _ := json.Marshal(r.StakingObservation)
			b, _ := json.Marshal(record)
			if string(a) != string(b) {
				return errors.New("staking observation already recorded differently")
			}
			return nil
		}
		r.StakingObservation = &record
		return nil
	})
	if e != nil {
		return out, e
	}
	return observed, nil
}
