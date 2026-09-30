package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"math"
)

type wenCampaignSetupPreparedV1 struct {
	message                                                  []byte
	blockhash                                                solana.Hash
	snapshot                                                 wenCampaignSetupSnapshotV1
	fee, units, currentHeight, lastValidHeight, maximumDebit uint64
}

// Unsigned preparation only. No wallet key, permission consumption or socket
// dispatch is available here. Previous keeps the exact approved message lifetime.
func prepareWENCampaignSetupV1(ctx context.Context, c wenCampaignPrepareRPCV1, pins signerWENBTCPinsV1, v wenCampaignSetupRequestV1, wallet solana.PublicKey, min, expires, lag, maxFee uint64, previous *wenCampaignSetupPreparedV1) (*wenCampaignSetupPreparedV1, error) {
	bad := errors.New("campaign preparation rejected")
	if maxFee == 0 {
		return nil, bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	snap, err := readWENCampaignSetupV1(ctx, c, pins, v, wallet, min, expires, lag)
	if err != nil {
		return nil, err
	}
	last := snap.ReferenceSlot
	fresh := func(slot uint64) bool {
		if slot < last || slot-snap.Slot > lag || slot >= expires {
			return false
		}
		last = slot
		return true
	}
	bh, err := c.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	if bh == nil || bh.Value == nil || !fresh(bh.Context.Slot) {
		return nil, bad
	}
	blockhash, end := bh.Value.Blockhash, bh.Value.LastValidBlockHeight
	if previous != nil {
		blockhash, end = previous.blockhash, previous.lastValidHeight
	}
	height, err := c.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	if height >= end || blockhash == (solana.Hash{}) || previous != nil && height < previous.currentHeight {
		return nil, bad
	}
	ix, _, err := buildWENCampaignAtomicSetupV1(snap.Setup)
	if err != nil {
		return nil, err
	}
	tx, err := solana.NewTransaction([]solana.Instruction{ix}, blockhash, solana.TransactionPayer(wallet))
	if err != nil {
		return nil, err
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	message, err := tx.Message.MarshalBinary()
	if err != nil {
		return nil, err
	}
	if previous != nil && !bytes.Equal(message, previous.message) {
		return nil, bad
	}
	fee, err := c.GetFeeForMessage(ctx, base64.StdEncoding.EncodeToString(message), rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	if fee == nil || fee.Value == nil || !fresh(fee.Context.Slot) || *fee.Value > maxFee || previous != nil && *fee.Value != previous.fee {
		return nil, bad
	}
	balance, err := c.GetBalance(ctx, wallet, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	required := snap.Setup.Terms.Deposit
	if snap.Rent > math.MaxUint64-required {
		return nil, bad
	}
	required += snap.Rent
	if maxFee > math.MaxUint64-required {
		return nil, bad
	}
	required += maxFee
	if balance == nil || !fresh(balance.Context.Slot) || balance.Value < required {
		return nil, bad
	}
	if 65+len(message) > 1232 {
		return nil, bad
	}
	wire := make([]byte, 65+len(message))
	wire[0] = 1
	copy(wire[65:], message)
	sim, err := c.SimulateRawTransactionWithOpts(ctx, wire, &rpc.SimulateTransactionOpts{Commitment: rpc.CommitmentFinalized, SigVerify: false, ReplaceRecentBlockhash: false})
	if err != nil {
		return nil, err
	}
	if sim == nil || sim.Value == nil || sim.Value.Err != nil || sim.Value.UnitsConsumed == nil || *sim.Value.UnitsConsumed > 200000 || !fresh(sim.Context.Slot) {
		return nil, bad
	}
	finalHeight, err := c.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	if finalHeight < height || finalHeight >= end {
		return nil, bad
	}
	again, err := readWENCampaignSetupV1(ctx, c, pins, v, wallet, last, expires, lag)
	if err != nil {
		return nil, err
	}
	if !fresh(again.ReferenceSlot) || !sameWENCampaignSetupStateV1(snap, again) {
		return nil, bad
	}
	if previous != nil && (!sameWENCampaignSetupStateV1(previous.snapshot, again) || previous.maximumDebit != required) {
		return nil, bad
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return &wenCampaignSetupPreparedV1{message: append([]byte(nil), message...), blockhash: blockhash, snapshot: again, maximumDebit: required, fee: *fee.Value, units: *sim.Value.UnitsConsumed, currentHeight: finalHeight, lastValidHeight: end}, nil
}
