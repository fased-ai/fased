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

type wenCampaignPrepareRPCV1 interface {
	wenCampaignReadRPCV1
	wenMiningPrepareRPCV1
}
type wenCampaignPreparedV1 struct {
	claim                                      *wenCampaignClaimSnapshotV1
	message                                    []byte
	blockhash                                  solana.Hash
	position                                   wenCampaignPositionV1
	setup                                      *wenCampaignSetupSnapshotV1
	fee, units, currentHeight, lastValidHeight uint64
}

// Unsigned preparation only. No wallet key, permission consumption or socket
// dispatch is available here. Previous keeps the exact approved message lifetime.
func prepareWENCampaignOwnerV1(ctx context.Context, c wenCampaignPrepareRPCV1, pins signerWENBTCPinsV1, v wenCampaignOwnerActionV1, wallet solana.PublicKey, min, expires, lag, maxFee uint64, previous *wenCampaignPreparedV1) (*wenCampaignPreparedV1, error) {
	if v.Operation == "claim" {
		return prepareWENCampaignClaimActionV1(ctx, c, pins, v, wallet, min, expires, lag, maxFee, previous)
	}
	if v.Claim != nil {
		return nil, errors.New("unexpected campaign claim")
	}
	if v.Operation == "setup" {
		return prepareWENCampaignSetupActionV1(ctx, c, pins, v, wallet, min, expires, lag, maxFee, previous)
	}
	bad := errors.New("campaign preparation rejected")
	if v.Setup != nil {
		return nil, bad
	}
	if maxFee == 0 {
		return nil, bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	snap, err := readWENCampaignOwnerV1(ctx, c, pins, v, wallet, min, expires, lag)
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
	ix, err := buildWENCampaignOwnerV1(v, wallet, snap)
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
	required := maxFee
	if v.Operation == "top-up" {
		if v.Amount > math.MaxUint64-required {
			return nil, bad
		}
		required += v.Amount
	}
	if balance == nil || !fresh(balance.Context.Slot) || balance.Value < required {
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
	again, err := readWENCampaignOwnerV1(ctx, c, pins, v, wallet, last, expires, lag)
	if err != nil {
		return nil, err
	}
	if !fresh(again.ReferenceSlot) || !sameWENCampaignPolicyStateV1(snap, again) || snap.AccountingSHA256 != again.AccountingSHA256 || !bytes.Equal(snap.Data, again.Data) || snap.Lamports != again.Lamports || snap.Rent != again.Rent {
		return nil, bad
	}
	if previous != nil && (!sameWENCampaignPolicyStateV1(previous.position, again) || previous.position.AccountingSHA256 != again.AccountingSHA256 || !bytes.Equal(previous.position.Data, again.Data) || previous.position.Lamports != again.Lamports || previous.position.Rent != again.Rent) {
		return nil, bad
	}
	if err := verifyWENCampaignOwnerMessageV1(v, wallet, again, blockhash, finalHeight, end, message); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return &wenCampaignPreparedV1{message: append([]byte(nil), message...), blockhash: blockhash, position: again, fee: *fee.Value, units: *sim.Value.UnitsConsumed, currentHeight: finalHeight, lastValidHeight: end}, nil
}
