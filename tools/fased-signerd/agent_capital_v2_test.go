package main

import (
	"encoding/base64"
	"encoding/binary"
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
)

func TestControlUIReviewDevnetCapitalBoundary(t *testing.T) {
	intent := signerIntentV2{Type: intentSolanaAgentCapitalAction, Cluster: "devnet", Action: "initialize_capital_offer", ProgramID: agentCapitalProgramIDV1}
	if !allowsControlUIReviewIntentV2(intent, "profile") {
		t.Fatal("exact Devnet Profile initialization must allow owner confirmation")
	}
	for _, mutate := range []func(*signerIntentV2){
		func(i *signerIntentV2) { i.Cluster = "mainnet-beta" },
		func(i *signerIntentV2) { i.Cluster = "" },
		func(i *signerIntentV2) { i.Action = "deposit_capital_offer" },
		func(i *signerIntentV2) { i.ProgramID = solana.NewWallet().PublicKey().String() },
	} {
		changed := intent
		mutate(&changed)
		if allowsControlUIReviewIntentV2(changed, "profile") {
			t.Fatal("expanded capital authority accepted")
		}
	}
	for _, role := range []string{"agent", "mining", "vault", "strategy", ""} {
		if allowsControlUIReviewIntentV2(intent, role) {
			t.Fatalf("wrong role %s accepted", role)
		}
	}
}

func TestAgentCapitalVaultMiningRequiresSignerOwnedCommitments(t *testing.T) {
	for _, action := range []string{"commit_vault_cycle", "reveal_vault_cycle"} {
		intent, wallet := agentCapitalDepositFixtureV2()
		contract := agentCapitalInstructionContractsV1[action]
		data := make([]byte, contract.DataSize)
		copy(data, contract.Discriminator[:])
		intent.Action = action
		intent.DataBase64 = base64.StdEncoding.EncodeToString(data)
		intent.Keys = nil
		for _, account := range contract.Accounts {
			key := solana.NewWallet().PublicKey()
			if account.IsSigner {
				key = wallet
			}
			if account.Address != "" {
				key = solana.MustPublicKeyFromBase58(account.Address)
			}
			intent.Keys = append(intent.Keys, signerSATAccountV2{Pubkey: key.String(), IsSigner: account.IsSigner, IsWritable: account.IsWritable})
		}
		if _, err := normalizeAgentCapitalIntentV2(intent, wallet); err == nil || !strings.Contains(err.Error(), "signer-owned Vault commitment") {
			t.Fatalf("generic mining secrets accepted for %s: %v", action, err)
		}
	}
}

func TestControlUIReviewDevnetLifecycleRoles(t *testing.T) {
	for action, wantRole := range map[string]string{
		"cancel_capital_offer": "profile", "succeed_empty_capital_offer": "profile", "deposit_capital_offer_generation": "vault",
		"activate_capital_offer": "profile", "record_vault_result": "profile",
		"configure_vault_mining": "profile", "compact_vault_pending_cycle": "profile",
		"claim_vault_sat": "vault", "request_vault_exit": "vault",
		"finalize_vault_exit": "vault", "refund_cancelled_position": "vault",
	} {
		for _, role := range []string{"profile", "vault", "agent", "mining", "strategy", "keeper", ""} {
			intent := signerIntentV2{Type: intentSolanaAgentCapitalAction, Cluster: "devnet", Action: action, ProgramID: agentCapitalProgramIDV1}
			if allowsControlUIReviewIntentV2(intent, role) != (role == wantRole) {
				t.Fatalf("wrong role decision: %s %s", action, role)
			}
			intent.Cluster = "mainnet-beta"
			if allowsControlUIReviewIntentV2(intent, role) {
				t.Fatal("Mainnet exception")
			}
			intent.Cluster = "devnet"
			intent.ProgramID = solana.NewWallet().PublicKey().String()
			if allowsControlUIReviewIntentV2(intent, role) {
				t.Fatal("wrong program exception")
			}
		}
	}
	for _, action := range []string{"bind_satcoin_vault", "deposit_capital_offer", "commit_cycle", "unknown", ""} {
		for _, role := range []string{"profile", "vault"} {
			if allowsControlUIReviewIntentV2(signerIntentV2{Type: intentSolanaAgentCapitalAction, Cluster: "devnet", Action: action, ProgramID: agentCapitalProgramIDV1}, role) {
				t.Fatal("unapproved action exception")
			}
		}
	}
}

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

func TestGenerationDepositRetainsVaultSpendAndBindsGeneration(t *testing.T) {
	fixture, wallet := agentCapitalDepositFixtureV2()
	fixture.Action = "deposit_capital_offer_generation"
	contract := agentCapitalInstructionContractsV1[fixture.Action]
	data := make([]byte, contract.DataSize)
	copy(data[:8], contract.Discriminator[:])
	binary.LittleEndian.PutUint64(data[8:], 1_000_000_000)
	binary.LittleEndian.PutUint64(data[16:], 2)
	fixture.DataBase64 = base64.StdEncoding.EncodeToString(data)
	intent, err := normalizeAgentCapitalIntentV2(fixture, wallet)
	if err != nil {
		t.Fatal(err)
	}
	if intent.RequiredRole != "vault" || intent.Asset != "solana:native" || intent.Amount.String() != "1000000000" {
		t.Fatal("generation deposit lost its Vault principal spend classification")
	}
	binary.LittleEndian.PutUint64(data[16:], 3)
	fixture.DataBase64 = base64.StdEncoding.EncodeToString(data)
	changed, err := normalizeAgentCapitalIntentV2(fixture, wallet)
	if err != nil {
		t.Fatal(err)
	}
	if intent.Digest == changed.Digest {
		t.Fatal("generation did not change intent hash")
	}
}

func TestAgentCapitalProfileActionUsesExactPolicyAndIndependentFeeReservation(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	contract := agentCapitalInstructionContractsV1["initialize_capital_offer"]
	data := make([]byte, contract.DataSize)
	copy(data[:8], contract.Discriminator[:])
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
	fixture := signerIntentV2{
		Type: intentSolanaAgentCapitalAction, Cluster: "devnet", Action: "initialize_capital_offer",
		ProgramID: agentCapitalProgramIDV1, DataBase64: base64.StdEncoding.EncodeToString(data), Keys: keys,
	}
	intent, err := normalizeAgentCapitalIntentV2(fixture, wallet)
	if err != nil {
		t.Fatal(err)
	}
	if intent.Asset != "agent-capital:action" || intent.Amount.String() != "1" || intent.RequiredRole != "profile" {
		t.Fatalf("unexpected Agent Capital profile effect: %#v", intent)
	}
	policy, err := normalizeSignerPolicyV2(signerPolicyV2{
		WalletID: "profile", Role: "profile", Operations: []string{intent.PolicyOperation}, Programs: intent.RequiredPrograms,
		Assets: []signerPolicyAssetV2{
			{Asset: "agent-capital:action", Destinations: []string{agentCapitalProgramIDV1}, MaxPerTx: "1", MaxDaily: "1"},
			{Asset: "solana:native", Destinations: []string{agentCapitalProgramIDV1}, MaxPerTx: "6500000", MaxDaily: "6500000"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	reservations, err := policyReservationsForIntentV2(policy, intent)
	if err != nil {
		t.Fatal(err)
	}
	if len(reservations) != 2 || reservations[0].Asset != "agent-capital:action" || reservations[1].Asset != "solana:native" {
		t.Fatalf("unexpected Agent Capital reservations: %#v", reservations)
	}
}
