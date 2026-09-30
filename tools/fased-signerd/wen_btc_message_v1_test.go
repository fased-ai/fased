package main

import (
	"encoding/binary"
	bin "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
	"testing"
)

func wenMessageFixture(t *testing.T, operation string) ([]byte, signerWENBTCMessageIntentV1, []signerWENBTCLookupPinV1, []*signerWENBTCAccountV1, signerWENBTCMessageLifeV1) {
	t.Helper()
	root, pins, request, wallet, _ := wenArtifactCase(t)
	a, err := loadWENBTCAcceptanceV1(root, pins, request, wallet, 150, 1)
	if err != nil {
		t.Fatal(err)
	}
	data, accounts, err := a.acceptanceInstruction(1)
	if err != nil {
		t.Fatal(err)
	}
	if operation == "acquisition" {
		other, payer, route, _, _ := wenAcquisitionFixture(t)
		a = other
		wallet = payer
		data, accounts, err = a.acquisitionInstruction(payer, route, 100)
		if err != nil {
			t.Fatal(err)
		}
	}
	intent := signerWENBTCMessageIntentV1{payer: wallet, program: a.program, blockhash: solana.Hash{1}, units: 200000, data: data, accounts: accounts}
	compute := solana.MustPublicKeyFromBase58("ComputeBudget111111111111111111111111111111")
	table := solana.PublicKey{99}
	tableKeys := solana.PublicKeySlice{}
	seen := map[solana.PublicKey]bool{}
	metas := solana.AccountMetaSlice{}
	for _, m := range accounts {
		k := solana.MustPublicKeyFromBase58(m.Pubkey)
		metas = append(metas, &solana.AccountMeta{PublicKey: k, IsSigner: m.IsSigner, IsWritable: m.IsWritable})
		if k != wallet && k != a.program && k != compute && !seen[k] {
			seen[k] = true
			tableKeys = append(tableKeys, k)
		}
	}
	budget := []byte{2, 0, 0, 0, 0}
	binary.LittleEndian.PutUint32(budget[1:], intent.units)
	tx, err := solana.NewTransaction([]solana.Instruction{solana.NewInstruction(compute, nil, budget), solana.NewInstruction(a.program, metas, data)}, intent.blockhash, solana.TransactionPayer(wallet), solana.TransactionAddressTables(map[solana.PublicKey]solana.PublicKeySlice{table: tableKeys}))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := tx.Message.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	d := make([]byte, 56+len(tableKeys)*32)
	binary.LittleEndian.PutUint32(d, 1)
	binary.LittleEndian.PutUint64(d[4:], ^uint64(0))
	binary.LittleEndian.PutUint64(d[12:], 149)
	for i, k := range tableKeys {
		copy(d[56+i*32:], k[:])
	}
	snapshot := &signerWENBTCAccountV1{Address: table, Owner: solana.MustPublicKeyFromBase58("AddressLookupTab1e1111111111111111111111111"), Slot: 150, Data: d}
	return raw, intent, []signerWENBTCLookupPinV1{{key: table, digest: wenHashV1(d)}}, []*signerWENBTCAccountV1{snapshot}, signerWENBTCMessageLifeV1{currentHeight: 10, lastValidHeight: 20, minimumSlot: 150, maximumSlotLag: 5}
}
func TestWENBTCMessageMatchesPreparedIntent(t *testing.T) {
	for _, operation := range []string{"acceptance", "acquisition"} {
		t.Run(operation, func(t *testing.T) {
			raw, intent, pins, snapshots, life := wenMessageFixture(t, operation)
			if err := verifyWENBTCMessageV1(raw, intent, pins, snapshots, life); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestWENBTCMessageRejectsMutation(t *testing.T) {
	for _, name := range []string{"noncanonical-shortvec", "privilege-escalation", "payer", "blockhash", "expiry", "zero-units", "trailing", "truncated", "oversize", "opcode", "instruction-data", "extra-instruction", "budget-price", "budget-amount", "account-order", "extra-signer", "readonly-payer", "lookup-key", "lookup-index", "duplicate-lookup", "lookup-hash", "lookup-owner", "lookup-slot", "lookup-stale", "lookup-deactivated", "lookup-warming", "lookup-metadata", "resolved-alias"} {
		t.Run(name, func(t *testing.T) {
			raw, intent, pins, snapshots, life := wenMessageFixture(t, "acceptance")
			change := func(fn func(*solana.Message)) {
				var m solana.Message
				if err := m.UnmarshalWithDecoder(bin.NewBinDecoder(raw)); err != nil {
					t.Fatal(err)
				}
				fn(&m)
				var err error
				raw, err = m.MarshalBinary()
				if err != nil {
					t.Fatal(err)
				}
			}
			repin := func() { pins[0].digest = wenHashV1(snapshots[0].Data) }
			switch name {
			case "noncanonical-shortvec":
				raw = append(append(append([]byte(nil), raw[:4]...), raw[4]|128, 0), raw[5:]...)
			case "privilege-escalation":
				change(func(m *solana.Message) { m.Header.NumReadonlyUnsignedAccounts-- })
			case "payer":
				intent.payer = solana.PublicKey{8}
			case "blockhash":
				intent.blockhash = solana.Hash{8}
			case "expiry":
				life.currentHeight = 20
			case "zero-units":
				intent.units = 0
			case "trailing":
				raw = append(raw, 0)
			case "truncated":
				raw = raw[:len(raw)-1]
			case "oversize":
				raw = append(raw, make([]byte, 1232)...)
			case "opcode":
				intent.data[0] = 112
			case "instruction-data":
				change(func(m *solana.Message) { m.Instructions[1].Data[10] ^= 1 })
			case "extra-instruction":
				change(func(m *solana.Message) { m.Instructions = append(m.Instructions, m.Instructions[0]) })
			case "budget-price":
				change(func(m *solana.Message) { m.Instructions[0].Data[0] = 3 })
			case "budget-amount":
				change(func(m *solana.Message) { m.Instructions[0].Data[1] ^= 1 })
			case "account-order":
				change(func(m *solana.Message) { a := m.Instructions[1].Accounts; a[1], a[2] = a[2], a[1] })
			case "extra-signer":
				change(func(m *solana.Message) { m.Header.NumRequiredSignatures = 2 })
			case "readonly-payer":
				change(func(m *solana.Message) { m.Header.NumReadonlySignedAccounts = 1 })
			case "lookup-key":
				change(func(m *solana.Message) { m.AddressTableLookups[0].AccountKey = solana.PublicKey{9} })
			case "lookup-index":
				change(func(m *solana.Message) { m.AddressTableLookups[0].WritableIndexes[0] = 255 })
			case "duplicate-lookup":
				change(func(m *solana.Message) {
					m.AddressTableLookups = append(m.AddressTableLookups, m.AddressTableLookups[0])
				})
			case "lookup-hash":
				snapshots[0].Data[56] ^= 1
			case "lookup-owner":
				snapshots[0].Owner = intent.program
			case "lookup-slot":
				snapshots[0].Slot = 149
			case "lookup-stale":
				snapshots[0].Slot = 156
			case "lookup-deactivated":
				binary.LittleEndian.PutUint64(snapshots[0].Data[4:], 149)
				repin()
			case "lookup-warming":
				binary.LittleEndian.PutUint64(snapshots[0].Data[12:], 150)
				repin()
			case "lookup-metadata":
				snapshots[0].Data[21] = 2
				repin()
			case "resolved-alias":
				copy(snapshots[0].Data[56:88], intent.payer[:])
				repin()
			}
			if err := verifyWENBTCMessageV1(raw, intent, pins, snapshots, life); err == nil {
				t.Fatal("mutated message accepted")
			}
		})
	}
}
