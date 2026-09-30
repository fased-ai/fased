package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"reflect"
	"strconv"
)

type wenStakingPrepareRPCV1 interface {
	wenMiningPrepareRPCV1
	GetMinimumBalanceForRentExemption(context.Context, uint64, rpc.CommitmentType) (uint64, error)
}
type wenStakingPreparedV1 struct {
	message                                        []byte
	blockhash                                      solana.Hash
	review                                         wenStakingReviewedConfigV1
	wallet                                         solana.PublicKey
	state                                          wenStakingReadbackV1
	slot, fee, rent, total, units, lastValidHeight uint64
}

// Private unsigned preparation: no reservation, signature or network send.
func prepareReviewedWENStakingV1(ctx context.Context, c wenStakingPrepareRPCV1, db, walletID string, v signerWENStakingIntentV1) (*wenStakingPreparedV1, error) {
	return preparePinnedWENStakingV1(ctx, c, db, walletID, v, nil)
}
func preparePinnedWENStakingV1(ctx context.Context, c wenStakingPrepareRPCV1, db, walletID string, v signerWENStakingIntentV1, pinned *wenStakingMessageBindingV1) (*wenStakingPreparedV1, error) {
	config, w, e := loadWENStakingAdmissionV1(db, walletID, v)
	if e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	state, e := readWENStakingRPCV1(ctx, c, config.pins, v, w, config.maxSlotLag)
	if e != nil {
		return nil, e
	}
	bad := errors.New("staking unsigned preparation rejected")
	expires, _ := strconv.ParseUint(v.ExpiresSlot, 10, 64)
	maxFee, _ := strconv.ParseUint(v.MaxFeeLamports, 10, 64)
	minimum := state.History.Slot
	fresh := func(slot uint64) bool {
		if slot < minimum || slot-state.History.Slot > config.maxSlotLag || slot >= expires {
			return false
		}
		minimum = slot
		return true
	}
	bh, e := c.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if bh == nil || bh.Value == nil || bh.Value.Blockhash == (solana.Hash{}) || !fresh(bh.Context.Slot) {
		return nil, bad
	}
	if pinned != nil {
		if pinned.ReviewSHA != config.reviewSHA || pinned.Slot > minimum || validateWENStakingMessageBindingV1(v, w, pinned.Fee+pinned.Rent, *pinned) != nil {
			return nil, bad
		}
		copyValue := *bh.Value
		copyValue.Blockhash = pinned.Blockhash
		copyValue.LastValidBlockHeight = pinned.LastValidHeight
		copyResult := *bh
		copyResult.Value = &copyValue
		bh = &copyResult
	}
	height, e := c.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if height >= bh.Value.LastValidBlockHeight {
		return nil, bad
	}
	ix, e := buildWENStakingInstructionV1(v, w)
	if e != nil {
		return nil, e
	}
	tx, e := solana.NewTransaction([]solana.Instruction{ix}, bh.Value.Blockhash, solana.TransactionPayer(w))
	if e != nil {
		return nil, e
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	message, e := tx.Message.MarshalBinary()
	if e != nil {
		return nil, e
	}
	if tx.Message.Header.NumRequiredSignatures != 1 || len(message)+65 > 1232 {
		return nil, bad
	}
	fee, e := c.GetFeeForMessage(ctx, base64.StdEncoding.EncodeToString(message), rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if fee == nil || fee.Value == nil || *fee.Value > maxFee || !fresh(fee.Context.Slot) {
		return nil, bad
	}
	history, e := validateWENStakingHistoryV1(v, w, state.History)
	if e != nil {
		return nil, e
	}
	rent := uint64(0)
	cache := map[uint64]uint64{}
	for _, size := range history.RentBytes {
		r, ok := cache[size]
		if !ok {
			r, e = c.GetMinimumBalanceForRentExemption(ctx, size, rpc.CommitmentFinalized)
			if e != nil {
				return nil, e
			}
			if r == 0 {
				return nil, bad
			}
			cache[size] = r
		}
		if r > ^uint64(0)-rent {
			return nil, bad
		}
		rent += r
	}
	if *fee.Value > ^uint64(0)-rent {
		return nil, bad
	}
	total := rent + *fee.Value
	if pinned != nil && (!bytes.Equal(message, pinned.Message) || *fee.Value != pinned.Fee || rent != pinned.Rent) {
		return nil, bad
	}
	if total > config.maxTotalCostLamports {
		return nil, bad
	}
	balance, e := c.GetBalance(ctx, w, rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if balance == nil || !fresh(balance.Context.Slot) || balance.Value < total {
		return nil, bad
	}
	wire := make([]byte, 65+len(message))
	wire[0] = 1
	copy(wire[65:], message)
	sim, e := c.SimulateRawTransactionWithOpts(ctx, wire, &rpc.SimulateTransactionOpts{Commitment: rpc.CommitmentFinalized, SigVerify: false, ReplaceRecentBlockhash: false})
	if e != nil {
		return nil, e
	}
	if sim == nil || sim.Value == nil || sim.Value.Err != nil || sim.Value.UnitsConsumed == nil || *sim.Value.UnitsConsumed > 200000 || !fresh(sim.Context.Slot) {
		return nil, bad
	}
	finalHeight, e := c.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if finalHeight < height || finalHeight >= bh.Value.LastValidBlockHeight {
		return nil, bad
	}
	again, e := readWENStakingRPCV1(ctx, c, config.pins, v, w, config.maxSlotLag)
	if e != nil {
		return nil, e
	}
	if !fresh(again.History.Slot) {
		return nil, bad
	}
	// Ignore advancing slots/time, but retain exact historical bytes and token results.
	normalize := func(h wenStakingHistorySnapshotV1) wenStakingHistorySnapshotV1 {
		h.Slot = 0
		h.Now = 0
		ptrs := []**signerWENBTCAccountV1{&h.Pool, &h.Position, &h.History, &h.NextHistory, &h.Index, &h.Point, &h.NextPoint}
		for _, p := range ptrs {
			if *p != nil {
				copy := **p
				copy.Slot = 0
				*p = &copy
			}
		}
		return h
	}
	if pinned != nil && pinned.Evidence != nil && !reflect.DeepEqual(normalize(pinned.Evidence.Before), normalize(again.History)) {
		return nil, bad
	}
	if !reflect.DeepEqual(normalize(state.History), normalize(again.History)) || state.Tokens != again.Tokens {
		return nil, bad
	}
	if e = recheckWENStakingReviewV1(db, walletID, v, config, w); e != nil {
		return nil, e
	}
	// Revalidate descriptor bytes too, not only the JSON review.
	current, owner, e := loadWENStakingAdmissionV1(db, walletID, v)
	if e != nil {
		return nil, e
	}
	if current.reviewSHA != config.reviewSHA || owner != w {
		return nil, bad
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	return &wenStakingPreparedV1{message: append([]byte(nil), message...), blockhash: bh.Value.Blockhash, review: config, wallet: w, state: again, slot: minimum, fee: *fee.Value, rent: rent, total: total, units: *sim.Value.UnitsConsumed, lastValidHeight: bh.Value.LastValidBlockHeight}, nil
}
