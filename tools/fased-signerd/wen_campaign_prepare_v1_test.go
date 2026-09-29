package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type campaignPrepareFake struct {
	*campaignReadFake
	next           uint64
	mode           string
	reads, heights int
	message        []byte
}

func (f *campaignPrepareFake) bump() uint64 { f.next++; return f.next }
func (f *campaignPrepareFake) GetSlot(context.Context, rpc.CommitmentType) (uint64, error) {
	return f.bump(), nil
}
func (f *campaignPrepareFake) GetMultipleAccountsWithOpts(_ context.Context, keys []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if len(keys) != len(f.addresses) || keys[0] != f.addresses[0] {
		page, err := f.campaignReadFake.GetMultipleAccountsWithOpts(context.Background(), keys, o)
		if err == nil && page != nil && f.mode == "accounting-changed" && f.reads > 1 && len(keys) >= 5 {
			copyPage := *page
			copyPage.Value = append([]*rpc.Account(nil), page.Value...)
			copySale := *copyPage.Value[0]
			copySale.Lamports++
			copyPage.Value[0] = &copySale
			return &copyPage, nil
		}
		return page, err
	}
	if o.Commitment != rpc.CommitmentFinalized || o.MinContextSlot == nil || len(keys) != len(f.addresses) {
		f.t.Fatal("unbounded read")
	}
	for i, k := range keys {
		if k != f.addresses[i] {
			f.t.Fatal("wrong key")
		}
	}
	slot := f.bump()
	if slot < *o.MinContextSlot {
		f.t.Fatal("stale fixture")
	}
	f.reads++
	out := &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: slot}}, Value: make([]*rpc.Account, len(keys))}
	for i, a := range f.page.Value {
		copy := *a
		data := append([]byte(nil), a.Data.GetBinary()...)
		if i == 3 {
			binary.LittleEndian.PutUint64(data, slot)
		}
		if i == 0 && f.mode == "changed" && f.reads > 1 {
			copy.Lamports++
		}
		copy.Data = rpc.DataBytesOrJSONFromBytes(data)
		out.Value[i] = &copy
	}
	return out, nil
}
func (f *campaignPrepareFake) GetLatestBlockhash(context.Context, rpc.CommitmentType) (*rpc.GetLatestBlockhashResult, error) {
	return &rpc.GetLatestBlockhashResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: f.bump()}}, Value: &rpc.LatestBlockhashResult{Blockhash: f.genesis, LastValidBlockHeight: 200}}, nil
}
func (f *campaignPrepareFake) GetBlockHeight(context.Context, rpc.CommitmentType) (uint64, error) {
	f.heights++
	if f.mode == "expired" || f.mode == "expires-during" && f.heights > 1 {
		return 200, nil
	}
	return 100, nil
}
func (f *campaignPrepareFake) GetFeeForMessage(_ context.Context, message string, _ rpc.CommitmentType) (*rpc.GetFeeForMessageResult, error) {
	f.message, _ = base64.StdEncoding.DecodeString(message)
	fee := uint64(5000)
	if f.mode == "fee" {
		fee++
	}
	return &rpc.GetFeeForMessageResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: f.bump()}}, Value: &fee}, nil
}
func (f *campaignPrepareFake) GetBalance(context.Context, solana.PublicKey, rpc.CommitmentType) (*rpc.GetBalanceResult, error) {
	amount := uint64(6000)
	if f.mode == "balance" {
		amount--
	}
	return &rpc.GetBalanceResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: f.bump()}}, Value: amount}, nil
}
func (f *campaignPrepareFake) SimulateRawTransactionWithOpts(_ context.Context, wire []byte, o *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	if o.SigVerify || o.ReplaceRecentBlockhash || o.Commitment != rpc.CommitmentFinalized || len(wire) != 65+len(f.message) || wire[0] != 1 || !bytes.Equal(wire[1:65], make([]byte, 64)) || !bytes.Equal(wire[65:], f.message) {
		f.t.Fatal("noncanonical simulation")
	}
	units := uint64(10000)
	if f.mode == "units" {
		units = 200001
	}
	out := &rpc.SimulateTransactionResponse{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: f.bump()}}, Value: &rpc.SimulateTransactionResult{UnitsConsumed: &units}}
	if f.mode == "simulation" {
		out.Value.Err = "failed"
	}
	return out, nil
}
