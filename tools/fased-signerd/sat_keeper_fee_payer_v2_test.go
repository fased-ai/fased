package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
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

func testKeeperSettleIntentGeneration2(
	t *testing.T,
	keeper, authority, program solana.PublicKey,
) signerIntentV2 {
	t.Helper()
	const cycleID uint64 = 9
	const pageIndex uint64 = 2
	const chunkIndex uint64 = 3
	cycle := make([]byte, 8)
	page := make([]byte, 8)
	binary.LittleEndian.PutUint64(cycle, cycleID)
	binary.LittleEndian.PutUint64(page, pageIndex)
	data := make([]byte, 25)
	data[0] = 122
	binary.LittleEndian.PutUint64(data[1:9], cycleID)
	binary.LittleEndian.PutUint64(data[9:17], pageIndex)
	binary.LittleEndian.PutUint64(data[17:25], chunkIndex)
	payout := solana.NewWallet().PublicKey()
	permanentMiningID := solana.NewWallet().PublicKey()
	return signerIntentV2{
		Type: intentSolanaSATKeeperAction, AuthorityWalletID: "mining", Action: "settleCyclePageV2",
		ProgramID: program.String(), DataBase64: base64.StdEncoding.EncodeToString(data),
		Keys: []signerSATAccountV2{
			satTestAccount(keeper, true, true),
			satTestAccount(payout, false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_cycle_state_v2"), cycle), false, false),
			satTestAccount(satTestPDA(t, program, []byte("sat_cycle_registry_meta"), cycle), false, false),
			satTestAccount(satTestPDA(t, program, []byte("sat_cycle_registry_page"), cycle, page), false, false),
			satTestAccount(satTestPDA(t, program, []byte("sat_cycle_settlement_progress_v3"), cycle), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_keeper_snapshot"), cycle), false, false),
			satTestAccount(solana.NewWallet().PublicKey(), false, false),
			satTestAccount(satTestPDA(t, program, []byte("sat_miner_cycle_state_v2"), authority[:], cycle), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_keeper_operating_reserve"), permanentMiningID[:]), false, true),
		},
		Context: &signerSATContextV2{
			MinerAuthorities:   []string{authority.String()},
			PermanentMiningIDs: []string{permanentMiningID.String()},
		},
	}
}

func testKeeperDistributeIntentGeneration2(
	t *testing.T,
	keeper, authority, permanentMiningID, program solana.PublicKey,
) signerIntentV2 {
	t.Helper()
	const cycleID uint64 = 10
	const pageIndex uint64 = 1
	cycle := make([]byte, 8)
	page := make([]byte, 8)
	binary.LittleEndian.PutUint64(cycle, cycleID)
	binary.LittleEndian.PutUint64(page, pageIndex)
	data := make([]byte, 25)
	data[0] = 125
	binary.LittleEndian.PutUint64(data[1:9], cycleID)
	binary.LittleEndian.PutUint64(data[9:17], pageIndex)
	return signerIntentV2{
		Type: intentSolanaSATKeeperAction, AuthorityWalletID: "mining", Action: "distributeCyclePageV2",
		ProgramID: program.String(), DataBase64: base64.StdEncoding.EncodeToString(data),
		Keys: []signerSATAccountV2{
			satTestAccount(keeper, true, true),
			satTestAccount(solana.NewWallet().PublicKey(), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_cycle_state_v2"), cycle), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_cycle_registry_page"), cycle, page), false, false),
			satTestAccount(satTestPDA(t, program, []byte("sat_cycle_settlement_progress_v3"), cycle), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_treasury_state_v2")), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_rebate_vault_v2")), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_treasury_vault_v2")), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_keeper_snapshot"), cycle), false, false),
			satTestAccount(solana.NewWallet().PublicKey(), false, false),
			satTestAccount(satTestPDA(t, program, []byte("sat_miner_cycle_state_v2"), authority[:], cycle), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_miner_capital_state"), authority[:]), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_agent_record"), permanentMiningID[:]), false, false),
			satTestAccount(satTestPDA(t, program, []byte("sat_agent_reward_remainder_v2"), permanentMiningID[:]), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_keeper_operating_reserve"), permanentMiningID[:]), false, true),
		},
		Context: &signerSATContextV2{
			MinerAuthorities:   []string{authority.String()},
			PermanentMiningIDs: []string{permanentMiningID.String()},
		},
	}
}

func testKeeperScoreIntentGeneration2(
	t *testing.T,
	keeper, authority, program solana.PublicKey,
) signerIntentV2 {
	t.Helper()
	intent := testKeeperSettleIntentGeneration2(t, keeper, authority, program)
	intent.Action = "scoreCyclePageV2"
	data, err := base64.StdEncoding.DecodeString(intent.DataBase64)
	if err != nil {
		t.Fatal(err)
	}
	data[0] = 124
	intent.DataBase64 = base64.StdEncoding.EncodeToString(data)
	intent.Keys = append(intent.Keys[:3], intent.Keys[4:]...)
	return intent
}

func testKeeperFinalizeIntentGeneration2(
	t *testing.T,
	keeper, program solana.PublicKey,
) signerIntentV2 {
	t.Helper()
	const cycleID uint64 = 11
	cycle := make([]byte, 8)
	binary.LittleEndian.PutUint64(cycle, cycleID)
	data := make([]byte, 9)
	data[0] = 123
	binary.LittleEndian.PutUint64(data[1:9], cycleID)
	return signerIntentV2{
		Type: intentSolanaSATKeeperAction, AuthorityWalletID: "mining", Action: "finalizeCycleSettlementV2",
		ProgramID: program.String(), DataBase64: base64.StdEncoding.EncodeToString(data),
		Keys: []signerSATAccountV2{
			satTestAccount(keeper, true, true),
			satTestAccount(solana.NewWallet().PublicKey(), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_global_state_v2")), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_protocol_generation_state_v2")), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_cycle_state_v2"), cycle), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_cycle_settlement_progress_v3"), cycle), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_cycle_registry_meta"), cycle), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_treasury_state_v2")), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_rebate_vault_v2")), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_treasury_vault_v2")), false, true),
			satTestAccount(solana.NewWallet().PublicKey(), false, false),
			satTestAccount(solana.NewWallet().PublicKey(), false, false),
			satTestAccount(satTestPDA(t, program, []byte("sat_keeper_snapshot"), cycle), false, false),
			satTestAccount(solana.NewWallet().PublicKey(), false, false),
		},
	}
}

func testKeeperRecordReceiptIntentGeneration2(
	t *testing.T,
	keeper, authority, permanentMiningID, program solana.PublicKey,
) signerIntentV2 {
	t.Helper()
	const cycleID uint64 = 12
	cycle := make([]byte, 8)
	binary.LittleEndian.PutUint64(cycle, cycleID)
	data := make([]byte, 25)
	data[0] = 134
	binary.LittleEndian.PutUint64(data[1:9], cycleID)
	binary.LittleEndian.PutUint64(data[9:17], 1)
	binary.LittleEndian.PutUint64(data[17:25], 1)
	return signerIntentV2{
		Type: intentSolanaSATKeeperAction, AuthorityWalletID: "mining", Action: "recordAgentCycleReceiptV2",
		ProgramID: program.String(), DataBase64: base64.StdEncoding.EncodeToString(data),
		Keys: []signerSATAccountV2{
			satTestAccount(keeper, true, false),
			satTestAccount(permanentMiningID, false, false),
			satTestAccount(satTestPDA(t, program, []byte("sat_agent_record"), permanentMiningID[:]), false, true),
			satTestAccount(satTestPDA(t, program, []byte("sat_cycle_state_v2"), cycle), false, false),
			satTestAccount(satTestPDA(t, program, []byte("sat_miner_cycle_state_v2"), authority[:], cycle), false, false),
			satTestAccount(satTestPDA(t, program, []byte("sat_cycle_settlement_progress_v3"), cycle), false, false),
		},
		Context: &signerSATContextV2{
			MinerAuthorities:   []string{authority.String()},
			PermanentMiningIDs: []string{permanentMiningID.String()},
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
		"openCycleV2",
		"closeCommitPhase",
		"closeCommitPhaseV2",
		"sealCycleEntropy",
		"snapshotKeeperCapabilitiesV2",
		"sealCycleEntropyV2",
		"releaseUnrevealedCommit",
		"releaseUnrevealedCommitV2",
		"abortEmptyCycle",
		"abortEmptyCycleV2",
		"settleCyclePage",
		"finalizeCycleSettlement",
		"scoreCyclePage",
		"distributeCyclePage",
		"settleCyclePageV2",
		"finalizeCycleSettlementV2",
		"scoreCyclePageV2",
		"distributeCyclePageV2",
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

func TestGeneration2KeeperUsesOnlyTheKeeperSigner(t *testing.T) {
	keeper := testKeeperPrivateKeyV2(t)
	authority := testKeeperPrivateKeyV2(t)
	program := solana.NewWallet().PublicKey()
	intent := testKeeperSettleIntentGeneration2(t, keeper.PublicKey(), authority.PublicKey(), program)
	normalized, err := normalizeKeeperFeePayerIntentV2(
		intent,
		keeper.PublicKey(),
		"mining",
		authority.PublicKey(),
	)
	if err != nil {
		t.Fatalf("normalize generation-2 keeper intent: %v", err)
	}
	if normalized.ParentIntent != nil || normalized.RequiredRole != "keeper" {
		t.Fatalf("generation-2 keeper retained Mining signing authority: %#v", normalized)
	}
	tx, err := execution.NewSignedTypedKeeperCapabilityTransaction(
		normalized.Instructions,
		solana.Hash{},
		keeper,
		nil,
	)
	if err != nil {
		t.Fatalf("sign generation-2 keeper transaction: %v", err)
	}
	if len(tx.Signatures) != 1 || tx.Signatures[0].IsZero() ||
		!tx.Message.AccountKeys[0].Equals(keeper.PublicKey()) {
		t.Fatalf("generation-2 keeper transaction is not single-capability signed: %#v", tx)
	}

	wrongSigner := cloneSATTestIntent(t, intent)
	wrongSigner.Keys[0] = satTestAccount(authority.PublicKey(), true, true)
	if _, err := normalizeKeeperFeePayerIntentV2(
		wrongSigner,
		keeper.PublicKey(),
		"mining",
		authority.PublicKey(),
	); err == nil || !strings.Contains(err.Error(), "signer account does not match") {
		t.Fatalf("generation-2 keeper accepted Mining authority as instruction signer: %v", err)
	}
}

func TestGeneration2StandaloneKeeperNeedsNoMiningParent(t *testing.T) {
	keeper := testKeeperPrivateKeyV2(t)
	minerIdentity := testKeeperPrivateKeyV2(t)
	program := solana.NewWallet().PublicKey()
	intent := testKeeperSettleIntentGeneration2(t, keeper.PublicKey(), minerIdentity.PublicKey(), program)
	intent.AuthorityWalletID = "keeper"
	normalized, err := normalizeKeeperFeePayerIntentV2(
		intent,
		keeper.PublicKey(),
		"keeper",
		keeper.PublicKey(),
	)
	if err != nil {
		t.Fatalf("normalize standalone generation-2 keeper intent: %v", err)
	}
	if normalized.ParentIntent != nil || normalized.RequiredRole != "keeper" {
		t.Fatalf("standalone generation-2 keeper retained a Mining parent: %#v", normalized)
	}
}

func TestGeneration2DistributionBindsPermanentIdentityTuples(t *testing.T) {
	keeper := solana.NewWallet().PublicKey()
	authority := solana.NewWallet().PublicKey()
	permanentMiningID := solana.NewWallet().PublicKey()
	program := solana.NewWallet().PublicKey()
	intent := testKeeperDistributeIntentGeneration2(
		t,
		keeper,
		authority,
		permanentMiningID,
		program,
	)
	if _, err := normalizeKeeperFeePayerIntentV2(intent, keeper, "mining", authority); err != nil {
		t.Fatalf("normalize generation-2 distribution tuple: %v", err)
	}

	tampered := cloneSATTestIntent(t, intent)
	tampered.Keys[12] = satTestAccount(
		satTestPDA(t, program, []byte("sat_agent_record"), authority[:]),
		false,
		false,
	)
	if _, err := normalizeKeeperFeePayerIntentV2(tampered, keeper, "mining", authority); err == nil ||
		!strings.Contains(err.Error(), "distribution agent record") {
		t.Fatalf("generation-2 distribution accepted a replaceable authority as AgentRecord: %v", err)
	}
}

func TestGeneration2ScoreAndFinalizeUseAmendedKeeperAccountOrders(t *testing.T) {
	keeper := solana.NewWallet().PublicKey()
	authority := solana.NewWallet().PublicKey()
	program := solana.NewWallet().PublicKey()
	for _, intent := range []signerIntentV2{
		testKeeperScoreIntentGeneration2(t, keeper, authority, program),
		testKeeperFinalizeIntentGeneration2(t, keeper, program),
	} {
		if _, err := normalizeKeeperFeePayerIntentV2(intent, keeper, "mining", authority); err != nil {
			t.Fatalf("normalize amended generation-2 %s account order: %v", intent.Action, err)
		}
	}
}

func TestGeneration2KeeperReceiptBindsMinerAndPermanentIdentity(t *testing.T) {
	keeper := solana.NewWallet().PublicKey()
	authority := solana.NewWallet().PublicKey()
	permanentMiningID := solana.NewWallet().PublicKey()
	program := solana.NewWallet().PublicKey()
	intent := testKeeperRecordReceiptIntentGeneration2(t, keeper, authority, permanentMiningID, program)
	if _, err := normalizeKeeperFeePayerIntentV2(intent, keeper, "mining", authority); err != nil {
		t.Fatalf("normalize generation-2 receipt intent: %v", err)
	}

	tampered := cloneSATTestIntent(t, intent)
	tampered.Keys[4] = satTestAccount(
		satTestPDA(t, program, []byte("sat_miner_cycle_state_v2"), permanentMiningID[:], []byte{12, 0, 0, 0, 0, 0, 0, 0}),
		false,
		false,
	)
	if _, err := normalizeKeeperFeePayerIntentV2(tampered, keeper, "mining", authority); err == nil ||
		!strings.Contains(err.Error(), "miner cycle state v2") {
		t.Fatalf("generation-2 receipt accepted a miner-cycle identity mismatch: %v", err)
	}

	tampered = cloneSATTestIntent(t, intent)
	tampered.Context.PermanentMiningIDs = []string{authority.String()}
	if _, err := normalizeKeeperFeePayerIntentV2(tampered, keeper, "mining", authority); err == nil ||
		!strings.Contains(err.Error(), "permanent identity mismatch") {
		t.Fatalf("generation-2 receipt accepted a permanent identity mismatch: %v", err)
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

func TestStandaloneKeeperCapabilityUsesItsOwnBoundedWalletV2(t *testing.T) {
	store, keys := openTestSignerV2(t)
	program := solana.NewWallet().PublicKey().String()
	keeper, _, err := keys.CreateWithRoleBaseline(
		"dedicated-keeper",
		0,
		signerRoleBaselineRequestV1{Version: 1, Role: "keeper"},
		signerRoleBaselineRuntimeV1{SATProgramID: program, Verified: true},
	)
	if err != nil {
		t.Fatalf("create standalone Keeper: %v", err)
	}
	service := &signerServiceV2{store: store, keys: keys}
	capability, err := service.keeperFeePayerCapabilityV2(keeper.WalletID)
	if err != nil {
		t.Fatalf("read standalone Keeper capability: %v", err)
	}
	if capability.MiningWalletID != keeper.WalletID ||
		capability.FeePayerWalletID != keeper.WalletID ||
		capability.FeePayerPublicKey != keeper.PublicKey ||
		capability.MaxPerTransaction != roleBaselineKeeperMaxPerTxV1 ||
		capability.MaxDaily != roleBaselineKeeperMaxDailyV1 {
		t.Fatalf("standalone Keeper capability is not self-contained and capped: %#v", capability)
	}
}

func TestStandaloneKeeperProvisioningIsReachableThroughControlOperationV2(t *testing.T) {
	configureTestSignerMiningRuntimeV1(t)
	store, keys := openTestSignerV2(t)
	service := &signerServiceV2{store: store, keys: keys}
	body, err := json.Marshal(signerKeeperFeePayerEnsureRequestV2{Standalone: true})
	if err != nil {
		t.Fatal(err)
	}
	req := request{Op: "v2.keeperFeePayer.ensure", WalletID: "dedicated-keeper", Request: body}
	raw, err := service.handle(req, signerConfig{}, true)
	if err != nil {
		t.Fatalf("provision standalone Keeper through control operation: %v", err)
	}
	var firstEnvelope struct {
		Result signerKeeperFeePayerCapabilityV2 `json:"result"`
	}
	if err := json.Unmarshal(raw, &firstEnvelope); err != nil {
		t.Fatal(err)
	}
	secondRaw, err := service.handle(req, signerConfig{}, true)
	if err != nil {
		t.Fatalf("repeat standalone Keeper provisioning: %v", err)
	}
	var secondEnvelope struct {
		Result signerKeeperFeePayerCapabilityV2 `json:"result"`
	}
	if err := json.Unmarshal(secondRaw, &secondEnvelope); err != nil {
		t.Fatal(err)
	}
	first := firstEnvelope.Result
	second := secondEnvelope.Result
	if first != second || first.MiningWalletID != "dedicated_keeper" ||
		first.FeePayerWalletID != "dedicated_keeper" || first.State != "ready" {
		t.Fatalf("standalone Keeper control operation is not bounded and idempotent: first=%#v second=%#v", first, second)
	}
	policy, err := store.getPolicy(first.FeePayerWalletID)
	if err != nil || policy.Role != "keeper" || containsStringV2(policy.Operations, intentSolanaNativeTransfer) {
		t.Fatalf("standalone Keeper control operation exposed a general wallet policy: %#v err=%v", policy, err)
	}
}
