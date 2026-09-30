package main

import (
	"context"
	"encoding/base64"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
)

type wenMiningPrepareRPCV1 interface {
	signerWENBTCReadRPCV1
	GetLatestBlockhash(context.Context, rpc.CommitmentType) (*rpc.GetLatestBlockhashResult, error)
	GetBlockHeight(context.Context, rpc.CommitmentType) (uint64, error)
	GetFeeForMessage(context.Context, string, rpc.CommitmentType) (*rpc.GetFeeForMessageResult, error)
	GetBalance(context.Context, solana.PublicKey, rpc.CommitmentType) (*rpc.GetBalanceResult, error)
	SimulateRawTransactionWithOpts(context.Context, []byte, *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error)
}

// Private observation only. A caller must revalidate before crossing the durable
// signing fence. No rent or mining principal is spent by commit/reveal.
type wenMiningPreparedV1 struct {
	message                                          []byte
	blockhash                                        solana.Hash
	entry                                            wenMiningEntrySnapshotV1
	accountKeys                                      []string
	slot, fee, units, currentHeight, lastValidHeight uint64
}

func prepareWENMiningFromRPCV1(ctx context.Context, client wenMiningPrepareRPCV1, root string, pins wenMiningPinsV1, v signerWENMiningIntentV1, wallet solana.PublicKey, maxSlotLag uint64) (*wenMiningPreparedV1, error) {
	return prepareWENMiningPinnedV1(ctx, client, root, pins, v, wallet, maxSlotLag, nil)
}

func prepareWENMiningPinnedV1(ctx context.Context, client wenMiningPrepareRPCV1, root string, pins wenMiningPinsV1, v signerWENMiningIntentV1, wallet solana.PublicKey, maxSlotLag uint64, previous *wenMiningPreparedV1) (*wenMiningPreparedV1, error) {
	bad := errors.New("WEN mining preparation rejected")
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	material, err := loadWENMiningPreimageV1(root, v, wallet)
	if err != nil {
		return nil, err
	}
	defer zeroBytes(material)
	var reveal []byte
	if v.Operation == "reveal" {
		reveal = material
	}
	snap, err := readWENMiningRPCV1(ctx, client, pins, v, wallet, reveal, maxSlotLag)
	if err != nil {
		return nil, err
	}
	expires, _ := strconv.ParseUint(v.ExpiresSlot, 10, 64)
	minimum := snap.Slot
	fresh := func(slot uint64) bool {
		if slot < minimum || slot-snap.Slot > maxSlotLag || slot >= expires {
			return false
		}
		minimum = slot
		return true
	}
	bh, err := client.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	if bh == nil || bh.Value == nil || !fresh(bh.Context.Slot) || bh.Value.Blockhash == (solana.Hash{}) {
		return nil, bad
	}
	if previous != nil {
		if previous.blockhash == (solana.Hash{}) || previous.slot > minimum {
			return nil, bad
		}
		// Keep the exact original lifetime and message; a fresh RPC blockhash cannot
		// authorize a replacement transaction after reservation or signing.
		owned := *bh.Value
		owned.Blockhash, owned.LastValidBlockHeight = previous.blockhash, previous.lastValidHeight
		copyResult := *bh
		copyResult.Value = &owned
		bh = &copyResult
	}
	height, err := client.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	if height >= bh.Value.LastValidBlockHeight || previous != nil && height < previous.currentHeight {
		return nil, bad
	}
	ix, err := prepareWENMiningInstructionV1(v, wallet, snap, reveal)
	if err != nil {
		return nil, err
	}
	tx, err := solana.NewTransaction([]solana.Instruction{ix}, bh.Value.Blockhash, solana.TransactionPayer(wallet))
	if err != nil {
		return nil, err
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	message, err := tx.Message.MarshalBinary()
	if err != nil {
		return nil, err
	}
	fee, err := client.GetFeeForMessage(ctx, base64.StdEncoding.EncodeToString(message), rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	if fee == nil || fee.Value == nil || !fresh(fee.Context.Slot) {
		return nil, bad
	}
	if err = verifyWENMiningMessageV1(v, wallet, snap, reveal, message, bh.Value.Blockhash, height, bh.Value.LastValidBlockHeight, *fee.Value); err != nil {
		return nil, err
	}
	balance, err := client.GetBalance(ctx, wallet, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	maxFee, _ := strconv.ParseUint(v.MaxFeeLamports, 10, 64)
	if balance == nil || !fresh(balance.Context.Slot) || balance.Value < maxFee {
		return nil, bad
	}
	wire := make([]byte, 65+len(message))
	wire[0] = 1
	copy(wire[65:], message)
	sim, err := client.SimulateRawTransactionWithOpts(ctx, wire, &rpc.SimulateTransactionOpts{Commitment: rpc.CommitmentFinalized, SigVerify: false, ReplaceRecentBlockhash: false})
	if err != nil {
		return nil, err
	}
	// The canonical message contains one ordinary instruction and no compute-budget override.
	if sim == nil || sim.Value == nil || sim.Value.Err != nil || sim.Value.UnitsConsumed == nil || *sim.Value.UnitsConsumed > 200000 || !fresh(sim.Context.Slot) {
		return nil, bad
	}
	finalHeight, err := client.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	if finalHeight < height || finalHeight >= bh.Value.LastValidBlockHeight {
		return nil, bad
	}
	// Recheck phase, deployment, exact entry and stored material after simulation.
	again, err := readWENMiningRPCV1(ctx, client, pins, v, wallet, reveal, maxSlotLag)
	if err != nil {
		return nil, err
	}
	if !fresh(again.Slot) {
		return nil, bad
	}
	if err = verifyWENMiningProtectedMessageV1(root, v, wallet, again, message, bh.Value.Blockhash, finalHeight, bh.Value.LastValidBlockHeight, *fee.Value); err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	keys, err := tx.Message.GetAllKeys()
	if err != nil {
		return nil, err
	}
	out := &wenMiningPreparedV1{entry: again, blockhash: bh.Value.Blockhash, message: append([]byte(nil), message...), slot: minimum, fee: *fee.Value, units: *sim.Value.UnitsConsumed, currentHeight: finalHeight, lastValidHeight: bh.Value.LastValidBlockHeight}
	for _, key := range keys {
		out.accountKeys = append(out.accountKeys, key.String())
	}
	return out, nil
}
