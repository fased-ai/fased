package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"os"
	"path/filepath"
	"testing"
)

type fundingCostFake struct {
	latestHash solana.Hash
	*fundingReadFake
	mode          string
	message       []byte
	fees, heights int
	afterSim      func()
}

func (f *fundingCostFake) GetLatestBlockhash(context.Context, rpc.CommitmentType) (*rpc.GetLatestBlockhashResult, error) {
	s := uint64(10)
	if f.mode == "stale" {
		s = 9
	}
	h := f.latestHash
	if h == (solana.Hash{}) {
		h = solana.Hash{8}
	}
	return &rpc.GetLatestBlockhashResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: s}}, Value: &rpc.LatestBlockhashResult{Blockhash: h, LastValidBlockHeight: 200}}, nil
}
func (f *fundingCostFake) GetBlockHeight(context.Context, rpc.CommitmentType) (uint64, error) {
	f.heights++
	if f.mode == "expired" || f.mode == "expires-after-readback" && f.heights == 3 {
		return 200, nil
	}
	return 100, nil
}
func (f *fundingCostFake) GetFeeForMessage(_ context.Context, m string, c rpc.CommitmentType) (*rpc.GetFeeForMessageResult, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("commitment")
	}
	b, e := base64.StdEncoding.DecodeString(m)
	if e != nil {
		f.t.Fatal(e)
	}
	if f.message != nil && !bytes.Equal(f.message, b) {
		f.t.Fatal("fee message changed")
	}
	f.message = b
	f.fees++
	n := uint64(5000)
	if f.mode == "fee" || f.mode == "fee-change" && f.fees > 1 {
		n++
	}
	return &rpc.GetFeeForMessageResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 10}}, Value: &n}, nil
}
func (f *fundingCostFake) GetBalance(context.Context, solana.PublicKey, rpc.CommitmentType) (*rpc.GetBalanceResult, error) {
	n := uint64(5000)
	if f.mode == "balance" {
		n--
	}
	return &rpc.GetBalanceResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 10}}, Value: n}, nil
}
func (f *fundingCostFake) SimulateRawTransactionWithOpts(_ context.Context, b []byte, o *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	if o.SigVerify || o.ReplaceRecentBlockhash || o.Commitment != rpc.CommitmentFinalized || len(b) < 65 || b[0] != 1 || !bytes.Equal(b[1:65], make([]byte, 64)) || !bytes.Equal(b[65:], f.message) {
		f.t.Fatal("unsigned exact simulation")
	}
	n := uint64(10000)
	if f.mode == "units" {
		n = 200001
	}
	var e any
	if f.mode == "simulation" {
		e = "failed"
	}
	if f.afterSim != nil {
		f.afterSim()
	}
	return &rpc.SimulateTransactionResponse{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 10}}, Value: &rpc.SimulateTransactionResult{Err: e, UnitsConsumed: &n}}, nil
}
func TestWENMiningFundingReviewedPreparation(t *testing.T) {
	raw, pins := fundingDescriptorFixture(t)
	for _, mode := range []string{"ok", "stale", "expired", "expires-after-readback", "fee", "fee-change", "balance", "units", "simulation", "state-change", "review-change", "descriptor-change", "review-mode", "review-symlink", "missing-descriptor", "review-intent", "review-budget", "review-pin"} {
		t.Run(mode, func(t *testing.T) {
			v, w, _, read := fundingRPCFixture(t)
			v.DescriptorSHA256 = pins.DescriptorSHA256
			v.CapabilitySHA256 = pins.CapabilitySHA256
			pd := read.page.Value[7].Data.GetBinary()
			pd = append(append([]byte{}, pd[:45]...), []byte("funding code")...)
			read.page.Value[7].Data = rpc.DataBytesOrJSONFromBytes(pd)
			db := filepath.Join(t.TempDir(), "state.db")
			root := filepath.Join(filepath.Dir(db), "wen-mining-funding", wenHashV1([]byte("miner")))
			if e := os.MkdirAll(root, 0700); e != nil {
				t.Fatal(e)
			}
			r := wenMiningFundingReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: w.String(), Intent: v, Pins: pins, MaxSlotLag: 2, MaxTotalCostLamports: 5000}
			path := filepath.Join(root, wenMiningFundingAdmissionNameV1(v))
			descriptor := filepath.Join(root, pins.DescriptorSHA256)
			write := func() {
				b, e := json.Marshal(r)
				if e != nil {
					t.Fatal(e)
				}
				if e = os.WriteFile(path, b, 0600); e != nil {
					t.Fatal(e)
				}
			}
			if mode == "review-intent" {
				r.Intent.Amount = "6001"
			}
			if mode == "review-budget" {
				r.MaxTotalCostLamports = 4999
			}
			if mode == "review-pin" {
				r.Pins.DeploymentSlot = 6
			}
			write()
			if e := os.WriteFile(descriptor, raw, 0600); e != nil {
				t.Fatal(e)
			}
			if mode == "review-mode" {
				os.Chmod(path, 0666)
			}
			if mode == "review-symlink" {
				os.Rename(path, path+"-real")
				os.Symlink(path+"-real", path)
			}
			if mode == "missing-descriptor" {
				os.Remove(descriptor)
			}
			f := &fundingCostFake{fundingReadFake: read, mode: mode}
			f.afterSim = func() {
				switch mode {
				case "state-change":
					read.page.Value[5].Lamports++
				case "review-change":
					r.MaxSlotLag++
					write()
				case "descriptor-change":
					os.WriteFile(descriptor, []byte("{}"), 0600)
				}
			}
			out, e := prepareReviewedWENMiningFundingV1(context.Background(), f, db, "miner", v)
			if (e == nil) != (mode == "ok") {
				t.Fatalf("mode %s: %v", mode, e)
			}
			if e == nil && (out.fee != 5000 || out.total != 5000 || out.rent != 0 || !bytes.Equal(out.message, f.message) || f.fees != 2 || f.heights != 3) {
				t.Fatal("capital/rent/fee or exact message binding")
			}
		})
	}
}

func TestWENMiningFundingPinnedCosts(t *testing.T) {
	for _, mode := range []string{"ok", "review", "state", "message", "rent", "fee", "expiry", "slot", "wallet", "nonce"} {
		t.Run(mode, func(t *testing.T) {
			v, w, _, read := fundingRPCFixture(t)
			config := wenMiningFundingReviewedConfigV1{maxSlotLag: 2, maxTotalCostLamports: 5000, reviewSHA: wenHashV1([]byte("review"))}
			state := wenMiningFundingReadbackV1{Slot: 10, StateHash: wenHashV1([]byte("state")), OwnerLamports: 5000}
			first, e := prepareWENMiningFundingCostsV1(context.Background(), &fundingCostFake{fundingReadFake: read}, v, w, config, state)
			if e != nil {
				t.Fatal(e)
			}
			b := wenMiningFundingMessageBindingV1{Message: first.message, Blockhash: first.blockhash, ReviewSHA: config.reviewSHA, StateHash: state.StateHash, Slot: 10, Fee: 5000, LastValidHeight: 200}
			switch mode {
			case "review":
				config.reviewSHA = wenHashV1([]byte("other"))
			case "state":
				state.StateHash = wenHashV1([]byte("other"))
			case "message":
				b.Message[0] ^= 1
			case "rent":
				b.Rent = 1
			case "fee":
				b.Fee--
			case "expiry":
				b.LastValidHeight = 100
			case "slot":
				b.Slot = 11
			case "wallet":
				w = solana.PublicKey{7}
			case "nonce":
				v.Nonce = "99"
			}
			f := &fundingCostFake{fundingReadFake: read, latestHash: solana.Hash{9}}
			out, e := preparePinnedWENMiningFundingCostsV1(context.Background(), f, v, w, config, state, &b)
			if (e == nil) != (mode == "ok") {
				t.Fatal(mode, e)
			}
			if e == nil && (out.blockhash != first.blockhash || !bytes.Equal(out.message, first.message)) {
				t.Fatal("replaced original signed lifetime")
			}
		})
	}
}
