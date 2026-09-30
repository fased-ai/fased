package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math/big"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type wenMarketReadPolicyV1 struct {
	Successor, Venue                        signerWENBTCPinsV1
	Creator, PricePolicy                    solana.PublicKey
	PoolOpen, ReferenceEnd, MaxDeviationBPS uint64
	SyntheticReference                      bool
}
type wenMarketBuySnapshotV1 struct {
	Quote              wenMarketBuyQuoteV1
	Now                uint64
	StateSHA256        string
	SyntheticReference bool
}

func wenMarketQuoteCashV1(a *signerWENBTCAccountV1, key, mint, owner solana.PublicKey, slot, minimum uint64) (uint64, error) {
	if a == nil || a.Address != key || a.Owner != solana.TokenProgramID || a.Executable || a.Slot != slot || len(a.Data) != 165 {
		return 0, errors.New("Buy cash custody rejected")
	}
	d := a.Data
	if !bytes.Equal(d[:32], mint[:]) || !bytes.Equal(d[32:64], owner[:]) || d[108] != 1 || binary.LittleEndian.Uint32(d[72:]) != 0 || binary.LittleEndian.Uint32(d[109:]) != 0 || binary.LittleEndian.Uint32(d[129:]) != 0 || binary.LittleEndian.Uint64(d[64:]) < minimum {
		return 0, errors.New("Buy cash authority/balance rejected")
	}
	return binary.LittleEndian.Uint64(d[64:]), nil
}

// Integer-only counterpart of the shared pool quote. Inputs are usable reserves
// after accrued venue fees, not reported aggregate balances or a provider quote.
func quoteWENMarketBuyV1(target, sat, cash uint64) (input, net, sale, effectiveSale uint64, err error) {
	bad := errors.New("Buy liquidity arithmetic rejected")
	if target == 0 || sat == 0 || cash == 0 {
		err = bad
		return
	}
	_, transferNet := wenSatTransferV1(target)
	fee := new(big.Int).Mul(new(big.Int).SetUint64(transferNet), big.NewInt(2500))
	fee.Add(fee, big.NewInt(999999))
	fee.Div(fee, big.NewInt(1000000))
	if !fee.IsUint64() || transferNet <= fee.Uint64() || sat > ^uint64(0)-transferNet {
		err = bad
		return
	}
	effectiveSale = transferNet - fee.Uint64()
	saleValue := new(big.Int).Mul(new(big.Int).SetUint64(effectiveSale), new(big.Int).SetUint64(cash))
	saleValue.Div(saleValue, new(big.Int).SetUint64(sat+effectiveSale))
	sale = saleValue.Uint64()
	if sale == 0 {
		err = bad
		return
	}
	lo, hi := target, ^uint64(0)
	_, maxNet := wenSatTransferV1(hi)
	if maxNet < target {
		err = bad
		return
	}
	for lo < hi {
		mid := lo + (hi-lo)/2
		_, n := wenSatTransferV1(mid)
		if n >= target {
			hi = mid
		} else {
			lo = mid + 1
		}
	}
	gross := lo
	if gross >= sat {
		err = bad
		return
	}
	required := new(big.Int).Mul(new(big.Int).SetUint64(gross), new(big.Int).SetUint64(cash))
	denom := new(big.Int).SetUint64(sat - gross)
	required.Add(required, new(big.Int).Sub(denom, big.NewInt(1)))
	required.Div(required, denom)
	if !required.IsUint64() {
		err = bad
		return
	}
	received := func(n uint64) uint64 {
		f := new(big.Int).Mul(new(big.Int).SetUint64(n), big.NewInt(2500))
		f.Add(f, big.NewInt(999999))
		f.Div(f, big.NewInt(1000000))
		if n <= f.Uint64() {
			return 0
		}
		after := n - f.Uint64()
		out := new(big.Int).Mul(new(big.Int).SetUint64(after), new(big.Int).SetUint64(sat))
		out.Div(out, new(big.Int).SetUint64(cash+after))
		return out.Uint64()
	}
	lo, hi = required.Uint64(), ^uint64(0)-cash
	if lo > hi || received(hi) < gross {
		err = bad
		return
	}
	for lo < hi {
		mid := lo + (hi-lo)/2
		if received(mid) >= gross {
			hi = mid
		} else {
			lo = mid + 1
		}
	}
	input = lo
	_, net = wenSatTransferV1(received(lo))
	return
}

func marketPriceReferenceV1(a *signerWENBTCAccountV1, p wenMarketBuyPinsV1, policy wenMarketReadPolicyV1, slot, now uint64) (*big.Int, error) {
	bad := errors.New("Buy price reference rejected")
	if policy.ReferenceEnd < 1800 || now < policy.ReferenceEnd || now-policy.ReferenceEnd > 300 {
		return nil, bad
	}
	derive := func(seed string, time uint64) (solana.PublicKey, byte, error) {
		b := make([]byte, 8)
		binary.LittleEndian.PutUint64(b, time)
		return solana.FindProgramAddress([][]byte{[]byte(seed), p.Economy[:], b}, p.Program)
	}
	address, bump, e := derive("wen-price-reference-v1", policy.ReferenceEnd)
	if e != nil {
		return nil, e
	}
	if a == nil || a.Address != address || a.Owner != p.Program || a.Executable || a.Slot != slot || len(a.Data) != 208 {
		return nil, bad
	}
	d := a.Data
	start := binary.LittleEndian.Uint64(d[112:])
	if !bytes.Equal(d[:8], []byte("WENREF01")) || d[8] != 1 || d[9] != 0 || d[10] != 0 || d[11] != bump || !bytes.Equal(d[12:16], make([]byte, 4)) || start != policy.ReferenceEnd-1800 || binary.LittleEndian.Uint64(d[120:]) != policy.ReferenceEnd || !bytes.Equal(d[16:48], p.Economy[:]) || !bytes.Equal(d[48:80], p.Pool[:]) || !bytes.Equal(d[80:112], policy.PricePolicy[:]) {
		return nil, bad
	}
	first, _, e := derive("wen-price-checkpoint-v1", start)
	if e != nil {
		return nil, e
	}
	last, _, e := derive("wen-price-checkpoint-v1", policy.ReferenceEnd)
	if e != nil {
		return nil, e
	}
	if !bytes.Equal(d[144:176], first[:]) || !bytes.Equal(d[176:208], last[:]) {
		return nil, bad
	}
	value := new(big.Int).SetUint64(binary.LittleEndian.Uint64(d[136:]))
	value.Lsh(value, 64)
	value.Add(value, new(big.Int).SetUint64(binary.LittleEndian.Uint64(d[128:])))
	if value.Sign() == 0 {
		return nil, bad
	}
	return value, nil
}

// Protected host pins and endpoint only. One finalized batch authenticates both
// installed programs, usable pool reserves, mint policy and owner custody.
// No caller-provided quote or price can cross this reader; it neither signs nor
// installs admission. Missing history is not replaced with zero obligations.
func readWENMarketBuyV1(ctx context.Context, c signerWENBTCReadRPCV1, p wenMarketBuyPinsV1, policy wenMarketReadPolicyV1, l wenMarketBuyLimitsV1) (wenMarketBuySnapshotV1, error) {
	var out wenMarketBuySnapshotV1
	bad := errors.New("Buy finalized custody read rejected")
	if c == nil || policy.Successor.ProgramID != p.Program.String() || policy.Successor.Genesis == "" || policy.Successor.Genesis != policy.Venue.Genesis || policy.Successor.DeploymentSlot == 0 || policy.Venue.DeploymentSlot == 0 || l.MinimumSlot < policy.Successor.DeploymentSlot || l.MinimumSlot < policy.Venue.DeploymentSlot || l.ExpiresSlot <= l.MinimumSlot || l.ExpiresSlot-l.MinimumSlot > 32 || l.RequestedNet == 0 || policy.MaxDeviationBPS > 500 || policy.ReferenceEnd < 1800 || policy.Creator.IsZero() || policy.PricePolicy.IsZero() {
		return out, bad
	}
	if (p.Profile == "mainnet" && policy.Successor.Genesis != "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") || (p.Profile == "devnet-synthetic-fixture" && policy.Successor.Genesis != "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") {
		return out, bad
	}
	// Derive canonical profile accounts before reading any arbitrary address.
	dummy := wenMarketBuyQuoteV1{Pool: p.Pool, RequestedNet: l.RequestedNet, InputCash: 1, QuotedNet: l.RequestedNet, Slot: l.MinimumSlot, ReferenceSlot: l.MinimumSlot}
	probe := l
	probe.SlippageBPS = 0
	probe.MaxCash = 1
	probe.MinimumNet = l.RequestedNet
	ix, e := buildWENMarketBuyV1(p, dummy, probe)
	if e != nil {
		return out, e
	}
	venue := ix.ProgramID()
	if policy.Venue.ProgramID != venue.String() {
		return out, bad
	}
	if policy.SyntheticReference && (p.Profile != "devnet-synthetic-fixture" || policy.Successor.Genesis != "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" || p.Program.String() != "GC4KiyyAkr3Gwp5pQXQMqoDinrRYtQq9BwZU2cVHDMaQ" || p.Economy.String() != "5fNcJggJb3rSRpkXhiHmfh1sTr45QLmDfVniFzg6LykH") {
		return out, bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	genesis, e := c.GetGenesisHash(ctx)
	if e != nil {
		return out, e
	}
	if genesis.String() != policy.Successor.Genesis {
		return out, bad
	}
	derive := func(program solana.PublicKey, seed string, rest ...[]byte) (solana.PublicKey, error) {
		key, _, e := solana.FindProgramAddress(append([][]byte{[]byte(seed)}, rest...), program)
		return key, e
	}
	metas := ix.Accounts()
	mint, cashMint, authority := metas[11].PublicKey, metas[10].PublicKey, metas[1].PublicKey
	collector, e := derive(p.Program, "wen-sat-collector-v1", p.Economy[:])
	if e != nil {
		return out, e
	}
	loader := solana.BPFLoaderUpgradeableProgramID
	pd, _, e := solana.FindProgramAddress([][]byte{p.Program[:]}, loader)
	if e != nil {
		return out, e
	}
	vd, _, e := solana.FindProgramAddress([][]byte{venue[:]}, loader)
	if e != nil {
		return out, e
	}
	end := make([]byte, 8)
	binary.LittleEndian.PutUint64(end, policy.ReferenceEnd)
	ref, e := derive(p.Program, "wen-price-reference-v1", p.Economy[:], end)
	if e != nil {
		return out, e
	}
	keys := []solana.PublicKey{p.Pool, p.Config, metas[7].PublicKey, metas[6].PublicKey, mint, cashMint, ref, p.AssetAccount, p.CashAccount, p.Program, pd, venue, vd, solana.SysVarClockPubkey}
	seen := map[solana.PublicKey]bool{}
	for _, key := range keys {
		if seen[key] {
			return out, bad
		}
		seen[key] = true
	}
	page, e := c.GetMultipleAccountsWithOpts(ctx, keys, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &l.MinimumSlot})
	if e != nil {
		return out, e
	}
	if page == nil || len(page.Value) != len(keys) || page.Context.Slot < l.MinimumSlot || page.Context.Slot >= l.ExpiresSlot {
		return out, bad
	}
	slot := page.Context.Slot
	accounts := make([]*signerWENBTCAccountV1, len(keys))
	state := sha256.New()
	for i, a := range page.Value {
		if a == nil && i == 6 && policy.SyntheticReference {
			continue
		}
		if a == nil || a.Data == nil {
			return out, bad
		}
		accounts[i] = &signerWENBTCAccountV1{Address: keys[i], Owner: a.Owner, Slot: slot, Executable: a.Executable, Data: append([]byte(nil), a.Data.GetBinary()...)}
		if i == 13 {
			continue
		} // Clock advances; it is checked separately, not custody state.
		state.Write(keys[i][:])
		state.Write(a.Owner[:])
		if a.Executable {
			state.Write([]byte{1})
		} else {
			state.Write([]byte{0})
		}
		b := make([]byte, 8)
		binary.LittleEndian.PutUint64(b, a.Lamports)
		state.Write(b)
		binary.LittleEndian.PutUint64(b, uint64(len(accounts[i].Data)))
		state.Write(b)
		state.Write(accounts[i].Data)
	}
	if e = verifyWENBTCDeploymentV1(policy.Successor, slot, accounts[9], accounts[10]); e != nil {
		return out, e
	}
	if e = verifyWENBTCDeploymentV1(policy.Venue, slot, accounts[11], accounts[12]); e != nil {
		return out, e
	}
	clock := accounts[13]
	if clock.Owner != solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111") || clock.Executable || len(clock.Data) != 40 || binary.LittleEndian.Uint64(clock.Data) != slot {
		return out, bad
	}
	now := binary.LittleEndian.Uint64(clock.Data[32:])
	if now > 1<<63-1 {
		return out, bad
	}
	pool, config := accounts[0], accounts[1]
	poolTag := sha256.Sum256([]byte("account:PoolState"))
	configTag := sha256.Sum256([]byte("account:AmmConfig"))
	if pool.Owner != venue || config.Owner != venue || pool.Executable || config.Executable || len(pool.Data) != 637 || len(config.Data) != 236 || !bytes.Equal(pool.Data[:8], poolTag[:8]) || !bytes.Equal(config.Data[:8], configTag[:8]) {
		return out, bad
	}
	d, cd := pool.Data, config.Data
	u := func(d []byte, at int) uint64 { return binary.LittleEndian.Uint64(d[at:]) }
	expectedCreator, e := derive(p.Program, "wen-pool-creator-v1", p.Economy[:])
	if e != nil || policy.Creator != expectedCreator {
		return out, bad
	}
	first, second := mint, cashMint
	firstVault, secondVault := keys[2], keys[3]
	firstProgram, secondProgram := solana.Token2022ProgramID, solana.TokenProgramID
	side := 0
	if bytes.Compare(first[:], second[:]) > 0 {
		first, second = second, first
		firstVault, secondVault = secondVault, firstVault
		firstProgram, secondProgram = secondProgram, firstProgram
		side = 1
	}
	lp, e := derive(venue, "pool_lp_mint", p.Pool[:])
	if e != nil {
		return out, e
	}
	expected := []solana.PublicKey{p.Config, policy.Creator, firstVault, secondVault, lp, first, second, firstProgram, secondProgram, metas[12].PublicKey}
	for i, key := range expected {
		if !bytes.Equal(d[8+i*32:40+i*32], key[:]) {
			return out, bad
		}
	}
	_, bump, e := solana.FindProgramAddress([][]byte{[]byte("vault_and_lp_mint_auth_seed")}, venue)
	if e != nil {
		return out, e
	}
	creatorFee := uint64(0)
	if p.Profile == "devnet-synthetic-fixture" {
		creatorFee = 2500
	}
	if u(cd, 12) != 2500 || u(cd, 108) != creatorFee || u(cd, 20) > 1000000 || u(cd, 28) > 1000000-u(cd, 20) || d[328] != bump || d[329]&4 != 0 || d[329]&^byte(7) != 0 || d[390] != 0 || u(d, 373) != policy.PoolOpen || now < policy.PoolOpen {
		return out, bad
	}
	if e = validateWENSatMintV1(accounts[4], mint, p.Economy, collector, slot); e != nil {
		return out, e
	}
	sat, _, e := validateWENSatCustodyV1(accounts[2], keys[2], mint, authority, slot, 1)
	if e != nil {
		return out, e
	}
	cash, e := wenMarketQuoteCashV1(accounts[3], keys[3], cashMint, authority, slot, 1)
	if e != nil {
		return out, e
	}
	usd := accounts[5]
	if usd.Owner != solana.TokenProgramID || usd.Executable || len(usd.Data) != 82 || usd.Data[44] != 6 || usd.Data[45] != 1 {
		return out, bad
	}
	accrued := func(index int) (uint64, error) {
		var sum uint64
		for _, at := range []int{341, 357, 397} {
			n := u(d, at+index*8)
			if n > ^uint64(0)-sum {
				return 0, bad
			}
			sum += n
		}
		return sum, nil
	}
	satFee, e := accrued(side)
	if e != nil || sat <= satFee {
		return out, bad
	}
	cashFee, e := accrued(1 - side)
	if e != nil || cash <= cashFee {
		return out, bad
	}
	input, net, sale, effective, e := quoteWENMarketBuyV1(l.RequestedNet, sat-satFee, cash-cashFee)
	if e != nil {
		return out, e
	}
	price := new(big.Int)
	if policy.SyntheticReference {
		price.SetUint64(31)
		price.Lsh(price, 32)
		price.Div(price, big.NewInt(10))
	} else {
		price, e = marketPriceReferenceV1(accounts[6], p, policy, slot, now)
		if e != nil {
			return out, e
		}
	}
	product := new(big.Int).Mul(price, new(big.Int).SetUint64(effective))
	if product.BitLen() > 128 {
		return out, bad
	}
	divisor := new(big.Int).Lsh(big.NewInt(100000), 32)
	baseline := new(big.Int).Div(product, divisor)
	if baseline.Sign() == 0 {
		return out, bad
	}
	delta := new(big.Int).Sub(new(big.Int).SetUint64(sale), baseline)
	delta.Abs(delta)
	delta.Mul(delta, big.NewInt(10000))
	bound := new(big.Int).Mul(baseline, new(big.Int).SetUint64(policy.MaxDeviationBPS))
	if delta.Cmp(bound) > 0 {
		return out, bad
	}
	if _, _, e = validateWENSatCustodyV1(accounts[7], p.AssetAccount, mint, p.Owner, slot, 0); e != nil {
		return out, e
	}
	if _, e = wenMarketQuoteCashV1(accounts[8], p.CashAccount, cashMint, p.Owner, slot, input); e != nil {
		return out, e
	}
	reference, e := c.GetSlot(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return out, e
	}
	if reference < slot || reference-slot > 32 || reference >= l.ExpiresSlot {
		return out, bad
	}
	after, e := c.GetGenesisHash(ctx)
	if e != nil {
		return out, e
	}
	if after != genesis {
		return out, bad
	}
	q := wenMarketBuyQuoteV1{Pool: p.Pool, RequestedNet: l.RequestedNet, InputCash: input, QuotedNet: net, Slot: slot, ReferenceSlot: reference}
	if _, e = buildWENMarketBuyV1(p, q, l); e != nil {
		return out, e
	}
	if e = ctx.Err(); e != nil {
		return out, e
	}
	return wenMarketBuySnapshotV1{Quote: q, Now: now, StateSHA256: hex.EncodeToString(state.Sum(nil)), SyntheticReference: policy.SyntheticReference}, nil
}
