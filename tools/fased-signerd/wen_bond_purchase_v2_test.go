package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	bin "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"testing"
)

func bondPurchaseFixtureV2(t *testing.T) (wenBondPurchasePinsV2, wenBondAccountV2, uint64, signerWENBTCRouteV1) {
	t.Helper()
	b, q, _, n, _ := bondClaimFixtureV2(t)
	policy := make([]byte, 96)
	copy(policy, []byte("WENACT01"))
	usdc := solana.MustPublicKeyFromBase58("DE8BhmX7qJGzjUSHnYYEXjAcnr86aVUCNquoyEqYsENc")
	copy(policy[8:], usdc[:])
	config := solana.PublicKey{9}
	copy(policy[40:], config[:])
	b.Policy = solana.PublicKey(sha256.Sum256(policy))
	copy(q.Data[48:], b.Policy[:])
	p := wenBondPurchasePinsV2{Bond: b, Source: solana.PublicKey{10}, PolicyBytes: policy, IndexCount: 9, DomainIndex: 2, MaximumCash: 380000000, MinimumNet: 9700000000000}
	router := solana.MustPublicKeyFromBase58("G7q2jKVjXZCFXLVeJU9AXKe8HNpH5VKxYJo4jdbCzEh6")
	btc := solana.MustPublicKeyFromBase58("GjcBddmBe8EHZQXqaf9qHsxovSqZ4ZpNE8Huc25sziTv")
	derive := func(program solana.PublicKey, seed string, rest ...[]byte) solana.PublicKey {
		k, _, e := wenBondKeyV2(program, seed, rest...)
		if e != nil {
			t.Fatal(e)
		}
		return k
	}
	keys := []solana.PublicKey{solana.TokenProgramID, derive(router, "authority", []byte{0}), derive(b.Program, "wen-btc-swap-v1", q.Key[:]), derive(b.Program, "wen-bond-swap-cash-v1", q.Key[:]), {11}, {12}, derive(b.Program, "wen-bond-swap-btc-v1", q.Key[:]), usdc, btc, router, router, derive(router, "__event_authority"), router, {13}}
	route := signerWENBTCRouteV1{Program: router, Data: make([]byte, 36), Accounts: make([]signerTypedAccountV2, len(keys))}
	tag := sha256.Sum256([]byte("global:shared_accounts_route"))
	copy(route.Data, tag[:8])
	binary.LittleEndian.PutUint32(route.Data[9:], 1)
	copy(route.Data[13:], []byte{26, 100, 0, 1})
	binary.LittleEndian.PutUint64(route.Data[17:], 180000000)
	binary.LittleEndian.PutUint64(route.Data[25:], 400000)
	for i, k := range keys {
		route.Accounts[i] = signerTypedAccountV2{Pubkey: k.String(), IsSigner: i == 2, IsWritable: i >= 3 && i <= 6}
	}
	return p, q, n, route
}
func TestWENBondPurchaseV2AtomicContract(t *testing.T) {
	p, q, n, r := bondPurchaseFixtureV2(t)
	ix, e := buildWENBondPurchaseV2(p, q, n, 288001, r)
	if e != nil {
		t.Fatal(e)
	}
	if len(ix) != 2 {
		t.Fatal("registry absent")
	}
	d, _ := ix[1].Data()
	if hex.EncodeToString(d) != "cb00" || len(ix[1].Accounts()) != 7 {
		t.Fatal("registry changed")
	}
	for _, mode := range []string{"expired", "cash-limit", "net-limit", "policy", "route-amount", "route-fee", "route-slippage", "route-output", "route-signer", "route-custody", "route-tail", "index"} {
		t.Run(mode, func(t *testing.T) {
			p, q, n, r := bondPurchaseFixtureV2(t)
			now := uint64(288001)
			switch mode {
			case "expired":
				now = 288300
			case "cash-limit":
				p.MaximumCash--
			case "net-limit":
				p.MinimumNet++
			case "policy":
				p.PolicyBytes[95] ^= 1
			case "route-amount":
				r.Data[17] ^= 1
			case "route-fee":
				r.Data[35] = 1
			case "route-slippage":
				binary.LittleEndian.PutUint16(r.Data[33:], 65535)
			case "route-output":
				binary.LittleEndian.PutUint64(r.Data[25:], 399999)
			case "route-signer":
				r.Accounts[13].IsSigner = true
			case "route-custody":
				r.Accounts[3].Pubkey = p.Source.String()
			case "route-tail":
				r.Accounts[13].Pubkey = r.Accounts[7].Pubkey
			case "index":
				p.IndexCount = ^uint64(0)
			}
			if _, e := buildWENBondPurchaseV2(p, q, n, now, r); e == nil {
				t.Fatal("invalid purchase admitted")
			}
		})
	}
	trackedPins, trackedQuote, trackedNonce, trackedRoute := bondPurchaseFixtureV2(t)
	trackedQuote.Data[10] = 2
	trackedPins.AssetIndex = 3
	tracked, e := buildWENBondPurchaseV2(trackedPins, trackedQuote, trackedNonce, 288001, trackedRoute)
	if e != nil {
		t.Fatal(e)
	}
	trackedData, _ := tracked[0].Data()
	if trackedData[0] != 220 || len(tracked[0].Accounts()) != len(ix[0].Accounts())+4 {
		t.Fatal("q2 opcode or asset tail missing")
	}
	paid := tracked[0].Accounts()[19].PublicKey
	asset, _, _ := wenBondKeyV2(trackedPins.Bond.Program, "wen-bond-asset-v1", paid[:])
	assetDomain, _, _ := wenBondKeyV2(trackedPins.Bond.Program, "wen-accounting-domain-v1", trackedPins.Bond.Sale[:], []byte{7})
	assetEntry, _, _ := wenBondKeyV2(trackedPins.Bond.Program, "wen-accounting-source-v1", assetDomain[:], asset[:])
	assetPage, _, _ := wenBondKeyV2(trackedPins.Bond.Program, "wen-accounting-index-v1", assetDomain[:], wenBondU64V2(3))
	wantTail := []solana.PublicKey{asset, assetDomain, assetEntry, assetPage}
	for i, want := range wantTail {
		if got := tracked[0].Accounts()[len(tracked[0].Accounts())-4+i]; got.PublicKey != want || !got.IsWritable || got.IsSigner {
			t.Fatalf("q2 asset account %d changed", i)
		}
	}
	trackedPins.AssetIndex = ^uint64(0)
	if _, e := buildWENBondPurchaseV2(trackedPins, trackedQuote, trackedNonce, 288001, trackedRoute); e == nil {
		t.Fatal("unbounded q2 asset index admitted")
	}
	// A single admitted table covers all non-signer instruction accounts.
	table := solana.PublicKey{20}
	keys := solana.PublicKeySlice{}
	seen := map[solana.PublicKey]bool{}
	for _, v := range ix {
		for _, a := range v.Accounts() {
			if a.PublicKey != p.Bond.Owner && !seen[a.PublicKey] {
				seen[a.PublicKey] = true
				keys = append(keys, a.PublicKey)
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
	snapshots := []*signerWENBTCAccountV1{{Address: table, Owner: solana.MustPublicKeyFromBase58("AddressLookupTab1e1111111111111111111111111"), Slot: 1000, Data: data}}
	pins := []signerWENBTCLookupPinV1{{key: table, digest: wenHashV1(data)}}
	life := signerWENBTCMessageLifeV1{10, 20, 1000, 32}
	bh := solana.Hash{7}
	raw, e := compileWENBondPurchaseV2(p, q, n, 288001, r, bh, 500000, pins, snapshots, life, nil)
	if e != nil {
		t.Fatal(e)
	}
	for i := range raw {
		changed := append([]byte(nil), raw...)
		changed[i] ^= 1
		if verifyWENBondPurchaseMessageV2(changed, p, q, n, 288001, r, bh, 500000, pins, snapshots, life) == nil {
			t.Fatalf("changed byte %d admitted", i)
		}
	}
	if _, e = compileWENBondPurchaseV2(p, q, n, 288001, r, bh, 500000, pins, snapshots, life, raw); e != nil {
		t.Fatal(e)
	}
	source := &signerWENBTCAccountV1{Address: p.Source, Owner: solana.TokenProgramID, Slot: 1000, Data: make([]byte, 165)}
	copy(source.Data, p.PolicyBytes[8:40])
	copy(source.Data[32:], p.Bond.Owner[:])
	source.Data[108] = 1
	binary.LittleEndian.PutUint64(source.Data[64:], 380000000)
	prepared, e := prepareWENBondPurchaseMessageV2(p, q, source, n, 288001, r, bh, 500000, pins, snapshots, life)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = prepared.revalidate(q, source, 288002, 11, snapshots); e != nil {
		t.Fatal(e)
	}
	for _, mode := range []string{"balance", "delegate", "mint", "owner", "slot", "quote-slot", "stale", "changed-source", "expired"} {
		t.Run("funding-"+mode, func(t *testing.T) {
			v := *source
			v.Data = append([]byte(nil), source.Data...)
			quote := q
			quote.Data = append([]byte(nil), q.Data...)
			now := uint64(288002)
			switch mode {
			case "balance":
				binary.LittleEndian.PutUint64(v.Data[64:], 379999999)
			case "delegate":
				v.Data[72] = 1
			case "mint":
				v.Data[0] ^= 1
			case "owner":
				v.Data[32] ^= 1
			case "slot":
				v.Slot = 999
			case "quote-slot":
				binary.LittleEndian.PutUint64(quote.Data[232:], 1001)
			case "stale":
				v.Slot = 1033
			case "changed-source":
				binary.LittleEndian.PutUint64(v.Data[64:], 380000001)
			case "expired":
				now = 288300
			}
			if mode != "changed-source" {
				if _, e := prepareWENBondPurchaseMessageV2(p, quote, &v, n, now, r, bh, 500000, pins, snapshots, life); e == nil {
					t.Fatal("invalid initial funding admitted")
				}
			}
			if _, e := prepared.revalidate(quote, &v, now, 11, snapshots); e == nil {
				t.Fatal("changed or unfunded preparation admitted")
			}
		})
	}
	// Mutating the caller's route/policy cannot alter an already owned packet.
	savedPolicy := p.PolicyBytes[95]
	savedRoute := r.Data[17]
	p.PolicyBytes[95] ^= 1
	r.Data[17] ^= 1
	if _, e = prepared.revalidate(q, source, 288002, 11, snapshots); e != nil {
		t.Fatal("caller mutation altered retained preparation", e)
	}
	p.PolicyBytes[95] = savedPolicy
	r.Data[17] = savedRoute
	for _, mode := range []string{"expiry", "compute", "lookup", "changed-blockhash", "missing-registry"} {
		t.Run(mode, func(t *testing.T) {
			modifiedLife := life
			modifiedUnits := uint32(500000)
			modifiedHash := bh
			switch mode {
			case "expiry":
				modifiedLife.currentHeight = 20
			case "compute":
				modifiedUnits = 1400001
			case "changed-blockhash":
				modifiedHash = solana.Hash{8}
			case "lookup":
				badSnapshot := *snapshots[0]
				badSnapshot.Data = append([]byte(nil), badSnapshot.Data...)
				badSnapshot.Data[56] ^= 1
				if _, e := compileWENBondPurchaseV2(p, q, n, 288001, r, bh, 500000, pins, []*signerWENBTCAccountV1{&badSnapshot}, life, nil); e == nil {
					t.Fatal("substituted lookup admitted")
				}
				return
			case "missing-registry":
				var m solana.Message
				if e := m.UnmarshalWithDecoder(bin.NewBinDecoder(raw)); e != nil {
					t.Fatal(e)
				}
				m.Instructions = m.Instructions[:2]
				wire, e := m.MarshalBinary()
				if e != nil {
					t.Fatal(e)
				}
				if verifyWENBondPurchaseMessageV2(wire, p, q, n, 288001, r, bh, 500000, pins, snapshots, life) == nil {
					t.Fatal("missing registry admitted")
				}
				return
			}
			if _, e := compileWENBondPurchaseV2(p, q, n, 288001, r, modifiedHash, modifiedUnits, pins, snapshots, modifiedLife, raw); e == nil {
				t.Fatal("changed review admitted")
			}
		})
	}
	if path := os.Getenv("WEN_BOND_PURCHASE_VECTOR"); path != "" {
		instructions := []any{}
		for _, v := range ix {
			d, _ := v.Data()
			accounts := []any{}
			for _, a := range v.Accounts() {
				accounts = append(accounts, map[string]any{"address": a.PublicKey.String(), "isSigner": a.IsSigner, "isWritable": a.IsWritable})
			}
			instructions = append(instructions, map[string]any{"programAddress": v.ProgramID().String(), "data": hex.EncodeToString(d), "accounts": accounts})
		}
		accounts := []any{}
		for _, a := range r.Accounts {
			accounts = append(accounts, map[string]any{"address": a.Pubkey, "isSigner": a.IsSigner, "isWritable": a.IsWritable})
		}
		v := map[string]any{"schema": "wen.fased.bond-purchase-vector.v2", "identity": map[string]string{"program": p.Bond.Program.String(), "sale": p.Bond.Sale.String(), "policy": p.Bond.Policy.String(), "buyer": p.Bond.Owner.String(), "source": p.Source.String()}, "quote": map[string]any{"address": hex.EncodeToString(q.Key[:]), "owner": hex.EncodeToString(q.Owner[:]), "executable": false, "data": hex.EncodeToString(q.Data)}, "policyBytes": hex.EncodeToString(p.PolicyBytes), "route": map[string]any{"programAddress": r.Program.String(), "data": hex.EncodeToString(r.Data), "accounts": accounts}, "instructions": instructions, "message": hex.EncodeToString(raw), "blockhash": bh.String(), "table": map[string]any{"key": table.String(), "keys": keys, "data": hex.EncodeToString(data)}}
		encoded, e := json.MarshalIndent(v, "", "  ")
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(path, append(encoded, '\n'), 0600); e != nil {
			t.Fatal(e)
		}
	}
}

func TestWENBondPurchaseRollingPolicyBinding(t *testing.T) {
	p, q, nonce, route := bondPurchaseFixtureV2(t)
	copy(p.PolicyBytes[:8], "WENACT03")
	binary.LittleEndian.PutUint64(p.PolicyBytes[72:80], 86400)
	p.Bond.Policy = solana.PublicKey(sha256.Sum256(p.PolicyBytes))
	copy(q.Data[48:], p.Bond.Policy[:])
	if _, err := buildWENBondPurchaseV2(p, q, nonce, 288001, route); err != nil {
		t.Fatalf("rolling policy rejected: %v", err)
	}
	binary.LittleEndian.PutUint64(p.PolicyBytes[72:80], 86399)
	p.Bond.Policy = solana.PublicKey(sha256.Sum256(p.PolicyBytes))
	copy(q.Data[48:], p.Bond.Policy[:])
	if _, err := buildWENBondPurchaseV2(p, q, nonce, 288001, route); err == nil {
		t.Fatal("rolling policy with sub-24-hour setup delay accepted")
	}
	binary.LittleEndian.PutUint64(p.PolicyBytes[72:80], 86400)
	p.Bond.Policy = solana.PublicKey(sha256.Sum256(p.PolicyBytes))
	copy(q.Data[48:], p.Bond.Policy[:])
	p.PolicyBytes[95] ^= 1
	if _, err := buildWENBondPurchaseV2(p, q, nonce, 288001, route); err == nil {
		t.Fatal("unbound rolling policy accepted")
	}
}
