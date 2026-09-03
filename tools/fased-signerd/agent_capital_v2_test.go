package main

import (
	"encoding/base64"
	"encoding/binary"
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
)

func agentCapitalDepositFixtureV2() (signerIntentV2, solana.PublicKey) {
	wallet := solana.NewWallet().PublicKey()
	contract := agentCapitalInstructionContractsV1["deposit_capital_offer"]
	data := make([]byte, contract.DataSize)
	copy(data[:8], contract.Discriminator[:])
	binary.LittleEndian.PutUint64(data[8:], 1_000_000_000)
	keys := make([]signerSATAccountV2, len(contract.Accounts))
	for index, account := range contract.Accounts {
		key := solana.NewWallet().PublicKey()
		if account.IsSigner {
			key = wallet
		}
		if account.Address != "" {
			key = solana.MustPublicKeyFromBase58(account.Address)
		}
		keys[index] = signerSATAccountV2{Pubkey: key.String(), IsSigner: account.IsSigner, IsWritable: account.IsWritable}
	}
	return signerIntentV2{Type: intentSolanaAgentCapitalAction, Cluster: "devnet", Action: "deposit_capital_offer", ProgramID: agentCapitalProgramIDV1, DataBase64: base64.StdEncoding.EncodeToString(data), Keys: keys}, wallet
}

func TestAgentCapitalIntentBindsGeneratedProgramActionAccountsAndAmount(t *testing.T) {
	fixture, wallet := agentCapitalDepositFixtureV2()
	intent, err := normalizeAgentCapitalIntentV2(fixture, wallet)
	if err != nil {
		t.Fatal(err)
	}
	if intent.Asset != "solana:native" || intent.Amount.String() != "1000000000" || intent.RequiredRole != "vault" {
		t.Fatalf("unexpected Agent Capital effect: %#v", intent)
	}
	if intent.PolicyOperation != "agentCapital.deposit_capital_offer@"+agentCapitalProgramIDV1 {
		t.Fatalf("unexpected Agent Capital policy operation: %s", intent.PolicyOperation)
	}

	wrongProgram := fixture
	wrongProgram.ProgramID = solana.NewWallet().PublicKey().String()
	if _, err := normalizeAgentCapitalIntentV2(wrongProgram, wallet); err == nil || !strings.Contains(err.Error(), "pinned canonical program") {
		t.Fatalf("wrong program error = %v", err)
	}

	wrongFlags := fixture
	wrongFlags.Keys = append([]signerSATAccountV2(nil), fixture.Keys...)
	wrongFlags.Keys[1].IsWritable = !wrongFlags.Keys[1].IsWritable
	if _, err := normalizeAgentCapitalIntentV2(wrongFlags, wallet); err == nil || !strings.Contains(err.Error(), "generated contract") {
		t.Fatalf("wrong flags error = %v", err)
	}

	wrongSigner := fixture
	wrongSigner.Keys = append([]signerSATAccountV2(nil), fixture.Keys...)
	wrongSigner.Keys[0].Pubkey = solana.NewWallet().PublicKey().String()
	if _, err := normalizeAgentCapitalIntentV2(wrongSigner, wallet); err == nil || !strings.Contains(err.Error(), "selected signer-owned wallet") {
		t.Fatalf("wrong signer error = %v", err)
	}
}
