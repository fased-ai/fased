package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"os"
	"path/filepath"
	"testing"
)

type stakingPrepareFake struct {
	*miningPrepareFake
	descriptor string
	rentCalls  int
}

func (f *stakingPrepareFake) GetMinimumBalanceForRentExemption(_ context.Context, n uint64, c rpc.CommitmentType) (uint64, error) {
	if c != rpc.CommitmentFinalized || (n != 104 && n != 112) {
		f.t.Fatal("rent")
	}
	f.rentCalls++
	if f.mode == "rent" {
		return 0, nil
	}
	return 1000, nil
}
func (f *stakingPrepareFake) GetBalance(_ context.Context, w solana.PublicKey, c rpc.CommitmentType) (*rpc.GetBalanceResult, error) {
	if w.String() != f.fixture.Wallet || c != rpc.CommitmentFinalized {
		f.t.Fatal("balance")
	}
	n := uint64(7000)
	if f.mode == "balance" {
		n--
	}
	return &rpc.GetBalanceResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: n}, nil
}
func (f *stakingPrepareFake) SimulateRawTransactionWithOpts(ctx context.Context, b []byte, o *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	result, e := f.miningPrepareFake.SimulateRawTransactionWithOpts(ctx, b, o)
	if f.mode == "descriptor-change" {
		if err := os.WriteFile(f.descriptor, []byte("{}"), 0600); err != nil {
			f.t.Fatal(err)
		}
	}
	if f.mode == "history-change" {
		d := append([]byte(nil), f.page.Value[2].Data.GetBinary()...)
		d[96] ^= 1
		f.page.Value[2].Data = rpc.DataBytesOrJSONFromBytes(d)
	}
	return result, e
}
func checkStakingPreparation(t *testing.T, base *wenReadRPCFake, v signerWENStakingIntentV1, w solana.PublicKey, pins wenStakingPinsV1, private ed25519.PrivateKey) {
	t.Helper()
	for _, mode := range []string{"ok", "missing-hash", "stale-hash", "expired", "expires-during", "height-rollback", "missing-fee", "fee", "balance", "units", "stale-sim", "simulation-error", "rent", "budget", "descriptor-change", "history-change"} {
		t.Run("prepare/"+mode, func(t *testing.T) {
			raw, _ := stakingDescriptorFixture(t)
			var d map[string]any
			dec := json.NewDecoder(bytes.NewReader(raw))
			dec.UseNumber()
			if e := dec.Decode(&d); e != nil {
				t.Fatal(e)
			}
			d["deployment"].(map[string]any)["stakingChange"].(map[string]any)["deployedBytesHash"] = pins.CodeSHA256
			raw, p := repinStakingDescriptor(t, d, pins)
			intent := v
			intent.DescriptorSHA256 = p.DescriptorSHA256
			intent.CapabilitySHA256 = p.CapabilitySHA256
			db := filepath.Join(t.TempDir(), "state.db")
			limit := uint64(7000)
			if mode == "budget" {
				limit = 6999
			}
			review := wenStakingReviewV1{Version: 1, WalletID: "staker", WalletPublicKey: w.String(), Intent: intent, Pins: p, MaxSlotLag: 2, MaxTotalCostLamports: limit}
			root := writeStakingReviewFixture(t, db, review)
			path := filepath.Join(root, p.DescriptorSHA256)
			if e := os.WriteFile(path, raw, 0600); e != nil {
				t.Fatal(e)
			}
			fixture := miningFixture(t)
			fixture.Wallet = w.String()
			ix, e := buildWENStakingInstructionV1(intent, w)
			if e != nil {
				t.Fatal(e)
			}
			tx, e := solana.NewTransaction([]solana.Instruction{ix}, solana.MustHashFromBase58(fixture.Blockhash), solana.TransactionPayer(w))
			if e != nil {
				t.Fatal(e)
			}
			tx.Message.SetVersion(solana.MessageVersionV0)
			msg, e := tx.Message.MarshalBinary()
			if e != nil {
				t.Fatal(e)
			}
			fixture.Messages = [][]byte{msg}
			clone := *base
			clone.calls = 0
			clone.change = "ok"
			page := *base.page
			page.Value = append([]*rpc.Account(nil), base.page.Value...)
			for i, a := range page.Value {
				if a != nil {
					copy := *a
					page.Value[i] = &copy
				}
			}
			clone.page = &page
			client := &stakingPrepareFake{miningPrepareFake: &miningPrepareFake{wenReadRPCFake: &clone, fixture: fixture, mode: mode}, descriptor: path}
			out, e := prepareReviewedWENStakingV1(context.Background(), client, db, "staker", intent)
			if (e == nil) != (mode == "ok") {
				t.Fatal("unexpected prepared staking", e)
			}
			if e == nil {
				checkStakingPreparedSubmission(t, client, intent, review, raw, private)
				checkStakingExecutor(t, client, intent, review, raw, private)
			}
			if e == nil {
				binding := wenStakingMessageBindingV1{Message: out.message, Blockhash: out.blockhash, ReviewSHA: out.review.reviewSHA, Slot: out.slot, Fee: out.fee, Rent: out.rent, LastValidHeight: out.lastValidHeight}
				client.fixture.Blockhash = intent.Genesis // RPC rotates blockhash; retained message must not change.
				pinned, err := preparePinnedWENStakingV1(context.Background(), client, db, "staker", intent, &binding)
				if err != nil || !bytes.Equal(pinned.message, out.message) || pinned.blockhash != out.blockhash {
					t.Fatal("pinned revalidation", err)
				}

				changed := binding
				history := out.state.History
				pool := *history.Pool
				pool.Data = append([]byte(nil), pool.Data...)
				pool.Data[88]--
				history.Pool = &pool
				changed.Evidence = &wenStakingPreparedEvidenceV1{Pins: p, Before: history}
				if _, err = preparePinnedWENStakingV1(context.Background(), client, db, "staker", intent, &changed); err == nil {
					t.Fatal("valid but different reserved history accepted")
				}
				binding.Fee--
				binding.Rent++
				if _, err = preparePinnedWENStakingV1(context.Background(), client, db, "staker", intent, &binding); err == nil {
					t.Fatal("changed fee allocation accepted")
				}
			}
			if e == nil && (!bytes.Equal(out.message, msg) || out.fee != 5000 || out.rent != 2000 || out.total != 7000 || out.state.Tokens.Net != 97 || client.rentCalls < 2) {
				t.Fatal("wrong prepared costs/state")
			}
		})
	}
}
