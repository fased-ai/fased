package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"math"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type wenSimulationRPC struct {
	signerWENBTCPrepareRPCV1
	t            *testing.T
	p            *signerWENBTCPreparedMessageV1
	failure      string
	genesis      solana.Hash
	calls, rents int
}

func (m *wenSimulationRPC) GetGenesisHash(context.Context) (solana.Hash, error) {
	m.calls++
	if m.failure == "cluster" || m.failure == "cluster-change" && m.calls > 1 {
		return solana.Hash{9}, nil
	}
	return m.genesis, nil
}
func (m *wenSimulationRPC) GetBlockHeight(context.Context, rpc.CommitmentType) (uint64, error) {
	if m.failure == "expiry" {
		return 20, nil
	}
	if m.failure == "rollback" {
		return 9, nil
	}
	return 11, nil
}
func (m *wenSimulationRPC) GetFeeForMessage(_ context.Context, msg string, c rpc.CommitmentType) (*rpc.GetFeeForMessageResult, error) {
	if msg != base64.StdEncoding.EncodeToString(m.p.message) || c != rpc.CommitmentFinalized {
		m.t.Fatal("fee did not bind message/commitment")
	}
	if m.failure == "fee-rpc" {
		return nil, errors.New("offline")
	}
	if m.failure == "fee-nil" {
		return nil, nil
	}
	n := uint64(5000)
	if m.failure == "fee-high" {
		n++
	}
	out := &rpc.GetFeeForMessageResult{Value: &n}
	out.Context.Slot = 154
	if m.failure == "fee-missing" {
		out.Value = nil
	}
	if m.failure == "fee-stale" {
		out.Context.Slot = 153
	}
	if m.failure == "slot-expiry" {
		out.Context.Slot = 200
	}
	return out, nil
}
func (m *wenSimulationRPC) GetMinimumBalanceForRentExemption(_ context.Context, size uint64, c rpc.CommitmentType) (uint64, error) {
	if c != rpc.CommitmentFinalized || size != m.p.rentLengths[m.rents] {
		m.t.Fatal("wrong rent size/commitment")
	}
	m.rents++
	if m.failure == "rent-zero" {
		return 0, nil
	}
	if m.failure == "rent-overflow" {
		return math.MaxUint64, nil
	}
	if m.failure == "rent-rpc" {
		return 0, errors.New("offline")
	}
	return 100, nil
}
func (m *wenSimulationRPC) GetBalance(_ context.Context, payer solana.PublicKey, c rpc.CommitmentType) (*rpc.GetBalanceResult, error) {
	if payer != m.p.intent.payer || c != rpc.CommitmentFinalized {
		m.t.Fatal("wrong balance payer/commitment")
	}
	if m.failure == "balance-nil" {
		return nil, nil
	}
	if m.failure == "balance-rpc" {
		return nil, errors.New("offline")
	}
	out := &rpc.GetBalanceResult{Value: 6000}
	out.Context.Slot = 154
	if m.failure == "balance-low" {
		out.Value = 1
	}
	if m.failure == "balance-stale" {
		out.Context.Slot = 153
	}
	return out, nil
}
func (m *wenSimulationRPC) SimulateRawTransactionWithOpts(_ context.Context, wire []byte, opts *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	if len(wire) != len(m.p.message)+65 || wire[0] != 1 || !bytes.Equal(wire[1:65], make([]byte, 64)) || !bytes.Equal(wire[65:], m.p.message) || opts.SigVerify || opts.ReplaceRecentBlockhash || opts.Commitment != rpc.CommitmentFinalized {
		m.t.Fatal("simulation changed unsigned envelope/options")
	}
	if m.failure == "simulation-rpc" {
		return nil, errors.New("offline")
	}
	if m.failure == "simulation-nil" {
		return nil, nil
	}
	n := uint64(m.p.intent.units)
	out := &rpc.SimulateTransactionResponse{Value: &rpc.SimulateTransactionResult{UnitsConsumed: &n}}
	out.Context.Slot = 155
	switch m.failure {
	case "simulation-missing":
		out.Value = nil
	case "simulation-error":
		out.Value.Err = "InstructionError"
	case "units-missing":
		out.Value.UnitsConsumed = nil
	case "units-high":
		n++
	case "simulation-stale":
		out.Context.Slot = 153
	case "simulation-lag":
		out.Context.Slot = 156
	}
	return out, nil
}
func TestWENBTCSimulationCostsAndEnvelope(t *testing.T) {
	cases := []string{"ok", "cluster", "cluster-change", "fee-rpc", "fee-nil", "fee-missing", "fee-high", "fee-stale", "slot-expiry", "rent-zero", "rent-overflow", "rent-rpc", "rent-budget", "balance-nil", "balance-rpc", "balance-low", "balance-stale", "simulation-rpc", "simulation-nil", "simulation-missing", "simulation-error", "units-missing", "units-high", "simulation-stale", "simulation-lag", "expiry", "rollback", "limits-overflow", "missing-rent"}
	for _, op := range []string{"acceptance", "acquisition"} {
		for _, name := range cases {
			t.Run(op+"/"+name, func(t *testing.T) {
				_, intent, pins, snapshots, life := wenMessageFixture(t, op)
				p, err := prepareWENBTCMessageV1(intent, pins, snapshots, life)
				if err != nil {
					t.Fatal(err)
				}
				p.referenceSlot = 154
				p.expiresSlot = 200
				p.rentLengths = []uint64{165, 165}
				if op == "acceptance" {
					p.rentLengths = []uint64{192, 165, 288, 178, 144, 1120}
				}
				m := &wenSimulationRPC{t: t, p: p, failure: name, genesis: solana.Hash{8}}
				maxRent := uint64(1000)
				if name == "rent-budget" {
					maxRent = 1
				}
				if name == "limits-overflow" {
					maxRent = math.MaxUint64
				}
				if name == "missing-rent" {
					p.rentLengths = nil
				}
				result, err := simulateWENBTCPreparedV1(context.Background(), m, p, m.genesis.String(), 5000, maxRent)
				if name != "ok" {
					if err == nil || result != nil {
						t.Fatal("invalid simulation admitted")
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				rent := uint64(len(p.rentLengths)) * 100
				if result.fee != 5000 || result.rent != rent || result.total != 5000+rent || result.slot != 155 || result.height != 11 || result.units != uint64(intent.units) || (op == "acquisition" && result.refundableRent != rent) || (op == "acceptance" && result.refundableRent != 0) {
					t.Fatalf("wrong costs: %+v", result)
				}
			})
		}
	}
}

func TestWENBTCRentLengthsFromVerifiedReadback(t *testing.T) {
	for mask := 0; mask < 4; mask++ {
		t.Run(string(rune('0'+mask)), func(t *testing.T) {
			root, pins, intent, wallet, f := wenRPCFixture(t)
			initial, err := readWENBTCAcceptanceRPCV1(context.Background(), f, root, pins, intent, wallet, 180000, 5)
			if err != nil {
				t.Fatal(err)
			}
			want := []uint64{192, 165, 288, 178}
			for bit, item := range []struct {
				role int
				size uint64
			}{{10, 144}, {12, 1120}} {
				if mask&(1<<bit) == 0 {
					want = append(want, item.size)
					continue
				}
				key := solana.MustPublicKeyFromBase58(initial.Accounts[item.role].Pubkey)
				for i, k := range f.addresses {
					if k == key {
						f.page.Value[i] = &rpc.Account{Data: rpc.DataBytesOrJSONFromBytes(make([]byte, item.size))}
					}
				}
			}
			result, err := readWENBTCAcceptanceRPCV1(context.Background(), f, root, pins, intent, wallet, 180000, 5)
			if err != nil {
				t.Fatal(err)
			}
			if len(result.rentLengths) != len(want) {
				t.Fatalf("wrong rent sizes: %v", result.rentLengths)
			}
			for i, n := range want {
				if result.rentLengths[i] != n {
					t.Fatalf("wrong rent sizes: %v", result.rentLengths)
				}
			}
		})
	}
}
