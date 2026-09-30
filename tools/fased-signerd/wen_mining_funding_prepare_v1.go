package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
)

type wenMiningFundingPreparedV1 struct {
	message                                                       []byte
	blockhash                                                     solana.Hash
	review                                                        wenMiningFundingReviewedConfigV1
	wallet                                                        solana.PublicKey
	state                                                         wenMiningFundingReadbackV1
	fee, rent, total, units, lastValidHeight, slot, currentHeight uint64
}

// Internal unsigned preparation only. No reservation, signature or send.
func prepareReviewedWENMiningFundingV1(ctx context.Context, c wenMiningPrepareRPCV1, db, walletID string, v signerWENMiningFundingIntentV1) (*wenMiningFundingPreparedV1, error) {
	return preparePinnedWENMiningFundingV1(ctx, c, db, walletID, v, nil)
}
func preparePinnedWENMiningFundingV1(ctx context.Context, c wenMiningPrepareRPCV1, db, walletID string, v signerWENMiningFundingIntentV1, pinned *wenMiningFundingMessageBindingV1) (*wenMiningFundingPreparedV1, error) {
	config, w, e := loadWENMiningFundingAdmissionV1(db, walletID, v)
	if e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	state, e := readWENMiningFundingRPCV1(ctx, c, config.pins, v, w, config.maxSlotLag)
	if e != nil {
		return nil, e
	}
	out, e := preparePinnedWENMiningFundingCostsV1(ctx, c, v, w, config, state, pinned)
	if e != nil {
		return nil, e
	}
	again, e := readWENMiningFundingRPCV1(ctx, c, config.pins, v, w, config.maxSlotLag)
	if e != nil {
		return nil, e
	}
	if again.Slot < out.slot || again.Slot-state.Slot > config.maxSlotLag || again.StateHash != state.StateHash {
		return nil, errors.New("funding state changed during preparation")
	}
	height, e := c.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if height < out.currentHeight || height >= out.lastValidHeight {
		return nil, errors.New("funding blockhash expired after readback")
	}
	if e = recheckWENMiningFundingReviewV1(db, walletID, v, config, w); e != nil {
		return nil, e
	}
	return out, nil
}
func prepareWENMiningFundingCostsV1(ctx context.Context, c wenMiningPrepareRPCV1, v signerWENMiningFundingIntentV1, w solana.PublicKey, config wenMiningFundingReviewedConfigV1, state wenMiningFundingReadbackV1) (*wenMiningFundingPreparedV1, error) {
	return preparePinnedWENMiningFundingCostsV1(ctx, c, v, w, config, state, nil)
}
func preparePinnedWENMiningFundingCostsV1(ctx context.Context, c wenMiningPrepareRPCV1, v signerWENMiningFundingIntentV1, w solana.PublicKey, config wenMiningFundingReviewedConfigV1, state wenMiningFundingReadbackV1, pinned *wenMiningFundingMessageBindingV1) (*wenMiningFundingPreparedV1, error) {
	bad := errors.New("mining funding cost preparation rejected")
	ix, e := buildWENMiningFundingInstructionV1(v, w)
	if e != nil {
		return nil, e
	}
	if state.Slot == 0 || !wenReservationHashV1(state.StateHash) {
		return nil, bad
	}
	num := func(s string) uint64 { n, _ := strconv.ParseUint(s, 10, 64); return n }
	latest := state.Slot
	fresh := func(s uint64) bool {
		if s < latest || s-state.Slot > config.maxSlotLag || s >= num(v.ExpiresSlot) {
			return false
		}
		latest = s
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
		if validateWENMiningFundingMessageBindingV1(v, w, pinned.Fee, *pinned) != nil || pinned.ReviewSHA != config.reviewSHA || pinned.StateHash != state.StateHash || pinned.Slot > state.Slot {
			return nil, bad
		}
		copyResult, copyValue := *bh, *bh.Value
		copyValue.Blockhash = pinned.Blockhash
		copyValue.LastValidBlockHeight = pinned.LastValidHeight
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
	if fee == nil || fee.Value == nil || *fee.Value == 0 || *fee.Value > num(v.MaxFeeLamports) || !fresh(fee.Context.Slot) {
		return nil, bad
	}
	if pinned != nil && (!bytes.Equal(message, pinned.Message) || *fee.Value != pinned.Fee) {
		return nil, bad
	}
	// Existing funding accounts require no new rent; capital is not owner fee spend.
	total := *fee.Value
	if total > config.maxTotalCostLamports || total > state.OwnerLamports {
		return nil, bad
	}
	balance, e := c.GetBalance(ctx, w, rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if balance == nil || balance.Value < total || !fresh(balance.Context.Slot) {
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
	finalFee, e := c.GetFeeForMessage(ctx, base64.StdEncoding.EncodeToString(message), rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if finalFee == nil || finalFee.Value == nil || *finalFee.Value != *fee.Value || !fresh(finalFee.Context.Slot) {
		return nil, bad
	}
	final, e := c.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if final < height || final >= bh.Value.LastValidBlockHeight {
		return nil, bad
	}
	return &wenMiningFundingPreparedV1{message: message, blockhash: bh.Value.Blockhash, review: config, wallet: w, state: state, fee: *fee.Value, rent: 0, total: total, units: *sim.Value.UnitsConsumed, lastValidHeight: bh.Value.LastValidBlockHeight, slot: latest, currentHeight: final}, nil
}
