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

type miningClaimCostFake struct {
	latestHash    solana.Hash
	expectedOwner solana.PublicKey
	*miningClaimRPCFake
	mode          string
	message       []byte
	fees, heights int
	afterSim      func()
}

func (f *miningClaimCostFake) GetLatestBlockhash(_ context.Context, commitment rpc.CommitmentType) (*rpc.GetLatestBlockhashResult, error) {
	if commitment != rpc.CommitmentFinalized {
		f.t.Fatal("unfinalized blockhash")
	}
	s := uint64(101)
	if f.mode == "stale" {
		s = 100
	}
	h := f.latestHash
	if h == (solana.Hash{}) {
		h = solana.Hash{8}
	}
	return &rpc.GetLatestBlockhashResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: s}}, Value: &rpc.LatestBlockhashResult{Blockhash: h, LastValidBlockHeight: 200}}, nil
}
func (f *miningClaimCostFake) GetBlockHeight(context.Context, rpc.CommitmentType) (uint64, error) {
	f.heights++
	if f.mode == "expired" || f.mode == "expires-after-readback" && f.heights == 3 {
		return 200, nil
	}
	return 100, nil
}
func (f *miningClaimCostFake) GetFeeForMessage(_ context.Context, m string, c rpc.CommitmentType) (*rpc.GetFeeForMessageResult, error) {
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
	return &rpc.GetFeeForMessageResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 101}}, Value: &n}, nil
}
func (f *miningClaimCostFake) GetBalance(_ context.Context, w solana.PublicKey, commitment rpc.CommitmentType) (*rpc.GetBalanceResult, error) {
	expected := f.expectedOwner
	if expected.IsZero() {
		expected = solana.PublicKey{5}
	}
	if w != expected || commitment != rpc.CommitmentFinalized {
		f.t.Fatal("unbound balance read")
	}
	n := uint64(5000)
	if f.mode == "balance" {
		n--
	}
	return &rpc.GetBalanceResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 101}}, Value: n}, nil
}
func (f *miningClaimCostFake) SimulateRawTransactionWithOpts(_ context.Context, b []byte, o *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	if o.SigVerify || o.ReplaceRecentBlockhash || o.Commitment != rpc.CommitmentFinalized || len(b) < 65 || b[0] != 1 || !bytes.Equal(b[1:65], make([]byte, 64)) || !bytes.Equal(b[65:], f.message) {
		f.t.Fatal("unsigned exact simulation")
	}
	n := uint64(10000)
	if f.mode == "units" {
		n = 400001
	}
	var e any
	if f.mode == "simulation" {
		e = "failed"
	}
	if f.afterSim != nil {
		f.afterSim()
	}
	return &rpc.SimulateTransactionResponse{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 101}}, Value: &rpc.SimulateTransactionResult{Err: e, UnitsConsumed: &n}}, nil
}

func TestWENMiningClaimReviewedPreparation(t *testing.T) {
	_, _, pins, _ := miningClaimRPCFixture(t, "sol")
	raw, pins := miningClaimReviewDescriptor(t, pins)
	for _, op := range []string{"sol", "sat"} {
		for _, mode := range []string{"ok", "stale", "expired", "expires-after-readback", "fee", "fee-change", "balance", "units", "simulation", "state-change", "review-change", "descriptor-change", "review-mode", "review-symlink", "missing-descriptor", "review-intent", "review-budget", "review-pin", "initial-state"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				v, w, _, read := miningClaimRPCFixture(t, op)
				v.DescriptorSHA256 = pins.DescriptorSHA256
				v.CapabilitySHA256 = pins.CapabilitySHA256
				state, e := readWENMiningClaimRPCV1(context.Background(), read, pins, v, w, 2)
				if e != nil {
					t.Fatal(e)
				}
				v.AccountStateSHA256 = state.StateHash
				if mode == "initial-state" {
					v.AccountStateSHA256 = wenHashV1([]byte("wrong"))
				}
				db := filepath.Join(t.TempDir(), "state.db")
				root := filepath.Join(filepath.Dir(db), "wen-mining-claim", wenHashV1([]byte("miner")))
				if e = os.MkdirAll(root, 0700); e != nil {
					t.Fatal(e)
				}
				review := wenMiningClaimReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: w.String(), Intent: v, Pins: pins, MaxSlotLag: 2, MaxTotalCostLamports: 5000}
				path := filepath.Join(root, wenMiningClaimAdmissionNameV1(v))
				descriptor := filepath.Join(root, pins.DescriptorSHA256)
				write := func() {
					b, e := json.Marshal(review)
					if e != nil {
						t.Fatal(e)
					}
					if e = os.WriteFile(path, b, 0600); e != nil {
						t.Fatal(e)
					}
				}
				switch mode {
				case "review-intent":
					review.Intent.MinimumReceived = "1"
				case "review-budget":
					review.MaxTotalCostLamports = 4999
				case "review-pin":
					review.Pins.DeploymentSlot = 102
				}
				write()
				if e = os.WriteFile(descriptor, raw, 0600); e != nil {
					t.Fatal(e)
				}
				switch mode {
				case "review-mode":
					os.Chmod(path, 0666)
				case "review-symlink":
					os.Rename(path, path+"-real")
					os.Symlink(path+"-real", path)
				case "missing-descriptor":
					os.Remove(descriptor)
				}
				f := &miningClaimCostFake{miningClaimRPCFake: read, mode: mode}
				f.afterSim = func() {
					switch mode {
					case "state-change":
						read.page.Value[4].Lamports++
					case "review-change":
						review.MaxSlotLag++
						write()
					case "descriptor-change":
						os.WriteFile(descriptor, []byte("{}"), 0600)
					}
				}
				out, e := prepareReviewedWENMiningClaimV1(context.Background(), f, db, "miner", v)
				if (e == nil) != (mode == "ok") {
					t.Fatalf("preparation: %v", e)
				}
				if e == nil && (out.fee != 5000 || out.total != 5000 || out.rent != 0 || !bytes.Equal(out.message, f.message) || f.fees != 2 || f.heights != 3) {
					t.Fatal("fee/message binding")
				}
			})
		}
	}
}
func TestWENMiningClaimPinnedCosts(t *testing.T) {
	for _, op := range []string{"sol", "sat"} {
		for _, mode := range []string{"ok", "review", "state", "message", "rent", "fee", "expiry", "slot", "wallet", "nonce"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				v, w, _, read := miningClaimRPCFixture(t, op)
				config := wenMiningClaimReviewedConfigV1{maxSlotLag: 2, maxTotalCostLamports: 5000, reviewSHA: wenHashV1([]byte("review"))}
				state := wenMiningClaimReadbackV1{Slot: 101, StateHash: v.AccountStateSHA256}
				first, e := prepareWENMiningClaimCostsV1(context.Background(), &miningClaimCostFake{miningClaimRPCFake: read}, v, w, config, state)
				if e != nil {
					t.Fatal(e)
				}
				b := wenMiningClaimMessageBindingV1{ComputeUnitLimit: first.computeLimit, Message: append([]byte(nil), first.message...), Blockhash: first.blockhash, ReviewSHA: config.reviewSHA, StateHash: state.StateHash, Slot: 101, Fee: 5000, LastValidHeight: 200}
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
					b.Slot = 102
				case "wallet":
					w = solana.PublicKey{7}
				case "nonce":
					v.Nonce = "99"
				}
				f := &miningClaimCostFake{miningClaimRPCFake: read, latestHash: solana.Hash{9}}
				out, e := preparePinnedWENMiningClaimCostsV1(context.Background(), f, v, w, config, state, &b)
				if (e == nil) != (mode == "ok") {
					t.Fatal(mode, e)
				}
				if e == nil && (out.blockhash != first.blockhash || !bytes.Equal(out.message, first.message)) {
					t.Fatal("original lifetime replaced")
				}
			})
		}
	}
}
