package main

import (
	"bytes"
	"context"
	"encoding/base64"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

type nativeClaimCostFake struct {
	wenStakingPrepareRPCV1
	t           *testing.T
	mode        string
	message     []byte
	heightCalls int
}

func (f *nativeClaimCostFake) GetLatestBlockhash(context.Context, rpc.CommitmentType) (*rpc.GetLatestBlockhashResult, error) {
	s := uint64(150)
	if f.mode == "stale" {
		s = 149
	}
	return &rpc.GetLatestBlockhashResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: s}}, Value: &rpc.LatestBlockhashResult{Blockhash: solana.Hash{8}, LastValidBlockHeight: 200}}, nil
}
func (f *nativeClaimCostFake) GetBlockHeight(context.Context, rpc.CommitmentType) (uint64, error) {
	f.heightCalls++
	if f.mode == "expired" || f.mode == "expires-during" && f.heightCalls > 1 {
		return 200, nil
	}
	return 100, nil
}
func (f *nativeClaimCostFake) GetFeeForMessage(_ context.Context, m string, c rpc.CommitmentType) (*rpc.GetFeeForMessageResult, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("commitment")
	}
	f.message, _ = base64.StdEncoding.DecodeString(m)
	fee := uint64(5000)
	if f.mode == "fee" {
		fee++
	}
	return &rpc.GetFeeForMessageResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: &fee}, nil
}
func (f *nativeClaimCostFake) GetMinimumBalanceForRentExemption(_ context.Context, n uint64, c rpc.CommitmentType) (uint64, error) {
	if n != 112 || c != rpc.CommitmentFinalized {
		f.t.Fatal("receipt rent")
	}
	if f.mode == "rent" {
		return 1001, nil
	}
	return 1000, nil
}
func (f *nativeClaimCostFake) GetBalance(context.Context, solana.PublicKey, rpc.CommitmentType) (*rpc.GetBalanceResult, error) {
	b := uint64(6000)
	if f.mode == "balance" {
		b--
	}
	return &rpc.GetBalanceResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: b}, nil
}
func (f *nativeClaimCostFake) SimulateRawTransactionWithOpts(_ context.Context, b []byte, o *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	if o.SigVerify || o.ReplaceRecentBlockhash || o.Commitment != rpc.CommitmentFinalized || len(b) < 65 || b[0] != 1 || !bytes.Equal(b[1:65], make([]byte, 64)) || !bytes.Equal(b[65:], f.message) {
		f.t.Fatal("different signed/simulated message")
	}
	units := uint64(10000)
	if f.mode == "units" {
		units = 200001
	}
	var err any
	if f.mode == "simulation" {
		err = "failed"
	}
	return &rpc.SimulateTransactionResponse{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: &rpc.SimulateTransactionResult{Err: err, UnitsConsumed: &units}}, nil
}
func TestWENNativeClaimCosts(t *testing.T) {
	for _, mode := range []string{"ok", "stale", "expired", "expires-during", "fee", "rent", "balance", "budget", "units", "simulation", "missing-state"} {
		t.Run(mode, func(t *testing.T) {
			v := nativeClaimIntentFixture()
			v.MinFinalizedSlot = "100"
			v.ExpiresSlot = "200"
			v.MaxRentLamports = "1000"
			config := wenNativeClaimReviewedConfigV1{maxSlotLag: 2, maxTotalCostLamports: 6000}
			state := wenNativeClaimReadbackV1{Allocation: wenNativeClaimAllocationV1{Gross: 250, Fee: 8, Net: 242, Weight: 25}, Slot: 150, StateHash: wenHashV1([]byte("state"))}
			if mode == "budget" {
				config.maxTotalCostLamports--
			}
			if mode == "missing-state" {
				state.StateHash = ""
			}
			f := &nativeClaimCostFake{t: t, mode: mode}
			out, e := prepareWENNativeClaimCostsV1(context.Background(), f, v, solana.PublicKey{5}, config, state)
			if (e == nil) != (mode == "ok") {
				t.Fatal(e)
			}
			if e == nil && (out.total != 6000 || out.rent != 1000 || out.fee != 5000 || !bytes.Equal(out.message, f.message)) {
				t.Fatal("cost binding")
			}
		})
	}
}

func TestWENNativeClaimPinnedCosts(t *testing.T) {
	for _, mode := range []string{"ok", "review", "state", "message", "fee", "rent", "expiry", "allocation", "weight"} {
		t.Run(mode, func(t *testing.T) {
			v := nativeClaimIntentFixture()
			v.MinFinalizedSlot = "100"
			v.ExpiresSlot = "200"
			v.MaxRentLamports = "1000"
			w := solana.PublicKey{5}
			config := wenNativeClaimReviewedConfigV1{maxSlotLag: 2, maxTotalCostLamports: 6000, reviewSHA: wenHashV1([]byte("review"))}
			state := wenNativeClaimReadbackV1{Allocation: wenNativeClaimAllocationV1{Gross: 250, Fee: 8, Net: 242, Weight: 25}, Slot: 150, StateHash: wenHashV1([]byte("state"))}
			ix, _ := buildWENNativeClaimInstructionV1(v, w)
			old := solana.Hash{9}
			tx, _ := solana.NewTransaction([]solana.Instruction{ix}, old, solana.TransactionPayer(w))
			tx.Message.SetVersion(solana.MessageVersionV0)
			msg, _ := tx.Message.MarshalBinary()
			b := wenNativeClaimMessageBindingV1{Gross: 250, TransferFee: 8, Net: 242, Weight: 25, Message: msg, Blockhash: old, ReviewSHA: config.reviewSHA, StateHash: state.StateHash, Slot: 150, Fee: 5000, Rent: 1000, LastValidHeight: 180}
			switch mode {
			case "review":
				b.ReviewSHA = wenHashV1([]byte("other"))
			case "state":
				b.StateHash = wenHashV1([]byte("other"))
			case "message":
				b.Message[0] ^= 1
			case "fee":
				b.Fee = 4999
			case "rent":
				b.Rent = 999
			case "allocation":
				b.Net++
			case "weight":
				b.Weight++
			case "expiry":
				b.LastValidHeight = 100
			}
			f := &nativeClaimCostFake{t: t}
			out, e := preparePinnedWENNativeClaimCostsV1(context.Background(), f, v, w, config, state, &b)
			if (e == nil) != (mode == "ok") {
				t.Fatal(e)
			}
			if e == nil && (out.blockhash != old || out.lastValidHeight != 180 || !bytes.Equal(out.message, msg)) {
				t.Fatal("original signed bytes replaced")
			}
		})
	}
}
