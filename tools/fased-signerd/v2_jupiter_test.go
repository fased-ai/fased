package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math/big"
	"strings"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	rpc "github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
)

func TestJupiterLiveExecutionDefaultsFailClosed(t *testing.T) {
	for _, intentType := range []string{
		intentSolanaJupiterSwap,
		intentSolanaTriggerCreate,
		intentSolanaTriggerCancel,
	} {
		if err := requireJupiterLiveExecutionV2(false, intentType); err == nil || !strings.Contains(err.Error(), "preview-only") {
			t.Fatalf("%s execution was not disabled by default: %v", intentType, err)
		}
		if err := requireJupiterLiveExecutionV2(true, intentType); err != nil {
			t.Fatalf("%s qualification override was rejected: %v", intentType, err)
		}
	}
	if err := requireJupiterLiveExecutionV2(false, intentSolanaNativeTransfer); err != nil {
		t.Fatalf("non-Jupiter execution was blocked: %v", err)
	}
}

func TestJupiterAddressLookupTablesFailClosedWithoutRPCTrust(t *testing.T) {
	message := solana.Message{AddressTableLookups: solana.MessageAddressTableLookupSlice{{
		AccountKey: solana.NewWallet().PublicKey(), WritableIndexes: solana.Uint8SliceAsNum{0},
	}}}
	if err := resolveAndVerifyLookupsV2(context.Background(), nil, &message); err == nil || !strings.Contains(err.Error(), "address lookup tables are denied") {
		t.Fatalf("Jupiter lookup table was accepted through a single RPC trust path: %v", err)
	}
}

func testJupiterIntentV2(owner solana.PublicKey) signerIntentV2 {
	return signerIntentV2{
		Type: intentSolanaJupiterSwap,
		Jupiter: &signerJupiterIntentV2{
			Owner:                   owner.String(),
			InputMint:               solana.NewWallet().PublicKey().String(),
			OutputMint:              solana.NewWallet().PublicKey().String(),
			InputAmount:             "100",
			MaxInputAmount:          "100",
			MinimumOutputAmount:     "90",
			MaxFeeLamports:          "5000",
			SourceTokenAccount:      solana.NewWallet().PublicKey().String(),
			DestinationTokenAccount: solana.NewWallet().PublicKey().String(),
			Programs:                []string{jupiterAggregatorV6V2},
		},
	}
}

func jupiterRouteV2Data(input, quote uint64, slippage, platformFee, positiveSlippage uint16) []byte {
	data := append([]byte(nil), jupiterRouteV2DiscriminatorV2[:]...)
	fixed := make([]byte, 22)
	binary.LittleEndian.PutUint64(fixed[:8], input)
	binary.LittleEndian.PutUint64(fixed[8:16], quote)
	binary.LittleEndian.PutUint16(fixed[16:18], slippage)
	binary.LittleEndian.PutUint16(fixed[18:20], platformFee)
	binary.LittleEndian.PutUint16(fixed[20:22], positiveSlippage)
	data = append(data, fixed...)
	data = append(data, 1, 0, 0, 0)    // one route-plan step
	data = append(data, 0, 0, 0, 0, 0) // minimum encoded RoutePlanStepV2
	return data
}

func jupiterRouteV2Metas(wallet solana.PublicKey, intent *signerJupiterIntentV2) []*solana.AccountMeta {
	jupiter := solana.MustPublicKeyFromBase58(jupiterAggregatorV6V2)
	return []*solana.AccountMeta{
		{PublicKey: wallet, IsSigner: true},
		{PublicKey: solana.MustPublicKeyFromBase58(intent.SourceTokenAccount), IsWritable: true},
		{PublicKey: solana.MustPublicKeyFromBase58(intent.DestinationTokenAccount), IsWritable: true},
		{PublicKey: solana.MustPublicKeyFromBase58(intent.InputMint)},
		{PublicKey: solana.MustPublicKeyFromBase58(intent.OutputMint)},
		{PublicKey: solana.TokenProgramID},
		{PublicKey: solana.TokenProgramID},
		{PublicKey: jupiter},
		{PublicKey: jupiterEventAuthorityV2},
		{PublicKey: jupiter},
	}
}

func TestJupiterIntentNormalizationIsExactAndFailClosed(t *testing.T) {
	owner := solana.NewWallet().PublicKey()
	input := testJupiterIntentV2(owner)
	normalized, err := normalizeSignerIntentV2(input)
	if err != nil {
		t.Fatalf("normalize Jupiter intent: %v", err)
	}
	if normalized.Amount.Cmp(big.NewInt(100)) != 0 || normalized.Asset != "solana:spl:"+input.Jupiter.InputMint ||
		normalized.RequiredRole != "" || normalized.PolicyOperation != intentSolanaJupiterSwap {
		t.Fatalf("unexpected normalized intent: %#v", normalized)
	}
	lowClaim := input
	lowFee := *input.Jupiter
	lowClaim.Jupiter = &lowFee
	lowClaim.Jupiter.MaxFeeLamports = "1"
	lowNormalized, err := normalizeSignerIntentV2(lowClaim)
	if err != nil {
		t.Fatalf("normalize low caller fee claim: %v", err)
	}
	policy, err := normalizeSignerPolicyV2(signerPolicyV2{
		WalletID: "jupiter-fee-accounting", Role: "agent", Operations: []string{intentSolanaJupiterSwap},
		Programs: []string{jupiterAggregatorV6V2},
		Assets: []signerPolicyAssetV2{
			{Asset: lowNormalized.Asset, Destinations: []string{owner.String()}, MaxPerTx: "100", MaxDaily: "1000"},
			{Asset: "solana:native", Destinations: []string{owner.String()}, MaxPerTx: "5000000", MaxDaily: "5000000"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	reservations, err := policyReservationsForIntentV2(policy, lowNormalized)
	if err != nil {
		t.Fatalf("build signer-owned Jupiter reservations: %v", err)
	}
	if len(reservations) != 2 || reservations[0].Asset != "solana:native" || reservations[0].Amount.Uint64() != signerNativeFeeReservationV2 {
		t.Fatalf("caller lowered durable Jupiter native fee accounting: %#v", reservations)
	}

	mutated := input
	jupiter := *input.Jupiter
	mutated.Jupiter = &jupiter
	mutated.Jupiter.MaxInputAmount = "101"
	if _, err := normalizeSignerIntentV2(mutated); err == nil || !strings.Contains(err.Error(), "maxInputAmount") {
		t.Fatalf("expected distinct max input rejection, got %v", err)
	}
	mutated = input
	jupiter = *input.Jupiter
	mutated.Jupiter = &jupiter
	mutated.Jupiter.Programs = []string{solana.TokenProgramID.String()}
	if _, err := normalizeSignerIntentV2(mutated); err == nil || !strings.Contains(err.Error(), "v6 aggregator") {
		t.Fatalf("expected missing Jupiter program rejection, got %v", err)
	}
	mutated = input
	jupiter = *input.Jupiter
	mutated.Jupiter = &jupiter
	mutated.Jupiter.MinimumOutputAmount = "0"
	if _, err := normalizeSignerIntentV2(mutated); err == nil || !strings.Contains(err.Error(), "positive input/minimum") {
		t.Fatalf("expected zero minimum output rejection, got %v", err)
	}
}

func TestEveryAutonomousJupiterAndTriggerIntentRequiresAgentRole(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	vault := solana.NewWallet().PublicKey()
	mint := solana.NewWallet().PublicKey()
	source := solana.NewWallet().PublicKey()
	destination := solana.NewWallet().PublicKey()
	create := triggerDepositIntentV2(wallet, vault, mint, source, destination, solana.TokenProgramID.String())
	cancel := triggerCancelIntentV2(wallet, vault, mint, source, destination, solana.TokenProgramID.String())

	for _, input := range []signerIntentV2{testJupiterIntentV2(wallet), create, cancel} {
		normalized, err := normalizeSignerIntentV2(input)
		if err != nil {
			t.Fatalf("normalize %s: %v", input.Type, err)
		}
		if normalized.RequiredRole != "" || normalized.PolicyOperation != input.Type {
			t.Fatalf("%s did not preserve reviewed-mode role flexibility: %#v", input.Type, normalized)
		}
		for _, role := range []string{"vault", "mining"} {
			if err := requireAutonomousRoleV2(signerPolicyV2{Role: role}, normalized); err == nil {
				t.Fatalf("%s policy authorized autonomous %s", role, input.Type)
			}
		}
		if err := requireAutonomousRoleV2(signerPolicyV2{Role: "agent"}, normalized); err != nil {
			t.Fatalf("Agent policy rejected autonomous %s: %v", input.Type, err)
		}
	}
}

func TestJupiterRouteV2BindsInstructionAmountsFeesAndAccounts(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	intent := testJupiterIntentV2(wallet).Jupiter
	data := jupiterRouteV2Data(100, 100, 1000, 0, 0) // on-chain minimum = 90
	metas := jupiterRouteV2Metas(wallet, intent)
	if err := validateJupiterRouteSemanticsV2(data, metas, wallet, intent); err != nil {
		t.Fatalf("validate exact RouteV2: %v", err)
	}

	tests := []struct {
		name   string
		data   []byte
		mutate func([]*solana.AccountMeta)
	}{
		{name: "input", data: jupiterRouteV2Data(101, 100, 1000, 0, 0)},
		{name: "minimum", data: jupiterRouteV2Data(100, 98, 1000, 0, 0)},
		{name: "platform fee", data: jupiterRouteV2Data(100, 100, 1000, 1, 0)},
		{name: "positive slippage fee", data: jupiterRouteV2Data(100, 100, 1000, 0, 1)},
		{name: "source account", data: data, mutate: func(values []*solana.AccountMeta) {
			values[1] = &solana.AccountMeta{PublicKey: solana.NewWallet().PublicKey(), IsWritable: true}
		}},
		{name: "destination mint", data: data, mutate: func(values []*solana.AccountMeta) {
			values[4] = &solana.AccountMeta{PublicKey: solana.NewWallet().PublicKey()}
		}},
		{name: "wallet signer", data: data, mutate: func(values []*solana.AccountMeta) {
			values[0] = &solana.AccountMeta{PublicKey: wallet}
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			candidate := jupiterRouteV2Metas(wallet, intent)
			if tc.mutate != nil {
				tc.mutate(candidate)
			}
			if err := validateJupiterRouteSemanticsV2(tc.data, candidate, wallet, intent); err == nil {
				t.Fatal("expected adversarial route rejection")
			}
		})
	}
}

func TestJupiterCodecRejectsUnknownAndLedgerLikeVariants(t *testing.T) {
	unknown := append([]byte(nil), jupiterRouteV2Data(100, 100, 1000, 0, 0)...)
	unknown[0] ^= 0xff
	if _, err := decodeJupiterRouteV2(unknown); err == nil {
		t.Fatal("unknown Jupiter instruction variant was accepted")
	}
	ledger := append([]byte{150, 86, 71, 116, 167, 93, 14, 104}, make([]byte, 32)...)
	if _, err := decodeJupiterRouteV2(ledger); err == nil {
		t.Fatal("token-ledger route was accepted without an exact input semantic")
	}
	legacy := append([]byte(nil), jupiterRouteDiscriminatorV2[:]...)
	legacy = append(legacy, 1, 0, 0, 0, 0, 0, 0, 0, 0)
	legacy = append(legacy, make([]byte, 19)...)
	if _, err := decodeJupiterRouteV2(legacy); err == nil || !strings.Contains(err.Error(), "require RouteV2") {
		t.Fatalf("legacy Jupiter tail layout was accepted: %v", err)
	}
}

func TestJupiterAuxiliaryInstructionsAreNarrowlyBound(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	intent := testJupiterIntentV2(wallet).Jupiter
	intent.InputMint = solanaNativeMintV2
	createData := append(append([]byte(nil), jupiterCreateTokenAccountDiscriminatorV2[:]...), 1)
	createMetas := []*solana.AccountMeta{
		{PublicKey: solana.MustPublicKeyFromBase58(intent.SourceTokenAccount), IsWritable: true},
		{PublicKey: wallet, IsSigner: true, IsWritable: true},
		{PublicKey: solana.MustPublicKeyFromBase58(intent.InputMint)},
		{PublicKey: solana.TokenProgramID},
		{PublicKey: solana.SystemProgramID},
	}
	if _, err := validateJupiterAuxiliaryInstructionV2(createData, createMetas, wallet, intent); err == nil || !strings.Contains(err.Error(), "token-account creation is denied") {
		t.Fatalf("signer-funded Jupiter token-account creation was accepted: %v", err)
	}
	createMetas[0] = &solana.AccountMeta{PublicKey: solana.NewWallet().PublicKey(), IsWritable: true}
	if _, err := validateJupiterAuxiliaryInstructionV2(createData, createMetas, wallet, intent); err == nil {
		t.Fatal("unreviewed Jupiter token account creation was accepted")
	}

	closeData := append([]byte(nil), jupiterCloseWSOLAccountDiscriminatorV2[:]...)
	closeMetas := []*solana.AccountMeta{
		{PublicKey: solana.MustPublicKeyFromBase58(intent.SourceTokenAccount), IsWritable: true},
		{PublicKey: wallet, IsSigner: true, IsWritable: true},
		{PublicKey: solana.TokenProgramID},
		{PublicKey: solana.SystemProgramID},
	}
	if action, err := validateJupiterAuxiliaryInstructionV2(closeData, closeMetas, wallet, intent); err != nil || action {
		t.Fatalf("validate exact WSOL cleanup: action=%v err=%v", action, err)
	}
	closeMetas[1] = &solana.AccountMeta{PublicKey: solana.NewWallet().PublicKey(), IsSigner: true, IsWritable: true}
	if _, err := validateJupiterAuxiliaryInstructionV2(closeData, closeMetas, wallet, intent); err == nil {
		t.Fatal("WSOL cleanup to another destination was accepted")
	}
}

func rpcAccountV2(t *testing.T, owner solana.PublicKey, lamports uint64, data []byte) *rpc.Account {
	t.Helper()
	encoded := base64.StdEncoding.EncodeToString(data)
	raw, err := json.Marshal(map[string]any{
		"lamports":   lamports,
		"owner":      owner.String(),
		"data":       []string{encoded, "base64"},
		"executable": false,
		"rentEpoch":  0,
	})
	if err != nil {
		t.Fatal(err)
	}
	var account rpc.Account
	if err := json.Unmarshal(raw, &account); err != nil {
		t.Fatalf("decode test RPC account: %v", err)
	}
	return &account
}

func tokenAccountV2(t *testing.T, mint, owner solana.PublicKey, amount uint64) *rpc.Account {
	t.Helper()
	data := make([]byte, 165)
	copy(data[:32], mint[:])
	copy(data[32:64], owner[:])
	binary.LittleEndian.PutUint64(data[64:72], amount)
	data[108] = 1
	return rpcAccountV2(t, solana.TokenProgramID, 2_039_280, data)
}

func TestToken2022ExtensionsFailClosedUntilSemanticallySupported(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	mint := solana.NewWallet().PublicKey()
	extendedTokenData := make([]byte, 166)
	copy(extendedTokenData[:32], mint[:])
	copy(extendedTokenData[32:64], wallet[:])
	extendedTokenData[108] = 1
	extendedTokenAccount := rpcAccountV2(t, solana.Token2022ProgramID, 2_039_280, extendedTokenData)
	if _, ok := parseJupiterTokenAccountV2(extendedTokenAccount); ok {
		t.Fatal("Token-2022 account extensions were accepted without semantic validation")
	}

	extendedMintData := make([]byte, 83)
	extendedMintData[44] = 9
	extendedMintData[45] = 1
	extendedMint := rpcAccountV2(t, solana.Token2022ProgramID, 1, extendedMintData)
	if _, err := validatePlainSPLMintAccountV2(
		extendedMint,
		solana.Token2022ProgramID,
	); err == nil || !strings.Contains(err.Error(), "extensions are not supported") {
		t.Fatalf("Token-2022 mint extensions were accepted without semantic validation: %v", err)
	}
}

func TestTriggerTokenValidationUsesExactMintLayoutAndCheckedToken2022(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	mint := solana.NewWallet().PublicKey()
	source := solana.NewWallet().PublicKey()
	destination := solana.NewWallet().PublicKey()
	vault := solana.NewWallet().PublicKey()
	normalized := normalizedIntentV2{Intent: signerIntentV2{
		Type: intentSolanaTriggerCreate,
		Jupiter: &signerJupiterIntentV2{
			InputMint:               mint.String(),
			InputAmount:             "10",
			SourceTokenAccount:      source.String(),
			DestinationTokenAccount: destination.String(),
			Trigger: &signerJupiterTriggerIntentV2{
				Program: solana.Token2022ProgramID.String(),
				Vault:   vault.String(),
			},
		},
	}}
	transferMetas := []*solana.AccountMeta{
		{PublicKey: source, IsWritable: true},
		{PublicKey: destination, IsWritable: true},
		{PublicKey: wallet, IsSigner: true},
	}
	transfer := make([]byte, 9)
	transfer[0] = 3
	binary.LittleEndian.PutUint64(transfer[1:], 10)
	if _, err := validateJupiterTokenInstructionV2(
		transfer,
		transferMetas,
		wallet,
		normalized,
		solana.Token2022ProgramID,
		nil,
	); err == nil || !strings.Contains(err.Error(), "TransferChecked is required") {
		t.Fatalf("unchecked Token-2022 Transfer was accepted: %v", err)
	}

	extendedMintData := make([]byte, 83)
	extendedMintData[44] = 9
	extendedMintData[45] = 1
	checkedMetas := []*solana.AccountMeta{
		{PublicKey: source, IsWritable: true},
		{PublicKey: mint},
		{PublicKey: destination, IsWritable: true},
		{PublicKey: wallet, IsSigner: true},
	}
	checked := make([]byte, 10)
	checked[0] = 12
	binary.LittleEndian.PutUint64(checked[1:9], 10)
	checked[9] = 9
	accounts := map[string]*rpc.Account{
		mint.String(): rpcAccountV2(t, solana.Token2022ProgramID, 1, extendedMintData),
	}
	if _, err := validateJupiterTokenInstructionV2(
		checked,
		checkedMetas,
		wallet,
		normalized,
		solana.Token2022ProgramID,
		accounts,
	); err == nil || !strings.Contains(err.Error(), "extensions are not supported") {
		t.Fatalf("extended Token-2022 mint was accepted by Trigger TransferChecked: %v", err)
	}
}

func TestJupiterNativeOutputAllowsFavorableExecution(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	inputMint := solana.NewWallet().PublicKey()
	source := solana.NewWallet().PublicKey()
	intent, err := normalizeSignerIntentV2(signerIntentV2{
		Type: intentSolanaJupiterSwap,
		Jupiter: &signerJupiterIntentV2{
			Owner:                   wallet.String(),
			InputMint:               inputMint.String(),
			OutputMint:              solanaNativeMintV2,
			InputAmount:             "10",
			MaxInputAmount:          "10",
			MinimumOutputAmount:     "10000",
			MaxFeeLamports:          "1000",
			SourceTokenAccount:      source.String(),
			DestinationTokenAccount: wallet.String(),
			Programs:                []string{jupiterAggregatorV6V2},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := jupiterTransactionSnapshotV2{
		Accounts: map[string]*rpc.Account{
			wallet.String(): rpcAccountV2(t, solana.SystemProgramID, 1_000_000, nil),
			source.String(): tokenAccountV2(t, inputMint, wallet, 100),
		},
		Post: map[string]*rpc.Account{
			wallet.String(): rpcAccountV2(t, solana.SystemProgramID, 1_012_000, nil),
			source.String(): tokenAccountV2(t, inputMint, wallet, 90),
		},
	}
	if err := validateJupiterBalanceSemanticsV2(wallet, intent, snapshot); err != nil {
		t.Fatalf("favorable native-output execution was rejected: %v", err)
	}
}

func TestJupiterSimulationBindsBalancesAndWalletIdentity(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	inputMint := solana.NewWallet().PublicKey()
	outputMint := solana.NewWallet().PublicKey()
	source := solana.NewWallet().PublicKey()
	destination := solana.NewWallet().PublicKey()
	intent, err := normalizeSignerIntentV2(signerIntentV2{
		Type: intentSolanaJupiterSwap,
		Jupiter: &signerJupiterIntentV2{
			Owner:                   wallet.String(),
			InputMint:               inputMint.String(),
			OutputMint:              outputMint.String(),
			InputAmount:             "10",
			MaxInputAmount:          "10",
			MinimumOutputAmount:     "5",
			MaxFeeLamports:          "10000",
			SourceTokenAccount:      source.String(),
			DestinationTokenAccount: destination.String(),
			Programs:                []string{jupiterAggregatorV6V2},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	preWallet := rpcAccountV2(t, solana.SystemProgramID, 1_000_000, nil)
	postWallet := rpcAccountV2(t, solana.SystemProgramID, 995_000, nil)
	snapshot := jupiterTransactionSnapshotV2{
		Accounts: map[string]*rpc.Account{
			wallet.String():      preWallet,
			source.String():      tokenAccountV2(t, inputMint, wallet, 100),
			destination.String(): tokenAccountV2(t, outputMint, wallet, 0),
		},
		Post: map[string]*rpc.Account{
			wallet.String():      postWallet,
			source.String():      tokenAccountV2(t, inputMint, wallet, 90),
			destination.String(): tokenAccountV2(t, outputMint, wallet, 5),
		},
	}
	if err := validateJupiterBalanceSemanticsV2(wallet, intent, snapshot); err != nil {
		t.Fatalf("validate exact simulated balances: %v", err)
	}

	tooLittle := snapshot
	tooLittle.Post = map[string]*rpc.Account{}
	for key, value := range snapshot.Post {
		tooLittle.Post[key] = value
	}
	tooLittle.Post[destination.String()] = tokenAccountV2(t, outputMint, wallet, 4)
	if err := validateJupiterBalanceSemanticsV2(wallet, intent, tooLittle); err == nil {
		t.Fatal("simulation below reviewed minimum output was accepted")
	}

	changedWallet := snapshot
	changedWallet.Post = map[string]*rpc.Account{}
	for key, value := range snapshot.Post {
		changedWallet.Post[key] = value
	}
	changedWallet.Post[wallet.String()] = rpcAccountV2(t, solana.TokenProgramID, 995_000, nil)
	if err := validateJupiterBalanceSemanticsV2(wallet, intent, changedWallet); err == nil {
		t.Fatal("wallet owner change was accepted")
	}

	extra := solana.NewWallet().PublicKey()
	extraMint := solana.NewWallet().PublicKey()
	snapshot.Accounts[extra.String()] = tokenAccountV2(t, extraMint, wallet, 10)
	snapshot.Post[extra.String()] = tokenAccountV2(t, extraMint, wallet, 9)
	if err := validateJupiterBalanceSemanticsV2(wallet, intent, snapshot); err == nil {
		t.Fatal("decrease of an unreviewed wallet token account was accepted")
	}
}

func TestJupiterReviewIsDurableImmutableAndExpires(t *testing.T) {
	store, keys := openTestSignerV2(t)
	wallet, _ := createTestSignerWalletV2(
		t,
		store,
		keys,
		"agent-jupiter",
		solana.NewWallet().PublicKey().String(),
		100,
		1000,
	)
	input := testJupiterIntentV2(solana.MustPublicKeyFromBase58(wallet.PublicKey))
	normalized, err := normalizeSignerIntentV2(input)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := store.putPolicy(signerPolicyV2{
		WalletID:   wallet.WalletID,
		Role:       "agent",
		Operations: []string{intentSolanaJupiterSwap},
		Programs:   []string{jupiterAggregatorV6V2},
		Assets: []signerPolicyAssetV2{
			{Asset: normalized.Asset, Destinations: []string{wallet.PublicKey}, MaxPerTx: "100", MaxDaily: "1000"},
			{Asset: "solana:native", Destinations: []string{wallet.PublicKey}, MaxPerTx: "5000000", MaxDaily: "10000000"},
		},
	}, 1)
	if err != nil {
		t.Fatalf("install Jupiter policy: %v", err)
	}
	now := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	req := signerReviewPrepareRequestV2{
		RequestID:  "jupiter-review-one",
		PolicyHash: policy.Hash,
		Mode:       jupiterReviewModeAutonomousV2,
		Intent:     normalized.Intent,
		Transaction: &signerSolanaTransactionEnvelopeV2{
			SerializedTxBase64: "AQ==",
			Programs:           normalized.RequiredPrograms,
			WritableAccounts:   []string{wallet.PublicKey},
			Submission:         jupiterSubmissionRPCV2,
		},
	}
	transactionDigest := "sha256:" + strings.Repeat("a", 64)
	review, err := store.prepareReviewV2(wallet.WalletID, req, normalized, *req.Transaction, transactionDigest)
	if err != nil {
		t.Fatalf("prepare durable review: %v", err)
	}
	if len(review.Nonce) != 64 || review.IntentDigest != normalized.Digest || len(review.SemanticIntent) == 0 {
		t.Fatalf("review omitted immutable bindings: %#v", review)
	}
	duplicate, err := store.prepareReviewV2(wallet.WalletID, req, normalized, *req.Transaction, transactionDigest)
	if err != nil || duplicate.Nonce != review.Nonce {
		t.Fatalf("idempotent prepare changed review: %#v err=%v", duplicate, err)
	}
	changed := normalized
	changed.Digest = "sha256:" + strings.Repeat("f", 64)
	if _, err := store.prepareReviewV2(wallet.WalletID, req, changed, *req.Transaction, transactionDigest); err == nil {
		t.Fatal("request id was rebound to a different review")
	}
	changedTransaction := *req.Transaction
	changedTransaction.SerializedTxBase64 = "Ag=="
	if _, err := store.prepareReviewV2(wallet.WalletID, req, normalized, changedTransaction, transactionDigest); err == nil || !strings.Contains(err.Error(), "different immutable") {
		t.Fatalf("request id was rebound to substituted transaction bytes: %v", err)
	}

	if _, _, _, err := store.requirePreparedReviewV2(wallet.WalletID, req.RequestID); err != nil {
		t.Fatalf("require current review: %v", err)
	}
	store.now = func() time.Time { return now.Add(16 * time.Minute) }
	if _, _, _, err := store.requirePreparedReviewV2(wallet.WalletID, req.RequestID); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expected expired review rejection, got %v", err)
	}
	store.now = func() time.Time { return now }
	operation, _, err := store.reserveOperation(signerExecuteRequestV2{
		RequestID: req.RequestID, PolicyHash: policy.Hash, Intent: normalized.Intent, intentWalletID: wallet.WalletID,
	}, normalized)
	if err != nil {
		t.Fatalf("reserve reviewed operation before expiry: %v", err)
	}
	store.now = func() time.Time { return now.Add(16 * time.Minute) }
	terminalized, err := store.terminalizeInvalidReviewedReservationV2(wallet.WalletID, req.RequestID, errors.New("signer review expired; prepare a fresh review"))
	if err != nil || !terminalized {
		t.Fatalf("expired reviewed reservation was not terminalized: terminalized=%v err=%v", terminalized, err)
	}
	operation, err = store.getOperation(req.RequestID)
	if err != nil || operation.State != operationFailed || operation.ReservationActive {
		t.Fatalf("expired reviewed reservation remains active: %#v err=%v", operation, err)
	}
	if usage, err := store.dailyUsage(wallet.WalletID, normalized.Asset, now); err != nil || usage.Sign() != 0 {
		t.Fatalf("expired reviewed reservation did not release primary usage: %v err=%v", usage, err)
	}
	if usage, err := store.dailyUsage(wallet.WalletID, "solana:native", now); err != nil || usage.Sign() != 0 {
		t.Fatalf("expired reviewed reservation did not release fee usage: %v err=%v", usage, err)
	}
}

func TestTriggerReturnSignedAndSecretsNeverCrossSocketResult(t *testing.T) {
	if _, err := normalizeTransactionEnvelopeV2(signerSolanaTransactionEnvelopeV2{
		SerializedTxBase64: "AQ==",
		Programs:           []string{solana.SystemProgramID.String()},
		WritableAccounts:   []string{solana.NewWallet().PublicKey().String()},
		Submission:         "returnSigned",
	}); err == nil || !strings.Contains(err.Error(), "signer-owned rpc") {
		t.Fatalf("legacy returnSigned mode was accepted: %v", err)
	}
	operation := signerOperationV2{
		RequestID: "trigger-no-secret-response", WalletID: "agent", IntentType: intentSolanaTriggerCreate,
		IntentDigest: "sha256:" + strings.Repeat("a", 64), PolicyHash: "sha256:" + strings.Repeat("b", 64),
		State: operationUnknown, SignedTxBase64: "signed-transaction-secret", Signature: "public-signature",
		ExternalResult: &signerExternalResultV2{Provider: triggerProviderJupiterV2, Action: "create", OrderID: "order-1", OrderState: "open"},
	}
	raw, err := marshalSignerResultV2(signerReviewExecutionResultV2{Operation: &operation, Signer: "public-signer"})
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"signed-transaction-secret", "api-key-secret", "jwt-secret", "signedTxBase64"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("socket result leaked %q: %s", secret, raw)
		}
	}
	if !strings.Contains(string(raw), "order-1") || !strings.Contains(string(raw), "public-signature") {
		t.Fatalf("socket result omitted safe public identifiers: %s", raw)
	}
}

func TestJupiterReviewPrepareRequiresSignerOwnedNetworkBeforePersistence(t *testing.T) {
	store, keys := openTestSignerV2(t)
	wallet, initialPolicy := createTestSignerWalletV2(
		t,
		store,
		keys,
		"agent-network-pending-review",
		solana.NewWallet().PublicKey().String(),
		100,
		1000,
	)
	intent, err := normalizeSignerIntentV2(testJupiterIntentV2(solana.MustPublicKeyFromBase58(wallet.PublicKey)))
	if err != nil {
		t.Fatal(err)
	}
	policy, err := store.putPolicy(signerPolicyV2{
		WalletID:   wallet.WalletID,
		Role:       "agent",
		Operations: []string{intentSolanaJupiterSwap},
		Programs:   []string{jupiterAggregatorV6V2},
		Assets: []signerPolicyAssetV2{
			{Asset: intent.Asset, Destinations: []string{wallet.PublicKey}, MaxPerTx: "100", MaxDaily: "1000"},
			{Asset: "solana:native", Destinations: []string{wallet.PublicKey}, MaxPerTx: "5000000", MaxDaily: "10000000"},
		},
	}, initialPolicy.Version)
	if err != nil {
		t.Fatal(err)
	}
	service := &signerServiceV2{store: store, keys: keys}
	request := signerReviewPrepareRequestV2{
		RequestID:  "network-pending-review",
		PolicyHash: policy.Hash,
		Mode:       jupiterReviewModeAutonomousV2,
		Intent:     intent.Intent,
		Transaction: &signerSolanaTransactionEnvelopeV2{
			SerializedTxBase64: "AQ==",
			Programs:           intent.RequiredPrograms,
			WritableAccounts:   []string{wallet.PublicKey},
			Submission:         jupiterSubmissionRPCV2,
		},
	}
	if _, err := service.prepareJupiterReviewV2(wallet.WalletID, request); !errors.Is(err, errSignerNetworkPendingV2) {
		t.Fatalf("expected signer-owned network-pending rejection, got %v", err)
	}
	if err := store.db.View(func(tx *bolt.Tx) error {
		if tx.Bucket(bucketSignerReviewsV2).Get([]byte(request.RequestID)) != nil {
			return errors.New("network-pending review was persisted")
		}
		if tx.Bucket(bucketSignerOperationsV2).Get([]byte(request.RequestID)) != nil {
			return errors.New("network-pending review reserved an operation")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestJupiterAuthorizationModesFailClosed(t *testing.T) {
	store, keys := openTestSignerV2(t)
	walletID := "vault-review-mode"
	wallet, _, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{
		WalletID:        walletID,
		ExpectedVersion: 0,
		Policy:          signerPolicyV2{WalletID: walletID, Role: "vault"},
	})
	if err != nil {
		t.Fatal(err)
	}
	input := testJupiterIntentV2(solana.MustPublicKeyFromBase58(wallet.PublicKey))
	normalized, err := normalizeSignerIntentV2(input)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := store.putPolicy(signerPolicyV2{
		WalletID:   wallet.WalletID,
		Role:       "vault",
		Operations: []string{intentSolanaJupiterSwap},
		Programs:   []string{jupiterAggregatorV6V2},
		Assets: []signerPolicyAssetV2{
			{Asset: normalized.Asset, Destinations: []string{wallet.PublicKey}, MaxPerTx: "100", MaxDaily: "1000"},
			{Asset: "solana:native", Destinations: []string{wallet.PublicKey}, MaxPerTx: "5000000", MaxDaily: "10000000"},
		},
	}, 1)
	if err != nil {
		t.Fatal(err)
	}
	req := signerReviewPrepareRequestV2{
		RequestID:   "vault-autonomous-review",
		PolicyHash:  policy.Hash,
		Mode:        jupiterReviewModeAutonomousV2,
		Intent:      normalized.Intent,
		Transaction: &signerSolanaTransactionEnvelopeV2{SerializedTxBase64: "AQ==", Programs: normalized.RequiredPrograms, WritableAccounts: []string{wallet.PublicKey}, Submission: jupiterSubmissionRPCV2},
	}
	if _, err := store.prepareReviewV2(wallet.WalletID, req, normalized, *req.Transaction, "sha256:"+strings.Repeat("a", 64)); err == nil || !strings.Contains(err.Error(), "Agent-role") {
		t.Fatalf("Vault autonomous review was accepted: %v", err)
	}
}

func triggerDepositIntentV2(wallet, vault, mint, source, destination solana.PublicKey, program string) signerIntentV2 {
	_ = vault
	_ = source
	_ = destination
	return signerIntentV2{
		Type: intentSolanaTriggerCreate,
		Jupiter: &signerJupiterIntentV2{
			Owner:          wallet.String(),
			InputMint:      mint.String(),
			OutputMint:     solana.NewWallet().PublicKey().String(),
			InputAmount:    "10",
			MaxInputAmount: "10",
			MaxFeeLamports: "5000",
			Programs:       []string{program},
			Trigger: &signerJupiterTriggerIntentV2{
				Operation: "create", Program: program,
				TriggerMint: mint.String(), Condition: "above", TargetPriceUSD: "200.00",
				SlippageBPS: 100, ExpiresAt: "2026-08-01T00:00:00.000Z", ExpectedOrderState: "new",
			},
		},
	}
}

func triggerCancelIntentV2(wallet, vault, mint, source, destination solana.PublicKey, program string) signerIntentV2 {
	_ = vault
	_ = source
	return signerIntentV2{
		Type: intentSolanaTriggerCancel,
		Jupiter: &signerJupiterIntentV2{
			Owner:                   wallet.String(),
			OutputMint:              mint.String(),
			MinimumOutputAmount:     "10",
			MaxFeeLamports:          "5000",
			DestinationTokenAccount: destination.String(),
			Programs:                []string{program},
			Trigger: &signerJupiterTriggerIntentV2{
				Operation: "cancel", Program: program,
				Order: "order-1", ExpectedOrderState: "open",
			},
		},
	}
}

func TestJupiterTriggerIntentRejectsOpaqueProgramsAndSignerAliasing(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	vault := solana.NewWallet().PublicKey()
	mint := solana.NewWallet().PublicKey()
	source := solana.NewWallet().PublicKey()
	destination := solana.NewWallet().PublicKey()
	valid := triggerDepositIntentV2(wallet, vault, mint, source, destination, solana.TokenProgramID.String())
	if _, err := normalizeSignerIntentV2(valid); err != nil {
		t.Fatalf("normalize exact Trigger create: %v", err)
	}

	opaque := valid
	opaqueJupiter := *valid.Jupiter
	opaque.Jupiter = &opaqueJupiter
	opaqueTrigger := *valid.Jupiter.Trigger
	opaque.Jupiter.Trigger = &opaqueTrigger
	opaqueProgram := solana.NewWallet().PublicKey().String()
	opaque.Jupiter.Programs = []string{opaqueProgram}
	opaque.Jupiter.Trigger.Program = opaqueProgram
	if _, err := normalizeSignerIntentV2(opaque); err == nil || !strings.Contains(err.Error(), "System or SPL") {
		t.Fatalf("expected opaque Trigger program rejection, got %v", err)
	}

	aliased := valid
	aliasedJupiter := *valid.Jupiter
	aliased.Jupiter = &aliasedJupiter
	aliasedTrigger := *valid.Jupiter.Trigger
	aliased.Jupiter.Trigger = &aliasedTrigger
	aliased.Jupiter.Trigger.Vault = wallet.String()
	if _, err := normalizeSignerIntentV2(aliased); err == nil || !strings.Contains(err.Error(), "signer-owned") {
		t.Fatalf("expected caller-supplied vault rejection, got %v", err)
	}
}

func TestJupiterTriggerCancelAcceptsOpaqueOrderIdentity(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	vault := solana.NewWallet().PublicKey()
	mint := solana.NewWallet().PublicKey()
	source := solana.NewWallet().PublicKey()
	destination := solana.NewWallet().PublicKey()
	intent := triggerCancelIntentV2(wallet, vault, mint, source, destination, solana.TokenProgramID.String())
	normalized, err := normalizeSignerIntentV2(intent)
	if err != nil {
		t.Fatalf("normalize Trigger cancel with opaque Jupiter order ID: %v", err)
	}
	if normalized.Intent.Jupiter == nil || normalized.Intent.Jupiter.Trigger == nil || normalized.Intent.Jupiter.Trigger.Order != "order-1" {
		t.Fatalf("opaque Trigger order identity was not preserved: %#v", normalized.Intent.Jupiter)
	}
	intent.Jupiter.Trigger.Order = "order\n2"
	if _, err := normalizeSignerIntentV2(intent); err == nil || !strings.Contains(err.Error(), "visible ASCII") {
		t.Fatalf("expected control-character order identity rejection, got %v", err)
	}
}

func TestJupiterTriggerTokenTransfersBindDirectionAuthorityAndExactAmount(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	vault := solana.NewWallet().PublicKey()
	mint := solana.NewWallet().PublicKey()
	source := solana.NewWallet().PublicKey()
	destination := solana.NewWallet().PublicKey()
	deposit, err := normalizeSignerIntentV2(
		triggerDepositIntentV2(wallet, vault, mint, source, destination, solana.TokenProgramID.String()),
	)
	if err != nil {
		t.Fatal(err)
	}
	deposit = enrichJupiterTriggerIntentV2(deposit, vault.String(), "deposit-request", source.String(), destination.String())
	mintData := make([]byte, 82)
	mintData[45] = 1
	accounts := map[string]*rpc.Account{
		mint.String():        rpcAccountV2(t, solana.TokenProgramID, 1, mintData),
		source.String():      tokenAccountV2(t, mint, wallet, 20),
		destination.String(): tokenAccountV2(t, mint, vault, 0),
	}
	data := make([]byte, 10)
	data[0] = 12
	binary.LittleEndian.PutUint64(data[1:9], 10)
	metas := []*solana.AccountMeta{
		{PublicKey: source, IsWritable: true},
		{PublicKey: mint},
		{PublicKey: destination, IsWritable: true},
		{PublicKey: wallet, IsSigner: true},
	}
	if action, err := validateJupiterTokenInstructionV2(data, metas, wallet, deposit, solana.TokenProgramID, accounts); err != nil || !action {
		t.Fatalf("validate exact Trigger deposit transfer: action=%v err=%v", action, err)
	}
	wrongAmount := append([]byte(nil), data...)
	binary.LittleEndian.PutUint64(wrongAmount[1:9], 9)
	if _, err := validateJupiterTokenInstructionV2(wrongAmount, metas, wallet, deposit, solana.TokenProgramID, accounts); err == nil {
		t.Fatal("Trigger deposit with changed amount was accepted")
	}

	cancel, err := normalizeSignerIntentV2(
		triggerCancelIntentV2(wallet, vault, mint, source, destination, solana.TokenProgramID.String()),
	)
	if err != nil {
		t.Fatal(err)
	}
	cancel = enrichJupiterTriggerIntentV2(cancel, vault.String(), "cancel-request", source.String(), destination.String())
	cancelMetas := []*solana.AccountMeta{
		{PublicKey: source, IsWritable: true},
		{PublicKey: mint},
		{PublicKey: destination, IsWritable: true},
		{PublicKey: vault, IsSigner: true},
	}
	accounts[source.String()] = tokenAccountV2(t, mint, vault, 20)
	accounts[destination.String()] = tokenAccountV2(t, mint, wallet, 0)
	if action, err := validateJupiterTokenInstructionV2(data, cancelMetas, wallet, cancel, solana.TokenProgramID, accounts); err != nil || !action {
		t.Fatalf("validate exact Trigger withdrawal transfer: action=%v err=%v", action, err)
	}
	cancelMetas[3] = &solana.AccountMeta{PublicKey: wallet, IsSigner: true}
	if _, err := validateJupiterTokenInstructionV2(data, cancelMetas, wallet, cancel, solana.TokenProgramID, accounts); err == nil {
		t.Fatal("Trigger withdrawal signed by the Gateway wallet instead of the reviewed vault was accepted")
	}
}

func TestJupiterTriggerWithdrawalRequiresExactWalletAndVaultSignerSet(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	vault := solana.NewWallet().PublicKey()
	mint := solana.NewWallet().PublicKey()
	intent, err := normalizeSignerIntentV2(triggerCancelIntentV2(
		wallet,
		vault,
		mint,
		solana.NewWallet().PublicKey(),
		solana.NewWallet().PublicKey(),
		solana.TokenProgramID.String(),
	))
	if err != nil {
		t.Fatal(err)
	}
	intent = enrichJupiterTriggerIntentV2(intent, vault.String(), "cancel-request", intent.Intent.Jupiter.SourceTokenAccount, intent.Intent.Jupiter.DestinationTokenAccount)
	tx := &solana.Transaction{
		Signatures: []solana.Signature{{}, {}},
		Message: solana.Message{
			Header:      solana.MessageHeader{NumRequiredSignatures: 2},
			AccountKeys: solana.PublicKeySlice{wallet, vault},
		},
	}
	if index, err := validateJupiterRequiredSignersV2(tx, wallet, intent); err != nil || index != 0 {
		t.Fatalf("validate exact wallet+vault signer set: index=%d err=%v", index, err)
	}
	tx.Message.AccountKeys = solana.PublicKeySlice{vault, wallet}
	if _, err := validateJupiterRequiredSignersV2(tx, wallet, intent); err == nil || !strings.Contains(err.Error(), "final transaction identity") {
		t.Fatalf("vault fee payer made the returned wallet signature an incorrect transaction id: %v", err)
	}
	tx.Message.AccountKeys = solana.PublicKeySlice{wallet, vault}
	tx.Message.AccountKeys[1] = solana.NewWallet().PublicKey()
	if _, err := validateJupiterRequiredSignersV2(tx, wallet, intent); err == nil {
		t.Fatal("unexpected Trigger co-signer was accepted")
	}
	tx.Message.AccountKeys[1] = vault
	tx.Signatures[1][0] = 1
	if _, err := validateJupiterRequiredSignersV2(tx, wallet, intent); err == nil {
		t.Fatal("pre-signed Trigger transaction was accepted")
	}
}

func TestJupiterTriggerNativeDepositAndWithdrawalBindVaultDeltas(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	vault := solana.NewWallet().PublicKey()
	deposit, err := normalizeSignerIntentV2(triggerDepositIntentV2(
		wallet,
		vault,
		solana.MustPublicKeyFromBase58(solanaNativeMintV2),
		wallet,
		vault,
		solana.SystemProgramID.String(),
	))
	if err != nil {
		t.Fatal(err)
	}
	deposit = enrichJupiterTriggerIntentV2(deposit, vault.String(), "deposit-request", wallet.String(), vault.String())
	snapshot := jupiterTransactionSnapshotV2{
		Accounts: map[string]*rpc.Account{
			wallet.String(): rpcAccountV2(t, solana.SystemProgramID, 1_000_000, nil),
			vault.String():  rpcAccountV2(t, solana.SystemProgramID, 500, nil),
		},
		Post: map[string]*rpc.Account{
			wallet.String(): rpcAccountV2(t, solana.SystemProgramID, 998_990, nil),
			vault.String():  rpcAccountV2(t, solana.SystemProgramID, 510, nil),
		},
	}
	if err := validateJupiterBalanceSemanticsV2(wallet, deposit, snapshot); err != nil {
		t.Fatalf("validate exact native Trigger deposit: %v", err)
	}
	snapshot.Post[vault.String()] = rpcAccountV2(t, solana.SystemProgramID, 511, nil)
	if err := validateJupiterBalanceSemanticsV2(wallet, deposit, snapshot); err == nil {
		t.Fatal("native Trigger deposit with an extra vault lamport was accepted")
	}

	cancelInput := triggerCancelIntentV2(
		wallet,
		vault,
		solana.MustPublicKeyFromBase58(solanaNativeMintV2),
		vault,
		wallet,
		solana.SystemProgramID.String(),
	)
	cancelInput.Jupiter.MaxFeeLamports = "5"
	cancel, err := normalizeSignerIntentV2(cancelInput)
	if err != nil {
		t.Fatal(err)
	}
	cancel = enrichJupiterTriggerIntentV2(cancel, vault.String(), "cancel-request", vault.String(), wallet.String())
	cancelSnapshot := jupiterTransactionSnapshotV2{
		Accounts: map[string]*rpc.Account{
			wallet.String(): rpcAccountV2(t, solana.SystemProgramID, 1_000_000, nil),
			vault.String():  rpcAccountV2(t, solana.SystemProgramID, 500, nil),
		},
		Post: map[string]*rpc.Account{
			wallet.String(): rpcAccountV2(t, solana.SystemProgramID, 1_000_005, nil),
			vault.String():  rpcAccountV2(t, solana.SystemProgramID, 490, nil),
		},
	}
	if err := validateJupiterBalanceSemanticsV2(wallet, cancel, cancelSnapshot); err != nil {
		t.Fatalf("validate exact native Trigger withdrawal: %v", err)
	}
	cancelSnapshot.Post[vault.String()] = rpcAccountV2(t, solana.SystemProgramID, 484, nil)
	if err := validateJupiterBalanceSemanticsV2(wallet, cancel, cancelSnapshot); err == nil {
		t.Fatal("native Trigger withdrawal above refund plus fee bound was accepted")
	}
}
