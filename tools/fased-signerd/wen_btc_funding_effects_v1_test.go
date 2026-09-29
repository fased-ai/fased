package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"strconv"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

func wenFundingReceiptFixture(t *testing.T, operation string) (wenBudgetReservationV1, *rpc.GetTransactionResult) {
	t.Helper()
	raw, _, _, snapshots, _ := wenMessageFixture(t, operation)
	wire := make([]byte, 65+len(raw))
	wire[0] = 1
	copy(wire[65:], raw)
	tx, err := solana.TransactionFromBytes(wire)
	if err != nil {
		t.Fatal(err)
	}
	tables := map[solana.PublicKey][]solana.PublicKey{}
	for _, snapshot := range snapshots {
		for at := 56; at < len(snapshot.Data); at += 32 {
			tables[snapshot.Address] = append(tables[snapshot.Address], solana.PublicKeyFromBytes(snapshot.Data[at:at+32]))
		}
	}
	loaded := rpc.LoadedAddresses{}
	for _, lookup := range tx.Message.GetAddressTableLookups() {
		for _, i := range lookup.WritableIndexes {
			loaded.Writable = append(loaded.Writable, tables[lookup.AccountKey][i])
		}
		for _, i := range lookup.ReadonlyIndexes {
			loaded.ReadOnly = append(loaded.ReadOnly, tables[lookup.AccountKey][i])
		}
	}
	keys := append(solana.PublicKeySlice(nil), tx.Message.AccountKeys...)
	keys = append(keys, loaded.Writable...)
	keys = append(keys, loaded.ReadOnly...)
	return wenFundingReceiptFromWire(t, wire, keys)
}
func wenFundingReceiptFromWire(t *testing.T, wire []byte, keys solana.PublicKeySlice) (wenBudgetReservationV1, *rpc.GetTransactionResult) {
	t.Helper()
	tx, err := solana.TransactionFromBytes(wire)
	if err != nil {
		t.Fatal(err)
	}
	writable := 0
	for _, lookup := range tx.Message.GetAddressTableLookups() {
		writable += len(lookup.WritableIndexes)
	}
	static := len(tx.Message.AccountKeys)
	loaded := rpc.LoadedAddresses{Writable: keys[static : static+writable], ReadOnly: keys[static+writable:]}
	operation := "acquisition"
	if tx.Message.Instructions[1].Data[0] == 111 {
		operation = "acceptance"
	}
	r := wenBudgetReservationV1{WalletPublicKey: keys[0].String(), WalletClaims: map[string]uint64{"solana:native": 1000000}}
	for _, key := range keys {
		r.AccountKeys = append(r.AccountKeys, key.String())
	}
	m := &rpc.TransactionMeta{Fee: 5000, LoadedAddresses: loaded, PreBalances: make([]uint64, len(keys)), PostBalances: make([]uint64, len(keys))}
	m.PreBalances[0] = 1000000
	m.PostBalances[0] = 995000
	ix := tx.Message.Instructions[1]
	offer := []byte(ix.Data)[1:465]
	k := func(i int) solana.PublicKey { return solana.PublicKeyFromBytes(offer[8+i*32 : 40+i*32]) }
	n := func(i int) uint64 { return binary.LittleEndian.Uint64(offer[328+i*8 : 336+i*8]) }
	sale := k(0)
	authority, _, err := solana.FindProgramAddress([][]byte{[]byte("wen-activation-v1"), sale[:]}, keys[tx.Message.Instructions[1].ProgramIDIndex])
	if err != nil {
		t.Fatal(err)
	}
	role := func(i int) solana.PublicKey { return keys[ix.Accounts[i]] }
	add := func(roleIndex int, mint, owner, program solana.PublicKey, decimals uint8, amount uint64, negative, created bool) {
		index := ix.Accounts[roleIndex]
		before := uint64(100)
		after := before + amount
		if negative {
			before = amount + 100
			after = 100
		}
		if created {
			before = 0
			after = amount
			m.PostBalances[index] = 100
			m.PostBalances[0] -= 100
		}
		entry := rpc.TokenBalance{AccountIndex: index, Mint: mint, Owner: &owner, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: strconv.FormatUint(before, 10), Decimals: decimals}}
		if !created {
			m.PreTokenBalances = append(m.PreTokenBalances, entry)
		}
		entry.UiTokenAmount = &rpc.UiTokenAmount{Amount: strconv.FormatUint(after, 10), Decimals: decimals}
		m.PostTokenBalances = append(m.PostTokenBalances, entry)
	}
	budget := n(10) + n(12)
	if operation == "acceptance" {
		add(1, k(3), k(2), solana.TokenProgramID, 6, n(4), true, false)
		add(2, k(3), authority, solana.TokenProgramID, 6, n(4)-budget-n(11), false, false)
		add(3, k(3), role(5), solana.TokenProgramID, 6, budget, false, true)
		add(4, k(3), authority, solana.TokenProgramID, 6, n(11), false, false)
		add(16, role(13), role(9), solana.Token2022ProgramID, 11, 0, false, true)
	} else {
		add(2, k(3), role(1), solana.TokenProgramID, 6, budget, true, false)
		add(3, k(4), authority, solana.TokenProgramID, 8, n(13), false, false)
		add(4, k(3), authority, solana.TokenProgramID, 6, n(12), false, false)
	}
	encoded, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
	env := &rpc.TransactionResultEnvelope{}
	if err := json.Unmarshal(encoded, env); err != nil {
		t.Fatal(err)
	}
	return r, &rpc.GetTransactionResult{Slot: 150, Transaction: env, Meta: m}
}

func TestWENBTCFundingEffects(t *testing.T) {
	for _, operation := range []string{"acceptance", "acquisition"} {
		for _, name := range []string{"valid", "amount", "owner", "mint", "missing", "creation-or-close", "reward"} {
			t.Run(operation+"/"+name, func(t *testing.T) {
				r, result := wenFundingReceiptFixture(t, operation)
				m := result.Meta
				switch name {
				case "amount":
					m.PostTokenBalances[0].UiTokenAmount.Amount = "101"
				case "owner":
					owner := solana.PublicKey{89}
					m.PreTokenBalances[0].Owner = &owner
					m.PostTokenBalances[0].Owner = &owner
				case "mint":
					mint := solana.PublicKey{88}
					m.PreTokenBalances[0].Mint = mint
					m.PostTokenBalances[0].Mint = mint
				case "missing":
					m.PostTokenBalances = m.PostTokenBalances[1:]
				case "creation-or-close":
					tx, _ := solana.TransactionFromBytes(result.Transaction.GetBinary())
					index := tx.Message.Instructions[1].Accounts[3]
					if operation == "acquisition" {
						index = tx.Message.Instructions[1].Accounts[11]
					}
					m.PreBalances[index]++
					m.PostBalances[index]++
				case "reward":
					if operation == "acceptance" {
						m.PostTokenBalances[4].UiTokenAmount.Amount = "1"
					} else {
						m.PostTokenBalances[1].UiTokenAmount.Amount = "100"
					}
				}
				proof := wenSuccessFundingEffectsV1(r, result)
				if (proof != "") != (name == "valid") {
					t.Fatal("funding match", proof)
				}
			})
		}
	}
}
