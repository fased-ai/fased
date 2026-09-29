package main

import (
	"context"
	"encoding/base64"
	"errors"
	"reflect"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type wenMarketPreparedBuyV1 struct {
	pins                                       wenMarketBuyPinsV1
	policy                                     wenMarketReadPolicyV1
	limits                                     wenMarketBuyLimitsV1
	maxFee, retainedLamports                   uint64
	snapshot                                   wenMarketBuySnapshotV1
	message                                    []byte
	blockhash                                  solana.Hash
	fee, units, currentHeight, lastValidHeight uint64
}

// Private unsigned preparation. All accounts must already exist: no account
// creation, rent spending, tip or priority-fee instruction is permitted. The
// retained native balance comes from protected budgeting, never application input.
// This does not reserve funds, consume a mandate, sign or submit.
func prepareWENMarketBuyV1(ctx context.Context, c wenMiningPrepareRPCV1, p wenMarketBuyPinsV1, policy wenMarketReadPolicyV1, l wenMarketBuyLimitsV1, maxFee, retainedLamports uint64, previous *wenMarketPreparedBuyV1) (*wenMarketPreparedBuyV1, error) {
	bad := errors.New("Buy protected preparation rejected")
	if c == nil || maxFee == 0 || retainedLamports > ^uint64(0)-maxFee {
		return nil, bad
	}
	// Copy authority pointers before any I/O so external profile mutation cannot
	// change the in-flight expectations or an already prepared review.
	if policy.Successor.UpgradeAuthority != nil {
		x := *policy.Successor.UpgradeAuthority
		policy.Successor.UpgradeAuthority = &x
	}
	if policy.Venue.UpgradeAuthority != nil {
		x := *policy.Venue.UpgradeAuthority
		policy.Venue.UpgradeAuthority = &x
	}
	if previous != nil && (previous.pins != p || !reflect.DeepEqual(previous.policy, policy) || previous.limits != l || previous.maxFee != maxFee || previous.retainedLamports != retainedLamports) {
		return nil, bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	snap, e := readWENMarketBuyV1(ctx, c, p, policy, l)
	if e != nil {
		return nil, e
	}
	last := snap.Quote.ReferenceSlot
	fresh := func(slot uint64) bool {
		if slot < last || slot < l.MinimumSlot || slot >= l.ExpiresSlot || slot-snap.Quote.Slot > 32 {
			return false
		}
		last = slot
		return true
	}
	bh, e := c.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if bh == nil || bh.Value == nil || !fresh(bh.Context.Slot) {
		return nil, bad
	}
	blockhash, end := bh.Value.Blockhash, bh.Value.LastValidBlockHeight
	if previous != nil {
		if previous.snapshot.StateSHA256 != snap.StateSHA256 || previous.snapshot.Quote.InputCash != snap.Quote.InputCash || previous.snapshot.Quote.QuotedNet != snap.Quote.QuotedNet {
			return nil, bad
		}
		blockhash, end = previous.blockhash, previous.lastValidHeight
	}
	height, e := c.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if height >= end || previous != nil && height < previous.currentHeight {
		return nil, bad
	}
	var old []byte
	if previous != nil {
		old = previous.message
	}
	message, e := compileWENMarketBuyV1(p, snap.Quote, l, blockhash, height, end, old)
	if e != nil {
		return nil, e
	}
	if e = verifyWENMarketBuyMessageV1(message, p, snap.Quote, l, blockhash, height, end); e != nil {
		return nil, e
	}
	fee, e := c.GetFeeForMessage(ctx, base64.StdEncoding.EncodeToString(message), rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if fee == nil || fee.Value == nil || *fee.Value == 0 || *fee.Value > maxFee || !fresh(fee.Context.Slot) || previous != nil && *fee.Value != previous.fee {
		return nil, bad
	}
	balance, e := c.GetBalance(ctx, p.Owner, rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if balance == nil || !fresh(balance.Context.Slot) || balance.Value < maxFee+retainedLamports {
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
	// Re-read custody and installed bytes after simulation. Do not silently rebuild
	// a changed order or extend its lifetime. Clock/slot progression is allowed.
	afterBounds := l
	afterBounds.MinimumSlot = last
	after, e := readWENMarketBuyV1(ctx, c, p, policy, afterBounds)
	if e != nil {
		return nil, e
	}
	if !fresh(after.Quote.Slot) || !fresh(after.Quote.ReferenceSlot) || after.StateSHA256 != snap.StateSHA256 || after.Quote.InputCash != snap.Quote.InputCash || after.Quote.QuotedNet != snap.Quote.QuotedNet {
		return nil, bad
	}
	finalHeight, e := c.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if finalHeight < height || finalHeight >= end {
		return nil, bad
	}
	return &wenMarketPreparedBuyV1{pins: p, policy: policy, limits: l, maxFee: maxFee, retainedLamports: retainedLamports, snapshot: after, message: message, blockhash: blockhash, fee: *fee.Value, units: *sim.Value.UnitsConsumed, currentHeight: finalHeight, lastValidHeight: end}, nil
}
