package main

import (
	"context"
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"math"
	"testing"
)

type wenBondPurchaseRPCFakeV2 struct {
	*wenBondRPCFakeV2
	records                             map[solana.PublicKey]*rpc.Account
	quote, source, programData, receipt solana.PublicKey
	batches                             int
}

func (f *wenBondPurchaseRPCFakeV2) GetMultipleAccountsWithOpts(_ context.Context, keys []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if o == nil || o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 || o.MinContextSlot == nil || *o.MinContextSlot < f.min || len(keys) > 100 {
		f.t.Fatal("unbounded purchase read")
	}
	f.batches++
	f.pageSlot = *o.MinContextSlot
	if f.pageSlot < f.slotStart {
		f.pageSlot = f.slotStart
	}
	f.reads++
	clock := make([]byte, 40)
	binary.LittleEndian.PutUint64(clock, f.pageSlot)
	binary.LittleEndian.PutUint64(clock[32:], f.now)
	if f.mode == "clock slot" {
		clock[0] ^= 1
	}
	if f.mode == "clock negative" {
		binary.LittleEndian.PutUint64(clock[32:], ^uint64(0))
	}
	f.records[solana.SysVarClockPubkey] = &rpc.Account{Owner: solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), Data: rpc.DataBytesOrJSONFromBytes(clock)}
	if f.mode == "index race" && f.batches == 2 {
		f.records[f.receipt] = &rpc.Account{Owner: solana.SystemProgramID, Data: rpc.DataBytesOrJSONFromBytes([]byte{1})}
	}
	values := make([]*rpc.Account, len(keys))
	seen := map[solana.PublicKey]bool{}
	for i, k := range keys {
		if seen[k] {
			f.t.Fatal("duplicate purchase batch key")
		}
		seen[k] = true
		values[i] = f.records[k]
	}
	return &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: f.pageSlot}}, Value: values}, nil
}
func (f *wenBondPurchaseRPCFakeV2) GetBalance(ctx context.Context, k solana.PublicKey, c rpc.CommitmentType) (*rpc.GetBalanceResult, error) {
	v, e := f.wenBondRPCFakeV2.GetBalance(ctx, k, c)
	v.Value = 1000000000
	if f.mode == "protected balance" {
		v.Value = 0
	}
	return v, e
}
func (f *wenBondPurchaseRPCFakeV2) SimulateRawTransactionWithOpts(ctx context.Context, wire []byte, o *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	mode := f.mode
	f.mode = "ok"
	v, e := f.wenBondRPCFakeV2.SimulateRawTransactionWithOpts(ctx, wire, o)
	f.mode = mode
	if mode == "simulation error" {
		v.Value.Err = "rejected by installed program"
	}
	if mode == "compute cap" {
		x := uint64(500001)
		v.Value.UnitsConsumed = &x
	}
	if mode == "expired simulation" {
		v.Context.Slot = f.expiry
	}
	mutate := func(k solana.PublicKey, at int) {
		a := f.records[k]
		d := append([]byte(nil), a.Data.GetBinary()...)
		d[at] ^= 1
		a.Data = rpc.DataBytesOrJSONFromBytes(d)
	}
	if mode == "concurrent purchase" {
		f.records[f.receipt] = &rpc.Account{Owner: solana.SystemProgramID, Data: rpc.DataBytesOrJSONFromBytes([]byte{1})}
	}
	if mode == "source changed" {
		mutate(f.source, 64)
	}
	if mode == "program changed" {
		mutate(f.programData, 47)
	}
	return v, e
}
func bondPurchaseReadFixtureV2(t *testing.T, owners ...solana.PublicKey) (*wenBondPurchaseRPCFakeV2, wenBondPurchasePinsV2, wenBondPurchaseReadPolicyV2, wenBondPurchaseCostLimitsV2) {
	t.Helper()
	p, q, n, route := bondPurchaseFixtureV2(t)
	if len(owners) > 0 {
		p.Bond.Owner = owners[0]
	}
	creator := solana.PublicKey{8}
	sale, sb, e := wenBondKeyV2(p.Bond.Program, "wen-genesis-v1", creator[:], p.Bond.Policy[:])
	if e != nil {
		t.Fatal(e)
	}
	p.Bond.Sale = sale
	p.IndexCount = 0
	p.DomainIndex = 0
	_, q, _, _, _ = bondClaimFixtureV2(t, p.Bond)
	own := func(seed string, rest ...[]byte) solana.PublicKey {
		k, _, e := wenBondKeyV2(p.Bond.Program, seed, rest...)
		if e != nil {
			t.Fatal(e)
		}
		return k
	}
	route.Accounts[2].Pubkey = own("wen-btc-swap-v1", q.Key[:]).String()
	route.Accounts[3].Pubkey = own("wen-bond-swap-cash-v1", q.Key[:]).String()
	route.Accounts[6].Pubkey = own("wen-bond-swap-btc-v1", q.Key[:]).String()
	ix, e := buildWENBondPurchaseV2(p, q, n, 288001, route)
	if e != nil {
		t.Fatal(e)
	}
	a := ix[0].Accounts()
	row := func(owner solana.PublicKey, d []byte, ex bool) *rpc.Account {
		return &rpc.Account{Owner: owner, Data: rpc.DataBytesOrJSONFromBytes(d), Executable: ex, Lamports: 1}
	}
	records := map[solana.PublicKey]*rpc.Account{}
	venue := solana.MustPublicKeyFromBase58("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb")
	for _, i := range []int{3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16, 17, 18, 22, 24, 25, 26, 27} {
		owner := p.Bond.Program
		switch i {
		case 5, 6:
			owner = venue
		case 7, 9:
			owner = solana.Token2022ProgramID
		case 8, 10, 11, 12, 17, 18, 25:
			owner = solana.TokenProgramID
		case 26, 27:
			owner = route.Program
		case 22, 24:
			owner = solana.BPFLoaderUpgradeableProgramID
		}
		records[a[i].PublicKey] = row(owner, []byte{1}, i == 22 || i == 24)
	}
	records[q.Key] = row(q.Owner, q.Data, false)
	source := make([]byte, 165)
	copy(source, p.PolicyBytes[8:40])
	copy(source[32:], p.Bond.Owner[:])
	source[108] = 1
	binary.LittleEndian.PutUint64(source[64:], 380000000)
	records[p.Source] = row(solana.TokenProgramID, source, false)
	reserve := make([]byte, 165)
	records[a[17].PublicKey] = row(solana.TokenProgramID, reserve, false)
	sd := make([]byte, 200)
	copy(sd, []byte("WENGEN01"))
	copy(sd[8:], []byte{2, 0, 3, sb})
	copy(sd[16:], creator[:])
	copy(sd[48:], p.Bond.Policy[:])
	copy(sd[80:], p.PolicyBytes[8:40])
	binary.LittleEndian.PutUint64(sd[152:], 604800)
	binary.LittleEndian.PutUint64(sd[160:], 604801)
	binary.LittleEndian.PutUint64(sd[168:], 50000000000)
	binary.LittleEndian.PutUint64(sd[176:], 50000000000)
	binary.LittleEndian.PutUint64(sd[192:], 1)
	records[p.Bond.Sale] = row(p.Bond.Program, sd, false)
	activation, ab, _ := wenBondKeyV2(p.Bond.Program, "wen-activation-v1", sale[:])
	ad := make([]byte, 160)
	copy(ad, []byte("WENACTR1"))
	copy(ad[8:], []byte{1, 0, 1, ab})
	copy(ad[16:], sale[:])
	copy(ad[128:], p.Bond.Policy[:])
	binary.LittleEndian.PutUint64(ad[80:], 1)
	scaled := uint64(50000000000) * 100000
	binary.LittleEndian.PutUint64(ad[88:], scaled/2)
	binary.LittleEndian.PutUint64(ad[120:], scaled/2-scaled/3-scaled*40/300-scaled*6/300)
	records[activation] = row(p.Bond.Program, ad, false)
	genesis := "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
	code := []byte{1, 2, 3}
	deployment := func(program solana.PublicKey) signerWENBTCPinsV1 {
		pd, _, _ := solana.FindProgramAddress([][]byte{program[:]}, solana.BPFLoaderUpgradeableProgramID)
		head := make([]byte, 36)
		binary.LittleEndian.PutUint32(head, 2)
		copy(head[4:], pd[:])
		body := make([]byte, 48)
		binary.LittleEndian.PutUint32(body, 3)
		binary.LittleEndian.PutUint64(body[4:], 90)
		copy(body[45:], code)
		records[program] = row(solana.BPFLoaderUpgradeableProgramID, head, true)
		records[pd] = row(solana.BPFLoaderUpgradeableProgramID, body, false)
		return signerWENBTCPinsV1{ProgramID: program.String(), Genesis: genesis, CodeSHA256: wenHashV1(code), DeploymentSlot: 90}
	}
	dp, vp, rp := deployment(p.Bond.Program), deployment(venue), deployment(route.Program)
	table := solana.PublicKey{20}
	keys := solana.PublicKeySlice{}
	seen := map[solana.PublicKey]bool{}
	for _, v := range ix {
		for _, m := range v.Accounts() {
			if m.PublicKey != p.Bond.Owner && !seen[m.PublicKey] {
				seen[m.PublicKey] = true
				keys = append(keys, m.PublicKey)
			}
		}
	}
	data := make([]byte, 56+32*len(keys))
	binary.LittleEndian.PutUint32(data, 1)
	binary.LittleEndian.PutUint64(data[4:], ^uint64(0))
	binary.LittleEndian.PutUint64(data[12:], 900)
	for i, k := range keys {
		copy(data[56+i*32:], k[:])
	}
	records[table] = row(solana.MustPublicKeyFromBase58("AddressLookupTab1e1111111111111111111111111"), data, false)
	rent := make([]byte, 17)
	binary.LittleEndian.PutUint64(rent, 3480)
	binary.LittleEndian.PutUint64(rent[8:], math.Float64bits(2))
	rent[16] = 50
	records[solana.SysVarRentPubkey] = row(solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), rent, false)
	policy := wenBondPurchaseReadPolicyV2{Deployment: dp, Venue: vp, Router: rp, Oracle: rp, Nonce: n, MinimumSlot: 1000, ExpiresSlot: 1032, MaxSlotLag: 32, QuoteSHA256: wenHashV1(q.Data), Route: route, LookupPins: []wenBondLookupPinV2{{Key: table, Digest: wenHashV1(data)}}}
	fake := &wenBondPurchaseRPCFakeV2{wenBondRPCFakeV2: &wenBondRPCFakeV2{t: t, owner: p.Bond.Owner, genesis: solana.MustHashFromBase58(genesis), min: 1000, expiry: 1032, slotStart: 1000, now: 288001}, records: records, quote: q.Key, source: p.Source, receipt: a[19].PublicKey}
	fake.programData, _, _ = solana.FindProgramAddress([][]byte{p.Bond.Program[:]}, solana.BPFLoaderUpgradeableProgramID)
	return fake, p, policy, wenBondPurchaseCostLimitsV2{MaxFee: 5000, MaxRent: 40000000, RecoveryBudget: 15000, RetainedLamports: 114762240, ComputeUnits: 500000}
}
func bondPurchaseQ2ReadFixtureV2(t *testing.T, owners ...solana.PublicKey) (*wenBondPurchaseRPCFakeV2, wenBondPurchasePinsV2, wenBondPurchaseReadPolicyV2, wenBondPurchaseCostLimitsV2, solana.PublicKey) {
	t.Helper()
	f, p, policy, limits := bondPurchaseReadFixtureV2(t, owners...)
	q := append([]byte(nil), f.records[f.quote].Data.GetBinary()...)
	q[10] = 2
	f.records[f.quote].Data = rpc.DataBytesOrJSONFromBytes(q)
	policy.QuoteSHA256 = wenHashV1(q)
	root, bump, e := wenBondKeyV2(p.Bond.Program, "wen-accounting-domain-v1", p.Bond.Sale[:], []byte{7})
	if e != nil {
		t.Fatal(e)
	}
	d := make([]byte, 104)
	copy(d, []byte("WENDOM01"))
	d[8], d[10], d[11], d[72] = 1, 7, bump, 1
	copy(d[16:], p.Bond.Sale[:])
	binary.LittleEndian.PutUint64(d[48:], 1)
	binary.LittleEndian.PutUint64(d[56:], 3)
	binary.LittleEndian.PutUint64(d[64:], 3)
	f.records[root] = &rpc.Account{Owner: p.Bond.Program, Data: rpc.DataBytesOrJSONFromBytes(d), Lamports: 1}
	p.AssetIndex = 3
	r := wenBondAccountV2{Key: f.quote, Owner: p.Bond.Program, Data: q}
	ix, e := buildWENBondPurchaseV2(p, r, policy.Nonce, f.now, policy.Route)
	if e != nil {
		t.Fatal(e)
	}
	table := policy.LookupPins[0].Key
	data := append([]byte(nil), f.records[table].Data.GetBinary()...)
	for _, a := range ix[0].Accounts()[len(ix[0].Accounts())-4:] {
		data = append(data, a.PublicKey[:]...)
	}
	f.records[table].Data = rpc.DataBytesOrJSONFromBytes(data)
	policy.LookupPins[0].Digest = wenHashV1(data)
	p.AssetIndex = 0 // Finalized source read must establish the index, not caller input.
	return f, p, policy, limits, root
}

func TestWENBondPurchaseV2TrackedIndexAndFullPacket(t *testing.T) {
	f, p, policy, limits, _ := bondPurchaseQ2ReadFixtureV2(t)
	prepared, e := prepareWENBondPurchaseCostsV2(context.Background(), f, p, policy, limits, nil)
	if e != nil {
		t.Fatal(e)
	}
	if prepared.snapshot.Pins.AssetIndex != 3 || len(prepared.message)+65 > 1232 || prepared.snapshot.Rent == 0 {
		t.Fatal("q2 index, complete packet or rent not bound")
	}
	for _, mode := range []string{"root count", "root sale", "root revision", "missing lookup"} {
		t.Run(mode, func(t *testing.T) {
			f, p, policy, limits, root := bondPurchaseQ2ReadFixtureV2(t)
			switch mode {
			case "root count", "root sale", "root revision":
				d := append([]byte(nil), f.records[root].Data.GetBinary()...)
				at := map[string]int{"root count": 56, "root sale": 16, "root revision": 64}[mode]
				if mode == "root count" {
					binary.LittleEndian.PutUint64(d[at:], ^uint64(0))
				} else {
					d[at] ^= 1
				}
				f.records[root].Data = rpc.DataBytesOrJSONFromBytes(d)
			case "missing lookup":
				key := policy.LookupPins[0].Key
				d := append([]byte(nil), f.records[key].Data.GetBinary()...)
				d = d[:len(d)-32]
				f.records[key].Data = rpc.DataBytesOrJSONFromBytes(d)
				policy.LookupPins[0].Digest = wenHashV1(d)
			}
			if _, e := prepareWENBondPurchaseCostsV2(context.Background(), f, p, policy, limits, nil); e == nil {
				t.Fatal("invalid q2 source or lookup admitted")
			}
		})
	}
}
func TestWENBondPurchaseV2FinalizedCostAdmission(t *testing.T) {
	for _, mode := range []string{"ok", "genesis", "genesis changed", "stale", "reference behind", "clock slot", "clock negative", "index race", "missing quote", "missing feed", "future quote", "route program", "program code", "lookup", "rent-owner", "rent-policy", "rent-cap", "fee cap", "recovery-missing", "protected balance", "simulation error", "compute cap", "expired simulation", "expired", "expires during", "height rollback", "concurrent purchase", "source changed", "program changed"} {
		t.Run(mode, func(t *testing.T) {
			f, p, policy, l := bondPurchaseReadFixtureV2(t)
			f.mode = mode
			mutate := func(k solana.PublicKey, at int) {
				a := f.records[k]
				d := append([]byte(nil), a.Data.GetBinary()...)
				d[at] ^= 1
				a.Data = rpc.DataBytesOrJSONFromBytes(d)
			}
			switch mode {
			case "missing quote":
				delete(f.records, f.quote)
			case "missing feed":
				ix, _ := buildWENBondPurchaseV2(p, wenBondAccountV2{f.quote, p.Bond.Program, false, f.records[f.quote].Data.GetBinary()}, policy.Nonce, f.now, policy.Route)
				delete(f.records, ix[0].Accounts()[26].PublicKey)
			case "future quote":
				d := append([]byte(nil), f.records[f.quote].Data.GetBinary()...)
				binary.LittleEndian.PutUint64(d[232:], 1001)
				f.records[f.quote].Data = rpc.DataBytesOrJSONFromBytes(d)
				policy.QuoteSHA256 = wenHashV1(f.records[f.quote].Data.GetBinary())
			case "route program":
				policy.Router.ProgramID = p.Bond.Program.String()
			case "program code":
				mutate(f.programData, 47)
			case "lookup":
				mutate(policy.LookupPins[0].Key, 56)
			case "rent-owner":
				f.records[solana.SysVarRentPubkey].Owner = p.Bond.Program
			case "rent-policy":
				mutate(solana.SysVarRentPubkey, 15)
			case "rent-cap":
				l.MaxRent = 1
			case "recovery-missing":
				l.RecoveryBudget = 0
			}
			out, e := prepareWENBondPurchaseCostsV2(context.Background(), f, p, policy, l, nil)
			if (e == nil) != (mode == "ok") {
				t.Fatal(mode, e)
			}
			if out != nil {
				if out.fee != 5000 || out.snapshot.Rent == 0 || out.snapshot.RefundableRent != 4078560 || out.total != out.fee+out.snapshot.Rent+15000+114762240 || f.batches != 4 {
					t.Fatal("incomplete lifecycle funding", out.snapshot.Rent, out.snapshot.RefundableRent, f.batches)
				}
			}
		})
	}
}
