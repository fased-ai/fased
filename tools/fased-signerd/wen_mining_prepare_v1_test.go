package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"os"
	"path/filepath"
	"testing"
)

type miningPrepareFake struct {
	*wenReadRPCFake
	fixture        wenMiningFixture
	mode, root     string
	index, heights int
}

func (f *miningPrepareFake) GetLatestBlockhash(_ context.Context, c rpc.CommitmentType) (*rpc.GetLatestBlockhashResult, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("commitment")
	}
	if f.mode == "missing-hash" {
		return nil, nil
	}
	slot := uint64(150)
	if f.mode == "stale-hash" {
		slot = 149
	}
	return &rpc.GetLatestBlockhashResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: slot}}, Value: &rpc.LatestBlockhashResult{Blockhash: solana.MustHashFromBase58(f.fixture.Blockhash), LastValidBlockHeight: 200}}, nil
}
func (f *miningPrepareFake) GetBlockHeight(_ context.Context, c rpc.CommitmentType) (uint64, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("commitment")
	}
	f.heights++
	if f.mode == "expired" || (f.mode == "expires-during" && f.heights > 1) {
		return 200, nil
	}
	if f.mode == "height-rollback" && f.heights > 1 {
		return 99, nil
	}
	return 100, nil
}
func (f *miningPrepareFake) GetFeeForMessage(_ context.Context, m string, c rpc.CommitmentType) (*rpc.GetFeeForMessageResult, error) {
	if c != rpc.CommitmentFinalized || m != base64.StdEncoding.EncodeToString(f.fixture.Messages[f.index]) {
		f.t.Fatal("message")
	}
	if f.mode == "missing-fee" {
		return nil, nil
	}
	fee := uint64(5000)
	if f.mode == "fee" {
		fee++
	}
	return &rpc.GetFeeForMessageResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: &fee}, nil
}
func (f *miningPrepareFake) GetBalance(_ context.Context, w solana.PublicKey, c rpc.CommitmentType) (*rpc.GetBalanceResult, error) {
	if c != rpc.CommitmentFinalized || w.String() != f.fixture.Wallet {
		f.t.Fatal("balance wallet")
	}
	n := uint64(5000)
	if f.mode == "balance" {
		n--
	}
	return &rpc.GetBalanceResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: n}, nil
}
func (f *miningPrepareFake) SimulateRawTransactionWithOpts(_ context.Context, b []byte, o *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	if o.Commitment != rpc.CommitmentFinalized || o.SigVerify || o.ReplaceRecentBlockhash || len(b) != 65+len(f.fixture.Messages[f.index]) || b[0] != 1 || !bytes.Equal(b[1:65], make([]byte, 64)) || !bytes.Equal(b[65:], f.fixture.Messages[f.index]) {
		f.t.Fatal("simulation wire")
	}
	if f.mode == "remove-preimage" {
		if e := os.Remove(filepath.Join(f.root, f.fixture.PreimageKey+".json")); e != nil {
			f.t.Fatal(e)
		}
	}
	if f.mode == "phase-change" {
		d := append([]byte(nil), f.page.Value[3].Data.GetBinary()...)
		binary.LittleEndian.PutUint64(d[32:], 1900)
		f.page.Value[3].Data = rpc.DataBytesOrJSONFromBytes(d)
	}
	if f.mode == "entry-change" {
		d := append([]byte(nil), f.page.Value[0].Data.GetBinary()...)
		d[200] ^= 1
		f.page.Value[0].Data = rpc.DataBytesOrJSONFromBytes(d)
	}
	units := uint64(10000)
	if f.mode == "units" {
		units = 200001
	}
	slot := uint64(150)
	if f.mode == "stale-sim" {
		slot = 149
	}
	out := &rpc.SimulateTransactionResponse{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: slot}}, Value: &rpc.SimulateTransactionResult{UnitsConsumed: &units}}
	if f.mode == "simulation-error" {
		out.Value.Err = "failed"
	}
	return out, nil
}
func TestWENMiningPrepareV1(t *testing.T) {
	for _, op := range []string{"commit", "reveal"} {
		for _, mode := range []string{"ok", "missing-hash", "stale-hash", "expired", "expires-during", "height-rollback", "missing-fee", "fee", "balance", "units", "stale-sim", "simulation-error", "remove-preimage", "phase-change", "entry-change"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				f := miningFixture(t)
				client, pins, v := miningPrepareSetup(t, f, op, mode)
				root, index := client.root, client.index
				out, e := prepareWENMiningFromRPCV1(context.Background(), client, root, pins, v, solana.MustPublicKeyFromBase58(f.Wallet), 2)
				if (e == nil) != (mode == "ok") {
					t.Fatal("unexpected admission", e)
				}
				if e == nil && (!bytes.Equal(out.message, f.Messages[index]) || out.fee != 5000 || out.units != 10000 || len(out.accountKeys) != 3 || out.accountKeys[0] != f.Wallet) {
					t.Fatal("unbound preparation")
				}
			})
		}
	}
}

func miningPrepareSetup(t *testing.T, f wenMiningFixture, op, mode string) (*miningPrepareFake, wenMiningPinsV1, signerWENMiningIntentV1) {
	t.Helper()
	v := f.Intent
	v.Operation = op
	data := f.Vectors["admitted"]
	now := uint64(1000)
	index := 0
	if op == "reveal" {
		data = f.Vectors["committed"]
		now = 1180
		index = 1
	}
	v.EntrySHA256 = wenHashV1(data)
	root := t.TempDir()
	if e := os.Chmod(root, 0700); e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(f.Preimage)
	if e := os.WriteFile(filepath.Join(root, f.PreimageKey+".json"), raw, 0600); e != nil {
		t.Fatal(e)
	}
	program := solana.MustPublicKeyFromBase58(v.ProgramID)
	loader := solana.MustPublicKeyFromBase58("BPFLoaderUpgradeab1e11111111111111111111111")
	pd, _, _ := solana.FindProgramAddress([][]byte{program[:]}, loader)
	p := make([]byte, 36)
	binary.LittleEndian.PutUint32(p, 2)
	copy(p[4:], pd[:])
	body := make([]byte, 48)
	binary.LittleEndian.PutUint32(body, 3)
	binary.LittleEndian.PutUint64(body[4:], 50)
	copy(body[45:], []byte{1, 2, 3})
	clock := make([]byte, 40)
	binary.LittleEndian.PutUint64(clock, 150)
	binary.LittleEndian.PutUint64(clock[32:], now)
	keys := []solana.PublicKey{solana.MustPublicKeyFromBase58(v.Entry), program, pd, solana.MustPublicKeyFromBase58("SysvarC1ock11111111111111111111111111111111")}
	account := func(d []byte, o solana.PublicKey, e bool) *rpc.Account {
		return &rpc.Account{Owner: o, Executable: e, Data: rpc.DataBytesOrJSONFromBytes(d)}
	}
	page := &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: []*rpc.Account{account(data, program, false), account(p, loader, true), account(body, loader, false), account(clock, solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), false)}}
	client := &miningPrepareFake{wenReadRPCFake: &wenReadRPCFake{t: t, genesis: solana.MustHashFromBase58(v.Genesis), page: page, addresses: keys}, fixture: f, mode: mode, root: root, index: index}
	pins := wenMiningPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, DescriptorSHA256: v.DescriptorSHA256, CapabilitySHA256: v.CapabilitySHA256, CodeSHA256: wenHashV1([]byte{1, 2, 3}), DeploymentSlot: 50}

	return client, pins, v
}
