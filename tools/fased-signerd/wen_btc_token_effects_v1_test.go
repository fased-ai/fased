package main

import (
	"encoding/base64"
	"encoding/json"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

func TestWENBTCTokenEffects(t *testing.T) {
	for _, name := range []string{"valid", "pre-only", "post-only", "overflow", "noncanonical", "duplicate", "mint-change", "owner-change", "program-change", "decimals-change", "index", "missing-owner", "missing-amount", "empty"} {
		t.Run(name, func(t *testing.T) {
			payer := solana.PublicKey{7}
			tx, err := solana.NewTransaction([]solana.Instruction{solana.NewInstruction(solana.SystemProgramID, nil, []byte{0})}, solana.Hash{1}, solana.TransactionPayer(payer))
			if err != nil {
				t.Fatal(err)
			}
			message, err := tx.Message.MarshalBinary()
			if err != nil {
				t.Fatal(err)
			}
			wire := make([]byte, 65+len(message))
			wire[0] = 1
			copy(wire[65:], message)
			encoded, _ := json.Marshal([]string{base64.StdEncoding.EncodeToString(wire), "base64"})
			envelope := &rpc.TransactionResultEnvelope{}
			if err := json.Unmarshal(encoded, envelope); err != nil {
				t.Fatal(err)
			}
			r := wenBudgetReservationV1{WalletPublicKey: payer.String(), WalletClaims: map[string]uint64{"solana:native": 10000}}
			for _, key := range tx.Message.AccountKeys {
				r.AccountKeys = append(r.AccountKeys, key.String())
			}
			owner, program, mint := solana.PublicKey{8}, solana.TokenProgramID, solana.PublicKey{9}
			pre := rpc.TokenBalance{AccountIndex: 1, Mint: mint, Owner: &owner, ProgramId: &program, UiTokenAmount: &rpc.UiTokenAmount{Amount: "100", Decimals: 6}}
			post := pre
			post.UiTokenAmount = &rpc.UiTokenAmount{Amount: "60", Decimals: 6}
			meta := &rpc.TransactionMeta{Fee: 5000, PreBalances: []uint64{10000, 0}, PostBalances: []uint64{5000, 0}, PreTokenBalances: []rpc.TokenBalance{pre}, PostTokenBalances: []rpc.TokenBalance{post}}
			switch name {
			case "pre-only":
				meta.PostTokenBalances = nil
			case "post-only":
				meta.PreTokenBalances = nil
			case "overflow":
				post.UiTokenAmount.Amount = "18446744073709551616"
			case "noncanonical":
				post.UiTokenAmount.Amount = "060"
			case "duplicate":
				meta.PostTokenBalances = append(meta.PostTokenBalances, post)
			case "mint-change":
				meta.PostTokenBalances[0].Mint = solana.PublicKey{10}
			case "owner-change":
				v := solana.PublicKey{10}
				meta.PostTokenBalances[0].Owner = &v
			case "program-change":
				v := solana.Token2022ProgramID
				meta.PostTokenBalances[0].ProgramId = &v
			case "decimals-change":
				post.UiTokenAmount.Decimals = 8
			case "index":
				meta.PostTokenBalances[0].AccountIndex = 3
			case "missing-owner":
				meta.PostTokenBalances[0].Owner = nil
			case "missing-amount":
				meta.PostTokenBalances[0].UiTokenAmount = nil
			case "empty":
				meta.PreTokenBalances = nil
				meta.PostTokenBalances = nil
			}
			proof, rows := wenSuccessTokenEffectsV1(r, &rpc.GetTransactionResult{Meta: meta, Transaction: envelope})
			valid := name == "valid" || name == "pre-only" || name == "post-only"
			if valid {
				if !wenReservationHashV1(proof) || len(rows) != 1 {
					t.Fatal("missing token evidence")
				}
				row := rows[0]
				if row.Account != r.AccountKeys[1] || row.Mint != mint.String() || row.Owner != owner.String() || row.Program != program.String() {
					t.Fatal("lost token identity")
				}
				if name == "valid" {
					if row.DeltaRaw != "-40" || row.PreRaw != "100" || row.PostRaw != "60" {
						t.Fatal("incorrect raw delta", row)
					}
				} else if row.DeltaRaw != "" || row.PrePresent != (name == "pre-only") || row.PostPresent != (name == "post-only") {
					t.Fatal("missing side inferred as zero", row)
				}
			} else if proof != "" || rows != nil {
				t.Fatal("invalid token receipt admitted")
			}
		})
	}
}
