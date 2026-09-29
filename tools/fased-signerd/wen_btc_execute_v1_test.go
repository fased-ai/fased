package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
)

type wenExecutionFixtureRPC struct {
	signerWENBTCSimulationRPCV1
	t                      *testing.T
	store                  *signerStoreV2
	failure                string
	phase, sendCount       int
	heightsAfterSimulation int
	wire                   []byte
	result                 *rpc.GetTransactionResult
}

func (m *wenExecutionFixtureRPC) SimulateRawTransactionWithOpts(ctx context.Context, raw []byte, opts *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	result, err := m.signerWENBTCSimulationRPCV1.SimulateRawTransactionWithOpts(ctx, raw, opts)
	m.phase = 1
	return result, err
}
func (m *wenExecutionFixtureRPC) GetMultipleAccountsWithOpts(ctx context.Context, keys []solana.PublicKey, opts *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if m.phase == 0 {
		return m.signerWENBTCSimulationRPCV1.GetMultipleAccountsWithOpts(ctx, keys, opts)
	}
	return (wenRevalidateFixtureRPC{signerWENBTCPrepareRPCV1: m.signerWENBTCSimulationRPCV1, t: m.t}).GetMultipleAccountsWithOpts(ctx, keys, opts)
}
func (m *wenExecutionFixtureRPC) GetSlot(ctx context.Context, c rpc.CommitmentType) (uint64, error) {
	if m.phase == 2 {
		return 160, nil
	}
	if m.phase == 1 {
		return 155, nil
	}
	return m.signerWENBTCSimulationRPCV1.GetSlot(ctx, c)
}
func (m *wenExecutionFixtureRPC) GetBlockHeight(ctx context.Context, c rpc.CommitmentType) (uint64, error) {
	if m.phase > 0 {
		m.heightsAfterSimulation++
		if m.failure == "execute-expiry" && m.heightsAfterSimulation > 1 {
			return 20, nil
		}
		return 11, nil
	}
	return m.signerWENBTCSimulationRPCV1.GetBlockHeight(ctx, c)
}
func (m *wenExecutionFixtureRPC) SendRawTransactionWithOpts(_ context.Context, wire []byte, opts rpc.TransactionOpts) (solana.Signature, error) {
	m.sendCount++
	m.phase = 2
	if opts.SkipPreflight || opts.PreflightCommitment != rpc.CommitmentFinalized || opts.MaxRetries == nil || *opts.MaxRetries != 0 || opts.MinContextSlot == nil || *opts.MinContextSlot != 155 {
		m.t.Fatal("unbound send options")
	}
	r := m.read()
	if r.State != "submission-uncertain" || !bytes.Equal(wire[65:], r.SignedMessage) {
		m.t.Fatal("wire returned before durable uncertainty")
	}
	expected, err := wenSignedWireV1(r, r.SignedMessage)
	if err != nil || !bytes.Equal(wire, expected) {
		m.t.Fatal("invalid sent signature", err)
	}
	m.wire = append([]byte(nil), wire...)
	keys := make(solana.PublicKeySlice, len(r.AccountKeys))
	for i, key := range r.AccountKeys {
		keys[i] = solana.MustPublicKeyFromBase58(key)
	}
	_, m.result = wenFundingReceiptFromWire(m.t, wire, keys)
	m.result.Slot = 157
	if m.failure == "execute-failed" {
		m.result.Meta.Err = map[string]any{"InstructionError": []any{1, "Custom"}}
		m.result.Meta.PostBalances = append([]uint64(nil), m.result.Meta.PreBalances...)
		m.result.Meta.PostBalances[0] -= m.result.Meta.Fee
		m.result.Meta.PostTokenBalances = m.result.Meta.PreTokenBalances
	}
	if m.failure == "execute-bad-funding" {
		m.result.Meta.PostTokenBalances[0].UiTokenAmount.Amount = "1"
	}
	signature := solana.MustSignatureFromBase58(r.Signature)
	if m.failure == "execute-send-error" {
		return solana.Signature{}, errors.New("send disconnected after submission")
	}
	if m.failure == "execute-wrong-signature" {
		return solana.Signature{99}, nil
	}
	return signature, nil
}
func (m *wenExecutionFixtureRPC) GetTransaction(_ context.Context, sig solana.Signature, opts *rpc.GetTransactionOpts) (*rpc.GetTransactionResult, error) {
	if sig.String() != m.read().Signature || opts.Commitment != rpc.CommitmentFinalized {
		m.t.Fatal("wrong reconciliation identity")
	}
	if m.failure == "execute-missing" || strings.HasPrefix(m.failure, "execute-missing-recovery") || m.failure == "execute-wrong-signature" {
		return nil, rpc.ErrNotFound
	}
	return m.result, nil
}
func (m *wenExecutionFixtureRPC) read() wenBudgetReservationV1 {
	var r wenBudgetReservationV1
	if err := m.store.db.View(func(tx *bolt.Tx) error {
		return json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("request:execute-request")), &r)
	}); err != nil {
		m.t.Fatal(err)
	}
	return r
}
