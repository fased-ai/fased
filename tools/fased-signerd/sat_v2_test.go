package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
)

func satTestPDA(t *testing.T, program solana.PublicKey, seeds ...[]byte) solana.PublicKey {
	t.Helper()
	address, _, err := solana.FindProgramAddress(seeds, program)
	if err != nil {
		t.Fatalf("derive test PDA: %v", err)
	}
	return address
}

func TestSignerV2SATGeneratedManifestAndSemanticValidatorsAreComplete(t *testing.T) {
	const expected = "abortEmptyCycle,cancelBondUnlock,claimBondStakingRewards,claimCycleRewards,claimCycleRewardsBatch,claimProtocolDistributorSat,claimProtocolTreasury,claimUnallocatedStakingRewards,closeCommitPhase,closeResolvedCycleArtifacts,closeResolvedCycleRegistryPage,closeResolvedMinerCycleState,commitCycle,compactPendingCycleRange,depositMinerCapital,distributeCyclePage,finalizeBondUnlock,finalizeCycleSettlement,increaseBondPosition,initMinerCapital,initializeCycle,openBondPosition,openCycle,openDispute,refillRegistryReserveFromTreasury,releaseUnrevealedCommit,republishEpochRoots,requestBondUnlock,resolveDispute,retargetUnlock,revealCycle,scoreCyclePage,sealCycleEntropy,setActiveCommit,settleCyclePage,syncBondStakingPosition,syncBondStakingRewards,topUpRegistryReserve,updateBondTierPolicy,validatorAttestation,withdrawMinerCapital"
	actions := sortedSATActionsV2()
	if len(actions) != 41 || strings.Join(actions, ",") != expected {
		t.Fatalf("generated SAT signer manifest is incomplete: %s", strings.Join(actions, ","))
	}
	wallet, program, contextKey := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey().String()
	for _, action := range actions {
		t.Run(action, func(t *testing.T) {
			codec := signerSATCodecsV2[action]
			if codec.Action != action || codec.AccountShape == "" || (codec.Family != satFamilyMain && codec.Family != satFamilyBond) {
				t.Fatalf("invalid generated SAT codec: %#v", codec)
			}
			dataLength := codec.DataLength
			if dataLength < 0 {
				dataLength = 17
			}
			data := make([]byte, dataLength)
			data[0] = codec.Discriminator
			context := (*signerSATContextV2)(nil)
			extraAccounts := 0
			switch action {
			case "validatorAttestation", "openDispute":
				context = &signerSATContextV2{TargetAuthority: contextKey}
			case "resolveDispute":
				context = &signerSATContextV2{DisputeAuthority: contextKey}
			case "sealCycleEntropy":
				context = &signerSATContextV2{IntervalStartCycleID: "0"}
			case "revealCycle":
				context = &signerSATContextV2{IntervalStartCycleID: "0", RegistryPageIndex: "0"}
			case "claimCycleRewardsBatch":
				data[1] = 1
				extraAccounts = 7
			case "compactPendingCycleRange":
				binary.LittleEndian.PutUint64(data[1:9], 1)
				binary.LittleEndian.PutUint64(data[9:17], 1)
				data[17] = 1
				context = &signerSATContextV2{FrontCycleIDs: []string{"1"}, BackCycleIDs: []string{}}
				extraAccounts = 1
			}
			accountCount := len(strings.Split(codec.AccountShape, ",")) + extraAccounts
			accounts := make(solana.AccountMetaSlice, accountCount)
			wireKeys := make([]signerSATAccountV2, accountCount)
			for index := range accounts {
				key := solana.NewWallet().PublicKey()
				accounts[index] = &solana.AccountMeta{PublicKey: key}
				wireKeys[index] = signerSATAccountV2{Pubkey: key.String()}
			}
			instruction := normalizedSATInstructionV2{
				Wire:    signerSATInstructionV2{Action: action, Context: context, Keys: wireKeys},
				Program: program, Data: data, Accounts: accounts, Codec: codec,
			}
			if err := validateSATSemanticsV2(instruction, wallet); err != nil && strings.Contains(err.Error(), "has no semantic validator") {
				t.Fatal(err)
			}
		})
	}
}

func TestSignerV2Generation2ActionsHaveSemanticValidators(t *testing.T) {
	wallet, program := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	identity, authority := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	for action, generated := range signerSATCodecsGeneration2 {
		if action == "bootstrapV2" || action == "setVnextEntryEnabled" || action == "migrateAgentRecordV2" || action == "claimProtocolDistributorSatV2" {
			continue
		}
		t.Run(action, func(t *testing.T) {
			length := generated.DataLength
			if length < 0 {
				length = 17
			}
			data := make([]byte, length)
			data[0] = generated.Discriminator
			if action == "claimCycleRewardsBatchV2" {
				data[1] = 1
			}
			if action == "releaseUnrevealedCommitV2" {
				copy(data[9:41], identity[:])
			}
			accountCount := len(strings.Split(generated.AccountShape, ",")) + 10
			accounts := make(solana.AccountMetaSlice, accountCount)
			for index := range accounts {
				accounts[index] = &solana.AccountMeta{PublicKey: solana.NewWallet().PublicKey()}
			}
			context := &signerSATContextV2{}
			switch action {
			case "commitCycleV2", "claimCycleRewardsV2", "claimCycleRewardsBatchV2", "closeResolvedMinerCycleStateV2":
				context.PermanentMiningIDs = []string{identity.String()}
			case "releaseUnrevealedCommitV2":
				context.PermanentMiningIDs = []string{identity.String()}
				context.MinerAuthorities = []string{authority.String()}
			case "revealCycleV2":
				context.RegistryPageIndex = "0"
				context.PermanentMiningIDs = []string{identity.String()}
			case "settleCyclePageV2", "scoreCyclePageV2", "distributeCyclePageV2":
				context.MinerAuthorities = []string{authority.String()}
				context.PermanentMiningIDs = []string{identity.String()}
			default:
				context = nil
			}
			instruction := normalizedSATInstructionV2{
				Wire:    signerSATInstructionV2{Action: action, Context: context},
				Program: program, Data: data, Accounts: accounts,
				Codec: signerSATCodecV2{Action: action},
			}
			if err := validateSATSemanticsV2(instruction, wallet); err != nil && strings.Contains(err.Error(), "has no semantic validator") {
				t.Fatal(err)
			}
		})
	}
}

func TestSignerV2Generation2InitMinerCapitalBindsAgentRecord(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	program := solana.NewWallet().PublicKey()
	permanentMiningID := solana.NewWallet().PublicKey()
	agentRecord := satTestPDA(t, program, []byte("sat_agent_record"), permanentMiningID[:])
	capital := satTestPDA(t, program, []byte("sat_miner_capital_state"), wallet[:])
	data := make([]byte, 33)
	data[0] = signerSATCodecsV2["initMinerCapital"].Discriminator
	copy(data[1:], wallet[:])
	input := signerSATInstructionV2{
		Action: "initMinerCapital", ProgramID: program.String(),
		DataBase64: base64.StdEncoding.EncodeToString(data),
		Keys: []signerSATAccountV2{
			{Pubkey: wallet.String(), IsSigner: true, IsWritable: true},
			{Pubkey: permanentMiningID.String()},
			{Pubkey: agentRecord.String()},
			{Pubkey: capital.String(), IsWritable: true},
			{Pubkey: solana.SystemProgramID.String()},
		},
	}
	normalized, err := normalizeSATInstructionV2(input, wallet)
	if err != nil {
		t.Fatalf("normalize generation-2 init miner capital: %v", err)
	}
	if err := validateSATInstructionV2(normalized, wallet); err != nil {
		t.Fatalf("validate generation-2 init miner capital: %v", err)
	}
	tampered := input
	tampered.Keys = append([]signerSATAccountV2(nil), input.Keys...)
	tampered.Keys[2].Pubkey = solana.NewWallet().PublicKey().String()
	if _, err = normalizeSATInstructionV2(tampered, wallet); err == nil ||
		!strings.Contains(err.Error(), "agent record") {
		t.Fatalf("tampered AgentRecord was not rejected: %v", err)
	}
}

func satTestAccount(key solana.PublicKey, signer, writable bool) signerSATAccountV2 {
	return signerSATAccountV2{Pubkey: key.String(), IsSigner: signer, IsWritable: writable}
}

func satTestDepositIntent(t *testing.T, wallet, program solana.PublicKey, amount uint64) signerIntentV2 {
	t.Helper()
	data := make([]byte, 9)
	data[0] = 37
	binary.LittleEndian.PutUint64(data[1:], amount)
	capital := satTestPDA(t, program, []byte("sat_miner_capital_state"), wallet[:])
	return signerIntentV2{
		Type: intentSolanaSATAction, Action: "depositMinerCapital", ProgramID: program.String(),
		DataBase64: base64.StdEncoding.EncodeToString(data),
		Keys: []signerSATAccountV2{
			satTestAccount(wallet, true, true),
			satTestAccount(capital, false, true),
			satTestAccount(solana.SystemProgramID, false, false),
		},
	}
}

func cloneSATTestIntent(t *testing.T, input signerIntentV2) signerIntentV2 {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	var out signerIntentV2
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestSignerV2SATContextPreservesOmittedFields(t *testing.T) {
	target := solana.NewWallet().PublicKey().String()
	context, err := normalizeSATContextV2(&signerSATContextV2{TargetAuthority: target})
	if err != nil {
		t.Fatalf("normalize SAT semantic context: %v", err)
	}
	if context.FrontCycleIDs != nil || context.BackCycleIDs != nil || context.MinerAuthorities != nil {
		t.Fatalf("omitted SAT context fields must stay omitted: %#v", context)
	}
	if err := validateSATContextForActionV2("validatorAttestation", context); err != nil {
		t.Fatalf("target-only validator context should be accepted: %v", err)
	}
	if _, err := normalizeSATContextV2(&signerSATContextV2{MinerAuthorities: []string{target, target}}); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("duplicate SAT miner authorities must be rejected, got %v", err)
	}
	batchData := make([]byte, 25)
	batchData[0], batchData[1] = 62, 2
	binary.LittleEndian.PutUint64(batchData[9:17], 42)
	binary.LittleEndian.PutUint64(batchData[17:25], 42)
	if err := validateSATCanonicalPaddingV2("claimCycleRewardsBatch", batchData); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("duplicate SAT claim cycles must be rejected, got %v", err)
	}
}

func TestSignerV2TypedSATDepositNormalizesAmountProgramsAndProgramBoundOperation(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	program := solana.NewWallet().PublicKey()
	intent := satTestDepositIntent(t, wallet, program, 250_000_000)
	normalized, err := normalizeSignerIntentForWalletV2(intent, &wallet)
	if err != nil {
		t.Fatalf("normalize typed SAT deposit: %v", err)
	}
	if normalized.Asset != "solana:native" || normalized.Amount.Uint64() != 250_000_000 {
		t.Fatalf("unexpected SAT accounting: asset=%s amount=%s", normalized.Asset, normalized.Amount)
	}
	if normalized.PolicyOperation != "sat.depositMinerCapital@"+program.String() {
		t.Fatalf("SAT policy operation is not program-bound: %s", normalized.PolicyOperation)
	}
	if normalized.RequiredRole != "mining" {
		t.Fatalf("SAT mining intent is not permanently bound to the Mining role: %#v", normalized)
	}
	capital := satTestPDA(t, program, []byte("sat_miner_capital_state"), wallet[:])
	if normalized.Destination != capital.String() {
		t.Fatalf("SAT deposit policy destination is not the exact miner capital PDA: %s", normalized.Destination)
	}
	if len(normalized.Instructions) != 1 || !normalized.Instructions[0].ProgramID().Equals(program) {
		t.Fatalf("unexpected typed SAT instruction: %#v", normalized.Instructions)
	}
	if !containsStringV2(normalized.RequiredPrograms, program.String()) || !containsStringV2(normalized.RequiredPrograms, solana.SystemProgramID.String()) {
		t.Fatalf("typed SAT required programs are incomplete: %#v", normalized.RequiredPrograms)
	}
	policy, err := normalizeSignerPolicyV2(signerPolicyV2{
		WalletID: "mining", Role: "mining",
		Operations: []string{normalized.PolicyOperation}, Programs: normalized.RequiredPrograms,
		Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{capital.String()}, MaxPerTx: "300000000", MaxDaily: "500000000"}},
	})
	if err != nil {
		t.Fatalf("normalize SAT policy: %v", err)
	}
	if _, err := policyAssetForIntentV2(policy, normalized); err != nil {
		t.Fatalf("program-bound policy should allow exact SAT deposit: %v", err)
	}
	for _, role := range []string{"agent", "vault"} {
		crossRole := policy
		crossRole.Role = role
		if _, err := policyAssetForIntentV2(crossRole, normalized); err == nil || !strings.Contains(err.Error(), "cannot authorize mining") {
			t.Fatalf("%s role authorized a Mining SAT operation despite exact policy grants: %v", role, err)
		}
	}
	policy.Operations = []string{"sat.depositMinerCapital@" + solana.NewWallet().PublicKey().String()}
	if _, err := policyAssetForIntentV2(policy, normalized); err == nil || !strings.Contains(err.Error(), "denies operation") {
		t.Fatalf("policy must reject action/program mismatch, got %v", err)
	}
}

func TestSignerV2TypedSATActiveCommitUsesCapitalExposureCap(t *testing.T) {
	wallet, program := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	capital := satTestPDA(t, program, []byte("sat_miner_capital_state"), wallet[:])
	data := make([]byte, 9)
	data[0] = 68
	binary.LittleEndian.PutUint64(data[1:], 250_000_000)
	intent := signerIntentV2{
		Type: intentSolanaSATAction, Action: "setActiveCommit", ProgramID: program.String(),
		DataBase64: base64.StdEncoding.EncodeToString(data),
		Keys: []signerSATAccountV2{
			satTestAccount(wallet, true, false), satTestAccount(capital, false, true),
		},
	}
	normalized, err := normalizeSignerIntentForWalletV2(intent, &wallet)
	if err != nil {
		t.Fatalf("normalize SAT active commit: %v", err)
	}
	if normalized.Asset != "sat:capital:lamports" || normalized.Amount.Uint64() != 250_000_000 || normalized.Destination != capital.String() {
		t.Fatalf("active commit must be capped as exact capital exposure: asset=%s amount=%s destination=%s", normalized.Asset, normalized.Amount, normalized.Destination)
	}
	zero := intent
	zeroData := append([]byte(nil), data...)
	binary.LittleEndian.PutUint64(zeroData[1:], 0)
	zero.DataBase64 = base64.StdEncoding.EncodeToString(zeroData)
	if _, err := normalizeSignerIntentForWalletV2(zero, &wallet); err == nil || !strings.Contains(err.Error(), "must be positive") {
		t.Fatalf("zero active-commit exposure was accepted into durable reservations: %v", err)
	}
}

func TestSignerV2TypedSATRejectsMalformedPayloadAccountsAndActionMismatch(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	program := solana.NewWallet().PublicKey()
	valid := satTestDepositIntent(t, wallet, program, 100)
	tests := []struct {
		name   string
		mutate func(*signerIntentV2)
		want   string
	}{
		{name: "action discriminator mismatch", mutate: func(input *signerIntentV2) { input.Action = "withdrawMinerCapital" }, want: "discriminator mismatch"},
		{name: "payload length", mutate: func(input *signerIntentV2) { input.DataBase64 = base64.StdEncoding.EncodeToString([]byte{37}) }, want: "payload must contain 9 bytes"},
		{name: "signer flags", mutate: func(input *signerIntentV2) { input.Keys[0].IsSigner = false }, want: "flags mismatch"},
		{name: "wrong PDA", mutate: func(input *signerIntentV2) { input.Keys[1].Pubkey = solana.NewWallet().PublicKey().String() }, want: "miner capital"},
		{name: "wrong system program", mutate: func(input *signerIntentV2) { input.Keys[2].Pubkey = solana.NewWallet().PublicKey().String() }, want: "system program"},
		{name: "unexpected semantic context", mutate: func(input *signerIntentV2) { input.Context = &signerSATContextV2{RegistryPageIndex: "1"} }, want: "rejects context field"},
		{name: "unknown action", mutate: func(input *signerIntentV2) { input.Action = "rawInstruction" }, want: "unsupported typed SAT action"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := cloneSATTestIntent(t, valid)
			test.mutate(&input)
			_, err := normalizeSignerIntentForWalletV2(input, &wallet)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("expected %q rejection, got %v", test.want, err)
			}
		})
	}
	otherWallet := solana.NewWallet().PublicKey()
	if _, err := normalizeSignerIntentForWalletV2(valid, &otherWallet); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("typed SAT signer must reject a different wallet, got %v", err)
	}
}

func TestSignerV2TypedSATBondValidatesMintATAsAndCleanupHasNoRawFallback(t *testing.T) {
	wallet, program, mint := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	position := satTestPDA(t, program, []byte("sat_bond_position"), wallet[:])
	tier := satTestPDA(t, program, []byte("sat_bond_tier_policy"))
	signerATA, _ := findAssociatedTokenAddressV2(wallet, mint, solana.TokenProgramID)
	vaultATA, _ := findAssociatedTokenAddressV2(position, mint, solana.TokenProgramID)
	data := make([]byte, 9)
	data[0] = 2
	binary.LittleEndian.PutUint64(data[1:], 75)
	intent := signerIntentV2{
		Type: intentSolanaVaultBondAction, Cluster: "devnet", Action: "openBondPosition", ProgramID: program.String(), DataBase64: base64.StdEncoding.EncodeToString(data),
		Keys: []signerSATAccountV2{
			satTestAccount(wallet, true, true), satTestAccount(tier, false, false),
			satTestAccount(position, false, true), satTestAccount(signerATA, false, true),
			satTestAccount(vaultATA, false, true), satTestAccount(mint, false, false),
			satTestAccount(solana.SystemProgramID, false, false), satTestAccount(solana.TokenProgramID, false, false),
			satTestAccount(solana.SPLAssociatedTokenAccountProgramID, false, false),
		},
	}
	normalized, err := normalizeSignerIntentForWalletV2(intent, &wallet)
	if err != nil {
		t.Fatalf("normalize typed SAT bond open: %v", err)
	}
	if normalized.Asset != "solana:spl:"+mint.String() || normalized.Amount.Uint64() != 75 {
		t.Fatalf("unexpected bond accounting: asset=%s amount=%s", normalized.Asset, normalized.Amount)
	}
	if normalized.RequiredRole != "vault" || normalized.PolicyOperation != "vaultBond.openBondPosition@"+program.String() {
		t.Fatalf("bond intent is not restricted to a program-bound Vault policy: %#v", normalized)
	}
	miningBypass := cloneSATTestIntent(t, intent)
	miningBypass.Type, miningBypass.Cluster = intentSolanaSATAction, ""
	if _, err := normalizeSignerIntentForWalletV2(miningBypass, &wallet); err == nil || !strings.Contains(err.Error(), "rejects Vault bond action") {
		t.Fatalf("generic SAT mining intent accepted a Vault bond action: %v", err)
	}
	wrongCluster := cloneSATTestIntent(t, intent)
	wrongCluster.Cluster = "testnet"
	if _, err := normalizeSignerIntentForWalletV2(wrongCluster, &wallet); err == nil || !strings.Contains(err.Error(), "cluster must be") {
		t.Fatalf("Vault bond intent accepted an unknown cluster: %v", err)
	}
	wrongFlags := cloneSATTestIntent(t, intent)
	wrongFlags.Keys[3].IsWritable = false
	if _, err := normalizeSignerIntentForWalletV2(wrongFlags, &wallet); err == nil || !strings.Contains(err.Error(), "flags mismatch") {
		t.Fatalf("Vault bond intent accepted mutated account flags: %v", err)
	}
	wrongProgram := cloneSATTestIntent(t, intent)
	wrongProgram.ProgramID = solana.NewWallet().PublicKey().String()
	if _, err := normalizeSignerIntentForWalletV2(wrongProgram, &wallet); err == nil || !strings.Contains(err.Error(), "bond tier policy") {
		t.Fatalf("Vault bond intent accepted accounts derived for a different program: %v", err)
	}
	zeroAmount := cloneSATTestIntent(t, intent)
	zeroData, _ := base64.StdEncoding.DecodeString(zeroAmount.DataBase64)
	for index := 1; index < len(zeroData); index++ {
		zeroData[index] = 0
	}
	zeroAmount.DataBase64 = base64.StdEncoding.EncodeToString(zeroData)
	if _, err := normalizeSignerIntentForWalletV2(zeroAmount, &wallet); err == nil || !strings.Contains(err.Error(), "amount must be positive") {
		t.Fatalf("Vault bond intent accepted zero amount: %v", err)
	}
	agentPolicy, err := normalizeSignerPolicyV2(signerPolicyV2{
		WalletID: "agent", Role: "agent", Operations: []string{normalized.PolicyOperation}, Programs: normalized.RequiredPrograms,
		Assets: []signerPolicyAssetV2{{Asset: normalized.Asset, Destinations: []string{normalized.Destination}, MaxPerTx: "100", MaxDaily: "100"}},
	})
	if err != nil {
		t.Fatalf("normalize non-Vault bypass policy: %v", err)
	}
	if _, err := policyAssetForIntentV2(agentPolicy, normalized); err == nil || !strings.Contains(err.Error(), "cannot authorize") {
		t.Fatalf("non-Vault role authorized a typed bond mutation: %v", err)
	}
	miningPolicy := agentPolicy
	miningPolicy.Role = "mining"
	if _, err := policyAssetForIntentV2(miningPolicy, normalized); err == nil || !strings.Contains(err.Error(), "cannot authorize vault") {
		t.Fatalf("Mining role authorized a Vault bond mutation despite exact policy grants: %v", err)
	}
	malformed := cloneSATTestIntent(t, intent)
	malformed.Keys[4].Pubkey = solana.NewWallet().PublicKey().String()
	if _, err := normalizeSignerIntentForWalletV2(malformed, &wallet); err == nil || !strings.Contains(err.Error(), "bond vault") {
		t.Fatalf("expected bond vault ATA rejection, got %v", err)
	}
	cleanup := signerIntentV2{
		Type: intentSolanaSATAction, Action: "cleanupBatch",
		Instructions: []signerSATInstructionV2{{Action: intent.Action, ProgramID: intent.ProgramID, DataBase64: intent.DataBase64, Keys: intent.Keys}},
	}
	if _, err := normalizeSignerIntentForWalletV2(cleanup, &wallet); err == nil || !strings.Contains(err.Error(), "rejects action") {
		t.Fatalf("cleanup batch must not accept arbitrary SAT instructions, got %v", err)
	}
}

func TestSignerV2TypedSATClaimsBindPolicyToExactMint(t *testing.T) {
	wallet, program, mint := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	distributor := satTestPDA(t, program, []byte("sat_bond_staking_distributor"))
	rewardVault, err := findAssociatedTokenAddressV2(distributor, mint, solana.TokenProgramID)
	if err != nil {
		t.Fatalf("derive reward vault: %v", err)
	}
	intent := signerIntentV2{
		Type: intentSolanaVaultBondAction, Cluster: "devnet", Action: "syncBondStakingRewards", ProgramID: program.String(),
		DataBase64: base64.StdEncoding.EncodeToString([]byte{8}),
		Keys: []signerSATAccountV2{
			satTestAccount(distributor, false, true),
			satTestAccount(rewardVault, false, false),
			satTestAccount(mint, false, false),
		},
	}
	normalized, err := normalizeSignerIntentForWalletV2(intent, &wallet)
	if err != nil {
		t.Fatalf("normalize typed SAT reward sync: %v", err)
	}
	if normalized.Asset != "sat:mint:"+mint.String() || normalized.Amount.Uint64() != 1 {
		t.Fatalf("SAT reward action is not bound to its exact mint: asset=%s amount=%s", normalized.Asset, normalized.Amount)
	}
	policy, err := normalizeSignerPolicyV2(signerPolicyV2{
		WalletID: "vault", Role: "vault", Operations: []string{normalized.PolicyOperation}, Programs: normalized.RequiredPrograms,
		Assets: []signerPolicyAssetV2{{Asset: "sat:mint:" + mint.String(), Destinations: []string{program.String()}, MaxPerTx: "1", MaxDaily: "10"}},
	})
	if err != nil {
		t.Fatalf("normalize mint-bound SAT policy: %v", err)
	}
	if _, err := policyAssetForIntentV2(policy, normalized); err != nil {
		t.Fatalf("exact mint policy should allow reward sync: %v", err)
	}
	policy.Assets[0].Asset = "sat:mint:" + solana.NewWallet().PublicKey().String()
	if _, err := policyAssetForIntentV2(policy, normalized); err == nil || !strings.Contains(err.Error(), "denies asset") {
		t.Fatalf("different mint policy must deny reward sync, got %v", err)
	}

	recipientOwner := solana.NewWallet().PublicKey()
	recipientATA, err := findAssociatedTokenAddressV2(recipientOwner, mint, solana.TokenProgramID)
	if err != nil {
		t.Fatalf("derive unallocated reward recipient: %v", err)
	}
	unallocated := signerIntentV2{
		Type: intentSolanaVaultBondAction, Cluster: "devnet", Action: "claimUnallocatedStakingRewards", ProgramID: program.String(),
		DataBase64: base64.StdEncoding.EncodeToString([]byte{11}),
		Keys: []signerSATAccountV2{
			satTestAccount(wallet, true, true), satTestAccount(distributor, false, true),
			satTestAccount(rewardVault, false, true), satTestAccount(recipientATA, false, true),
			satTestAccount(recipientOwner, false, false), satTestAccount(mint, false, false),
			satTestAccount(solana.SystemProgramID, false, false), satTestAccount(solana.TokenProgramID, false, false),
			satTestAccount(solana.SPLAssociatedTokenAccountProgramID, false, false),
		},
	}
	normalizedUnallocated, err := normalizeSignerIntentForWalletV2(unallocated, &wallet)
	if err != nil {
		t.Fatalf("normalize unallocated SAT reward claim: %v", err)
	}
	if normalizedUnallocated.Asset != "sat:mint:"+mint.String() || normalizedUnallocated.Destination != recipientOwner.String() {
		t.Fatalf("SAT reward claim policy must bind mint and recipient: asset=%s destination=%s", normalizedUnallocated.Asset, normalizedUnallocated.Destination)
	}
}

func TestSignerV2TypedSATCompactionRequiresExactBoundarySequences(t *testing.T) {
	wallet, program := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	data := make([]byte, 25)
	data[0] = 75
	binary.LittleEndian.PutUint64(data[1:9], 10)
	binary.LittleEndian.PutUint64(data[9:17], 13)
	data[17], data[18] = 2, 1
	cycleIDs := []uint64{10, 11, 13}
	keys := []signerSATAccountV2{
		satTestAccount(wallet, true, true),
		satTestAccount(satTestPDA(t, program, []byte("sat_miner_capital_state"), wallet[:]), false, true),
	}
	for _, cycleID := range cycleIDs {
		seed := make([]byte, 8)
		binary.LittleEndian.PutUint64(seed, cycleID)
		keys = append(keys, satTestAccount(satTestPDA(t, program, []byte("sat_miner_cycle_state"), wallet[:], seed), false, false))
	}
	intent := signerIntentV2{
		Type: intentSolanaSATAction, Action: "compactPendingCycleRange", ProgramID: program.String(),
		DataBase64: base64.StdEncoding.EncodeToString(data), Keys: keys,
		Context: &signerSATContextV2{FrontCycleIDs: []string{"10", "11"}, BackCycleIDs: []string{"13"}},
	}
	if _, err := normalizeSignerIntentForWalletV2(intent, &wallet); err != nil {
		t.Fatalf("normalize exact SAT pending-range compaction: %v", err)
	}
	nonContiguous := cloneSATTestIntent(t, intent)
	nonContiguous.Context.FrontCycleIDs[1] = "12"
	if _, err := normalizeSignerIntentForWalletV2(nonContiguous, &wallet); err == nil || !strings.Contains(err.Error(), "front cycles must be contiguous") {
		t.Fatalf("non-contiguous front compaction must be rejected, got %v", err)
	}
	overlap := cloneSATTestIntent(t, intent)
	overlapData, err := base64.StdEncoding.DecodeString(overlap.DataBase64)
	if err != nil {
		t.Fatal(err)
	}
	binary.LittleEndian.PutUint64(overlapData[9:17], 11)
	overlap.DataBase64 = base64.StdEncoding.EncodeToString(overlapData)
	if _, err := normalizeSignerIntentForWalletV2(overlap, &wallet); err == nil || !strings.Contains(err.Error(), "boundary cycles overlap") {
		t.Fatalf("overlapping compaction boundaries must be rejected, got %v", err)
	}
}
