package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"

	solana "github.com/gagliardetto/solana-go"
)

// Canonical Rust builder vectors, not transactions or deployment admission.
func TestWENBTCRejectsLegacySignerCapabilities(t *testing.T) {
	raw, err := os.ReadFile("testdata/wen-btc-source-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		SourceDigest   string `json:"sourceDigest"`
		ContractDigest string `json:"contractDigest"`
		Vectors        []struct {
			Opcode     byte                   `json:"opcode"`
			Name       string                 `json:"name"`
			ProgramID  string                 `json:"programId"`
			DataBase64 string                 `json:"dataBase64"`
			Keys       []signerTypedAccountV2 `json:"keys"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Vectors) != 2 || len(fixture.SourceDigest) != 64 || len(fixture.ContractDigest) != 64 {
		t.Fatal("invalid WEN fixture")
	}
	names := []string{"commitCycle", "openCycle", "openBondPosition"}
	checks := 0
	for _, v := range fixture.Vectors {
		data, err := base64.StdEncoding.Strict().DecodeString(v.DataBase64)
		if err != nil || len(data) == 0 || data[0] != v.Opcode || (v.Opcode != 111 && v.Opcode != 112) || len(v.Keys) == 0 {
			t.Fatal("invalid BTC vector")
		}
		wallet := solana.MustPublicKeyFromBase58(v.Keys[0].Pubkey)
		for _, action := range names {
			for _, kind := range []string{"solana.satAction", "solana.vaultBondAction"} {
				input := signerIntentV2{Type: kind, Action: action, ProgramID: v.ProgramID, DataBase64: v.DataBase64, Keys: v.Keys}
				if kind == "solana.vaultBondAction" {
					input.Cluster = "devnet"
				}
				t.Run(v.Name+"/"+kind+"/"+action, func(t *testing.T) {
					if _, err := normalizeSignerIntentForWalletV2(input, &wallet); err == nil {
						t.Fatal("WEN BTC vector accepted under legacy signer capability")
					}
				})
				checks++
			}
		}
		for _, kind := range []string{"solana.wenBtcSubscription", "solana.wenBtcAcceptance", "solana.wenBtcAcquisition"} {
			input := signerIntentV2{Type: kind, ProgramID: v.ProgramID, DataBase64: v.DataBase64, Keys: v.Keys}
			if _, err := normalizeSignerIntentForWalletV2(input, &wallet); err == nil {
				t.Fatal("unimplemented WEN signer intent accepted")
			}
			checks++
		}
	}
	t.Logf("PASS %d WEN/legacy signer rejection checks; no keys loaded or signing performed", checks)
}
