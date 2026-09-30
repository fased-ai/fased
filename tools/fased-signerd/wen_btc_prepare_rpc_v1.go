package main

import (
	"context"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
)

type signerWENBTCPrepareRPCV1 interface {
	signerWENBTCReadRPCV1
	GetLatestBlockhash(context.Context, rpc.CommitmentType) (*rpc.GetLatestBlockhashResult, error)
	GetBlockHeight(context.Context, rpc.CommitmentType) (uint64, error)
}

// Internal preparation only. The same signer-owned client supplies instruction,
// deployment/custody observations, lookup tables, blockhash and lifetime. This
// returns no signature and does not expose a new external execution operation.
func prepareWENBTCFromRPCV1(ctx context.Context, client signerWENBTCPrepareRPCV1, root string, pins signerWENBTCPinsV1, intent signerWENBTCIntentV1, wallet solana.PublicKey, nowHint, maxSlotLag uint64, units uint32, lookups []signerWENBTCLookupPinV1, route *signerWENBTCRouteV1) (*signerWENBTCPreparedMessageV1, error) {
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	if units == 0 || units > 1400000 || len(lookups) < 1 || len(lookups) > 4 {
		return nil, errors.New("invalid WEN BTC preparation limits")
	}
	lookups = append([]signerWENBTCLookupPinV1(nil), lookups...)
	readback, err := readWENBTCSubscriptionRPCV1(ctx, client, root, pins, intent, wallet, nowHint, maxSlotLag, route)
	if err != nil {
		return nil, err
	}
	expiry, _ := strconv.ParseUint(intent.ExpiresSlot, 10, 64)
	return prepareWENBTCReadbackRPCV1(ctx, client, pins.Genesis, solana.MustPublicKeyFromBase58(pins.ProgramID), wallet, readback, expiry, maxSlotLag, units, lookups)
}

func prepareWENBTCReadbackRPCV1(ctx context.Context, client signerWENBTCPrepareRPCV1, genesis string, program, wallet solana.PublicKey, readback signerWENBTCReadResultV1, expiresSlot, maxSlotLag uint64, units uint32, pins []signerWENBTCLookupPinV1) (*signerWENBTCPreparedMessageV1, error) {
	bad := errors.New("WEN BTC preparation readback is stale or inconsistent")
	if readback.Slot == 0 || readback.ReferenceSlot < readback.Slot || readback.ReferenceSlot-readback.Slot > maxSlotLag || readback.ReferenceSlot >= expiresSlot || len(pins) < 1 || len(pins) > 4 {
		return nil, bad
	}
	expectedGenesis, err := solana.HashFromBase58(genesis)
	if err != nil || expectedGenesis == (solana.Hash{}) {
		return nil, bad
	}
	chain, err := client.GetGenesisHash(ctx)
	if err != nil {
		return nil, err
	}
	if chain != expectedGenesis {
		return nil, bad
	}
	keys := make([]solana.PublicKey, len(pins))
	seen := map[solana.PublicKey]bool{}
	for i, p := range pins {
		if p.key.IsZero() || seen[p.key] {
			return nil, bad
		}
		seen[p.key] = true
		keys[i] = p.key
	}
	minimum := readback.ReferenceSlot
	batch, err := client.GetMultipleAccountsWithOpts(ctx, keys, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &minimum})
	if err != nil {
		return nil, err
	}
	inWindow := func(slot uint64) bool {
		return slot >= readback.Slot && slot-readback.Slot <= maxSlotLag && slot < expiresSlot
	}
	if batch == nil || len(batch.Value) != len(keys) || batch.Context.Slot < minimum || !inWindow(batch.Context.Slot) {
		return nil, bad
	}
	snapshots := make([]*signerWENBTCAccountV1, len(keys))
	for i, a := range batch.Value {
		if a == nil || a.Data == nil {
			return nil, errors.New("WEN BTC admitted lookup missing")
		}
		snapshots[i] = &signerWENBTCAccountV1{Address: keys[i], Owner: a.Owner, Slot: batch.Context.Slot, Executable: a.Executable, Data: append([]byte(nil), a.Data.GetBinary()...)}
	}
	// Reject unadmitted table state before obtaining a blockhash or compiling.
	life := signerWENBTCMessageLifeV1{minimumSlot: readback.Slot, maximumSlotLag: maxSlotLag}
	if _, err = verifiedWENBTCLookupTablesV1(pins, snapshots, life); err != nil {
		return nil, err
	}
	hash, err := client.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	if hash == nil || hash.Value == nil || hash.Value.Blockhash == (solana.Hash{}) || hash.Context.Slot < batch.Context.Slot || !inWindow(hash.Context.Slot) {
		return nil, bad
	}
	height, err := client.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	life.currentHeight = height
	life.lastValidHeight = hash.Value.LastValidBlockHeight
	prepared, err := prepareWENBTCMessageV1(signerWENBTCMessageIntentV1{payer: wallet, program: program, blockhash: hash.Value.Blockhash, units: units, data: readback.Data, accounts: readback.Accounts}, pins, snapshots, life)
	if err != nil {
		return nil, err
	}
	finalHeight, err := client.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	if _, err = prepared.revalidate(snapshots, finalHeight); err != nil {
		return nil, err
	}
	reference, err := client.GetSlot(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return nil, err
	}
	if reference < hash.Context.Slot || !inWindow(reference) {
		return nil, bad
	}
	chain, err = client.GetGenesisHash(ctx)
	if err != nil {
		return nil, err
	}
	if chain != expectedGenesis {
		return nil, bad
	}
	// Carry the latest checked height into subsequent revalidation.
	prepared.life.currentHeight = finalHeight
	prepared.referenceSlot = reference
	prepared.expiresSlot = expiresSlot
	prepared.rentLengths = append([]uint64(nil), readback.rentLengths...)
	return prepared, nil
}
