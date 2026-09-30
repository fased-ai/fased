package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"os"
	"path/filepath"
	"testing"
)

func TestWENNativeClaimHistoryRPC(t *testing.T) {
	for _, mode := range []string{"ok", "genesis", "genesis-change", "stale", "reference-behind", "reference-expired", "rpc-error", "nil-page", "reference-error", "code", "clock", "missing", "paid", "pin", "expired", "missing-vault", "frozen-vault", "wrong-destination", "wrong-decimals", "inactive-sale", "missing-activation", "activation-supply", "token-owner", "token-executable", "short-page"} {
		t.Run(mode, func(t *testing.T) {
			v, s := nativeStateFixture(t)
			p := solana.MustPublicKeyFromBase58(v.ProgramID)
			pd, _, _ := solana.FindProgramAddress([][]byte{p[:]}, solana.BPFLoaderUpgradeableProgramID)
			code := []byte{9, 8, 7}
			program := make([]byte, 36)
			binary.LittleEndian.PutUint32(program, 2)
			copy(program[4:], pd[:])
			data := make([]byte, 48)
			binary.LittleEndian.PutUint32(data, 3)
			binary.LittleEndian.PutUint64(data[4:], 1)
			copy(data[45:], code)
			clock := make([]byte, 40)
			binary.LittleEndian.PutUint64(clock, 150)
			binary.LittleEndian.PutUint64(clock[32:], s.Now)
			pins := wenStakingPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, DescriptorSHA256: v.DescriptorSHA256, CapabilitySHA256: v.CapabilitySHA256, DeploymentSlot: 1, CodeSHA256: wenHashV1(code)}
			ix, _ := buildWENNativeClaimInstructionV1(v, solana.PublicKey{5})
			keys := []solana.PublicKey{}
			for _, i := range []int{4, 3, 5, 6, 7} {
				keys = append(keys, ix.Accounts()[i].PublicKey)
			}
			keys = append(keys, p, pd, solana.SysVarClockPubkey)
			for _, i := range []int{10, 8, 9, 11, 1, 2} {
				keys = append(keys, ix.Accounts()[i].PublicKey)
			}
			account := func(owner solana.PublicKey, d []byte, ex bool) *rpc.Account {
				return &rpc.Account{Owner: owner, Data: rpc.DataBytesOrJSONFromBytes(d), Executable: ex}
			}
			values := []*rpc.Account{}
			for _, a := range []*signerWENBTCAccountV1{s.Source, s.Receipt, s.Cohort, s.History} {
				values = append(values, account(a.Owner, a.Data, false))
			}
			values = append(values, nil, account(solana.BPFLoaderUpgradeableProgramID, program, true), account(solana.BPFLoaderUpgradeableProgramID, data, false), account(solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), clock, false))
			mint, vault, destination := s.Mint, s.Inventory, s.Destination
			token := &signerWENBTCAccountV1{Owner: solana.BPFLoaderUpgradeableProgramID, Executable: true}
			for _, a := range []*signerWENBTCAccountV1{mint, vault, destination, token} {
				values = append(values, account(a.Owner, a.Data, a.Executable))
			}
			bv := btcClaimIntentFixture()
			bv.ProgramID = v.ProgramID
			bv.Sale = v.Sale
			saleAccount, activation := claimActivationFixture(t, bv)
			for _, a := range []*signerWENBTCAccountV1{saleAccount, activation} {
				values = append(values, account(a.Owner, a.Data, false))
			}
			f := wenReadRPCFake{t: t, genesis: solana.Hash{1}, addresses: keys, page: &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: values}, change: mode}
			switch mode {
			case "token-owner":
				values[11].Owner = solana.SystemProgramID
			case "token-executable":
				values[11].Executable = false
			case "short-page":
				f.page.Value = f.page.Value[:13]
			case "code":
				data[45] ^= 1
			case "clock":
				clock[0] ^= 1
			case "missing":
				values[0] = nil
			case "paid":
				values[4] = values[0]
			case "pin":
				pins.DescriptorSHA256 = "wrong"
			case "missing-vault":
				values[9] = nil
			case "frozen-vault":
				vault.Data[108] = 2
			case "wrong-destination":
				destination.Data[32] ^= 1
			case "wrong-decimals":
				mint.Data[44] = 9
			case "inactive-sale":
				saleAccount.Data[10] = 2
			case "missing-activation":
				values[13] = nil
			case "activation-supply":
				activation.Data[88] ^= 1
			case "expired":
				f.page.Context.Slot = 200
			}
			out, e := readWENNativeClaimHistoryRPCV1(context.Background(), &f, pins, v, solana.PublicKey{5}, solana.PublicKey{6}, 2)
			if (e == nil) != (mode == "ok") {
				t.Fatalf("unexpected RPC admission: %v", e)
			}
			if mode == "ok" {
				testReviewedNativeRead(t, v, pins, &f, out)
			}
			if e == nil && (out.Allocation.Net != 242 || len(out.StateHash) != 64) {
				t.Fatal(out)
			}
		})
	}
}

type nativeReviewRaceRPC struct {
	*wenReadRPCFake
	after func()
}

func (f *nativeReviewRaceRPC) GetSlot(c context.Context, k rpc.CommitmentType) (uint64, error) {
	n, e := f.wenReadRPCFake.GetSlot(c, k)
	if f.after != nil {
		f.after()
	}
	return n, e
}
func testReviewedNativeRead(t *testing.T, v signerWENNativeClaimIntentV1, pins wenStakingPinsV1, f *wenReadRPCFake, want wenNativeClaimReadbackV1) {
	raw, descriptorPins := nativeClaimDescriptorFixture(t, "ok")
	var d map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if e := dec.Decode(&d); e != nil {
		t.Fatal(e)
	}
	dep := d["deployment"].(map[string]any)["ownerClaim"].(map[string]any)
	program := solana.MustPublicKeyFromBase58(v.ProgramID)
	dep["program"] = hex.EncodeToString(program[:])
	dep["genesis"] = v.Genesis
	dep["deploymentSlot"] = "1"
	dep["deployedBytesHash"] = pins.CodeSHA256
	dep["upgradeAuthority"] = nil
	delete(d, "descriptorDigest")
	b, _ := wenJSONV1(d)
	d["descriptorDigest"] = "sha256:" + wenHashV1(b)
	b, _ = wenJSONV1(d)
	pins.DescriptorSHA256 = wenHashV1(b)
	pins.CapabilitySHA256 = descriptorPins.CapabilitySHA256
	v.DescriptorSHA256 = pins.DescriptorSHA256
	v.CapabilitySHA256 = pins.CapabilitySHA256
	v.MaxRentLamports = "1000"
	db := filepath.Join(t.TempDir(), "state.db")
	root := filepath.Join(filepath.Dir(db), "wen-native-claim", wenHashV1([]byte("miner")))
	if e := os.MkdirAll(root, 0700); e != nil {
		t.Fatal(e)
	}
	r := wenNativeClaimReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: solana.PublicKey{5}.String(), Intent: v, Policy: solana.PublicKey{6}.String(), Pins: pins, MaxTotalCostLamports: 6000, MaxSlotLag: 2}
	path := filepath.Join(root, wenNativeClaimAdmissionNameV1(v))
	write := func() {
		raw, _ := json.Marshal(r)
		if e := os.WriteFile(path, raw, 0600); e != nil {
			t.Fatal(e)
		}
	}
	write()
	if e := os.WriteFile(filepath.Join(root, pins.DescriptorSHA256), b, 0600); e != nil {
		t.Fatal(e)
	}
	out, e := readReviewedWENNativeClaimV1(context.Background(), db, "miner", v, f)
	if e != nil || out != want {
		t.Fatalf("joined: %+v %v", out, e)
	}
	costs := &nativeJoinedCostFake{nativeClaimCostFake: &nativeClaimCostFake{t: t}, reader: f}
	prepared, e := prepareReviewedWENNativeClaimV1(context.Background(), costs, db, "miner", v)
	if e != nil || prepared.total != 6000 || prepared.state.Allocation.Net != 242 {
		t.Fatalf("joined prepare %v", e)
	}
	costs.after = func() { r.MaxSlotLag++; write() }
	if _, e = prepareReviewedWENNativeClaimV1(context.Background(), costs, db, "miner", v); e == nil {
		t.Fatal("preparation accepted review mutation")
	}
	r.MaxSlotLag = 2
	write()
	original := append([]byte(nil), f.page.Value[9].Data.GetBinary()...)
	costs.after = func() {
		changed := append([]byte(nil), original...)
		changed[64]++
		f.page.Value[9].Data = rpc.DataBytesOrJSONFromBytes(changed)
	}
	if _, e = prepareReviewedWENNativeClaimV1(context.Background(), costs, db, "miner", v); e == nil {
		t.Fatal("preparation accepted custody mutation")
	}
	f.page.Value[9].Data = rpc.DataBytesOrJSONFromBytes(original)
	race := &nativeReviewRaceRPC{f, func() { r.MaxSlotLag++; write() }}
	if _, e = readReviewedWENNativeClaimV1(context.Background(), db, "miner", v, race); e == nil {
		t.Fatal("review changed during RPC accepted")
	}
	if e = os.WriteFile(filepath.Join(root, pins.DescriptorSHA256), []byte("{}"), 0600); e != nil {
		t.Fatal(e)
	}
	calls := f.calls
	if _, e = readReviewedWENNativeClaimV1(context.Background(), db, "miner", v, f); e == nil || f.calls != calls {
		t.Fatal("invalid descriptor reached RPC")
	}
}

type nativeJoinedCostFake struct {
	*nativeClaimCostFake
	reader *wenReadRPCFake
	after  func()
}

func (f *nativeJoinedCostFake) GetGenesisHash(c context.Context) (solana.Hash, error) {
	return f.reader.GetGenesisHash(c)
}
func (f *nativeJoinedCostFake) GetSlot(c context.Context, k rpc.CommitmentType) (uint64, error) {
	return f.reader.GetSlot(c, k)
}
func (f *nativeJoinedCostFake) GetMultipleAccountsWithOpts(c context.Context, k []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	return f.reader.GetMultipleAccountsWithOpts(c, k, o)
}
func (f *nativeJoinedCostFake) SimulateRawTransactionWithOpts(c context.Context, b []byte, o *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	r, e := f.nativeClaimCostFake.SimulateRawTransactionWithOpts(c, b, o)
	if f.after != nil {
		f.after()
	}
	return r, e
}
