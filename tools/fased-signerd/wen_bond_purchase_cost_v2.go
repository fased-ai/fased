package main

import (
	"context"
	"encoding/base64"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"reflect"
)

type wenBondPurchaseCostLimitsV2 struct {
	MaxFee, MaxRent, RecoveryBudget, RetainedLamports uint64
	ComputeUnits                                      uint32
}
type wenBondPurchaseCostPreparedV2 struct {
	pins                                              wenBondPurchasePinsV2
	policy                                            wenBondPurchaseReadPolicyV2
	limits                                            wenBondPurchaseCostLimitsV2
	snapshot                                          wenBondPurchaseSnapshotV2
	message                                           []byte
	blockhash                                         solana.Hash
	fee, total, units, currentHeight, lastValidHeight uint64
}

// Every amount is a protected limit, not an application quote. Receipt capital
// and recoverable staging rent both count toward peak funding; no anticipated
// rent refund can finance the purchase. This remains unsigned and unreserved.
func prepareWENBondPurchaseCostsV2(ctx context.Context, c wenMiningPrepareRPCV1, p wenBondPurchasePinsV2, policy wenBondPurchaseReadPolicyV2, limits wenBondPurchaseCostLimitsV2, previous *wenBondPurchaseCostPreparedV2) (*wenBondPurchaseCostPreparedV2, error) {
	bad := errors.New("Bond protected purchase cost preparation rejected")
	if c == nil || limits.MaxFee == 0 || limits.RecoveryBudget == 0 || limits.ComputeUnits == 0 || limits.ComputeUnits > 1400000 {
		return nil, bad
	}
	policy = cloneWENBondPurchasePolicyV2(policy)
	p.PolicyBytes = append([]byte(nil), p.PolicyBytes...)
	if previous != nil && (!reflect.DeepEqual(previous.pins, p) || !reflect.DeepEqual(previous.policy, policy) || previous.limits != limits) {
		return nil, bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	s, e := readWENBondPurchaseV2(ctx, c, p, policy)
	if e != nil {
		return nil, e
	}
	if s.Rent > limits.MaxRent {
		return nil, bad
	}
	last := s.ReferenceSlot
	fresh := func(slot uint64) bool {
		if slot < last || slot >= policy.ExpiresSlot || slot < s.Slot || slot-s.Slot > policy.MaxSlotLag {
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
	hash, end := bh.Value.Blockhash, bh.Value.LastValidBlockHeight
	if previous != nil {
		if previous.snapshot.StateSHA256 != s.StateSHA256 || previous.snapshot.Rent != s.Rent {
			return nil, bad
		}
		hash, end = previous.blockhash, previous.lastValidHeight
	}
	height, e := c.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if height >= end || previous != nil && height < previous.currentHeight {
		return nil, bad
	}
	life := signerWENBTCMessageLifeV1{height, end, s.Slot, policy.MaxSlotLag}
	packet, e := prepareWENBondPurchaseMessageV2(s.Pins, s.Quote, &s.Source, policy.Nonce, s.Now, policy.Route, hash, limits.ComputeUnits, policy.internalLookups(), s.Lookups, life)
	if e != nil {
		return nil, e
	}
	if previous != nil && !reflect.DeepEqual(previous.message, packet.message) {
		return nil, bad
	}
	fee, e := c.GetFeeForMessage(ctx, base64.StdEncoding.EncodeToString(packet.message), rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if fee == nil || fee.Value == nil || *fee.Value == 0 || *fee.Value > limits.MaxFee || !fresh(fee.Context.Slot) || previous != nil && *fee.Value != previous.fee {
		return nil, bad
	}
	total := uint64(0)
	for _, n := range []uint64{*fee.Value, s.Rent, limits.RecoveryBudget, limits.RetainedLamports} {
		if total > ^uint64(0)-n {
			return nil, bad
		}
		total += n
	}
	balance, e := c.GetBalance(ctx, p.Bond.Owner, rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if balance == nil || !fresh(balance.Context.Slot) || balance.Value < total {
		return nil, bad
	}
	wire := make([]byte, 65+len(packet.message))
	wire[0] = 1
	copy(wire[65:], packet.message)
	sim, e := c.SimulateRawTransactionWithOpts(ctx, wire, &rpc.SimulateTransactionOpts{Commitment: rpc.CommitmentFinalized, SigVerify: false, ReplaceRecentBlockhash: false})
	if e != nil {
		return nil, e
	}
	if sim == nil || sim.Value == nil || sim.Value.Err != nil || sim.Value.UnitsConsumed == nil || *sim.Value.UnitsConsumed > uint64(limits.ComputeUnits) || !fresh(sim.Context.Slot) {
		return nil, bad
	}
	bounds := policy
	bounds.MinimumSlot = last
	after, e := readWENBondPurchaseV2(ctx, c, p, bounds)
	if e != nil {
		return nil, e
	}
	if !fresh(after.Slot) || !fresh(after.ReferenceSlot) || after.Now < s.Now || after.StateSHA256 != s.StateSHA256 || after.Rent != s.Rent || after.RefundableRent != s.RefundableRent {
		return nil, bad
	}
	if _, e = packet.revalidate(after.Quote, &after.Source, after.Now, height, after.Lookups); e != nil {
		return nil, e
	}
	final, e := c.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if final < height || final >= end {
		return nil, bad
	}
	return &wenBondPurchaseCostPreparedV2{p, policy, limits, after, append([]byte(nil), packet.message...), hash, *fee.Value, total, *sim.Value.UnitsConsumed, final, end}, nil
}
