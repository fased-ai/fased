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

type wenWithdrawalPreparedV1 struct {
	message                                        []byte
	blockhash                                      solana.Hash
	review                                         wenWithdrawalReviewedConfigV1
	wallet                                         solana.PublicKey
	state                                          wenWithdrawalReadbackV1
	slot, fee, rent, total, units, lastValidHeight uint64
}

// Private unsigned preparation: no reservation, signature or network send.
func prepareReviewedWENWithdrawalV1(ctx context.Context, c wenMiningPrepareRPCV1, db, walletID string, v signerWENWithdrawalIntentV1) (*wenWithdrawalPreparedV1, error) {
	return preparePinnedWENWithdrawalV1(ctx, c, db, walletID, v, nil)
}
func preparePinnedWENWithdrawalV1(ctx context.Context, c wenMiningPrepareRPCV1, db, walletID string, v signerWENWithdrawalIntentV1, pinned *wenWithdrawalMessageBindingV1) (*wenWithdrawalPreparedV1, error) {
	config, w, e := loadWENWithdrawalAdmissionV1(db, walletID, v)
	if e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	state, e := readWENWithdrawalRPCV1(ctx, c, config.pins, v, w, config.maxSlotLag)
	if e != nil {
		return nil, e
	}
	bad := errors.New("withdrawal unsigned preparation rejected")
	expires, _ := strconv.ParseUint(v.ExpiresSlot, 10, 64)
	maxFee, _ := strconv.ParseUint(v.MaxFeeLamports, 10, 64)
	minimum := state.Slot
	fresh := func(slot uint64) bool {
		if slot < minimum || slot-state.Slot > config.maxSlotLag || slot >= expires {
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
		if pinned.ReviewSHA != config.reviewSHA || pinned.Slot > minimum || validateWENWithdrawalMessageBindingV1(v, w, pinned.Fee, *pinned) != nil {
			return nil, bad
		}
		value := *bh.Value
		value.Blockhash = pinned.Blockhash
		value.LastValidBlockHeight = pinned.LastValidHeight
		copy := *bh
		copy.Value = &value
		bh = &copy
	}
	height, e := c.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if height >= bh.Value.LastValidBlockHeight {
		return nil, bad
	}
	ix, e := buildWENWithdrawalInstructionV1(v, w)
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
	if pinned != nil && (!bytes.Equal(message, pinned.Message) || *fee.Value != pinned.Fee) {
		return nil, bad
	}
	rent := uint64(0)
	total := *fee.Value
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
	again, e := readWENWithdrawalRPCV1(ctx, c, config.pins, v, w, config.maxSlotLag)
	if e != nil {
		return nil, e
	}
	if !fresh(again.Slot) {
		return nil, bad
	}
	// Retain every observed account byte while allowing slots and Clock time to advance.
	normalize := func(h wenWithdrawalReadbackV1) wenWithdrawalReadbackV1 {
		h.Slot = 0
		h.Now = 0
		for _, p := range []**signerWENBTCAccountV1{&h.Pool, &h.Position, &h.Custody, &h.Mint, &h.Destination, &h.Sale, &h.Activation} {
			if *p != nil {
				copy := **p
				copy.Slot = 0
				*p = &copy
			}
		}
		return h
	}
	if pinned != nil && pinned.Evidence != nil && !reflect.DeepEqual(normalize(pinned.Evidence.Before), normalize(again)) {
		return nil, bad
	}
	if !reflect.DeepEqual(normalize(state), normalize(again)) {
		return nil, bad
	}
	if e = recheckWENWithdrawalReviewV1(db, walletID, v, config, w); e != nil {
		return nil, e
	}
	// Revalidate descriptor bytes too, not only the JSON review.
	current, owner, e := loadWENWithdrawalAdmissionV1(db, walletID, v)
	if e != nil {
		return nil, e
	}
	if current.reviewSHA != config.reviewSHA || owner != w {
		return nil, bad
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	return &wenWithdrawalPreparedV1{message: append([]byte(nil), message...), blockhash: bh.Value.Blockhash, review: config, wallet: w, state: again, slot: minimum, fee: *fee.Value, rent: rent, total: total, units: *sim.Value.UnitsConsumed, lastValidHeight: bh.Value.LastValidBlockHeight}, nil
}
