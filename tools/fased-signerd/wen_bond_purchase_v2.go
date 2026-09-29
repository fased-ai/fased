package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	bin "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
)

// Internal compiler inputs must be supplied by protected preparation. This
// contract alone does not admit a route, authenticate funding, or enable signing.
type wenBondPurchasePinsV2 struct {
	Bond                                                         wenBondPinsV2
	Source                                                       solana.PublicKey
	PolicyBytes                                                  []byte
	IndexCount, DomainIndex, AssetIndex, MaximumCash, MinimumNet uint64
}

func buildWENBondPurchaseV2(p wenBondPurchasePinsV2, quote wenBondAccountV2, nonce, now uint64, route signerWENBTCRouteV1) ([]solana.Instruction, error) {
	bad := errors.New("successor atomic Bond purchase rejected")
	b := p.Bond
	q, e := inspectWENBondQuoteV2(b, quote, nonce)
	if e != nil {
		return nil, e
	}
	tracked := quote.Data[10] == 2
	if quote.Data[10] != 0 && !tracked || !tracked && p.AssetIndex != 0 || tracked && p.AssetIndex == ^uint64(0) {
		return nil, bad
	}
	if len(p.PolicyBytes) != 96 || (string(p.PolicyBytes[:8]) != "WENACT01" && string(p.PolicyBytes[:8]) != "WENACT03") || sha256.Sum256(p.PolicyBytes) != [32]byte(b.Policy) || p.Source.IsZero() || b.Program.IsZero() || b.Sale.IsZero() || b.Owner.IsZero() || q.DirectCosts != 0 || q.Cash <= q.RequiredUSD || q.Cash > q.MaximumCash || p.MaximumCash < q.Cash || p.MinimumNet == 0 || p.MinimumNet > q.Net || now < q.Created || now >= q.Expires || now/28800 != q.End/28800 || p.IndexCount == ^uint64(0) {
		return nil, bad
	}
	if string(p.PolicyBytes[:8]) == "WENACT03" && binary.LittleEndian.Uint64(p.PolicyBytes[72:80]) < 86400 {
		return nil, bad
	}
	usdc := solana.MustPublicKeyFromBase58("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
	btc := solana.MustPublicKeyFromBase58("cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij")
	router := solana.MustPublicKeyFromBase58("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")
	oracle := solana.MustPublicKeyFromBase58("pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou")
	cpmm := solana.MustPublicKeyFromBase58("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C")
	if b.Profile == "devnet-synthetic-fixture" {
		usdc = solana.MustPublicKeyFromBase58("DE8BhmX7qJGzjUSHnYYEXjAcnr86aVUCNquoyEqYsENc")
		btc = solana.MustPublicKeyFromBase58("GjcBddmBe8EHZQXqaf9qHsxovSqZ4ZpNE8Huc25sziTv")
		router = solana.MustPublicKeyFromBase58("G7q2jKVjXZCFXLVeJU9AXKe8HNpH5VKxYJo4jdbCzEh6")
		oracle = router
		cpmm = solana.MustPublicKeyFromBase58("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb")
	}
	if !bytes.Equal(p.PolicyBytes[8:40], usdc[:]) || route.Program != router {
		return nil, bad
	}
	derive := func(program solana.PublicKey, seeds ...[]byte) solana.PublicKey {
		k, _, err := solana.FindProgramAddress(seeds, program)
		if err != nil {
			e = err
		}
		return k
	}
	own := func(seed string, rest ...[]byte) solana.PublicKey {
		return derive(b.Program, append([][]byte{[]byte(seed)}, rest...)...)
	}
	sale := b.Sale[:]
	config := solana.PublicKeyFromBytes(p.PolicyBytes[40:72])
	mint := own("wen-sat-mint-v1", sale)
	first, second := mint, usdc
	if bytes.Compare(first[:], second[:]) > 0 {
		first, second = second, first
	}
	pool := derive(cpmm, []byte("pool"), config[:], first[:], second[:])
	lp := derive(cpmm, []byte("pool_lp_mint"), pool[:])
	creator := own("wen-pool-creator-v1", sale)
	lpAccount := derive(solana.SPLAssociatedTokenAccountProgramID, creator[:], solana.TokenProgramID[:], lp[:])
	paid := own("wen-paid-primary-v1", sale, q.Key[:])
	reserve := own("wen-economy-btc-v2", sale)
	feed := func(h string) solana.PublicKey {
		raw, _ := hex.DecodeString(h)
		return derive(oracle, []byte{0, 0}, raw)
	}
	order := []solana.PublicKey{b.Owner, b.Sale, own("wen-activation-v1", sale), own("wen-reserve-ledger-v1", sale), own("wen-allocation-v1", sale, []byte{0}), pool, config, derive(cpmm, []byte("pool_vault"), pool[:], mint[:]), derive(cpmm, []byte("pool_vault"), pool[:], usdc[:]), mint, usdc, lp, lpAccount, q.Key, solana.SystemProgramID, own("wen-sat-promises-v1", sale), own("wen-price-reference-v1", sale, wenBondU64V2(q.End)), reserve, p.Source, paid, own("wen-paid-release-v1", sale), own("wen-issuance-epoch-v1", sale, wenBondU64V2(q.End/28800)), solana.TokenProgramID, own("wen-subscription-custody-v1", paid[:]), solana.Token2022ProgramID, btc, feed("eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a"), feed("2817d7bfe5c64b8ea956e9a26f573ef64e72e4d7891f2d6af9bcc93f7aff9a97")}
	seen := map[solana.PublicKey]bool{}
	for _, k := range order {
		if seen[k] || k == b.Program {
			return nil, bad
		}
		seen[k] = true
	}
	d, a := route.Data, route.Accounts
	if len(d) < 36 || len(d) > 44 || len(a) < 14 || len(a) > 64 {
		return nil, bad
	}
	tag := sha256.Sum256([]byte("global:shared_accounts_route"))
	legs := binary.LittleEndian.Uint32(d[9:13])
	at := 13 + 4*int(legs)
	if !bytes.Equal(d[:8], tag[:8]) || d[8] >= 8 || legs < 1 || legs > 3 || len(d) != at+19 {
		return nil, bad
	}
	for i := 0; i < int(legs); i++ {
		if !bytes.Equal(d[13+4*i:17+4*i], []byte{26, 100, byte(i), byte(i + 1)}) {
			return nil, bad
		}
	}
	quoted := binary.LittleEndian.Uint64(d[at+8:])
	slip := binary.LittleEndian.Uint16(d[at+16:])
	if slip > 50 {
		return nil, bad
	}
	minimum := wenBondN(quoted)
	minimum.Mul(minimum, wenBondN(uint64(10000-slip))).Quo(minimum, wenBondN(10000))
	if binary.LittleEndian.Uint64(d[at:]) != q.Cash-q.RequiredUSD || quoted == 0 || slip > 50 || d[at+18] != 0 || minimum.Sign() == 0 || minimum.Cmp(wenBondN(q.RequiredBTC)) < 0 {
		return nil, bad
	}
	authority := own("wen-btc-swap-v1", q.Key[:])
	cash := own("wen-bond-swap-cash-v1", q.Key[:])
	asset := own("wen-bond-swap-btc-v1", q.Key[:])
	protected := map[solana.PublicKey]bool{authority: true, cash: true, asset: true, usdc: true, btc: true}
	keys := make([]solana.PublicKey, len(a))
	for i, m := range a {
		k, err := solana.PublicKeyFromBase58(m.Pubkey)
		if err != nil || k.String() != m.Pubkey {
			return nil, bad
		}
		keys[i] = k
	}
	fixed := []solana.PublicKey{solana.TokenProgramID, derive(router, []byte("authority"), []byte{d[8]}), authority, cash, keys[4], keys[5], asset, usdc, btc, router, router, derive(router, []byte("__event_authority")), router}
	for i, m := range a {
		k := keys[i]
		if k == b.Program || m.IsSigner != (i == 2) {
			return nil, bad
		}
		if i < 13 {
			if k != fixed[i] || m.IsWritable != (i >= 3 && i <= 6) {
				return nil, bad
			}
		} else if protected[k] {
			return nil, bad
		}
		for j, core := range order {
			if core == k && j != 10 && j != 22 && j != 25 && !(j >= 26 && !m.IsWritable && !m.IsSigner) {
				return nil, bad
			}
		}
	}
	if keys[4] == keys[5] {
		return nil, bad
	}
	for _, i := range []int{4, 5} {
		if protected[keys[i]] || keys[i] == router || keys[i] == solana.TokenProgramID {
			return nil, bad
		}
	}
	for _, k := range order {
		if k == router {
			return nil, bad
		}
	}
	root := own("wen-bond-owner-v1", sale, b.Owner[:])
	page := own("wen-bond-page-v1", root[:], wenBondU64V2(p.IndexCount/8))
	domain := own("wen-accounting-domain-v1", sale, []byte{2})
	entry := own("wen-accounting-source-v1", domain[:], root[:])
	domainPage := own("wen-accounting-index-v1", domain[:], wenBondU64V2(p.DomainIndex))
	for _, k := range keys {
		seen[k] = true
	}
	seen[router] = true
	for _, k := range []solana.PublicKey{root, page, domain, entry, domainPage} {
		if seen[k] || k == b.Program {
			return nil, bad
		}
		seen[k] = true
	}
	var assetTail []solana.PublicKey
	if tracked {
		asset := own("wen-bond-asset-v1", paid[:])
		assetDomain := own("wen-accounting-domain-v1", sale, []byte{7})
		assetEntry := own("wen-accounting-source-v1", assetDomain[:], asset[:])
		assetPage := own("wen-accounting-index-v1", assetDomain[:], wenBondU64V2(p.AssetIndex))
		assetTail = []solana.PublicKey{asset, assetDomain, assetEntry, assetPage}
		for _, k := range assetTail {
			if seen[k] || k == b.Program {
				return nil, bad
			}
			seen[k] = true
		}
	}
	if e != nil {
		return nil, e
	}
	opcode := byte(191)
	if tracked {
		opcode = 220
	}
	data := append([]byte{opcode}, p.PolicyBytes...)
	for _, n := range []uint64{nonce, q.End, q.Gross, q.Expires, q.DirectCosts, q.BondCosts, q.Waiting, q.Cash} {
		data = append(data, wenBondU64V2(n)...)
	}
	data = append(data, byte(len(a)))
	for _, m := range a {
		var role byte
		if m.IsSigner {
			role |= 1
		}
		if m.IsWritable {
			role |= 2
		}
		data = append(data, role)
	}
	data = append(data, d...)
	metas := make([]*solana.AccountMeta, 0, len(order)+len(a)+6)
	for i, k := range order {
		w := i == 0 || i == 3 || i == 4 || i == 15 || i == 17 || i == 18 || i == 19 || i == 20 || i == 21 || i == 23
		metas = append(metas, &solana.AccountMeta{PublicKey: k, IsSigner: i == 0, IsWritable: w})
	}
	for i, m := range a {
		metas = append(metas, &solana.AccountMeta{PublicKey: keys[i], IsWritable: m.IsWritable})
	}
	metas = append(metas, &solana.AccountMeta{PublicKey: router})
	for _, k := range []solana.PublicKey{domain, entry, domainPage, root, page} {
		metas = append(metas, &solana.AccountMeta{PublicKey: k, IsWritable: true})
	}
	for _, k := range assetTail {
		metas = append(metas, &solana.AccountMeta{PublicKey: k, IsWritable: true})
	}
	registryKeys := []solana.PublicKey{b.Owner, b.Sale, order[3], order[4], own("wen-budget-governance-v1", sale), own("wen-cash-liabilities-v1", sale), solana.SystemProgramID}
	registry := make([]*solana.AccountMeta, len(registryKeys))
	unique := map[solana.PublicKey]bool{}
	for i, k := range registryKeys {
		if k == b.Program || unique[k] {
			return nil, bad
		}
		unique[k] = true
		registry[i] = &solana.AccountMeta{PublicKey: k, IsSigner: i == 0, IsWritable: i == 0 || i == 5}
	}
	if e != nil {
		return nil, e
	}
	return []solana.Instruction{solana.NewInstruction(b.Program, metas, data), solana.NewInstruction(b.Program, registry, []byte{203, 0})}, nil
}

func compileWENBondPurchaseV2(p wenBondPurchasePinsV2, quote wenBondAccountV2, nonce, now uint64, route signerWENBTCRouteV1, blockhash solana.Hash, units uint32, pins []signerWENBTCLookupPinV1, snapshots []*signerWENBTCAccountV1, life signerWENBTCMessageLifeV1, previous []byte) ([]byte, error) {
	if units == 0 || units > 1400000 || blockhash == (solana.Hash{}) || life.currentHeight >= life.lastValidHeight {
		return nil, errors.New("Bond purchase lifetime/budget rejected")
	}
	ix, e := buildWENBondPurchaseV2(p, quote, nonce, now, route)
	if e != nil {
		return nil, e
	}
	tables, e := verifiedWENBTCLookupTablesV1(pins, snapshots, life)
	if e != nil {
		return nil, e
	}
	if quote.Data[10] == 2 {
		covered := map[solana.PublicKey]bool{}
		for _, table := range tables {
			for _, key := range table {
				covered[key] = true
			}
		}
		for _, account := range ix[0].Accounts()[len(ix[0].Accounts())-4:] {
			if !covered[account.PublicKey] {
				return nil, errors.New("Bond asset lookup missing")
			}
		}
	}
	budget := make([]byte, 5)
	budget[0] = 2
	binary.LittleEndian.PutUint32(budget[1:], units)
	ix = append([]solana.Instruction{solana.NewInstruction(solana.ComputeBudget, nil, budget)}, ix...)
	tx, e := solana.NewTransaction(ix, blockhash, solana.TransactionPayer(p.Bond.Owner), solana.TransactionAddressTables(tables))
	if e != nil {
		return nil, e
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	raw, e := tx.Message.MarshalBinary()
	if e != nil {
		return nil, e
	}
	if len(raw)+65 > 1232 || previous != nil && !bytes.Equal(previous, raw) {
		return nil, errors.New("Bond purchase packet changed or oversized")
	}
	if e = verifyWENBondPurchaseMessageV2(raw, p, quote, nonce, now, route, blockhash, units, pins, snapshots, life); e != nil {
		return nil, e
	}
	return raw, nil
}
func verifyWENBondPurchaseMessageV2(raw []byte, p wenBondPurchasePinsV2, quote wenBondAccountV2, nonce, now uint64, route signerWENBTCRouteV1, blockhash solana.Hash, units uint32, pins []signerWENBTCLookupPinV1, snapshots []*signerWENBTCAccountV1, life signerWENBTCMessageLifeV1) error {
	bad := errors.New("atomic Bond purchase message rejected")
	if len(raw) == 0 || len(raw)+65 > 1232 || units == 0 || units > 1400000 || blockhash == (solana.Hash{}) || life.currentHeight >= life.lastValidHeight {
		return bad
	}
	expected, e := buildWENBondPurchaseV2(p, quote, nonce, now, route)
	if e != nil {
		return e
	}
	tables, e := verifiedWENBTCLookupTablesV1(pins, snapshots, life)
	if e != nil {
		return e
	}
	var m solana.Message
	if m.UnmarshalWithDecoder(bin.NewBinDecoder(raw)) != nil {
		return bad
	}
	wire, e := m.MarshalBinary()
	if e != nil || !bytes.Equal(wire, raw) {
		return bad
	}
	if m.GetVersion() != solana.MessageVersionV0 || m.Header.NumRequiredSignatures != 1 || m.Header.NumReadonlySignedAccounts != 0 || len(m.AccountKeys) == 0 || m.AccountKeys[0] != p.Bond.Owner || m.RecentBlockhash != blockhash || len(m.Instructions) != 3 {
		return bad
	}
	staticCount := len(m.AccountKeys)
	seen := map[solana.PublicKey]bool{}
	for _, l := range m.GetAddressTableLookups() {
		t, ok := tables[l.AccountKey]
		if !ok || seen[l.AccountKey] {
			return bad
		}
		seen[l.AccountKey] = true
		for _, indices := range []solana.Uint8SliceAsNum{l.WritableIndexes, l.ReadonlyIndexes} {
			for _, n := range indices {
				if int(n) >= len(t) {
					return bad
				}
			}
		}
	}
	if len(seen) == 0 || m.SetAddressTables(tables) != nil || m.ResolveLookups() != nil {
		return bad
	}
	budget := make([]byte, 5)
	budget[0] = 2
	binary.LittleEndian.PutUint32(budget[1:], units)
	expected = append([]solana.Instruction{solana.NewInstruction(solana.ComputeBudget, nil, budget)}, expected...)
	type role struct{ signer, writable bool }
	roles := map[solana.PublicKey]role{p.Bond.Owner: {true, true}}
	for _, ix := range expected {
		roles[ix.ProgramID()] = roles[ix.ProgramID()]
		for _, a := range ix.Accounts() {
			old := roles[a.PublicKey]
			roles[a.PublicKey] = role{old.signer || a.IsSigner, old.writable || a.IsWritable}
		}
	}
	readonlyStatic := 0
	for _, k := range m.AccountKeys[1:staticCount] {
		if !roles[k].writable {
			readonlyStatic++
		}
	}
	if int(m.Header.NumReadonlyUnsignedAccounts) != readonlyStatic {
		return bad
	}
	if len(roles) != len(m.AccountKeys) {
		return bad
	}
	seen = map[solana.PublicKey]bool{}
	for _, k := range m.AccountKeys {
		r, ok := roles[k]
		w, err := m.IsWritable(k)
		if !ok || seen[k] || err != nil || w != r.writable || m.IsSigner(k) != r.signer {
			return bad
		}
		seen[k] = true
	}
	for n, ix := range expected {
		v := m.Instructions[n]
		d, _ := ix.Data()
		if int(v.ProgramIDIndex) >= len(m.AccountKeys) || m.AccountKeys[v.ProgramIDIndex] != ix.ProgramID() || !bytes.Equal(v.Data, d) || len(v.Accounts) != len(ix.Accounts()) {
			return bad
		}
		for i, at := range v.Accounts {
			if int(at) >= len(m.AccountKeys) || m.AccountKeys[at] != ix.Accounts()[i].PublicKey {
				return bad
			}
		}
	}
	return nil
}
