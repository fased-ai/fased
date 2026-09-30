package main

import (
	"context"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

type wenPrepareRPCFake struct {
	*wenReadRPCFake
	table          *rpc.GetMultipleAccountsResult
	pins           []signerWENBTCLookupPinV1
	hash           *rpc.GetLatestBlockhashResult
	heights, slots int
	mode           string
	combined       bool
}

func (f *wenPrepareRPCFake) GetMultipleAccountsWithOpts(ctx context.Context, keys []solana.PublicKey, opts *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if len(keys) == 30 && f.combined {
		return f.wenReadRPCFake.GetMultipleAccountsWithOpts(ctx, keys, opts)
	}
	if len(keys) != len(f.pins) || opts.Commitment != rpc.CommitmentFinalized || opts.Encoding != solana.EncodingBase64 || opts.MinContextSlot == nil || *opts.MinContextSlot != 151 {
		f.t.Fatal("lookup request not bound to finalized instruction readback")
	}
	for i, k := range keys {
		if k != f.pins[i].key {
			f.t.Fatal("lookup address substitution")
		}
	}
	if f.mode == "table-error" {
		return nil, errors.New("table read failed")
	}
	return f.table, nil
}
func (f *wenPrepareRPCFake) GetLatestBlockhash(_ context.Context, c rpc.CommitmentType) (*rpc.GetLatestBlockhashResult, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("blockhash not finalized")
	}
	if f.mode == "hash-error" {
		return nil, errors.New("blockhash failed")
	}
	return f.hash, nil
}
func (f *wenPrepareRPCFake) GetBlockHeight(_ context.Context, c rpc.CommitmentType) (uint64, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("height not finalized")
	}
	f.heights++
	switch f.mode {
	case "height-error":
		return 0, errors.New("height failed")
	case "expired":
		return 20, nil
	case "expires-during":
		if f.heights > 1 {
			return 20, nil
		}
	case "height-rollback":
		if f.heights > 1 {
			return 9, nil
		}
	}
	return uint64(9 + f.heights), nil
}
func (f *wenPrepareRPCFake) GetSlot(_ context.Context, c rpc.CommitmentType) (uint64, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("slot not finalized")
	}
	f.slots++
	if f.combined && f.slots == 1 {
		return 151, nil
	}
	switch f.mode {
	case "reference-stale":
		return 156, nil
	case "reference-behind":
		return 152, nil
	}
	return 154, nil
}
func (f *wenPrepareRPCFake) GetGenesisHash(ctx context.Context) (solana.Hash, error) {
	f.calls++
	if f.mode == "genesis" || (f.mode == "genesis-change" && f.calls > 1) {
		return solana.Hash{}, nil
	}
	return f.genesis, nil
}
func wenPrepareRPCFixture(t *testing.T, operation string) (signerWENBTCMessageIntentV1, *wenPrepareRPCFake, signerWENBTCReadResultV1) {
	t.Helper()
	_, intent, pins, snapshots, _ := wenMessageFixture(t, operation)
	f := &wenPrepareRPCFake{wenReadRPCFake: &wenReadRPCFake{t: t, genesis: solana.Hash{7}}, pins: pins, table: &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 152}}, Value: []*rpc.Account{{Owner: snapshots[0].Owner, Data: rpc.DataBytesOrJSONFromBytes(snapshots[0].Data)}}}, hash: &rpc.GetLatestBlockhashResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 153}}, Value: &rpc.LatestBlockhashResult{Blockhash: solana.Hash{1}, LastValidBlockHeight: 20}}}
	return intent, f, signerWENBTCReadResultV1{Slot: 150, ReferenceSlot: 151, Now: 100, Data: intent.data, Accounts: intent.accounts}
}
func TestWENBTCFreshPreparationRPC(t *testing.T) {
	for _, operation := range []string{"acceptance", "acquisition"} {
		t.Run(operation, func(t *testing.T) {
			intent, f, read := wenPrepareRPCFixture(t, operation)
			p, err := prepareWENBTCReadbackRPCV1(context.Background(), f, f.genesis.String(), intent.program, intent.payer, read, 200, 5, 200000, f.pins)
			if err != nil || p == nil {
				t.Fatal(err)
			}
			if f.heights != 2 || f.calls != 2 || len(p.message) == 0 || p.life.currentHeight != 11 {
				t.Fatal("incomplete rechecks")
			}
		})
	}
}
func TestWENBTCFreshPreparationRejectsRPCDrift(t *testing.T) {
	for _, mode := range []string{"genesis", "genesis-change", "table-error", "table-missing", "table-old", "table-stale", "table-owner", "table-bytes", "hash-error", "hash-missing", "hash-empty", "hash-old", "hash-stale", "height-error", "expired", "expires-during", "height-rollback", "reference-stale", "reference-behind", "intent-expired"} {
		t.Run(mode, func(t *testing.T) {
			intent, f, read := wenPrepareRPCFixture(t, "acquisition")
			f.mode = mode
			expiry := uint64(200)
			switch mode {
			case "table-missing":
				f.table.Value[0] = nil
			case "table-old":
				f.table.Context.Slot = 150
			case "table-stale":
				f.table.Context.Slot = 156
			case "table-owner":
				f.table.Value[0].Owner = intent.program
			case "table-bytes":
				f.table.Value[0].Data.GetBinary()[56] ^= 1
			case "hash-missing":
				f.hash = nil
			case "hash-empty":
				f.hash.Value.Blockhash = solana.Hash{}
			case "hash-old":
				f.hash.Context.Slot = 151
			case "hash-stale":
				f.hash.Context.Slot = 156
			case "intent-expired":
				expiry = 154
			}
			p, err := prepareWENBTCReadbackRPCV1(context.Background(), f, f.genesis.String(), intent.program, intent.payer, read, expiry, 5, 200000, f.pins)
			if err == nil || p != nil {
				t.Fatal("inconsistent RPC returned preparation")
			}
		})
	}
}
func TestWENBTCInstructionReadbackToPreparedMessage(t *testing.T) {
	root, pins, intent, wallet, reader := wenRPCFixture(t)
	_, f, _ := wenPrepareRPCFixture(t, "acceptance")
	f.wenReadRPCFake = reader
	f.combined = true
	p, err := prepareWENBTCFromRPCV1(context.Background(), f, root, pins, intent, wallet, 180000, 5, 200000, f.pins, nil)
	if err != nil || p == nil {
		t.Fatal(err)
	}
	if p.intent.payer != wallet || p.intent.data[0] != 111 || p.life.minimumSlot != 150 || f.heights != 2 {
		t.Fatal("instruction binding lost")
	}
}
