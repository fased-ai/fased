package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"reflect"
	"strconv"
)

type wenWithdrawalPoststateObservationV1 struct {
	Snapshot                  wenWithdrawalReadbackV1
	MatchesExpectedTransition bool
}

// Compare the isolated Rust withdrawal transition, not intervening activity.
func validateWENWithdrawalPoststateV1(v signerWENWithdrawalIntentV1, w solana.PublicKey, before, after wenWithdrawalReadbackV1, outcomeSlot uint64) error {
	bad := errors.New("withdrawal poststate differs")
	preview, e := previewWENWithdrawalV1(v, w, before.Slot, before.Now, before.Pool, before.Position, before.Mint, before.Custody, before.Destination)
	if e != nil {
		return e
	}
	if outcomeSlot < before.Slot || after.Slot < outcomeSlot || after.Now < before.Now {
		return bad
	}
	raw, e := json.Marshal(before)
	if e != nil {
		return e
	}
	var expected wenWithdrawalReadbackV1
	if e = json.Unmarshal(raw, &expected); e != nil {
		return e
	}
	put := func(a *signerWENBTCAccountV1, o int, n uint64) { binary.LittleEndian.PutUint64(a.Data[o:], n) }
	day, _ := strconv.ParseUint(v.Day, 10, 64)
	put(expected.Pool, 80, day)
	put(expected.Pool, 88, preview.Eligible)
	put(expected.Pool, 104, preview.RemainingCustodied)
	put(expected.Position, 80, 0)
	put(expected.Position, 88, 0)
	put(expected.Custody, 64, binary.LittleEndian.Uint64(expected.Custody.Data[64:])-preview.Gross)
	put(expected.Destination, 64, binary.LittleEndian.Uint64(expected.Destination.Data[64:])+preview.Net)
	ext, e := wenSatExtensionsV1(expected.Destination.Data, 2, map[uint16]int{2: 8, 7: 0})
	if e != nil {
		return e
	}
	binary.LittleEndian.PutUint64(ext[2], binary.LittleEndian.Uint64(ext[2])+preview.Fee)
	expected.Slot = after.Slot
	expected.Now = after.Now
	expected.Preview = wenWithdrawalPreviewV1{}
	after.Preview = wenWithdrawalPreviewV1{}
	for _, a := range []*signerWENBTCAccountV1{expected.Pool, expected.Position, expected.Custody, expected.Mint, expected.Destination, expected.Sale, expected.Activation} {
		if a == nil {
			return bad
		}
		a.Slot = after.Slot
	}
	if !reflect.DeepEqual(expected, after) {
		return bad
	}
	return nil
}

// Finalized later observation; does not sign, send or change settlement.
func readWENWithdrawalPoststateRPCV1(ctx context.Context, c signerWENBTCReadRPCV1, pins wenStakingPinsV1, r wenBudgetReservationV1, before wenWithdrawalReadbackV1, maxSlotLag uint64) (wenWithdrawalPoststateObservationV1, error) {
	var out wenWithdrawalPoststateObservationV1
	if r.State != "finalized-success" || r.OutcomeSlot == 0 || !wenReservationHashV1(r.WithdrawalEffectsSHA256) || !wenWithdrawalSettlementScopesValidV1(r) {
		return out, errors.New("withdrawal finalized success required")
	}
	v := *r.WithdrawalIntent
	w, e := solana.PublicKeyFromBase58(r.WalletPublicKey)
	if e != nil {
		return out, e
	}
	raw, e := json.Marshal(before)
	if e != nil {
		return out, e
	}
	var saved wenWithdrawalReadbackV1
	if e = json.Unmarshal(raw, &saved); e != nil {
		return out, e
	}
	if _, e = previewWENWithdrawalV1(v, w, saved.Slot, saved.Now, saved.Pool, saved.Position, saved.Mint, saved.Custody, saved.Destination); e != nil {
		return out, e
	}
	if e = validateWENStakingActivationV1(v.identity(), saved.Slot, saved.Now, saved.Sale, saved.Activation); e != nil {
		return out, e
	}
	if r.OutcomeSlot < saved.Slot {
		return out, errors.New("receipt precedes withdrawal prestate")
	}
	observed, e := readWENWithdrawalStateV1(ctx, c, pins, v, w, maxSlotLag, r.OutcomeSlot)
	if e != nil {
		return out, e
	}
	out.Snapshot = observed
	out.MatchesExpectedTransition = validateWENWithdrawalPoststateV1(v, w, saved, observed, r.OutcomeSlot) == nil
	return out, nil
}
