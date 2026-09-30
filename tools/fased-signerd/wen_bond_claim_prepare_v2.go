package main

import (
	"context"
	"encoding/base64"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"reflect"
)

type wenBondClaimPreparedV2 struct {
	pins                                                                 wenBondPinsV2
	policy                                                               wenBondReadPolicyV2
	snapshot                                                             wenBondClaimSnapshotV2
	maxFee, retainedLamports, fee, units, currentHeight, lastValidHeight uint64
	blockhash                                                            solana.Hash
	message                                                              []byte
}

// Clock-only vesting growth does not change the nonce instruction. Existing
// accepted rights and prior claims must be identical; current funding is checked
// for the larger preview by the reader. This never attributes receipt progress.
func wenBondClaimRefreshV2(old, fresh wenBondClaimV2) bool {
	if fresh.AvailableGross < old.AvailableGross || fresh.AvailableNet < old.AvailableNet {
		return false
	}
	old.AvailableGross, old.AvailableNet, old.TransferFee = 0, 0, 0
	fresh.AvailableGross, fresh.AvailableNet, fresh.TransferFee = 0, 0, 0
	return old == fresh
}

// No account creation, priority-fee/tip instruction, reservation, signing or
// submission. Revalidation retains the original message and blockhash lifetime.
func prepareWENBondClaimV2(ctx context.Context, c wenMiningPrepareRPCV1, p wenBondPinsV2, policy wenBondReadPolicyV2, maxFee, retained uint64, previous *wenBondClaimPreparedV2) (*wenBondClaimPreparedV2, error) {
	bad := errors.New("Bond protected claim preparation rejected")
	if c == nil || maxFee == 0 || retained > ^uint64(0)-maxFee {
		return nil, bad
	}
	if policy.Deployment.UpgradeAuthority != nil {
		x := *policy.Deployment.UpgradeAuthority
		policy.Deployment.UpgradeAuthority = &x
	}
	if previous != nil && (previous.pins != p || !reflect.DeepEqual(previous.policy, policy) || previous.maxFee != maxFee || previous.retainedLamports != retained) {
		return nil, bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	s, e := readWENBondClaimV2(ctx, c, p, policy)
	if e != nil {
		return nil, e
	}
	last := s.ReferenceSlot
	fresh := func(slot uint64) bool {
		if slot < last || slot < policy.MinimumSlot || slot >= policy.ExpiresSlot || slot-s.Slot > policy.MaxSlotLag {
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
		if previous.snapshot.StateSHA256 != s.StateSHA256 || !wenBondClaimRefreshV2(previous.snapshot.Claim, s.Claim) {
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
	var old []byte
	if previous != nil {
		old = previous.message
	}
	message, e := compileWENBondClaimV2(p, s.Claim, hash, height, end, old)
	if e != nil {
		return nil, e
	}
	if e = verifyWENBondClaimMessageV2(message, p, s.Claim, hash, height, end); e != nil {
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
	if balance == nil || !fresh(balance.Context.Slot) || balance.Value < maxFee+retained {
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
	bounds := policy
	bounds.MinimumSlot = last
	after, e := readWENBondClaimV2(ctx, c, p, bounds)
	if e != nil {
		return nil, e
	}
	// Allow only Clock-driven vesting growth, not changed receipt/custody state.
	if !fresh(after.Slot) || !fresh(after.ReferenceSlot) || after.StateSHA256 != s.StateSHA256 || !wenBondClaimRefreshV2(s.Claim, after.Claim) {
		return nil, bad
	}
	final, e := c.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return nil, e
	}
	if final < height || final >= end {
		return nil, bad
	}
	return &wenBondClaimPreparedV2{pins: p, policy: policy, snapshot: after, maxFee: maxFee, retainedLamports: retained, fee: *fee.Value, units: *sim.Value.UnitsConsumed, currentHeight: final, lastValidHeight: end, blockhash: hash, message: message}, nil
}
