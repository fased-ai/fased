package main

import (
	"context"
	"encoding/base64"
	"errors"
	"math"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type signerWENBTCSimulationRPCV1 interface {
	signerWENBTCPrepareRPCV1
	GetFeeForMessage(context.Context, string, rpc.CommitmentType) (*rpc.GetFeeForMessageResult, error)
	GetMinimumBalanceForRentExemption(context.Context, uint64, rpc.CommitmentType) (uint64, error)
	GetBalance(context.Context, solana.PublicKey, rpc.CommitmentType) (*rpc.GetBalanceResult, error)
	SimulateRawTransactionWithOpts(context.Context, []byte, *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error)
}

// Internal observation, not a signing ticket or an execution receipt. Rent is
// working capital; acquisition's two temporary token accounts are refundable.
type signerWENBTCSimulationV1 struct {
	slot, height, units, fee, rent, refundableRent, total uint64
}

func simulateWENBTCFromRPCV1(ctx context.Context, client signerWENBTCSimulationRPCV1, root string, pins signerWENBTCPinsV1, intent signerWENBTCIntentV1, wallet solana.PublicKey, nowHint, maxSlotLag uint64, units uint32, lookups []signerWENBTCLookupPinV1, route *signerWENBTCRouteV1) (*signerWENBTCSimulationV1, error) {
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	p, err := prepareWENBTCFromRPCV1(ctx, client, root, pins, intent, wallet, nowHint, maxSlotLag, units, lookups, route)
	if err != nil {
		return nil, err
	}
	fee, _ := strconv.ParseUint(intent.MaxFeeLamports, 10, 64)
	rent, _ := strconv.ParseUint(intent.MaxRentLamports, 10, 64)
	return simulateWENBTCPreparedV1(ctx, client, p, pins.Genesis, fee, rent)
}

func simulateWENBTCPreparedV1(ctx context.Context, client signerWENBTCSimulationRPCV1, p *signerWENBTCPreparedMessageV1, genesis string, maxFee, maxRent uint64) (*signerWENBTCSimulationV1, error) {
	bad := errors.New("WEN BTC simulation or cost admission rejected")
	if p == nil || len(p.message) == 0 || len(p.message)+65 > 1232 || len(p.intent.data) == 0 || len(p.rentLengths) < 2 || len(p.rentLengths) > 6 || maxFee == 0 || maxRent > math.MaxUint64-maxFee || p.referenceSlot < p.life.minimumSlot || p.referenceSlot >= p.expiresSlot {
		return nil, bad
	}
	chain := func() error {
		h, err := client.GetGenesisHash(ctx)
		if err != nil {
			return err
		}
		if h.String() != genesis {
			return bad
		}
		return nil
	}
	if err := chain(); err != nil {
		return nil, err
	}
	// SDK calls without minContextSlot must still return a monotonically fresh
	// context within the instruction's original admission window.
	minimum := p.referenceSlot
	fresh := func(slot uint64) bool {
		if slot < minimum || slot < p.life.minimumSlot || slot-p.life.minimumSlot > p.life.maximumSlotLag || slot >= p.expiresSlot {
			return false
		}
		minimum = slot
		return true
	}
	fee, err := client.GetFeeForMessage(ctx, base64.StdEncoding.EncodeToString(p.message), rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	if fee == nil || fee.Value == nil || !fresh(fee.Context.Slot) || *fee.Value > maxFee {
		return nil, bad
	}
	out := &signerWENBTCSimulationV1{fee: *fee.Value}
	for _, size := range p.rentLengths {
		n, err := client.GetMinimumBalanceForRentExemption(ctx, size, rpc.CommitmentFinalized)
		if err != nil {
			return nil, err
		}
		if n == 0 || n > math.MaxUint64-out.rent {
			return nil, bad
		}
		out.rent += n
	}
	if out.rent > maxRent || out.fee > math.MaxUint64-out.rent {
		return nil, bad
	}
	out.total = out.fee + out.rent
	balance, err := client.GetBalance(ctx, p.intent.payer, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	if balance == nil || !fresh(balance.Context.Slot) || balance.Value < out.total {
		return nil, bad
	}
	// One compact signature count, one zeroed signature, then the exact reviewed
	// message. No SDK reconstruction or replacement blockhash is permitted.
	wire := make([]byte, 65+len(p.message))
	wire[0] = 1
	copy(wire[65:], p.message)
	sim, err := client.SimulateRawTransactionWithOpts(ctx, wire, &rpc.SimulateTransactionOpts{Commitment: rpc.CommitmentFinalized, SigVerify: false, ReplaceRecentBlockhash: false})
	if err != nil {
		return nil, err
	}
	if sim == nil || sim.Value == nil || sim.Value.Err != nil || sim.Value.UnitsConsumed == nil || *sim.Value.UnitsConsumed > uint64(p.intent.units) || !fresh(sim.Context.Slot) {
		return nil, bad
	}
	height, err := client.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	if height < p.life.currentHeight || height >= p.life.lastValidHeight {
		return nil, bad
	}
	if err := chain(); err != nil {
		return nil, err
	}
	out.slot, out.height, out.units = sim.Context.Slot, height, *sim.Value.UnitsConsumed
	if p.intent.data[0] == 112 {
		out.refundableRent = out.rent
	}
	return out, nil
}
