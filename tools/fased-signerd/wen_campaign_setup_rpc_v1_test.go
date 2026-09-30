package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"math"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type campaignSetupRPCFake struct {
	*campaignPrepareFake
	accounts         map[solana.PublicKey]*rpc.Account
	registry, window solana.PublicKey
	pages, rentCalls int
}

func (f *campaignSetupRPCFake) GetSlot(_ context.Context, k rpc.CommitmentType) (uint64, error) {
	if k != rpc.CommitmentFinalized {
		f.t.Fatal("nonfinalized slot")
	}
	if f.mode == "stale" {
		return 200, nil
	}
	return f.bump(), nil
}
func (f *campaignSetupRPCFake) GetBalance(_ context.Context, _ solana.PublicKey, k rpc.CommitmentType) (*rpc.GetBalanceResult, error) {
	if k != rpc.CommitmentFinalized {
		f.t.Fatal("nonfinalized balance")
	}
	n := uint64(9360)
	if f.accounts[f.registry] == nil {
		n = 10480
	}
	if f.mode == "balance" {
		n--
	}
	return &rpc.GetBalanceResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: f.bump()}}, Value: n}, nil
}
func (f *campaignSetupRPCFake) GetMinimumBalanceForRentExemption(_ context.Context, n uint64, k rpc.CommitmentType) (uint64, error) {
	if k != rpc.CommitmentFinalized || (n != 256 && n != 112 && n != 80) {
		f.t.Fatal("unexpected rent request")
	}
	f.rentCalls++
	if f.mode == "rent-error" {
		return 0, errors.New("no rent quote")
	}
	if f.mode == "rent-overflow" {
		return math.MaxUint64, nil
	}
	r := n * 10
	if f.mode == "rent-change" && f.rentCalls > 2 {
		r++
	}
	return r, nil
}
func (f *campaignSetupRPCFake) GetMultipleAccountsWithOpts(_ context.Context, keys []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 || o.MinContextSlot == nil || (len(keys) != 1 && len(keys) != 8) {
		f.t.Fatal("invalid setup read")
	}
	if f.mode == "rpc-error" {
		return nil, errors.New("RPC unavailable")
	}
	if f.mode == "nil-page" {
		return nil, nil
	}
	slot := f.bump()
	if slot < *o.MinContextSlot {
		f.t.Fatal("stale fixture")
	}
	if len(keys) == 8 {
		f.pages++
	}
	r := &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: slot}}, Value: make([]*rpc.Account, len(keys))}
	for i, k := range keys {
		a := f.accounts[k]
		if a == nil {
			continue
		}
		copy := *a
		b := bytes.Clone(a.Data.GetBinary())
		if k == solana.SysVarClockPubkey {
			binary.LittleEndian.PutUint64(b, slot)
			if f.mode == "clock" {
				binary.LittleEndian.PutUint64(b, slot-1)
			}
		}
		if len(keys) == 8 && k == f.registry && f.mode == "registry-race" {
			b[80]++
		}
		if k == f.window && f.pages > 1 && f.mode == "changed-window" {
			copy.Lamports++
		}
		copy.Data = rpc.DataBytesOrJSONFromBytes(b)
		r.Value[i] = &copy
	}
	if f.mode == "short-page" {
		r.Value = r.Value[:0]
	}
	if f.mode == "missing-mint" && len(keys) == 8 {
		r.Value[4] = nil
	}
	if f.mode == "below-minimum" {
		r.Context.Slot = 0
	}
	return r, nil
}

func campaignSetupRPCFixture(t *testing.T, mode string) (*campaignSetupRPCFake, signerWENBTCPinsV1, wenCampaignSetupRequestV1, solana.PublicKey) {
	t.Helper()
	key := func(n byte) (k solana.PublicKey) {
		for i := range k {
			k[i] = n
		}
		return
	}
	program, economy, owner, issuer := key(2), key(3), key(4), key(5)
	derive := func(seed string, rest ...[]byte) solana.PublicKey {
		k, _, e := solana.FindProgramAddress(append([][]byte{[]byte(seed)}, rest...), program)
		if e != nil {
			t.Fatal(e)
		}
		return k
	}
	mint := derive("wen-sat-mint-v1", economy[:])
	collector := derive("wen-sat-collector-v1", economy[:])
	registry := derive("wen-retail-members-v2", issuer[:], mint[:])
	window := derive("wen-retail-window-v2", issuer[:], mint[:], make([]byte, 8))
	genesis := solana.Hash(key(8))
	f := &campaignSetupRPCFake{campaignPrepareFake: &campaignPrepareFake{campaignReadFake: &campaignReadFake{wenReadRPCFake: &wenReadRPCFake{t: t, genesis: genesis}}, next: 100, mode: mode}, accounts: map[solana.PublicKey]*rpc.Account{}, registry: registry, window: window}
	add := func(k, owner solana.PublicKey, b []byte, executable bool) {
		f.accounts[k] = &rpc.Account{Owner: owner, Executable: executable, Lamports: 1000, Data: rpc.DataBytesOrJSONFromBytes(b)}
	}
	w := make([]byte, 256)
	copy(w, "WENRCMP2")
	w[8] = 1
	w[11] = 12
	copy(w[16:], issuer[:])
	copy(w[48:], mint[:])
	for offset, n := range map[int]uint64{120: 1, 128: 1900, 136: 2200, 216: 1, 232: 1000, 240: 60000, 248: 30000} {
		binary.LittleEndian.PutUint64(w[offset:], n)
	}
	add(window, program, w, false)
	g := make([]byte, 112)
	copy(g, "WENRMEM2")
	g[8] = 1
	copy(g[16:], issuer[:])
	copy(g[48:], mint[:])
	binary.LittleEndian.PutUint64(g[80:], 7)
	if mode != "new-registry" {
		add(registry, program, g, false)
	}
	m := make([]byte, 278)
	binary.LittleEndian.PutUint32(m, 1)
	copy(m[4:], economy[:])
	m[44] = 11
	m[45] = 1
	m[165] = 1
	binary.LittleEndian.PutUint16(m[166:], 1)
	binary.LittleEndian.PutUint16(m[168:], 108)
	copy(m[202:], collector[:])
	for _, o := range []int{72, 90} {
		binary.LittleEndian.PutUint64(m[170+o+8:], math.MaxUint64)
		binary.LittleEndian.PutUint16(m[170+o+16:], 300)
	}
	if mode == "mint-fee" {
		m[276] ^= 1
	}
	add(mint, solana.Token2022ProgramID, m, false)
	pd, _, _ := solana.FindProgramAddress([][]byte{program[:]}, solana.BPFLoaderUpgradeableProgramID)
	p := make([]byte, 36)
	binary.LittleEndian.PutUint32(p, 2)
	copy(p[4:], pd[:])
	add(program, solana.BPFLoaderUpgradeableProgramID, p, true)
	d := make([]byte, 48)
	binary.LittleEndian.PutUint32(d, 3)
	binary.LittleEndian.PutUint64(d[4:], 100)
	copy(d[45:], []byte{1, 2, 3})
	add(pd, solana.BPFLoaderUpgradeableProgramID, d, false)
	clock := make([]byte, 40)
	binary.LittleEndian.PutUint64(clock[32:], 1800)
	add(solana.SysVarClockPubkey, solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), clock, false)
	pins := signerWENBTCPinsV1{ProgramID: program.String(), Genesis: genesis.String(), DeploymentSlot: 100, CodeSHA256: wenHashV1([]byte{1, 2, 3})}
	if mode == "binary" {
		pins.CodeSHA256 = wenHashV1([]byte{4})
	}
	if mode == "genesis" {
		pins.Genesis = solana.Hash(key(9)).String()
	}
	if mode == "genesis-change" {
		f.change = mode
	}
	return f, pins, wenCampaignSetupRequestV1{Program: program, Economy: economy, Issuer: issuer, Terms: wenCampaignSetupTermsV1{Deposit: 1000, MaxPrice: 1, Daily: 100, Total: 1000, Expiry: 3000, MaxWait: 1500}}, owner
}

func TestWENCampaignSetupPreparationV1(t *testing.T) {
	for _, mode := range []string{"ok", "new-registry", "rpc-error", "nil-page", "short-page", "missing-mint", "below-minimum", "registry-race", "changed-window", "rent-change", "rent-error", "rent-overflow", "mint-fee", "clock", "binary", "genesis", "genesis-change", "stale", "balance", "fee", "units", "simulation", "expired", "expires-during"} {
		t.Run(mode, func(t *testing.T) {
			f, pins, q, owner := campaignSetupRPCFixture(t, mode)
			p, e := prepareWENCampaignSetupV1(context.Background(), f, pins, q, owner, 100, 132, 32, 5000, nil)
			if mode != "ok" && mode != "new-registry" {
				if e == nil {
					t.Fatal("bad preparation accepted")
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			expected := uint64(9360)
			if mode == "new-registry" {
				expected = 10480
			}
			if p.maximumDebit != expected || p.fee != 5000 || p.snapshot.Rent != expected-6000 {
				t.Fatal("incorrect principal/rent/fee split")
			}
			again, e := prepareWENCampaignSetupV1(context.Background(), f, pins, q, owner, 100, 132, 32, 5000, p)
			if e != nil || !bytes.Equal(again.message, p.message) {
				t.Fatal("stable reviewed preparation", e)
			}
			q.Terms.Deposit++
			if _, e = prepareWENCampaignSetupV1(context.Background(), f, pins, q, owner, 100, 132, 32, 5000, p); e == nil {
				t.Fatal("changed reviewed terms accepted")
			}
		})
	}
}
