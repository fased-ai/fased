package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	solana "github.com/gagliardetto/solana-go"
)

func bondClaimFixtureV2(t *testing.T, override ...wenBondPinsV2) (wenBondPinsV2, wenBondAccountV2, wenBondAccountV2, uint64, uint64) {
	t.Helper()
	p := wenBondPinsV2{Profile: "devnet-synthetic-fixture", Program: solana.MustPublicKeyFromBase58("GC4KiyyAkr3Gwp5pQXQMqoDinrRYtQq9BwZU2cVHDMaQ"), Sale: solana.MustPublicKeyFromBase58("5fNcJggJb3rSRpkXhiHmfh1sTr45QLmDfVniFzg6LykH"), Policy: solana.PublicKey{3}, Owner: solana.PublicKey{4}, Destination: solana.PublicKey{5}}
	if len(override) > 0 {
		p = override[0]
	}
	nonce := uint64(17)
	end := uint64(288000)
	start := end + 1
	now := start + 302400
	q, qb, e := wenBondKeyV2(p.Program, "wen-bond-net-quote-v1", p.Sale[:], p.Owner[:], wenBondU64V2(nonce))
	if e != nil {
		t.Fatal(e)
	}
	r, rb, e := wenBondKeyV2(p.Program, "wen-paid-primary-v1", p.Sale[:], q[:])
	if e != nil {
		t.Fatal(e)
	}
	reference, _, _ := wenBondKeyV2(p.Program, "wen-price-reference-v1", p.Sale[:], wenBondU64V2(end))
	reserve, _, _ := wenBondKeyV2(p.Program, "wen-economy-btc-v2", p.Sale[:])
	d := make([]byte, 352)
	copy(d, []byte("WENBNQ01"))
	copy(d[8:], []byte{1, 0, 0, qb})
	for at, k := range map[int]solana.PublicKey{16: p.Sale, 48: p.Policy, 80: p.Owner, 112: reference, 280: reserve} {
		copy(d[at:at+32], k[:])
	}
	for at, n := range map[int]uint64{144: nonce, 152: start, 160: end + 300, 168: 10000000000000, 176: 9700000000000, 184: 400000000, 192: 380000000, 200: 200000000, 208: 50000000000, 216: 2500000000000000, 232: 1000, 240: 9700000000000, 248: end, 312: 100000000, 320: 400000} {
		binary.LittleEndian.PutUint64(d[at:], n)
	}
	v := make([]byte, 288)
	copy(v, []byte("WENPAID1"))
	copy(v[8:], []byte{2, 1, 0, rb})
	for at, k := range map[int]solana.PublicKey{16: p.Sale, 48: p.Policy, 80: q, 112: p.Owner} {
		copy(v[at:at+32], k[:])
	}
	h := sha256.Sum256(d)
	copy(v[144:], h[:])
	for at, n := range map[int]uint64{176: start / 28800, 184: start, 192: 380000000, 200: 200000000, 208: 180000000, 224: 10000000000000, 248: start + 604800} {
		binary.LittleEndian.PutUint64(v[at:], n)
	}
	return p, wenBondAccountV2{q, p.Program, false, d}, wenBondAccountV2{r, p.Program, false, v}, nonce, now
}
func TestWENBondClaimV2AcceptedRightsAndFees(t *testing.T) {
	p, q, r, n, now := bondClaimFixtureV2(t)
	c, e := inspectWENBondClaimV2(p, q, r, n, now, 1)
	if e != nil {
		t.Fatal(e)
	}
	if c.AvailableGross != 5000000000000 || c.AvailableNet != 4850000000000 || c.TransferFee != 150000000000 || c.USDBacking != 200000000 || c.BTCCapital != 180000000 {
		t.Fatal("wrong accepted accounting", c)
	}
	for _, at := range []uint64{now, c.End, c.End + 1} {
		if _, e = inspectWENBondClaimV2(p, q, r, n, at, 1); e != nil {
			t.Fatal("expired quote blocked accepted claim", e)
		}
	}
	for _, at := range []uint64{c.Start - 1, c.Start} {
		if _, e = inspectWENBondClaimV2(p, q, r, n, at, 1); e == nil {
			t.Fatal("unvested claim admitted")
		}
	}
	if _, e = inspectWENBondClaimV2(p, q, r, n, now, c.AvailableNet+1); e == nil {
		t.Fatal("net minimum ignored")
	}
	binary.LittleEndian.PutUint64(r.Data[256:], 1000000000000)
	binary.LittleEndian.PutUint64(r.Data[264:], 970000000000)
	binary.LittleEndian.PutUint64(r.Data[272:], 30000000000)
	c, e = inspectWENBondClaimV2(p, q, r, n, now, 1)
	if e != nil || c.AvailableGross != 4000000000000 || c.AvailableNet != 3880000000000 {
		t.Fatal("previous claims not deducted", c, e)
	}
}

func TestWENBondClaimV2TrackedQuoteRights(t *testing.T) {
	p, q, r, nonce, now := bondClaimFixtureV2(t)
	q.Data[10] = 2 // The installed q2 purchase keeps the vested-claim opcode and receipt layout.
	h := sha256.Sum256(q.Data)
	copy(r.Data[144:176], h[:])
	claim, err := inspectWENBondClaimV2(p, q, r, nonce, now, 1)
	if err != nil || claim.AvailableNet != 4850000000000 || claim.QuoteSHA256 != h {
		t.Fatal("tracked Bond claim rights rejected", claim, err)
	}
	if _, err = buildWENBondClaimV2(p, claim); err != nil {
		t.Fatal("tracked Bond claim cannot compile", err)
	}
	q.Data[10] = 3
	if _, err = inspectWENBondClaimV2(p, q, r, nonce, now, 1); err == nil {
		t.Fatal("unsupported Bond quote version admitted")
	}
}
func TestWENBondClaimV2RejectsSubstitutions(t *testing.T) {
	for _, which := range []string{"quote", "receipt"} {
		limit := 352
		if which == "receipt" {
			limit = 288
		}
		for at := 0; at < limit; at++ {
			p, q, r, n, now := bondClaimFixtureV2(t)
			if which == "quote" {
				q.Data[at] ^= 1
			} else {
				r.Data[at] ^= 1
			}
			if _, e := inspectWENBondClaimV2(p, q, r, n, now, 1); e == nil {
				t.Fatalf("%s substituted byte %d accepted", which, at)
			}
		}
	}
	for _, change := range []func(*wenBondPinsV2, *wenBondAccountV2, *wenBondAccountV2){
		func(p *wenBondPinsV2, q, r *wenBondAccountV2) { p.Owner = solana.PublicKey{8} },
		func(p *wenBondPinsV2, q, r *wenBondAccountV2) { q.Owner = solana.PublicKey{8} },
		func(p *wenBondPinsV2, q, r *wenBondAccountV2) { r.Key = solana.PublicKey{8} },
		func(p *wenBondPinsV2, q, r *wenBondAccountV2) { q.Executable = true },
		func(p *wenBondPinsV2, q, r *wenBondAccountV2) { r.Executable = true },
	} {
		p, q, r, n, now := bondClaimFixtureV2(t)
		change(&p, &q, &r)
		if _, e := inspectWENBondClaimV2(p, q, r, n, now, 1); e == nil {
			t.Fatal("substituted record admitted")
		}
	}
}
func TestWENBondClaimV2MessageAndExport(t *testing.T) {
	p, q, r, n, now := bondClaimFixtureV2(t)
	c, e := inspectWENBondClaimV2(p, q, r, n, now, 1)
	if e != nil {
		t.Fatal(e)
	}
	bh := solana.Hash{7}
	m, e := compileWENBondClaimV2(p, c, bh, 10, 20, nil)
	if e != nil {
		t.Fatal(e)
	}
	if e = verifyWENBondClaimMessageV2(m, p, c, bh, 10, 20); e != nil {
		t.Fatal(e)
	}
	if _, e = compileWENBondClaimV2(p, c, bh, 11, 20, m); e != nil {
		t.Fatal(e)
	}
	if _, e = compileWENBondClaimV2(p, c, bh, 20, 20, m); e == nil {
		t.Fatal("expired lifetime admitted")
	}
	changed := p
	changed.Destination = solana.PublicKey{8}
	if _, e = compileWENBondClaimV2(changed, c, bh, 11, 20, m); e == nil {
		t.Fatal("changed destination reused review")
	}
	for i := range m {
		copy := append([]byte(nil), m...)
		copy[i] ^= 1
		if e = verifyWENBondClaimMessageV2(copy, p, c, bh, 10, 20); e == nil {
			t.Fatalf("changed message byte %d accepted", i)
		}
	}
	if path := os.Getenv("WEN_BOND_CLAIM_VECTOR"); path != "" {
		account := func(a wenBondAccountV2) map[string]any {
			return map[string]any{"address": hex.EncodeToString(a.Key[:]), "owner": hex.EncodeToString(a.Owner[:]), "executable": a.Executable, "data": hex.EncodeToString(a.Data)}
		}
		v := map[string]any{"schema": "wen.fased.bond-claim-vector.v2", "identity": map[string]string{"program": p.Program.String(), "sale": p.Sale.String(), "policy": p.Policy.String(), "buyer": p.Owner.String(), "destination": p.Destination.String()}, "quote": account(q), "receipt": account(r), "nonce": "17", "now": "590401", "minimumNet": "1", "blockhash": bh.String(), "message": hex.EncodeToString(m), "availableGross": "5000000000000", "availableNet": "4850000000000", "transferFee": "150000000000"}
		raw, e := json.MarshalIndent(v, "", "  ")
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(path, append(raw, '\n'), 0600); e != nil {
			t.Fatal(e)
		}
	}
}

func bondClaimFundingFixtureV2(t *testing.T, p wenBondPinsV2, c wenBondClaimV2) (*signerWENBTCAccountV1, *signerWENBTCAccountV1, *signerWENBTCAccountV1, *signerWENBTCAccountV1) {
	t.Helper()
	ix, e := buildWENBondClaimV2(p, c)
	if e != nil {
		t.Fatal(e)
	}
	a := ix.Accounts()
	mk := a[5].PublicKey
	rec := func(k, owner solana.PublicKey, n int) *signerWENBTCAccountV1 {
		return &signerWENBTCAccountV1{Address: k, Owner: owner, Slot: 1000, Data: make([]byte, n)}
	}
	collector, _, _ := wenBondKeyV2(p.Program, "wen-sat-collector-v1", p.Sale[:])
	m := rec(mk, solana.Token2022ProgramID, 278)
	d := m.Data
	binary.LittleEndian.PutUint32(d, 1)
	copy(d[4:], p.Sale[:])
	d[44] = 11
	d[45] = 1
	d[165] = 1
	binary.LittleEndian.PutUint16(d[166:], 1)
	binary.LittleEndian.PutUint16(d[168:], 108)
	copy(d[202:], collector[:])
	for _, o := range []int{72, 90} {
		binary.LittleEndian.PutUint64(d[170+o+8:], ^uint64(0))
		binary.LittleEndian.PutUint16(d[170+o+16:], 300)
	}
	token := func(k, owner solana.PublicKey) *signerWENBTCAccountV1 {
		x := rec(k, solana.Token2022ProgramID, 178)
		copy(x.Data, mk[:])
		copy(x.Data[32:], owner[:])
		x.Data[108] = 1
		x.Data[165] = 2
		binary.LittleEndian.PutUint16(x.Data[166:], 2)
		binary.LittleEndian.PutUint16(x.Data[168:], 8)
		return x
	}
	book, b, _ := wenBondKeyV2(p.Program, "wen-sat-promises-v1", p.Sale[:])
	pr := rec(book, p.Program, 128)
	copy(pr.Data, []byte("WENPROM1"))
	copy(pr.Data[8:], []byte{1, 0, 0, b})
	copy(pr.Data[16:], p.Sale[:])
	copy(pr.Data[48:], mk[:])
	binary.LittleEndian.PutUint64(pr.Data[80:], c.Gross)
	return pr, m, token(a[6].PublicKey, c.Receipt), token(p.Destination, p.Owner)
}
func TestWENBondClaimV2PromiseAndTokenFunding(t *testing.T) {
	p, q, r, n, now := bondClaimFixtureV2(t)
	c, e := inspectWENBondClaimV2(p, q, r, n, now, 1)
	if e != nil {
		t.Fatal(e)
	}
	for _, mode := range []string{"valid", "missing", "slot", "promise", "promise-overflow", "supply-overflow", "custody-overflow", "destination-overflow", "withheld-overflow", "wrong-owner", "fee-policy"} {
		pr, m, cu, d := bondClaimFundingFixtureV2(t, p, c)
		switch mode {
		case "missing":
			pr = nil
		case "slot":
			d.Slot--
		case "promise":
			binary.LittleEndian.PutUint64(pr.Data[80:], c.AvailableGross-1)
		case "promise-overflow":
			binary.LittleEndian.PutUint64(pr.Data[88:], ^uint64(0))
			binary.LittleEndian.PutUint64(pr.Data[96:], 1)
		case "supply-overflow":
			binary.LittleEndian.PutUint64(m.Data[36:], ^uint64(0))
		case "custody-overflow":
			binary.LittleEndian.PutUint64(cu.Data[64:], ^uint64(0))
		case "destination-overflow":
			binary.LittleEndian.PutUint64(d.Data[64:], ^uint64(0))
		case "withheld-overflow":
			binary.LittleEndian.PutUint64(d.Data[170:], ^uint64(0))
		case "wrong-owner":
			d.Data[32] ^= 1
		case "fee-policy":
			m.Data[276] ^= 1
		}
		e = validateWENBondClaimFundingV2(p, c, 1000, pr, m, cu, d)
		if (mode == "valid") != (e == nil) {
			t.Fatalf("%s: %v", mode, e)
		}
	}
}
func TestWENBondClaimV2SyntheticAllowanceAndOverflow(t *testing.T) {
	p, q, r, n, now := bondClaimFixtureV2(t)
	set := func(d []byte, at int, v uint64) { binary.LittleEndian.PutUint64(d[at:], v) }
	set(q.Data, 328, 1)
	set(q.Data, 336, 100)
	set(q.Data, 344, 376000000)
	set(r.Data, 192, 376000000)
	set(r.Data, 208, 176000000)
	h := sha256.Sum256(q.Data)
	copy(r.Data[144:], h[:])
	if _, e := inspectWENBondClaimV2(p, q, r, n, now, 1); e != nil {
		t.Fatal(e)
	}
	p.Profile = "mainnet"
	if _, e := inspectWENBondClaimV2(p, q, r, n, now, 1); e == nil {
		t.Fatal("synthetic allowance admitted for mainnet")
	}
	p.Profile = "devnet-synthetic-fixture"
	set(q.Data, 216, ^uint64(0))
	set(q.Data, 224, 1)
	h = sha256.Sum256(q.Data)
	copy(r.Data[144:], h[:])
	if _, e := inspectWENBondClaimV2(p, q, r, n, now, 1); e == nil {
		t.Fatal("overflowed quote accounting admitted")
	}
}
