package main

import (
	"math/big"
	"strings"
	"testing"

	"fased-signerd/internal/execution"
	solana "github.com/gagliardetto/solana-go"
	rpc "github.com/gagliardetto/solana-go/rpc"
)

func moneyFoundationIntentFixtureV2(t *testing.T, wallet, positionMint solana.PublicKey) signerIntentV2 {
	t.Helper()
	addresses, err := deriveMoneyFoundationAddressesV2(wallet, positionMint)
	if err != nil {
		t.Fatal(err)
	}
	return signerIntentV2{
		Type: intentSolanaMoneyFoundation, Cluster: "devnet",
		MoneyFoundation: &signerMoneyFoundationIntentV2{
			ContractGeneration: 1, PolicyGeneration: "1",
			PolicyDigestSHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			Action:             "ADD_POL", SourceClass: "OWNER_SEED", SourceOwner: wallet.String(), DestinationOwner: wallet.String(),
			Lifecycle: "ENABLED", FundingAuthorized: true, PublicEntryEnabled: false,
			LiquidityTreasury: wallet.String(), EmergencyAuthority: solana.NewWallet().PublicKey().String(),
			EmergencyUnwindNotBefore: "0", SATMint: moneyFoundationSATMintV1,
			SATTokenProgram: solana.TokenProgramID.String(), WrappedSOLMint: moneyFoundationWSOLMintV1,
			VenueProgram: moneyFoundationMeteoraProgramV1, PoolConfig: moneyFoundationPoolConfigV1,
			Pool: addresses.Pool.String(), PositionMint: positionMint.String(),
			PositionTokenAccount: addresses.PositionTokenAccount.String(), SATVault: addresses.SATVault.String(), SOLVault: addresses.SOLVault.String(),
			InitialSATRaw: "50000000000", InitialSOLLamports: "2500000", InputRaw: "50000000000",
			MinimumSATRaw: "0", MinimumSOLLamports: "0", MaxSlippageBPS: 100, MaxPriceImpactBPS: 1000,
			MaxCombinedFeeBPS: 1000, SimulationSlot: "100", ExpiresSlot: "200",
			SourceDescriptorSHA256:    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			ProtectedCapitalAddresses: []string{solana.NewWallet().PublicKey().String()},
		},
	}
}

func TestMoneyFoundationDerivesPinnedDevnetPool(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	positionMint := solana.MustPublicKeyFromBase58("FasEdZ9BAsboUPF2TUQjLaapC8arcAkV5fRnMtV2G1Ev")
	addresses, err := deriveMoneyFoundationAddressesV2(wallet, positionMint)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := addresses.Pool.String(), "2jLvTwU9f9s9wHbnR8Lkq8xMqeSbuws5RRW1cYDua2DK"; got != want {
		t.Fatalf("pool = %s, want %s", got, want)
	}
	if got, want := addresses.PoolAuthority.String(), "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"; got != want {
		t.Fatalf("pool authority = %s, want %s", got, want)
	}
}

func TestNormalizeMoneyFoundationAddPOLReservesSOLAndSAT(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	positionMint := solana.NewWallet().PublicKey()
	normalized, err := normalizeSignerIntentForWalletV2(moneyFoundationIntentFixtureV2(t, wallet, positionMint), &wallet)
	if err != nil {
		t.Fatal(err)
	}
	if normalized.RequiredRole != "vault" || normalized.Asset != "solana:native" || normalized.Amount.String() != "2500000" {
		t.Fatalf("unexpected primary effect: role=%s asset=%s amount=%s", normalized.RequiredRole, normalized.Asset, normalized.Amount)
	}
	if len(normalized.AdditionalReservations) != 1 || normalized.AdditionalReservations[0].Asset != "solana:spl:"+moneyFoundationSATMintV1 || normalized.AdditionalReservations[0].Amount.String() != "50000000000" {
		t.Fatalf("unexpected SAT reservation: %+v", normalized.AdditionalReservations)
	}
}

func TestSignMoneyFoundationPreservesOnlyEphemeralPositionSignature(t *testing.T) {
	vault := solana.NewWallet()
	position := solana.NewWallet()
	instruction := solana.NewInstruction(
		solana.SystemProgramID,
		solana.AccountMetaSlice{
			&solana.AccountMeta{PublicKey: vault.PublicKey(), IsSigner: true, IsWritable: true},
			&solana.AccountMeta{PublicKey: position.PublicKey(), IsSigner: true, IsWritable: true},
		},
		[]byte{1},
	)
	tx, err := solana.NewTransaction([]solana.Instruction{instruction}, solana.Hash{1}, solana.TransactionPayer(vault.PublicKey()))
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.PartialSign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(position.PublicKey()) {
			copy := position.PrivateKey
			return &copy
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	preserved := tx.Signatures[1]
	raw, signature, err := execution.SignValidatedMoneyFoundationTransaction(tx, 0, 1, vault.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) == 0 || signature.IsZero() || tx.Signatures[1] != preserved {
		t.Fatal("reviewed money-foundation signer did not preserve both exact signatures")
	}
}

func TestMoneyFoundationAddPOLRequiresExactSimulatedSATDebit(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	intent := moneyFoundationIntentFixtureV2(t, wallet, solana.NewWallet().PublicKey()).MoneyFoundation
	sat := solana.MustPublicKeyFromBase58(moneyFoundationSATMintV1)
	wsol := solana.MustPublicKeyFromBase58(moneyFoundationWSOLMintV1)
	pre := []*rpc.Account{
		rpcAccountV2(t, solana.SystemProgramID, 10_000_000, nil),
		tokenAccountV2(t, sat, wallet, 60_000_000_000),
		tokenAccountV2(t, wsol, wallet, 7),
	}
	post := []*rpc.Account{
		rpcAccountV2(t, solana.SystemProgramID, 7_000_000, nil),
		tokenAccountV2(t, sat, wallet, 10_000_000_000),
		tokenAccountV2(t, wsol, wallet, 7),
	}
	if err := validateMoneyFoundationAccountDeltasV2(*intent, wallet, pre, post, big.NewInt(1_000_000)); err != nil {
		t.Fatalf("exact SAT debit was rejected: %v", err)
	}
	post[1] = tokenAccountV2(t, sat, wallet, 10_000_000_001)
	if err := validateMoneyFoundationAccountDeltasV2(*intent, wallet, pre, post, big.NewInt(1_000_000)); err == nil || !strings.Contains(err.Error(), "exact reviewed SAT") {
		t.Fatalf("inexact SAT debit was accepted: %v", err)
	}
}

func TestMoneyFoundationEmergencyRequiresBothMinimumReturns(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	intent := moneyFoundationIntentFixtureV2(t, wallet, solana.NewWallet().PublicKey()).MoneyFoundation
	intent.Action = "EMERGENCY_UNWIND"
	intent.MinimumSATRaw = "100"
	intent.MinimumSOLLamports = "200"
	sat := solana.MustPublicKeyFromBase58(moneyFoundationSATMintV1)
	wsol := solana.MustPublicKeyFromBase58(moneyFoundationWSOLMintV1)
	pre := []*rpc.Account{
		rpcAccountV2(t, solana.SystemProgramID, 1_000, nil),
		tokenAccountV2(t, sat, wallet, 10),
		tokenAccountV2(t, wsol, wallet, 50),
	}
	post := []*rpc.Account{
		rpcAccountV2(t, solana.SystemProgramID, 1_150, nil),
		tokenAccountV2(t, sat, wallet, 110),
		tokenAccountV2(t, wsol, wallet, 50),
	}
	if err := validateMoneyFoundationAccountDeltasV2(*intent, wallet, pre, post, big.NewInt(50)); err != nil {
		t.Fatalf("minimum returns after bounded fee were rejected: %v", err)
	}
	post[1] = tokenAccountV2(t, sat, wallet, 109)
	if err := validateMoneyFoundationAccountDeltasV2(*intent, wallet, pre, post, big.NewInt(50)); err == nil || !strings.Contains(err.Error(), "SAT return") {
		t.Fatalf("sub-minimum SAT return was accepted: %v", err)
	}
	post[1] = tokenAccountV2(t, sat, wallet, 110)
	post[0] = rpcAccountV2(t, solana.SystemProgramID, 1_149, nil)
	if err := validateMoneyFoundationAccountDeltasV2(*intent, wallet, pre, post, big.NewInt(50)); err == nil || !strings.Contains(err.Error(), "SOL return") {
		t.Fatalf("sub-minimum SOL return was accepted: %v", err)
	}
}

func TestMoneyFoundationEmergencyRejectsAnyAuxiliaryValueInstruction(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	positionMint := solana.NewWallet().PublicKey()
	intent := moneyFoundationIntentFixtureV2(t, wallet, positionMint).MoneyFoundation
	intent.Action = "EMERGENCY_UNWIND"
	addresses, err := deriveMoneyFoundationAddressesV2(wallet, positionMint)
	if err != nil {
		t.Fatal(err)
	}
	canonical := solana.AccountMetaSlice{
		{PublicKey: wallet, IsSigner: true, IsWritable: true},
		{PublicKey: addresses.PoolAuthority}, {PublicKey: addresses.Pool}, {PublicKey: addresses.Position},
		{PublicKey: addresses.PositionTokenAccount}, {PublicKey: addresses.TreasurySATAccount},
		{PublicKey: addresses.TreasurySOLAccount}, {PublicKey: addresses.SATVault}, {PublicKey: addresses.SOLVault},
		{PublicKey: positionMint}, {PublicKey: solana.MustPublicKeyFromBase58(moneyFoundationSATMintV1)},
		{PublicKey: solana.MustPublicKeyFromBase58(moneyFoundationWSOLMintV1)}, {PublicKey: solana.TokenProgramID},
		{PublicKey: solana.Token2022ProgramID}, {PublicKey: addresses.EventAuthority},
	}
	meteora := solana.MustPublicKeyFromBase58(moneyFoundationMeteoraProgramV1)
	instructions := []solana.Instruction{
		solana.NewInstruction(meteora, canonical, moneyFoundationClaimFeeDiscriminatorV1),
		solana.NewInstruction(meteora, solana.AccountMetaSlice{{PublicKey: wallet, IsSigner: true}}, moneyFoundationRemoveAllDiscriminatorV1),
		solana.NewInstruction(meteora, solana.AccountMetaSlice{{PublicKey: wallet, IsSigner: true}}, moneyFoundationClosePositionDiscriminatorV1),
		solana.NewInstruction(solana.TokenProgramID, solana.AccountMetaSlice{
			{PublicKey: addresses.TreasurySOLAccount, IsWritable: true},
			{PublicKey: wallet, IsWritable: true},
			{PublicKey: wallet, IsSigner: true},
		}, []byte{9}),
	}
	tx, err := solana.NewTransaction(instructions, solana.Hash{1}, solana.TransactionPayer(wallet))
	if err != nil {
		t.Fatal(err)
	}
	if err := validateMoneyFoundationEmergencyV2(tx, wallet, *intent, addresses); err != nil {
		t.Fatalf("canonical emergency sequence was rejected: %v", err)
	}
	malicious := append([]solana.Instruction(nil), instructions[:3]...)
	malicious = append(malicious,
		solana.NewInstruction(solana.SystemProgramID, solana.AccountMetaSlice{
			{PublicKey: wallet, IsSigner: true, IsWritable: true},
			{PublicKey: solana.NewWallet().PublicKey(), IsWritable: true},
		}, make([]byte, 12)),
		instructions[3],
	)
	tx, err = solana.NewTransaction(malicious, solana.Hash{1}, solana.TransactionPayer(wallet))
	if err != nil {
		t.Fatal(err)
	}
	if err := validateMoneyFoundationEmergencyV2(tx, wallet, *intent, addresses); err == nil || !strings.Contains(err.Error(), "unreviewed program") {
		t.Fatalf("auxiliary System transfer was accepted: %v", err)
	}
}
