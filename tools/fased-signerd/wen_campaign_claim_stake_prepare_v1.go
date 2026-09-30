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

type wenCampaignClaimStakePreparedV1 struct {
	message                                                        []byte
	blockhash                                                      solana.Hash
	snapshot                                                       wenCampaignClaimStakeReadbackV1
	fee, rent, units, currentHeight, lastValidHeight, maximumDebit uint64
}

// Unsigned preparation only. No wallet key, permission consumption or socket
// dispatch is available here. Previous keeps the exact approved message lifetime.
func prepareWENCampaignClaimStakeV1(ctx context.Context, c wenStakingPrepareRPCV1, pins wenStakingPinsV1, v signerWENStakingIntentV1, q wenCampaignClaimRequestV1, wallet solana.PublicKey, minimumNet, lag, maxTotal uint64, previous *wenCampaignClaimStakePreparedV1) (*wenCampaignClaimStakePreparedV1, error) {
	maxFee, _ := strconv.ParseUint(v.MaxFeeLamports, 10, 64)
	expires, _ := strconv.ParseUint(v.ExpiresSlot, 10, 64)
	bad := errors.New("campaign preparation rejected")
	if maxFee == 0 || maxTotal < maxFee {
		return nil, bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	snap, err := readWENCampaignClaimStakeV1(ctx, c, pins, v, q, wallet, minimumNet, lag)
	if err != nil {
		return nil, err
	}
	last := snap.Claim.ReferenceSlot
	fresh := func(slot uint64) bool {
		if slot < last || slot-snap.Claim.Slot > lag || slot >= expires {
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
	ix, _, err := buildWENCampaignClaimStakeV1(v, minimumNet, snap.Claim, snap.History)
	if err != nil {
		return nil, err
	}
	message, err := compileWENCampaignClaimStakeV1(ix, wallet, blockhash, height, end)
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
	rent := uint64(0)
	cache := map[uint64]uint64{}
	for _, size := range snap.Result.RentBytes {
		r, ok := cache[size]
		if !ok {
			r, err = c.GetMinimumBalanceForRentExemption(ctx, size, rpc.CommitmentFinalized)
			if err != nil {
				return nil, err
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
	if maxFee > ^uint64(0)-rent || rent+maxFee > maxTotal || previous != nil && rent != previous.rent {
		return nil, bad
	}
	balance, err := c.GetBalance(ctx, wallet, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	required := maxFee + rent
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
	if sim == nil || sim.Value == nil || sim.Value.Err != nil || sim.Value.UnitsConsumed == nil || *sim.Value.UnitsConsumed > 400000 || !fresh(sim.Context.Slot) {
		return nil, bad
	}
	finalHeight, err := c.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	if finalHeight < height || finalHeight >= end {
		return nil, bad
	}
	updated := v
	updated.MinFinalizedSlot = strconv.FormatUint(last, 10)
	again, err := readWENCampaignClaimStakeV1(ctx, c, pins, updated, q, wallet, minimumNet, lag)
	if err != nil {
		return nil, err
	}
	if !fresh(again.Claim.ReferenceSlot) || !sameWENCampaignClaimStakeStateV1(snap, again) {
		return nil, bad
	}
	if previous != nil && (!sameWENCampaignClaimStakeStateV1(previous.snapshot, again) || previous.maximumDebit != required) {
		return nil, bad
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return &wenCampaignClaimStakePreparedV1{message: append([]byte(nil), message...), blockhash: blockhash, snapshot: again, maximumDebit: required, fee: *fee.Value, rent: rent, units: *sim.Value.UnitsConsumed, currentHeight: finalHeight, lastValidHeight: end}, nil
}

// Compare all economic and custody bytes without mutating either observation.
func sameWENCampaignClaimStakeStateV1(a, b wenCampaignClaimStakeReadbackV1) bool {
	if !sameWENCampaignClaimStateV1(a.Claim, b.Claim) {
		return false
	}
	normalize := func(v wenCampaignClaimStakeReadbackV1) wenCampaignClaimStakeReadbackV1 {
		v.Claim = wenCampaignClaimSnapshotV1{}
		v.Sale.Slot = 0
		v.Activation.Slot = 0
		v.History.Slot = 0
		v.History.Now /= 86400
		for _, p := range []**signerWENBTCAccountV1{&v.History.Pool, &v.History.Position, &v.History.History, &v.History.NextHistory, &v.History.Index, &v.History.Point, &v.History.NextPoint} {
			if *p != nil {
				copy := **p
				copy.Slot = 0
				*p = &copy
			}
		}
		return v
	}
	return reflect.DeepEqual(normalize(a), normalize(b))
}
