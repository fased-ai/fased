package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math/big"

	bin "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
)

// Internal successor contract only. Inputs must come from the protected owner
// profile and an authenticated finalized reader. This does not enable signing,
// authenticate custody/deployment, or accept legacy subscription quotes.
type wenBondPinsV2 struct {
	Profile                                   string
	Program, Sale, Policy, Owner, Destination solana.PublicKey
}
type wenBondAccountV2 struct {
	Key, Owner solana.PublicKey
	Executable bool
	Data       []byte
}
type wenBondClaimV2 struct {
	Quote, Receipt                                                                  solana.PublicKey
	Nonce, Start, End, Cash, USDBacking, BTCCapital, Gross                          uint64
	ClaimedGross, ClaimedNet, ClaimedFee, AvailableGross, AvailableNet, TransferFee uint64
	QuoteSHA256                                                                     [32]byte
}

func wenBondKeyV2(program solana.PublicKey, seed string, rest ...[]byte) (solana.PublicKey, uint8, error) {
	return solana.FindProgramAddress(append([][]byte{[]byte(seed)}, rest...), program)
}
func wenBondU64V2(n uint64) []byte {
	b := make([]byte, 8)
	binary.LittleEndian.PutUint64(b, n)
	return b
}
func wenBondCeilV2(a, b *big.Int) *big.Int {
	return new(big.Int).Quo(new(big.Int).Add(a, new(big.Int).Sub(b, big.NewInt(1))), b)
}
func wenBondN(n uint64) *big.Int { return new(big.Int).SetUint64(n) }

type wenBondQuoteV2 struct {
	Key                                                                                                             solana.PublicKey
	Created, Expires, Gross, Net, End, Cash, MaximumCash, RequiredUSD, RequiredBTC, DirectCosts, BondCosts, Waiting uint64
}

func inspectWENBondQuoteV2(p wenBondPinsV2, quote wenBondAccountV2, nonce uint64) (wenBondQuoteV2, error) {
	var out wenBondQuoteV2
	bad := errors.New("successor Bond quote rejected")
	if p.Profile != "mainnet" && p.Profile != "devnet-synthetic-fixture" {
		return out, bad
	}
	q, qb, e := wenBondKeyV2(p.Program, "wen-bond-net-quote-v1", p.Sale[:], p.Owner[:], wenBondU64V2(nonce))
	if e != nil {
		return out, e
	}
	d := quote.Data
	if quote.Key != q || quote.Owner != p.Program || quote.Executable || len(d) != 352 || string(d[:8]) != "WENBNQ01" || d[8] != 1 || d[9] != 0 || (d[10] != 0 && d[10] != 2) || d[11] != qb || !bytes.Equal(d[12:16], make([]byte, 4)) {
		return out, bad
	}
	keyAt := func(data []byte, at int, k solana.PublicKey) bool { return bytes.Equal(data[at:at+32], k[:]) }
	if !keyAt(d, 16, p.Sale) || !keyAt(d, 48, p.Policy) || !keyAt(d, 80, p.Owner) {
		return out, bad
	}
	u := func(at int) uint64 { return binary.LittleEndian.Uint64(d[at:]) }
	created, expires, gross, net, end := u(152), u(160), u(168), u(176), u(248)
	total := new(big.Int).Add(wenBondN(u(216)), wenBondN(u(224)))
	fee := wenBondCeilV2(new(big.Int).Mul(wenBondN(gross), big.NewInt(3)), big.NewInt(100))
	if u(144) != nonce || end < 1800 || end > ^uint64(0)-300 || created < end || created > end+300 || expires <= created || expires > end+300 || gross == 0 || net == 0 || fee.Cmp(wenBondN(gross)) >= 0 || new(big.Int).Sub(wenBondN(gross), fee).Cmp(wenBondN(net)) != 0 || u(240) < net || u(208) == 0 || u(184) == 0 || total.Sign() == 0 || new(big.Int).Add(total, wenBondN(gross)).BitLen() > 64 {
		return out, bad
	}
	reserve, _, e := wenBondKeyV2(p.Program, "wen-economy-btc-v2", p.Sale[:])
	if e != nil {
		return out, e
	}
	reference, _, e := wenBondKeyV2(p.Program, "wen-price-reference-v1", p.Sale[:], wenBondU64V2(end))
	if e != nil {
		return out, e
	}
	expectedBTC := wenBondCeilV2(new(big.Int).Mul(wenBondN(u(312)), wenBondN(gross)), total)
	if !keyAt(d, 112, reference) || !keyAt(d, 280, reserve) || expectedBTC.Cmp(wenBondN(u(320))) != 0 || new(big.Int).Add(wenBondN(u(312)), expectedBTC).BitLen() > 64 {
		return out, bad
	}
	ratio := wenBondCeilV2(new(big.Int).Mul(wenBondN(u(208)), wenBondN(gross)), total)
	repair := new(big.Int).Sub(wenBondCeilV2(new(big.Int).Add(total, wenBondN(gross)), big.NewInt(100000)), wenBondN(u(208)))
	if repair.Cmp(ratio) > 0 {
		ratio = repair
	}
	direct := new(big.Int).Add(wenBondN(u(184)), wenBondN(u(256)))
	price := new(big.Int).Sub(new(big.Int).Quo(new(big.Int).Mul(direct, big.NewInt(9500)), big.NewInt(10000)), wenBondN(u(264)))
	wait := new(big.Int).Sub(new(big.Int).Sub(new(big.Int).Sub(direct, wenBondN(u(264))), wenBondN(u(272))), big.NewInt(1))
	if wait.Cmp(price) < 0 {
		price = wait
	}
	if direct.BitLen() > 64 || new(big.Int).Add(wenBondN(u(208)), ratio).BitLen() > 64 || ratio.Cmp(wenBondN(u(200))) != 0 || price.Sign() <= 0 || price.Cmp(ratio) < 0 || price.Cmp(wenBondN(u(192))) != 0 {
		return out, bad
	}
	cash := new(big.Int).Quo(new(big.Int).Mul(wenBondN(u(184)), big.NewInt(9500)), big.NewInt(10000))
	switch u(328) {
	case 0:
		if u(336) != 0 || u(344) != 0 {
			return out, bad
		}
	case 1:
		if p.Profile != "devnet-synthetic-fixture" {
			return out, bad
		}
		fixture := wenBondCeilV2(new(big.Int).Mul(wenBondN(u(184)), big.NewInt(9400)), big.NewInt(10000))
		if u(336) != 100 || fixture.Cmp(wenBondN(u(344))) != 0 || fixture.Cmp(cash) > 0 {
			return out, bad
		}
		cash = fixture
	default:
		return out, bad
	}

	return wenBondQuoteV2{q, created, expires, gross, net, end, cash.Uint64(), u(192), u(200), u(320), u(256), u(264), u(272)}, nil
}

// Recovery validates immutable quote terms at creation, not at today's time.
// Expiry blocks a new purchase, never recovery or an already accepted claim.
func inspectWENBondClaimV2(p wenBondPinsV2, quote, receipt wenBondAccountV2, nonce, now, minimumNet uint64) (wenBondClaimV2, error) {
	if minimumNet == 0 {
		return wenBondClaimV2{}, errors.New("successor Bond claim requires net minimum")
	}
	c, e := inspectWENBondRightsV2(p, quote, receipt, nonce, now)
	if e != nil {
		return c, e
	}
	if c.AvailableNet < minimumNet {
		return wenBondClaimV2{}, errors.New("successor Bond claim below net minimum")
	}
	return c, nil
}

// Accepted-rights inspection is also valid before vesting and after full claim.
// It cannot compile a claim with zero availability or authorize execution.
func inspectWENBondRightsV2(p wenBondPinsV2, quote, receipt wenBondAccountV2, nonce, now uint64) (wenBondClaimV2, error) {
	var out wenBondClaimV2
	bad := errors.New("successor Bond claim records rejected")
	if p.Profile != "mainnet" && p.Profile != "devnet-synthetic-fixture" {
		return out, bad
	}
	for _, k := range []solana.PublicKey{p.Program, p.Sale, p.Policy, p.Owner, p.Destination} {
		if k.IsZero() {
			return out, bad
		}
	}
	validated, e := inspectWENBondQuoteV2(p, quote, nonce)
	if e != nil {
		return out, e
	}
	q := validated.Key
	r, rb, e := wenBondKeyV2(p.Program, "wen-paid-primary-v1", p.Sale[:], q[:])
	if e != nil {
		return out, e
	}
	d, v := quote.Data, receipt.Data
	if receipt.Key != r || receipt.Owner != p.Program || receipt.Executable || len(v) != 288 || string(v[:8]) != "WENPAID1" || !bytes.Equal(v[8:12], []byte{2, 1, 0, rb}) || !bytes.Equal(v[12:16], make([]byte, 4)) || !bytes.Equal(v[280:], make([]byte, 8)) {
		return out, bad
	}
	keyAt := func(data []byte, at int, k solana.PublicKey) bool { return bytes.Equal(data[at:at+32], k[:]) }
	if !keyAt(v, 16, p.Sale) || !keyAt(v, 48, p.Policy) || !keyAt(v, 80, q) || !keyAt(v, 112, p.Owner) {
		return out, bad
	}
	u := func(at int) uint64 { return binary.LittleEndian.Uint64(d[at:]) }
	created, expires, gross, cash := validated.Created, validated.Expires, validated.Gross, wenBondN(validated.Cash)
	h := sha256.Sum256(d)
	if !bytes.Equal(v[144:176], h[:]) {
		return out, bad
	}
	rv := func(at int) uint64 { return binary.LittleEndian.Uint64(v[at:]) }
	start, finish := rv(184), rv(248)
	claimed := new(big.Int).Add(wenBondN(rv(264)), wenBondN(rv(272)))
	capital := new(big.Int).Add(wenBondN(rv(200)), wenBondN(rv(208)))
	if start < created || start >= expires || rv(176) != start/28800 || start > ^uint64(0)-604800 || finish != start+604800 || now < start || rv(200) == 0 || rv(208) == 0 || capital.Cmp(wenBondN(rv(192))) != 0 || rv(216) != 0 || u(256) != 0 || cash.Cmp(wenBondN(rv(192))) != 0 || cash.Cmp(wenBondN(u(192))) > 0 || rv(200) != u(200) || rv(224) != gross || rv(232) != 0 || rv(240) != 0 || rv(256) > gross || claimed.Cmp(wenBondN(rv(256))) != 0 {
		return out, bad
	}
	elapsed := now - start
	if elapsed > 604800 {
		elapsed = 604800
	}
	vested := new(big.Int).Quo(new(big.Int).Mul(wenBondN(gross), wenBondN(elapsed)), big.NewInt(604800))
	if vested.Cmp(wenBondN(rv(256))) < 0 {
		return out, bad
	}
	available := new(big.Int).Sub(vested, wenBondN(rv(256))).Uint64()
	f := wenBondCeilV2(new(big.Int).Mul(wenBondN(available), big.NewInt(3)), big.NewInt(100)).Uint64()
	return wenBondClaimV2{q, r, nonce, start, finish, rv(192), rv(200), rv(208), gross, rv(256), rv(264), rv(272), available, available - f, f, h}, nil
}

// Opcode 192 carries only nonce: minimumNet is a pre-sign admission check, not
// an on-chain price limit. A refreshed coherent read and simulation are required
// before signing; concurrent claims cannot reuse this preview.
func buildWENBondClaimV2(p wenBondPinsV2, c wenBondClaimV2) (solana.Instruction, error) {
	q, _, e := wenBondKeyV2(p.Program, "wen-bond-net-quote-v1", p.Sale[:], p.Owner[:], wenBondU64V2(c.Nonce))
	if e != nil {
		return nil, e
	}
	r, _, e := wenBondKeyV2(p.Program, "wen-paid-primary-v1", p.Sale[:], q[:])
	if e != nil {
		return nil, e
	}
	if r != c.Receipt || q != c.Quote || c.AvailableNet == 0 || c.AvailableGross < c.AvailableNet || c.AvailableGross-c.AvailableNet != c.TransferFee {
		return nil, errors.New("Bond claim preparation changed")
	}
	derive := func(seed string, rest ...[]byte) solana.PublicKey {
		k, _, err := wenBondKeyV2(p.Program, seed, rest...)
		if err != nil {
			e = err
		}
		return k
	}
	source := derive("wen-bond-owner-v1", p.Sale[:], p.Owner[:])
	domain := derive("wen-accounting-domain-v1", p.Sale[:], []byte{2})
	keys := []solana.PublicKey{p.Owner, p.Sale, derive("wen-activation-v1", p.Sale[:]), r, derive("wen-sat-promises-v1", p.Sale[:]), derive("wen-sat-mint-v1", p.Sale[:]), derive("wen-subscription-custody-v1", r[:]), p.Destination, solana.Token2022ProgramID, domain, derive("wen-accounting-source-v1", domain[:], source[:])}
	if e != nil {
		return nil, e
	}
	seen := map[solana.PublicKey]bool{}
	metas := make([]*solana.AccountMeta, len(keys))
	for i, k := range keys {
		if k.IsZero() || k == p.Program || seen[k] {
			return nil, errors.New("Bond claim account aliases")
		}
		seen[k] = true
		metas[i] = &solana.AccountMeta{PublicKey: k, IsSigner: i == 0, IsWritable: i >= 3 && i <= 7 || i >= 9}
	}
	return solana.NewInstruction(p.Program, metas, append([]byte{192}, wenBondU64V2(c.Nonce)...)), nil
}
func compileWENBondClaimV2(p wenBondPinsV2, c wenBondClaimV2, blockhash solana.Hash, height, lastValid uint64, previous []byte) ([]byte, error) {
	if blockhash == (solana.Hash{}) || height >= lastValid {
		return nil, errors.New("Bond claim lifetime rejected")
	}
	ix, e := buildWENBondClaimV2(p, c)
	if e != nil {
		return nil, e
	}
	tx, e := solana.NewTransaction([]solana.Instruction{ix}, blockhash, solana.TransactionPayer(p.Owner))
	if e != nil {
		return nil, e
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	raw, e := tx.Message.MarshalBinary()
	if e != nil {
		return nil, e
	}
	if len(raw)+65 > 1232 || previous != nil && !bytes.Equal(raw, previous) {
		return nil, errors.New("Bond claim message changed")
	}
	return raw, nil
}
func verifyWENBondClaimMessageV2(raw []byte, p wenBondPinsV2, c wenBondClaimV2, blockhash solana.Hash, height, lastValid uint64) error {
	bad := errors.New("Bond claim message rejected")
	if len(raw) == 0 || len(raw)+65 > 1232 || blockhash == (solana.Hash{}) || height >= lastValid {
		return bad
	}
	ix, e := buildWENBondClaimV2(p, c)
	if e != nil {
		return e
	}
	var m solana.Message
	if m.UnmarshalWithDecoder(bin.NewBinDecoder(raw)) != nil {
		return bad
	}
	encoded, e := m.MarshalBinary()
	if e != nil || !bytes.Equal(raw, encoded) {
		return bad
	}
	if m.GetVersion() != solana.MessageVersionV0 || m.Header.NumRequiredSignatures != 1 || m.Header.NumReadonlySignedAccounts != 0 || len(m.GetAddressTableLookups()) != 0 || len(m.Instructions) != 1 || len(m.AccountKeys) != 12 || m.AccountKeys[0] != p.Owner || m.RecentBlockhash != blockhash {
		return bad
	}
	i := m.Instructions[0]
	d, _ := ix.Data()
	if int(i.ProgramIDIndex) >= len(m.AccountKeys) || m.AccountKeys[i.ProgramIDIndex] != p.Program || !bytes.Equal(i.Data, d) || len(i.Accounts) != 11 {
		return bad
	}
	seen := map[solana.PublicKey]bool{}
	for _, k := range m.AccountKeys {
		if seen[k] {
			return bad
		}
		seen[k] = true
	}
	w, e := m.IsWritable(p.Program)
	if e != nil || w || m.IsSigner(p.Program) {
		return bad
	}
	for j, a := range ix.Accounts() {
		if int(i.Accounts[j]) >= len(m.AccountKeys) || m.AccountKeys[i.Accounts[j]] != a.PublicKey {
			return bad
		}
		w, e = m.IsWritable(a.PublicKey)
		if e != nil || w != (a.IsWritable || a.PublicKey == p.Owner) || m.IsSigner(a.PublicKey) != a.IsSigner {
			return bad
		}
	}
	return nil
}

// All accounts must come from one finalized snapshot. This is the token/promise
// funding portion only: launch activation, deployed bytes, Clock and RPC identity
// must additionally be authenticated by the eventual protected reader.
func validateWENBondClaimFundingV2(p wenBondPinsV2, c wenBondClaimV2, slot uint64, promises, mint, custody, destination *signerWENBTCAccountV1) error {
	bad := errors.New("Bond claim token/promise funding rejected")
	ix, e := buildWENBondClaimV2(p, c)
	if e != nil {
		return e
	}
	a := ix.Accounts()
	mintKey := a[5].PublicKey
	collector, _, e := wenBondKeyV2(p.Program, "wen-sat-collector-v1", p.Sale[:])
	if e != nil {
		return e
	}
	if e = validateWENSatMintV1(mint, mintKey, p.Sale, collector, slot); e != nil {
		return e
	}
	book, b, e := wenBondKeyV2(p.Program, "wen-sat-promises-v1", p.Sale[:])
	if e != nil {
		return e
	}
	if promises == nil || promises.Address != book || promises.Owner != p.Program || promises.Executable || promises.Slot != slot || len(promises.Data) != 128 {
		return bad
	}
	d := promises.Data
	if string(d[:8]) != "WENPROM1" || !bytes.Equal(d[8:12], []byte{1, 0, 0, b}) || !bytes.Equal(d[12:16], make([]byte, 4)) || !bytes.Equal(d[16:48], p.Sale[:]) || !bytes.Equal(d[48:80], mintKey[:]) || !bytes.Equal(d[104:], make([]byte, 24)) {
		return bad
	}
	authorized, minted, cancelled := binary.LittleEndian.Uint64(d[80:]), binary.LittleEndian.Uint64(d[88:]), binary.LittleEndian.Uint64(d[96:])
	used := new(big.Int).Add(wenBondN(minted), wenBondN(cancelled))
	if used.Cmp(wenBondN(authorized)) > 0 || new(big.Int).Sub(wenBondN(authorized), used).Cmp(wenBondN(c.AvailableGross)) < 0 {
		return bad
	}
	amount, _, e := validateWENSatCustodyV1(custody, a[6].PublicKey, mintKey, c.Receipt, slot, 0)
	if e != nil {
		return e
	}
	dest, withheld, e := validateWENSatCustodyV1(destination, p.Destination, mintKey, p.Owner, slot, 0)
	if e != nil {
		return e
	}
	supply := binary.LittleEndian.Uint64(mint.Data[36:])
	if supply > ^uint64(0)-c.AvailableGross || amount > ^uint64(0)-c.AvailableGross || dest > ^uint64(0)-c.AvailableNet || withheld > ^uint64(0)-c.TransferFee {
		return bad
	}
	return nil
}
