package main

import (
	"context"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
)

type wenStakingPoststateObservationV1 struct {
	Snapshot                  wenStakingHistorySnapshotV1
	MatchesExpectedTransition bool
}

// Historical consistency observation, not transaction-time attestation. Never
// signs, sends, changes eligibility or releases accounting reservations.
func readWENStakingPoststateRPCV1(ctx context.Context, client signerWENBTCReadRPCV1, pins wenStakingPinsV1, r wenBudgetReservationV1, before wenStakingHistorySnapshotV1, maxSlotLag uint64) (wenStakingPoststateObservationV1, error) {
	var out wenStakingPoststateObservationV1
	bad := errors.New("staking finalized success required for historical observation")
	if r.State != "finalized-success" || r.OutcomeSlot == 0 || !wenReservationHashV1(r.StakingEffectsSHA256) || !wenStakingSettlementScopesValidV1(r) {
		return out, bad
	}
	v := *r.StakingIntent
	w, e := solana.PublicKeyFromBase58(r.WalletPublicKey)
	if e != nil {
		return out, bad
	}
	// Keep the caller's pre-state immutable through RPC callbacks.
	raw, e := json.Marshal(before)
	if e != nil {
		return out, e
	}
	var saved wenStakingHistorySnapshotV1
	if e = json.Unmarshal(raw, &saved); e != nil {
		return out, e
	}
	if _, e = validateWENStakingHistoryV1(v, w, saved); e != nil {
		return out, e
	}
	if r.OutcomeSlot < saved.Slot {
		return out, bad
	}
	observed, e := readWENStakingObservationV1(ctx, client, pins, v, w, maxSlotLag, false, r.OutcomeSlot)
	if e != nil {
		return out, e
	}
	out.Snapshot = observed.History
	out.MatchesExpectedTransition = validateWENStakingPoststateV1(v, w, saved, out.Snapshot, r.OutcomeSlot) == nil
	return out, nil
}
