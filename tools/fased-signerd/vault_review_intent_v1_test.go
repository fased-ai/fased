package main

import (
	solana "github.com/gagliardetto/solana-go"
	"strings"
	"testing"
)

func TestVaultSemanticIntentV1(t *testing.T) {
	key := solana.NewWallet().PublicKey()
	input := signerIntentV2{Type: intentSolanaVaultMining, Cluster: "devnet", Action: "commit_vault_cycle", VaultMining: &signerVaultMiningIntentV1{
		Profile: key.String(), PermanentMining: solana.NewWallet().PublicKey().String(), Reference: "sha256:" + strings.Repeat("a", 64), CycleID: "43", CommittedLamports: "1000000000", AuthorityGeneration: "1", BindingGeneration: "1", ActivationGeneration: "7", MaxRentLamports: "5000000", MaxFeeLamports: "5000", MinFinalizedSlot: "101",
	}}
	normalized, err := normalizeSignerIntentForWalletV2(input, &key)
	if err != nil {
		t.Fatal(err)
	}
	if normalized.RequiredRole != "agent" || normalized.NativeFeeReservation.String() != "5005000" {
		t.Fatal("wrong bounded authority")
	}
	for _, mutate := range []func(*signerIntentV2){
		func(i *signerIntentV2) { i.Cluster = "mainnet" },
		func(i *signerIntentV2) { i.VaultMining.CycleID = "043" },
		func(i *signerIntentV2) { i.VaultMining.MaxRentLamports = "18446744073709551615" },
		func(i *signerIntentV2) { i.Action = "reveal_vault_cycle" },
		func(i *signerIntentV2) { i.VaultMining.Reference = "secret" },
	} {
		copyInput := input
		fields := *input.VaultMining
		copyInput.VaultMining = &fields
		mutate(&copyInput)
		if _, err := normalizeSignerIntentForWalletV2(copyInput, &key); err == nil {
			t.Fatal("accepted malformed Vault intent")
		}
	}
	input.Action = "reveal_vault_cycle"
	input.VaultMining.ActivationGeneration = "0"
	input.VaultMining.MaxRentLamports = "0"
	if _, err := normalizeSignerIntentForWalletV2(input, &key); err != nil {
		t.Fatal(err)
	}
}
