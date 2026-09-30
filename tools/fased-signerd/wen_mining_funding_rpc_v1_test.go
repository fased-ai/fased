package main

import (
	"context"
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"math"
	"testing"
)

type fundingReadFake struct {
	t       *testing.T
	genesis solana.Hash
	page    *rpc.GetMultipleAccountsResult
	keys    []solana.PublicKey
	calls   int
	mode    string
}

func (f *fundingReadFake) GetGenesisHash(context.Context) (solana.Hash, error) {
	f.calls++
	g := f.genesis
	if f.mode == "cluster" || f.mode == "cluster-change" && f.calls > 1 {
		g[0] ^= 1
	}
	return g, nil
}
func (f *fundingReadFake) GetSlot(context.Context, rpc.CommitmentType) (uint64, error) {
	if f.mode == "stale" {
		return 19, nil
	}
	return 11, nil
}
func (f *fundingReadFake) GetMultipleAccountsWithOpts(_ context.Context, keys []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 || o.MinContextSlot == nil || *o.MinContextSlot != 5 {
		f.t.Fatal("unbound RPC options")
	}
	if len(keys) != len(f.keys) {
		f.t.Fatal("key count")
	}
	for i, k := range keys {
		if k != f.keys[i] {
			f.t.Fatal("wrong key")
		}
	}
	return f.page, nil
}
func fundingRPCFixture(t *testing.T, owners ...solana.PublicKey) (signerWENMiningFundingIntentV1, solana.PublicKey, wenStakingPinsV1, *fundingReadFake) {
	v, owner, _ := miningFundingFixture(t)
	if len(owners) > 0 {
		owner = owners[0]
	}
	v.MinFinalizedSlot = "5"
	p := solana.MustPublicKeyFromBase58(v.ProgramID)
	id := solana.MustPublicKeyFromBase58(v.VaultID)
	sale, sb, _ := solana.FindProgramAddress([][]byte{[]byte("wen-genesis-v1"), owner[:], id[:]}, p)
	v.Sale = sale.String()
	ix, e := buildWENMiningFundingInstructionV1(v, owner)
	if e != nil {
		t.Fatal(e)
	}
	keys := []solana.PublicKey{}
	for _, a := range ix.Accounts() {
		keys = append(keys, a.PublicKey)
	}
	pd, _, _ := solana.FindProgramAddress([][]byte{p[:]}, solana.BPFLoaderUpgradeableProgramID)
	keys = append(keys, p, pd, solana.SysVarClockPubkey, solana.SysVarRentPubkey)
	put := func(d []byte, o int, n uint64) { binary.LittleEndian.PutUint64(d[o:], n) }
	key := func(d []byte, o int, k solana.PublicKey) { copy(d[o:o+32], k[:]) }
	header := func(n int, m string, b byte) []byte {
		d := make([]byte, n)
		copy(d, []byte(m))
		d[8] = 1
		d[11] = b
		return d
	}
	_, vb, _ := solana.FindProgramAddress([][]byte{[]byte("wen-portfolio-sol-v1"), owner[:], id[:]}, p)
	nonce := uint64(0)
	for _, c := range v.Nonce {
		nonce = nonce*10 + uint64(c-'0')
	}
	le := make([]byte, 8)
	put(le, 0, nonce)
	_, ab, _ := solana.FindProgramAddress([][]byte{[]byte("wen-portfolio-action-v1"), keys[0][:], le}, p)
	_, bb, _ := solana.FindProgramAddress([][]byte{[]byte("wen-mining-budget-v1"), sale[:], owner[:]}, p)
	_, cb, _ := solana.FindProgramAddress([][]byte{[]byte("wen-mining-capital-v1"), sale[:], owner[:]}, p)
	vault := header(160, "WENPVL01", vb)
	vault[10] = 1
	key(vault, 16, owner)
	key(vault, 48, id)
	key(vault, 80, keys[5])
	put(vault, 120, 6000)
	put(vault, 144, 1)
	action := header(112, "WENPVA01", ab)
	key(action, 16, keys[0])
	put(action, 48, nonce)
	put(action, 56, 6000)
	put(action, 64, 100)
	key(action, 72, keys[5])
	sd := header(192, "WENGEN01", sb)
	sd[10] = 3
	key(sd, 16, owner)
	key(sd, 48, id)
	put(sd, 152, 604800)
	put(sd, 160, 604801)
	budget := header(1712, "WENMBD01", bb)
	key(budget, 16, sale)
	key(budget, 48, owner)
	key(budget, 80, keys[5])
	put(budget, 136, 500)
	put(budget, 144, 1)
	capital := header(80, "WENMCP01", cb)
	key(capital, 16, sale)
	key(capital, 48, owner)
	code := []byte{1, 2, 3}
	prog := make([]byte, 36)
	binary.LittleEndian.PutUint32(prog, 2)
	key(prog, 4, pd)
	body := make([]byte, 48)
	binary.LittleEndian.PutUint32(body, 3)
	put(body, 4, 5)
	copy(body[45:], code)
	clock := make([]byte, 40)
	put(clock, 0, 10)
	put(clock, 32, 10)
	rent := make([]byte, 17)
	put(rent, 0, 3480)
	put(rent, 8, math.Float64bits(2))
	rent[16] = 50
	data := [][]byte{vault, action, {}, sd, budget, capital, prog, body, clock, rent}
	values := make([]*rpc.Account, len(data))
	sysvar := solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111")
	for i, d := range data {
		o := p
		if i == 2 {
			o = solana.SystemProgramID
		}
		if i == 6 || i == 7 {
			o = solana.BPFLoaderUpgradeableProgramID
		}
		if i >= 8 {
			o = sysvar
		}
		values[i] = &rpc.Account{Owner: o, Executable: i == 6, Data: rpc.DataBytesOrJSONFromBytes(d), Lamports: 3000000}
	}
	pins := wenStakingPinsV1{ProgramID: v.ProgramID, Genesis: v.Genesis, DescriptorSHA256: v.DescriptorSHA256, CapabilitySHA256: v.CapabilitySHA256, CodeSHA256: wenHashV1(code), DeploymentSlot: 5}
	return v, owner, pins, &fundingReadFake{t: t, genesis: solana.MustHashFromBase58(v.Genesis), keys: keys, page: &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 10}}, Value: values}}
}
func TestWENMiningFundingFinalizedRPCV1(t *testing.T) {
	for _, mode := range []string{"ok", "cluster", "cluster-change", "stale", "missing", "code", "clock", "rent", "capital", "vault", "sale", "sale-pda", "budget", "bucket", "capital-owner", "owner", "pin", "paid"} {
		t.Run(mode, func(t *testing.T) {
			v, w, p, c := fundingRPCFixture(t)
			c.mode = mode
			change := func(i, o int, b byte) {
				d := append([]byte(nil), c.page.Value[i].Data.GetBinary()...)
				d[o] = b
				c.page.Value[i].Data = rpc.DataBytesOrJSONFromBytes(d)
			}
			switch mode {
			case "missing":
				c.page.Value[4] = nil
			case "code":
				change(7, 45, 7)
			case "clock":
				change(8, 0, 9)
			case "rent":
				change(9, 16, 101)
			case "capital":
				c.page.Value[5].Lamports = 1448179
			case "vault":
				c.page.Value[0].Lamports = 2010479
			case "sale":
				change(3, 10, 2)
			case "sale-pda":
				change(3, 48, 7)
			case "budget":
				change(4, 144, 0)
			case "bucket":
				change(4, 176, 2)
				change(4, 184, 1)
			case "capital-owner":
				c.page.Value[5].Owner = w
			case "owner":
				c.page.Value[2].Owner = solana.MustPublicKeyFromBase58(p.ProgramID)
			case "pin":
				p.CapabilitySHA256 = "bad"
			case "paid":
				change(1, 10, 1)
			}
			out, e := readWENMiningFundingRPCV1(context.Background(), c, p, v, w, 2)
			if (e == nil) != (mode == "ok") {
				t.Fatalf("unexpected %v", e)
			}
			if e == nil {
				if out.Slot != 10 || out.Now != 10 || len(out.StateHash) != 64 || c.calls != 2 {
					t.Fatal("bad snapshot")
				}
				c.page.Value[5].Lamports++
				next, e := readWENMiningFundingRPCV1(context.Background(), c, p, v, w, 2)
				if e != nil || next.StateHash == out.StateHash {
					t.Fatal("lamports not bound")
				}
			}
		})
	}
}
