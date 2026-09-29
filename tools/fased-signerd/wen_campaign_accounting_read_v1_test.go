package main

import (
	"context"
	"encoding/binary"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

func campaignAccountingTestSale(program, issuer solana.PublicKey) solana.PublicKey {
	sale, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-genesis-v1"), issuer[:], solana.SysVarClockPubkey[:]}, program)
	return sale
}

func campaignAccountingTestIndexed(t *testing.T, program, sale, issuer, mint solana.PublicKey, accounts map[solana.PublicKey]*rpc.Account) (solana.PublicKey, solana.PublicKey, solana.PublicKey) {
	t.Helper()
	catalogue, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-retail-members-v2"), issuer[:], mint[:]}, program)
	root, rootBump, _ := solana.FindProgramAddress([][]byte{[]byte("wen-accounting-domain-v1"), sale[:], {3}}, program)
	entry, entryBump, _ := solana.FindProgramAddress([][]byte{[]byte("wen-accounting-source-v1"), root[:], catalogue[:]}, program)
	index, indexBump, _ := solana.FindProgramAddress([][]byte{[]byte("wen-accounting-index-v1"), root[:], make([]byte, 8)}, program)
	r := make([]byte, 104)
	copy(r, "WENDOM01")
	r[8], r[10], r[11], r[72] = 1, 3, rootBump, 1
	copy(r[16:], sale[:])
	for _, at := range []int{48, 56, 64} {
		binary.LittleEndian.PutUint64(r[at:], 1)
	}
	e := make([]byte, 128)
	copy(e, "WENDS001")
	e[8], e[11] = 1, entryBump
	copy(e[16:], root[:])
	copy(e[48:], catalogue[:])
	i := make([]byte, 120)
	copy(i, "WENDIX01")
	i[8], i[11] = 1, indexBump
	copy(i[16:], root[:])
	copy(i[48:], catalogue[:])
	copy(i[80:], entry[:])
	accounts[root] = &rpc.Account{Owner: program, Lamports: 1100, Data: rpc.DataBytesOrJSONFromBytes(r)}
	accounts[entry] = &rpc.Account{Owner: program, Lamports: 1100, Data: rpc.DataBytesOrJSONFromBytes(e)}
	accounts[index] = &rpc.Account{Owner: program, Lamports: 1100, Data: rpc.DataBytesOrJSONFromBytes(i)}
	return root, entry, index
}

func TestWENCampaignAccountingReadV1(t *testing.T) {
	program, issuer := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	sale := campaignAccountingTestSale(program, issuer)
	mint, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), sale[:]}, program)
	window := campaignAccountingTestWindow(program, issuer, mint)
	for _, mode := range []string{"empty", "indexed", "funded", "missing-sale", "wrong-window", "missing-funding", "bad-root", "bad-entry", "missing-index", "changed"} {
		t.Run(mode, func(t *testing.T) {
			accounts := campaignAccountingTestAccounts(t, program, sale, issuer, window, mint)
			var root, entry, index solana.PublicKey
			if mode == "indexed" || mode == "bad-root" || mode == "bad-entry" || mode == "missing-index" {
				root, entry, index = campaignAccountingTestIndexed(t, program, sale, issuer, mint, accounts)
			}
			switch mode {
			case "funded", "missing-funding":
				w := append([]byte(nil), accounts[window].Data.GetBinary()...)
				w[11] = 62
				accounts[window].Data = rpc.DataBytesOrJSONFromBytes(w)
				if mode == "funded" {
					budget, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-funded-mining-budget-v1"), sale[:], make([]byte, 8)}, program)
					funding, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-retail-funding-v2"), window[:]}, program)
					f := make([]byte, 176)
					copy(f, "WENRFND2")
					f[8] = 1
					copy(f[16:], window[:])
					copy(f[48:], sale[:])
					copy(f[80:], budget[:])
					accounts[funding] = &rpc.Account{Owner: program, Lamports: 1100, Data: rpc.DataBytesOrJSONFromBytes(f)}
				}
			case "missing-sale":
				delete(accounts, sale)
			case "wrong-window":
				accounts[window].Owner = solana.SystemProgramID
			case "bad-root":
				d := append([]byte(nil), accounts[root].Data.GetBinary()...)
				d[56]++
				accounts[root].Data = rpc.DataBytesOrJSONFromBytes(d)
			case "bad-entry":
				d := append([]byte(nil), accounts[entry].Data.GetBinary()...)
				d[48] ^= 1
				accounts[entry].Data = rpc.DataBytesOrJSONFromBytes(d)
			case "missing-index":
				delete(accounts, index)
			}
			c := &campaignReadFake{wenReadRPCFake: &wenReadRPCFake{t: t}, accounting: accounts, accountingChange: mode == "changed"}
			hash, err := readWENCampaignAccountingV1(context.Background(), c, program, sale, issuer, window, mint, 110, 132)
			pass := mode == "empty" || mode == "indexed" || mode == "funded"
			if (err == nil) != pass || pass && hash == ([32]byte{}) {
				t.Fatalf("accounting read %s: %v", mode, err)
			}
		})
	}
}

func campaignAccountingTestWindow(program, issuer, mint solana.PublicKey) solana.PublicKey {
	window, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-retail-window-v2"), issuer[:], mint[:], make([]byte, 8)}, program)
	return window
}

func campaignAccountingTestAccounts(t *testing.T, program, sale, issuer, window, mint solana.PublicKey) map[solana.PublicKey]*rpc.Account {
	t.Helper()
	if sale != campaignAccountingTestSale(program, issuer) || window != campaignAccountingTestWindow(program, issuer, mint) {
		t.Fatal("noncanonical accounting fixture")
	}
	_, bump, _ := solana.FindProgramAddress([][]byte{[]byte("wen-genesis-v1"), issuer[:], solana.SysVarClockPubkey[:]}, program)
	s := make([]byte, 192)
	copy(s, "WENGEN01")
	s[8], s[11] = 1, bump
	copy(s[16:], issuer[:])
	copy(s[48:], solana.SysVarClockPubkey[:])
	copy(s[80:], mint[:])
	copy(s[112:], solana.SystemProgramID[:])
	binary.LittleEndian.PutUint64(s[152:], 604800)
	binary.LittleEndian.PutUint64(s[160:], 604801)
	w := make([]byte, 256)
	copy(w, "WENRCMP2")
	w[8], w[10] = 1, 1
	copy(w[16:], issuer[:])
	copy(w[48:], mint[:])
	return map[solana.PublicKey]*rpc.Account{
		sale:   {Owner: program, Lamports: 1100, Data: rpc.DataBytesOrJSONFromBytes(s)},
		window: {Owner: program, Lamports: 1100, Data: rpc.DataBytesOrJSONFromBytes(w)},
	}
}
