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

type wenMiningClaimPreparedV1 struct {
	computeLimit                                                  uint32
	message                                                       []byte
	blockhash                                                     solana.Hash
	review                                                        wenMiningClaimReviewedConfigV1
	wallet                                                        solana.PublicKey
	state                                                         wenMiningClaimReadbackV1
	fee, rent, total, units, lastValidHeight, slot, currentHeight uint64
}

// Internal unsigned preparation only. No reservation, signature or send.
func prepareReviewedWENMiningClaimV1(ctx context.Context, c wenMiningPrepareRPCV1, db, walletID string, v signerWENMiningClaimIntentV1) (*wenMiningClaimPreparedV1, error) {
	return preparePinnedWENMiningClaimV1(ctx, c, db, walletID, v, nil)
}
func preparePinnedWENMiningClaimV1(ctx context.Context, c wenMiningPrepareRPCV1, db, walletID string, v signerWENMiningClaimIntentV1, pinned *wenMiningClaimMessageBindingV1) (*wenMiningClaimPreparedV1, error) {
	config, w, e := loadWENMiningClaimAdmissionV1(db, walletID, v)
	if e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	state, e := readWENMiningClaimRPCV1(ctx, c, config.pins, v, w, config.maxSlotLag)
	if e != nil {
		return nil, e
	}
	out, e := preparePinnedWENMiningClaimCostsV1(ctx, c, v, w, config, state, pinned)
	if e != nil {
		return nil, e
	}
	again, e := readWENMiningClaimRPCV1(ctx, c, config.pins, v, w, config.maxSlotLag)
	if e != nil {
		return nil, e
	}
	if again.Slot < out.slot || again.Slot-state.Slot > config.maxSlotLag || again.StateHash != state.StateHash {
		return nil, errors.New("claim state changed during preparation")
	}
	height, e := c.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if height < out.currentHeight || height >= out.lastValidHeight {
		return nil, errors.New("claim blockhash expired after readback")
	}
	if e = recheckWENMiningClaimReviewV1(db, walletID, v, config, w); e != nil {
		return nil, e
	}
	return out, nil
}
func prepareWENMiningClaimCostsV1(ctx context.Context, c wenMiningPrepareRPCV1, v signerWENMiningClaimIntentV1, w solana.PublicKey, config wenMiningClaimReviewedConfigV1, state wenMiningClaimReadbackV1) (*wenMiningClaimPreparedV1, error) {
	return preparePinnedWENMiningClaimCostsV1(ctx, c, v, w, config, state, nil)
}
func preparePinnedWENMiningClaimCostsV1(ctx context.Context, c wenMiningPrepareRPCV1, v signerWENMiningClaimIntentV1, w solana.PublicKey, config wenMiningClaimReviewedConfigV1, state wenMiningClaimReadbackV1, pinned *wenMiningClaimMessageBindingV1) (*wenMiningClaimPreparedV1, error) {
	bad := errors.New("mining claim cost preparation rejected")
	ix, e := buildWENMiningClaimInstructionV1(v, w)
	if e != nil {
		return nil, e
	}
	if state.Slot == 0 || !wenReservationHashV1(state.StateHash) || state.StateHash != v.AccountStateSHA256 || config.maxSlotLag == 0 || config.maxSlotLag > 32 {
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
		if validateWENMiningClaimMessageBindingV1(v, w, pinned.Fee, *pinned) != nil || pinned.ReviewSHA != config.reviewSHA || pinned.StateHash != state.StateHash || pinned.Slot > state.Slot {
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
	limit := wenMiningClaimComputeLimitV1
	if pinned != nil {
		limit = pinned.ComputeUnitLimit
	}
	instructions, e := wenMiningClaimInstructionsV1(ix, limit)
	if e != nil {
		return nil, e
	}
	tx, e := solana.NewTransaction(instructions, bh.Value.Blockhash, solana.TransactionPayer(w))
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
	// Both claim legs use existing accounts. Payouts cannot fund the up-front fee.
	total := *fee.Value
	if total > config.maxTotalCostLamports {
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
	simulationLimit := uint64(limit)
	if limit == 0 {
		simulationLimit = 200000
	}
	if sim == nil || sim.Value == nil || sim.Value.Err != nil || sim.Value.UnitsConsumed == nil || *sim.Value.UnitsConsumed > simulationLimit || !fresh(sim.Context.Slot) {
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
	return &wenMiningClaimPreparedV1{computeLimit: limit, message: message, blockhash: bh.Value.Blockhash, review: config, wallet: w, state: state, fee: *fee.Value, rent: 0, total: total, units: *sim.Value.UnitsConsumed, lastValidHeight: bh.Value.LastValidBlockHeight, slot: latest, currentHeight: final}, nil
}
