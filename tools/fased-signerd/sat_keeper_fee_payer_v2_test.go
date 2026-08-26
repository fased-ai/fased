package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"strings"
	"testing"

	"fased-signerd/internal/execution"
	solana "github.com/gagliardetto/solana-go"
)

func testKeeperCloseCommitIntentV2(t *testing.T, keeper, authority, program solana.PublicKey) signerIntentV2 {
	t.Helper()
	data := make([]byte, 9)
	data[0] = 90
	binary.LittleEndian.PutUint64(data[1:], 1)
	cycle := satTestPDA(t, program, []byte("sat_cycle_state"), data[1:])
	return signerIntentV2{
		Type: intentSolanaSATKeeperAction, AuthorityWalletID: "mining", Action: "closeCommitPhase",
		ProgramID: program.String(), DataBase64: base64.StdEncoding.EncodeToString(data),
		Keys: []signerSATAccountV2{
			satTestAccount(authority, true, false),
			satTestAccount(cycle, false, true),
		},
	}
}

func testKeeperPrivateKeyV2(t *testing.T) solana.PrivateKey {
	t.Helper()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate keeper key: %v", err)
	}
	return solana.PrivateKey(privateKey)
}

func TestKeeperFeePayerActionBoundaryV2(t *testing.T) {
	for _, action := range []string{
		"closeCommitPhase",
		"sealCycleEntropy",
		"releaseUnrevealedCommit",
		"abortEmptyCycle",
		"settleCyclePage",
		"finalizeCycleSettlement",
		"scoreCyclePage",
		"distributeCyclePage",
	} {
		if err := requireKeeperFeePayerActionV2(action); err != nil {
			t.Fatalf("keeper action %s was rejected: %v", action, err)
		}
	}

	for _, action := range []string{
		"depositMinerCapital",
		"withdrawMinerCapital",
		"setActiveCommit",
		"commitCycle",
		"revealCycle",
		"claimCycleRewards",
		"claimProtocolTreasury",
		"openBondPosition",
	} {
		if err := requireKeeperFeePayerActionV2(action); err == nil ||
			!strings.Contains(err.Error(), "not an allowlisted keeper action") {
			t.Fatalf("non-keeper action %s was not rejected safely: %v", action, err)
		}
	}
}

func TestKeeperFeePayerTransactionUsesTwoDistinctSignersV2(t *testing.T) {
	keeper := testKeeperPrivateKeyV2(t)
	authority := testKeeperPrivateKeyV2(t)
	program := solana.NewWallet().PublicKey()
	instruction := solana.NewInstruction(
		program,
		solana.AccountMetaSlice{
			&solana.AccountMeta{PublicKey: authority.PublicKey(), IsSigner: true, IsWritable: true},
		},
		[]byte{1},
	)

	tx, err := execution.NewSignedTypedTransactionWithFeePayer(
		[]solana.Instruction{instruction},
		solana.Hash{},
		keeper,
		[]solana.PrivateKey{authority},
		nil,
	)
	if err != nil {
		t.Fatalf("sign keeper transaction: %v", err)
	}
	if !tx.Message.AccountKeys[0].Equals(keeper.PublicKey()) {
		t.Fatalf("keeper key is not the transaction fee payer: %s", tx.Message.AccountKeys[0])
	}
	if len(tx.Signatures) != 2 || tx.Signatures[0].IsZero() || tx.Signatures[1].IsZero() {
		t.Fatalf("keeper transaction does not contain both required signatures: %#v", tx.Signatures)
	}
}

func TestKeeperFeePayerTransactionRejectsPrincipalAuthorityReuseV2(t *testing.T) {
	authority := testKeeperPrivateKeyV2(t)
	instruction := solana.NewInstruction(
		solana.NewWallet().PublicKey(),
		solana.AccountMetaSlice{
			&solana.AccountMeta{PublicKey: authority.PublicKey(), IsSigner: true},
		},
		[]byte{1},
	)
	_, err := execution.NewSignedTypedTransactionWithFeePayer(
		[]solana.Instruction{instruction},
		solana.Hash{},
		authority,
		[]solana.PrivateKey{authority},
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "fee payer must be distinct") {
		t.Fatalf("reused mining authority was not rejected: %v", err)
	}
}

func TestKeeperFeePayerIntentBindsKeeperPolicyAndMiningAuthorityV2(t *testing.T) {
	keeper := solana.NewWallet().PublicKey()
	authority := solana.NewWallet().PublicKey()
	program := solana.NewWallet().PublicKey()
	intent := testKeeperCloseCommitIntentV2(t, keeper, authority, program)
	normalized, err := normalizeKeeperFeePayerIntentV2(intent, keeper, "mining", authority)
	if err != nil {
		t.Fatalf("normalize keeper fee-payer intent: %v", err)
	}
	if normalized.RequiredRole != "keeper" || normalized.ParentIntent == nil || normalized.ParentIntent.RequiredRole != "mining" {
		t.Fatalf("keeper/mining authority roles were not independently bound: %#v", normalized)
	}
	if normalized.PolicyOperation != "satKeeperFee.closeCommitPhase@"+program.String() ||
		normalized.NativeFeeReservation == nil || normalized.NativeFeeReservation.Uint64() != 500_000 {
		t.Fatalf("keeper fee policy or cap was not bound: %#v", normalized)
	}
	runtime := signerRoleBaselineRuntimeV1{
		SATProgramID: program.String(), SATBondProgramID: solana.NewWallet().PublicKey().String(),
		SATMintAddress: solana.NewWallet().PublicKey().String(), SATMintProgramID: solana.TokenProgramID.String(), Verified: true,
	}
	keeperPolicy, err := compileSignerRoleBaselineV1(
		"keeper", keeper.String(), signerRoleBaselineRequestV1{Version: 1, Role: "keeper"}, runtime,
	)
	if err != nil {
		t.Fatalf("compile keeper policy: %v", err)
	}
	miningPolicy, err := compileSignerRoleBaselineV1(
		"mining", authority.String(), signerRoleBaselineRequestV1{Version: 1, Role: "mining"}, runtime,
	)
	if err != nil {
		t.Fatalf("compile mining policy: %v", err)
	}
	if _, err := policyReservationsForIntentV2(keeperPolicy, normalized); err != nil {
		t.Fatalf("keeper policy did not reserve the bounded fee: %v", err)
	}
	if _, err := policyAssetForIntentV2(miningPolicy, *normalized.ParentIntent); err != nil {
		t.Fatalf("Mining policy did not independently authorize keeper work: %v", err)
	}

	denied := satTestDepositIntent(t, authority, program, 1)
	denied.Type = intentSolanaSATKeeperAction
	denied.AuthorityWalletID = "mining"
	if _, err := normalizeKeeperFeePayerIntentV2(denied, keeper, "mining", authority); err == nil ||
		!strings.Contains(err.Error(), "not an allowlisted keeper action") {
		t.Fatalf("keeper lane accepted mining principal action: %v", err)
	}
}

func TestKeeperFeePayerCapabilityIsSignerOwnedBoundAndIdempotentV2(t *testing.T) {
	store, keys := openTestSignerV2(t)
	program := solana.NewWallet().PublicKey().String()
	mining, _, err := keys.CreateWithRoleBaseline(
		"mining",
		0,
		signerRoleBaselineRequestV1{Version: 1, Role: "mining"},
		signerRoleBaselineRuntimeV1{
			SATProgramID:     program,
			SATBondProgramID: solana.NewWallet().PublicKey().String(),
			SATMintAddress:   solana.NewWallet().PublicKey().String(),
			SATMintProgramID: solana.TokenProgramID.String(),
			Verified:         true,
		},
	)
	if err != nil {
		t.Fatalf("create Mining parent: %v", err)
	}
	service := &signerServiceV2{store: store, keys: keys}
	first, err := service.ensureKeeperFeePayerCapabilityV2(mining.WalletID)
	if err != nil {
		t.Fatalf("ensure Keeper fee payer: %v", err)
	}
	second, err := service.ensureKeeperFeePayerCapabilityV2(mining.WalletID)
	if err != nil || first != second {
		t.Fatalf("Keeper ensure was not idempotent: first=%#v second=%#v err=%v", first, second, err)
	}
	if first.FeePayerPublicKey == mining.PublicKey || first.FeePayerWalletID == mining.WalletID ||
		len(first.FeePayerWalletID) != 64 || !strings.HasPrefix(first.FeePayerWalletID, "sat_kfp_") ||
		first.MaxPerTransaction != "500000" || first.MaxDaily != "50000000" {
		t.Fatalf("Keeper capability is not authority/cap separated: %#v", first)
	}
	policy, err := store.getPolicy(first.FeePayerWalletID)
	if err != nil || policy.Role != "keeper" || containsStringV2(policy.Operations, intentSolanaNativeTransfer) {
		t.Fatalf("Keeper key exposed a general wallet policy: %#v err=%v", policy, err)
	}
}
