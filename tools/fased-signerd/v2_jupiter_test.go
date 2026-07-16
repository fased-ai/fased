package main

import (
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
	if normalized.Amount.Cmp(big.NewInt(100)) != 0 || normalized.Asset != "solana:spl:"+input.Jupiter.InputMint {
		t.Fatalf("unexpected normalized intent: %#v", normalized)
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
	if action, err := validateJupiterAuxiliaryInstructionV2(createData, createMetas, wallet, intent); err != nil || action {
		t.Fatalf("validate exact create-token-account: action=%v err=%v", action, err)
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
		Assets: []signerPolicyAssetV2{{
			Asset:        normalized.Asset,
			Destinations: []string{wallet.PublicKey},
			MaxPerTx:     "100",
			MaxDaily:     "1000",
		}},
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
		Assets: []signerPolicyAssetV2{{
			Asset:        intent.Asset,
			Destinations: []string{wallet.PublicKey},
			MaxPerTx:     "100",
			MaxDaily:     "1000",
		}},
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
		Assets:     []signerPolicyAssetV2{{Asset: normalized.Asset, Destinations: []string{wallet.PublicKey}, MaxPerTx: "100", MaxDaily: "1000"}},
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
	return signerIntentV2{
		Type: intentSolanaTriggerDeposit,
		Jupiter: &signerJupiterIntentV2{
			Owner:                   wallet.String(),
			InputMint:               mint.String(),
			InputAmount:             "10",
			MaxInputAmount:          "10",
			MaxFeeLamports:          "5000",
			SourceTokenAccount:      source.String(),
			DestinationTokenAccount: destination.String(),
			Programs:                []string{program},
			Trigger: &signerJupiterTriggerIntentV2{
				Program:   program,
				Vault:     vault.String(),
				RequestID: "deposit-request",
			},
		},
	}
}

func triggerCancelIntentV2(wallet, vault, mint, source, destination solana.PublicKey, program string) signerIntentV2 {
	return signerIntentV2{
		Type: intentSolanaTriggerCancel,
		Jupiter: &signerJupiterIntentV2{
			Owner:                   wallet.String(),
			OutputMint:              mint.String(),
			MinimumOutputAmount:     "10",
			MaxFeeLamports:          "5000",
			SourceTokenAccount:      source.String(),
			DestinationTokenAccount: destination.String(),
			Programs:                []string{program},
			Trigger: &signerJupiterTriggerIntentV2{
				Program:   program,
				Vault:     vault.String(),
				Order:     "order-1",
				RequestID: "cancel-request",
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
		t.Fatalf("normalize exact Trigger deposit: %v", err)
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
	if _, err := normalizeSignerIntentV2(aliased); err == nil || !strings.Contains(err.Error(), "distinct") {
		t.Fatalf("expected signer/vault alias rejection, got %v", err)
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
	accounts := map[string]*rpc.Account{
		mint.String():        rpcAccountV2(t, solana.TokenProgramID, 1, make([]byte, 82)),
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
