package main

import (
	"encoding/base64"
	"encoding/json"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

func TestWENBTCSuccessNativeEffects(t *testing.T) {
	for _, name := range []string{"valid", "loaded-address", "missing-keys", "balance-count", "conservation", "over-budget", "payer-credit"} {
		t.Run(name, func(t *testing.T) {
			raw, intent, _, snapshots, _ := wenMessageFixture(t, "acceptance")
			wire := make([]byte, 65+len(raw))
			wire[0] = 1
			copy(wire[65:], raw)
			tx, err := solana.TransactionFromBytes(wire)
			if err != nil {
				t.Fatal(err)
			}
			tables := map[solana.PublicKey][]solana.PublicKey{}
			for _, snapshot := range snapshots {
				for offset := 56; offset < len(snapshot.Data); offset += 32 {
					tables[snapshot.Address] = append(tables[snapshot.Address], solana.PublicKeyFromBytes(snapshot.Data[offset:offset+32]))
				}
			}
			loaded := rpc.LoadedAddresses{}
			for _, lookup := range tx.Message.GetAddressTableLookups() {
				for _, index := range lookup.WritableIndexes {
					loaded.Writable = append(loaded.Writable, tables[lookup.AccountKey][index])
				}
				for _, index := range lookup.ReadonlyIndexes {
					loaded.ReadOnly = append(loaded.ReadOnly, tables[lookup.AccountKey][index])
				}
			}
			keys := append(solana.PublicKeySlice(nil), tx.Message.AccountKeys...)
			keys = append(keys, loaded.Writable...)
			keys = append(keys, loaded.ReadOnly...)
			r := wenBudgetReservationV1{WalletPublicKey: intent.payer.String(), WalletClaims: map[string]uint64{"solana:native": 7000}}
			for _, key := range keys {
				r.AccountKeys = append(r.AccountKeys, key.String())
			}
			m := &rpc.TransactionMeta{Fee: 5000, LoadedAddresses: loaded, PreBalances: make([]uint64, len(keys)), PostBalances: make([]uint64, len(keys))}
			m.PreBalances[0] = 10000
			m.PostBalances[0] = 4000
			m.PostBalances[1] = 1000
			switch name {
			case "loaded-address":
				if len(m.LoadedAddresses.Writable) == 0 {
					t.Fatal("fixture must use writable lookup")
				}
				m.LoadedAddresses.Writable[0] = solana.PublicKey{98}
			case "missing-keys":
				r.AccountKeys = nil
			case "balance-count":
				m.PostBalances = m.PostBalances[:1]
			case "conservation":
				m.PostBalances[1]++
			case "over-budget":
				r.WalletClaims["solana:native"] = 5999
			case "payer-credit":
				m.PostBalances[0] = 10001
			}
			encoded, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
			envelope := &rpc.TransactionResultEnvelope{}
			if err := json.Unmarshal(encoded, envelope); err != nil {
				t.Fatal(err)
			}
			proof, debit := wenSuccessNativeEffectsV1(r, &rpc.GetTransactionResult{Slot: 150, Meta: m, Transaction: envelope})
			if name == "valid" {
				if !wenReservationHashV1(proof) || debit != 6000 {
					t.Fatal("missing native proof", proof, debit)
				}
			} else if proof != "" || debit != 0 {
				t.Fatal("invalid native receipt accepted")
			}
		})
	}
}
