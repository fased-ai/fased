package main

import (
	"context"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

type wenWithdrawalDurableObservationV1 struct {
	BindingSHA256 string
	Observation   wenWithdrawalPoststateObservationV1
}

// Freeze the reservation, receipt and pre-state identity across asynchronous RPC.
func wenWithdrawalObservationBindingV1(r wenBudgetReservationV1) (string, error) {
	if r.WithdrawalPrepared == nil || r.WithdrawalPrepared.Evidence == nil || r.WithdrawalIntent == nil {
		return "", errors.New("withdrawal pre-state not recorded")
	}
	w, e := solana.PublicKeyFromBase58(r.WalletPublicKey)
	if e != nil {
		return "", e
	}
	if e = validateWENWithdrawalMessageBindingV1(*r.WithdrawalIntent, w, r.WalletClaims["solana:native"], *r.WithdrawalPrepared); e != nil {
		return "", e
	}
	// Observation itself is excluded; all other journal/accounting fields are bound.
	r.WithdrawalObservation = nil
	raw, e := json.Marshal(r)
	if e != nil {
		return "", e
	}
	return wenHashV1(raw), nil
}

func (s *signerStoreV2) observeWENWithdrawalPoststateV1(ctx context.Context, client signerWENBTCReadRPCV1, request, digest string, maxSlotLag uint64) (wenWithdrawalPoststateObservationV1, error) {
	var out wenWithdrawalPoststateObservationV1
	bad := errors.New("withdrawal observation journal changed")
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
	binding, e := wenWithdrawalObservationBindingV1(saved)
	if e != nil {
		return out, e
	}
	evidence := saved.WithdrawalPrepared.Evidence
	observed, e := readWENWithdrawalPoststateRPCV1(ctx, client, evidence.Pins, saved, evidence.Before, maxSlotLag)
	if e != nil {
		return out, e
	}
	if e = ctx.Err(); e != nil {
		return out, e
	}
	record := wenWithdrawalDurableObservationV1{BindingSHA256: binding, Observation: observed}
	e = s.changeWENReservationV1(request, digest, func(_ *bolt.Tx, r *wenBudgetReservationV1) error {
		current, e := wenWithdrawalObservationBindingV1(*r)
		if e != nil {
			return e
		}
		if current != binding {
			return bad
		}
		if r.WithdrawalObservation != nil {
			a, _ := json.Marshal(r.WithdrawalObservation)
			b, _ := json.Marshal(record)
			if string(a) != string(b) {
				return errors.New("withdrawal observation already recorded differently")
			}
			return nil
		}
		r.WithdrawalObservation = &record
		return nil
	})
	if e != nil {
		return out, e
	}
	return observed, nil
}
