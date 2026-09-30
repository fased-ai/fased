package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"os"
	"strconv"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type wenMarketReadFakeV1 struct {
	*wenReadRPCFake
	reference uint64
}

func (f *wenMarketReadFakeV1) GetSlot(_ context.Context, c rpc.CommitmentType) (uint64, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("unfinalized Buy read")
	}
	return f.reference, nil
}
func marketReadFixtureV1(t *testing.T) (*wenMarketReadFakeV1, wenMarketBuyPinsV1, wenMarketReadPolicyV1, wenMarketBuyLimitsV1) {
	t.Helper()
	v := wenMarketVectorsV1(t)[3]
	p, _, l := wenMarketVectorArgsV1(t, v)
	p.Program = solana.MustPublicKeyFromBase58("GC4KiyyAkr3Gwp5pQXQMqoDinrRYtQq9BwZU2cVHDMaQ")
	p.Economy = solana.MustPublicKeyFromBase58("5fNcJggJb3rSRpkXhiHmfh1sTr45QLmDfVniFzg6LykH")
	derive := func(program solana.PublicKey, seed string, rest ...[]byte) (solana.PublicKey, byte) {
		key, b, e := solana.FindProgramAddress(append([][]byte{[]byte(seed)}, rest...), program)
		if e != nil {
			t.Fatal(e)
		}
		return key, b
	}
	venue := solana.MustPublicKeyFromBase58("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb")
	cashMint := solana.MustPublicKeyFromBase58("DE8BhmX7qJGzjUSHnYYEXjAcnr86aVUCNquoyEqYsENc")
	mint, _ := derive(p.Program, "wen-sat-mint-v1", p.Economy[:])
	collector, _ := derive(p.Program, "wen-sat-collector-v1", p.Economy[:])
	creator, _ := derive(p.Program, "wen-pool-creator-v1", p.Economy[:])
	first, second := mint, cashMint
	side := 0
	if bytes.Compare(first[:], second[:]) > 0 {
		first, second = second, first
		side = 1
	}
	p.Pool, _ = derive(venue, "pool", p.Config[:], first[:], second[:])
	assetVault, _ := derive(venue, "pool_vault", p.Pool[:], mint[:])
	cashVault, _ := derive(venue, "pool_vault", p.Pool[:], cashMint[:])
	authority, bump := derive(venue, "vault_and_lp_mint_auth_seed")
	lp, _ := derive(venue, "pool_lp_mint", p.Pool[:])
	observation, _ := derive(venue, "observation", p.Pool[:])
	end := make([]byte, 8)
	binary.LittleEndian.PutUint64(end, 1800)
	ref, refBump := derive(p.Program, "wen-price-reference-v1", p.Economy[:], end)
	loader := solana.BPFLoaderUpgradeableProgramID
	pd, _, _ := solana.FindProgramAddress([][]byte{p.Program[:]}, loader)
	vd, _, _ := solana.FindProgramAddress([][]byte{venue[:]}, loader)
	keys := []solana.PublicKey{p.Pool, p.Config, assetVault, cashVault, mint, cashMint, ref, p.AssetAccount, p.CashAccount, p.Program, pd, venue, vd, solana.SysVarClockPubkey}
	account := func(owner solana.PublicKey, d []byte, ex bool) *rpc.Account {
		return &rpc.Account{Owner: owner, Data: rpc.DataBytesOrJSONFromBytes(d), Executable: ex, Lamports: 1}
	}
	u := func(d []byte, at int, n uint64) { binary.LittleEndian.PutUint64(d[at:], n) }
	pool := make([]byte, 637)
	tag := sha256.Sum256([]byte("account:PoolState"))
	copy(pool, tag[:8])
	fv, sv, fp, sp := assetVault, cashVault, solana.Token2022ProgramID, solana.TokenProgramID
	if side == 1 {
		fv, sv = sv, fv
		fp, sp = sp, fp
	}
	expected := []solana.PublicKey{p.Config, creator, fv, sv, lp, first, second, fp, sp, observation}
	for i, k := range expected {
		copy(pool[8+i*32:], k[:])
	}
	pool[328] = bump
	u(pool, 373, 1)
	config := make([]byte, 236)
	tag = sha256.Sum256([]byte("account:AmmConfig"))
	copy(config, tag[:8])
	u(config, 12, 2500)
	u(config, 108, 2500)
	token := func(mint, owner solana.PublicKey, amount uint64, extended bool) []byte {
		n := 165
		if extended {
			n = 178
		}
		d := make([]byte, n)
		copy(d, mint[:])
		copy(d[32:], owner[:])
		u(d, 64, amount)
		d[108] = 1
		if extended {
			d[165] = 2
			binary.LittleEndian.PutUint16(d[166:], 2)
			binary.LittleEndian.PutUint16(d[168:], 8)
		}
		return d
	}
	mintData := make([]byte, 278)
	binary.LittleEndian.PutUint32(mintData, 1)
	copy(mintData[4:], p.Economy[:])
	mintData[44] = 11
	mintData[45] = 1
	mintData[165] = 1
	binary.LittleEndian.PutUint16(mintData[166:], 1)
	binary.LittleEndian.PutUint16(mintData[168:], 108)
	f := mintData[170:]
	copy(f[32:], collector[:])
	for _, at := range []int{72, 90} {
		u(f, at+8, ^uint64(0))
		binary.LittleEndian.PutUint16(f[at+16:], 300)
	}
	usd := make([]byte, 82)
	usd[44] = 6
	usd[45] = 1
	reference := make([]byte, 208)
	copy(reference, []byte("WENREF01"))
	reference[8] = 1
	reference[11] = refBump
	copy(reference[16:], p.Economy[:])
	copy(reference[48:], p.Pool[:])
	copy(reference[80:], p.Config[:])
	u(reference, 120, 1800)
	u(reference, 128, 31*(1<<32)/10)
	start := make([]byte, 8)
	firstPoint, _ := derive(p.Program, "wen-price-checkpoint-v1", p.Economy[:], start)
	lastPoint, _ := derive(p.Program, "wen-price-checkpoint-v1", p.Economy[:], end)
	copy(reference[144:], firstPoint[:])
	copy(reference[176:], lastPoint[:])
	code := []byte{1, 2, 3}
	deployment := func(program, programData solana.PublicKey) (*rpc.Account, *rpc.Account) {
		d := make([]byte, 36)
		binary.LittleEndian.PutUint32(d, 2)
		copy(d[4:], programData[:])
		body := make([]byte, 48)
		binary.LittleEndian.PutUint32(body, 3)
		u(body, 4, 90)
		copy(body[45:], code)
		return account(loader, d, true), account(loader, body, false)
	}
	program, body := deployment(p.Program, pd)
	vp, vb := deployment(venue, vd)
	clock := make([]byte, 40)
	u(clock, 0, 100)
	u(clock, 32, 1801)
	rows := []*rpc.Account{account(venue, pool, false), account(venue, config, false), account(solana.Token2022ProgramID, token(mint, authority, 1000000000000000, true), false), account(solana.TokenProgramID, token(cashMint, authority, 31000000000, false), false), account(solana.Token2022ProgramID, mintData, false), account(solana.TokenProgramID, usd, false), account(p.Program, reference, false), account(solana.Token2022ProgramID, token(mint, p.Owner, 0, true), false), account(solana.TokenProgramID, token(cashMint, p.Owner, 100000000, false), false), program, body, vp, vb, account(solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), clock, false)}
	genesis := "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
	policy := wenMarketReadPolicyV1{Successor: signerWENBTCPinsV1{ProgramID: p.Program.String(), Genesis: genesis, CodeSHA256: wenHashV1(code), DeploymentSlot: 90}, Venue: signerWENBTCPinsV1{ProgramID: venue.String(), Genesis: genesis, CodeSHA256: wenHashV1(code), DeploymentSlot: 90}, Creator: creator, PricePolicy: p.Config, PoolOpen: 1, ReferenceEnd: 1800, MaxDeviationBPS: 500}
	l.RequestedNet = 1000000000
	l.MinimumNet = l.RequestedNet
	l.MaxCash = 100000
	l.SlippageBPS = 0
	fake := &wenMarketReadFakeV1{wenReadRPCFake: &wenReadRPCFake{t: t, genesis: solana.MustHashFromBase58(genesis), addresses: keys, page: &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 100}}, Value: rows}}, reference: 101}
	return fake, p, policy, l
}
func TestWENMarketReadAuthenticatedCustody(t *testing.T) {
	for _, synthetic := range []bool{false, true} {
		f, p, policy, l := marketReadFixtureV1(t)
		policy.SyntheticReference = synthetic
		if synthetic {
			f.page.Value[6] = nil
		}
		out, e := readWENMarketBuyV1(context.Background(), f, p, policy, l)
		if e != nil {
			t.Fatal(e)
		}
		if out.Quote.InputCash == 0 || out.Quote.QuotedNet < l.RequestedNet || out.SyntheticReference != synthetic || !wenReservationHashV1(out.StateSHA256) {
			t.Fatal("incomplete verified quote")
		}
	}
}
func TestWENMarketReadRejectsChangedCustody(t *testing.T) {
	cases := []struct {
		name   string
		change func(*wenMarketReadFakeV1, *wenMarketReadPolicyV1, *wenMarketBuyLimitsV1)
	}{
		{"missing account", func(f *wenMarketReadFakeV1, _ *wenMarketReadPolicyV1, _ *wenMarketBuyLimitsV1) { f.page.Value[8] = nil }},
		{"wrong pool owner", func(f *wenMarketReadFakeV1, _ *wenMarketReadPolicyV1, _ *wenMarketBuyLimitsV1) {
			f.page.Value[0].Owner = solana.TokenProgramID
		}},
		{"changed venue bytes", func(f *wenMarketReadFakeV1, _ *wenMarketReadPolicyV1, _ *wenMarketBuyLimitsV1) {
			d := f.page.Value[12].Data.GetBinary()
			d[47] ^= 1
			f.page.Value[12].Data = rpc.DataBytesOrJSONFromBytes(d)
		}},
		{"changed successor bytes", func(f *wenMarketReadFakeV1, _ *wenMarketReadPolicyV1, _ *wenMarketBuyLimitsV1) {
			d := f.page.Value[10].Data.GetBinary()
			d[47] ^= 1
			f.page.Value[10].Data = rpc.DataBytesOrJSONFromBytes(d)
		}},
		{"delegated cash", func(f *wenMarketReadFakeV1, _ *wenMarketReadPolicyV1, _ *wenMarketBuyLimitsV1) {
			d := f.page.Value[8].Data.GetBinary()
			d[72] = 1
			f.page.Value[8].Data = rpc.DataBytesOrJSONFromBytes(d)
		}},
		{"wrong asset owner", func(f *wenMarketReadFakeV1, _ *wenMarketReadPolicyV1, _ *wenMarketBuyLimitsV1) {
			d := f.page.Value[7].Data.GetBinary()
			d[32] ^= 1
			f.page.Value[7].Data = rpc.DataBytesOrJSONFromBytes(d)
		}},
		{"changed SAT tariff", func(f *wenMarketReadFakeV1, _ *wenMarketReadPolicyV1, _ *wenMarketBuyLimitsV1) {
			d := f.page.Value[4].Data.GetBinary()
			d[170+88] ^= 1
			f.page.Value[4].Data = rpc.DataBytesOrJSONFromBytes(d)
		}},
		{"empty usable reserve", func(f *wenMarketReadFakeV1, _ *wenMarketReadPolicyV1, _ *wenMarketBuyLimitsV1) {
			d := f.page.Value[0].Data.GetBinary()
			binary.LittleEndian.PutUint64(d[341:], ^uint64(0))
			f.page.Value[0].Data = rpc.DataBytesOrJSONFromBytes(d)
		}},
		{"unbound clock", func(f *wenMarketReadFakeV1, _ *wenMarketReadPolicyV1, _ *wenMarketBuyLimitsV1) {
			d := f.page.Value[13].Data.GetBinary()
			d[0] ^= 1
			f.page.Value[13].Data = rpc.DataBytesOrJSONFromBytes(d)
		}},
		{"stale reference", func(f *wenMarketReadFakeV1, _ *wenMarketReadPolicyV1, _ *wenMarketBuyLimitsV1) {
			d := f.page.Value[13].Data.GetBinary()
			binary.LittleEndian.PutUint64(d[32:], 2101)
			f.page.Value[13].Data = rpc.DataBytesOrJSONFromBytes(d)
		}},
		{"reference identity", func(f *wenMarketReadFakeV1, _ *wenMarketReadPolicyV1, _ *wenMarketBuyLimitsV1) {
			d := f.page.Value[6].Data.GetBinary()
			d[48] ^= 1
			f.page.Value[6].Data = rpc.DataBytesOrJSONFromBytes(d)
		}},
		{"expired observation", func(f *wenMarketReadFakeV1, _ *wenMarketReadPolicyV1, _ *wenMarketBuyLimitsV1) { f.reference = 132 }},
		{"genesis changed", func(f *wenMarketReadFakeV1, _ *wenMarketReadPolicyV1, _ *wenMarketBuyLimitsV1) {
			f.change = "genesis-change"
		}},
		{"cash cap", func(_ *wenMarketReadFakeV1, _ *wenMarketReadPolicyV1, l *wenMarketBuyLimitsV1) { l.MaxCash = 1 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f, p, policy, l := marketReadFixtureV1(t)
			tc.change(f, &policy, &l)
			if _, e := readWENMarketBuyV1(context.Background(), f, p, policy, l); e == nil {
				t.Fatal("invalid custody accepted")
			}
		})
	}
}

func TestWENMarketQuoteCanonicalIntegerParity(t *testing.T) {
	raw, e := os.ReadFile("testdata/wen-market-buy-v1.json")
	if e != nil {
		t.Fatal(e)
	}
	var fixture struct {
		QuoteRows []struct {
			NetSat, SatReserve, USDCReserve, BuyUSDC, BuyNetSat, SaleUSDC string
			Accepted                                                      bool
		}
	}
	if e = json.Unmarshal(raw, &fixture); e != nil {
		t.Fatal(e)
	}
	if len(fixture.QuoteRows) != 6 {
		t.Fatal("missing quote vectors")
	}
	number := func(s string) uint64 {
		n, e := strconv.ParseUint(s, 10, 64)
		if e != nil {
			t.Fatal(e)
		}
		return n
	}
	for _, v := range fixture.QuoteRows {
		input, net, sale, _, e := quoteWENMarketBuyV1(number(v.NetSat), number(v.SatReserve), number(v.USDCReserve))
		if (e == nil) != v.Accepted {
			t.Fatal("arithmetic acceptance differs", v.NetSat, e)
		}
		if v.Accepted && (input != number(v.BuyUSDC) || net != number(v.BuyNetSat) || sale != number(v.SaleUSDC)) {
			t.Fatal("integer quote differs from shared client", v.NetSat)
		}
	}
}
