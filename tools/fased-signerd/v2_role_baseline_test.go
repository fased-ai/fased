package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

func TestSignerRoleBaselineV1CompilesUsefulImmutableRoles(t *testing.T) {
	wallet := solana.NewWallet().PublicKey().String()
	for _, role := range []string{"agent", "vault"} {
		policy, err := compileSignerRoleBaselineV1(
			role,
			wallet,
			signerRoleBaselineRequestV1{Version: 1, Role: role},
			signerRoleBaselineRuntimeV1{},
		)
		if err != nil {
			t.Fatalf("compile %s baseline: %v", role, err)
		}
		if policy.BaselineVersion != 1 || policy.Role != role || policy.Hash == "" ||
			!containsStringV2(policy.Operations, intentSolanaNativeTransfer) || len(policy.Assets) == 0 {
			t.Fatalf("%s baseline is not role-ready: %#v", role, policy)
		}
		if role == "vault" {
			intent, err := normalizeSignerIntentV2(signerIntentV2{
				Type: intentSolanaNativeTransfer, Destination: solana.NewWallet().PublicKey().String(), Lamports: "1",
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := validateReviewPolicyV2(policy, intent, jupiterReviewModeReviewedV2); err != nil {
				t.Fatalf("Vault baseline did not authorize an exact reviewed destination: %v", err)
			}
			if _, err := policyAssetForIntentV2(policy, intent); err == nil || !strings.Contains(err.Error(), "denies destination") {
				t.Fatalf("Vault baseline allowed the reviewed destination through direct policy: %v", err)
			}
		}
	}
}

func TestSignerMiningRoleBaselineV1UsesReleaseRuntimeAndAllTypedActions(t *testing.T) {
	wallet := solana.NewWallet().PublicKey().String()
	program := solana.NewWallet().PublicKey().String()
	bondProgram := solana.NewWallet().PublicKey().String()
	mint := solana.NewWallet().PublicKey().String()
	policy, err := compileSignerRoleBaselineV1(
		"mining",
		wallet,
		signerRoleBaselineRequestV1{Version: 1, Role: "mining"},
		signerRoleBaselineRuntimeV1{
			SATProgramID: program, SATBondProgramID: bondProgram,
			SATMintAddress: mint, SATMintProgramID: solana.TokenProgramID.String(), Verified: true,
		},
	)
	if err != nil {
		t.Fatalf("compile Mining baseline: %v", err)
	}
	if !policy.TypedSATPrograms || policy.BaselineVersion != 1 {
		t.Fatalf("Mining baseline lacks typed SAT authority: %#v", policy)
	}
	for _, action := range sortedSATActionsV2() {
		if signerSATCodecsV2[action].Family == satFamilyMain && !containsStringV2(policy.Operations, "sat."+action+"@"+program) {
			t.Fatalf("Mining baseline omitted typed SAT action %s", action)
		}
	}
	for _, action := range []string{"create", "extend", "deactivate", "close"} {
		operation := "satLookup." + action + "@" + satAddressLookupTableProgramIDV2.String()
		if !containsStringV2(policy.Operations, operation) {
			t.Fatalf("Mining baseline omitted %s", operation)
		}
	}
	prelaunch, err := compileSignerRoleBaselineV1(
		"mining",
		wallet,
		signerRoleBaselineRequestV1{Version: 1, Role: "mining"},
		signerRoleBaselineRuntimeV1{},
	)
	if err != nil || prelaunch.BaselineVersion != 1 || prelaunch.Role != "mining" ||
		prelaunch.TypedSATPrograms || !containsStringV2(prelaunch.Operations, intentSolanaNativeTransfer) {
		t.Fatalf("Mining pre-launch baseline was not restricted to reviewed transfers: policy=%#v err=%v", prelaunch, err)
	}
}

func TestSignerMiningPrelaunchBaselineIsWalletReadyWithoutSATAuthority(t *testing.T) {
	store, keys := openTestSignerV2(t)
	wallet, policy, err := keys.CreateWithRoleBaseline(
		"prelaunch-mining",
		0,
		signerRoleBaselineRequestV1{Version: 1, Role: "mining"},
		signerRoleBaselineRuntimeV1{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if policy.TypedSATPrograms {
		t.Fatalf("pre-launch policy unexpectedly granted typed SAT authority: %#v", policy)
	}
	readiness, err := (&signerServiceV2{store: store, keys: keys}).walletReadinessV2(wallet.WalletID)
	if err != nil || !readiness.PolicyReady || readiness.NetworkReady || readiness.Ready ||
		readiness.OperationLane != "mining-reviewed-only" {
		t.Fatalf("pre-launch Mining wallet did not expose its reviewed-use lane: %#v err=%v", readiness, err)
	}
}

func TestSignerMiningRoleBaselineRuntimeRequiresTrustedSignedManifest(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	program := solana.NewWallet().PublicKey().String()
	bondProgram := solana.NewWallet().PublicKey().String()
	mint := solana.NewWallet().PublicKey().String()
	manifest, err := json.Marshal(map[string]any{
		"schema": "sat-mainnet-addresses.v1", "network": "mainnet-beta", "status": "live",
		"sat": map[string]string{
			"programId": program, "bondProgramId": bondProgram, "mint": mint,
			"mintProgramId": solana.TokenProgramID.String(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(manifest)
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "sat-runtime.manifest.json")
	signaturePath := filepath.Join(dir, "sat-runtime.manifest.sig")
	if err := os.WriteFile(manifestPath, manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(signaturePath, []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, manifest))), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FASED_SAT_PROGRAM_ID", program)
	t.Setenv("FASED_SAT_BOND_PROGRAM_ID", bondProgram)
	t.Setenv("FASED_SAT_MINT_ADDRESS", mint)
	t.Setenv("FASED_SAT_MINT_PROGRAM_ID", solana.TokenProgramID.String())
	t.Setenv("FASED_SAT_RUNTIME_MANIFEST_PATH", manifestPath)
	t.Setenv("FASED_SAT_RUNTIME_MANIFEST_SHA256", hex.EncodeToString(digest[:]))
	t.Setenv("FASED_SAT_RUNTIME_MANIFEST_SIGNATURE_PATH", signaturePath)
	t.Setenv("FASED_SAT_MAINNET_MANIFEST_PUBLIC_KEY", base64.RawURLEncoding.EncodeToString(publicKey))
	runtime := signerRoleBaselineRuntimeFromEnvV1()
	if !runtime.Verified || runtime.VerificationErr != "" {
		t.Fatalf("signed SAT runtime was not verified: %#v", runtime)
	}
	if err := os.WriteFile(signaturePath, []byte(base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))), 0o600); err != nil {
		t.Fatal(err)
	}
	runtime = signerRoleBaselineRuntimeFromEnvV1()
	if runtime.Verified || !strings.Contains(runtime.VerificationErr, "not trusted") {
		t.Fatalf("untrusted SAT runtime signature was accepted: %#v", runtime)
	}
}

func TestSignerApplicationCreatesAndExplicitlyActivatesRoleBaselineV1(t *testing.T) {
	store, keys := openTestSignerV2(t)
	service := &signerServiceV2{store: store, keys: keys}
	createBody, err := json.Marshal(signerWalletCreateRequestV2{
		ExpectedVersion: 0,
		Baseline:        &signerRoleBaselineRequestV1{Version: 1, Role: "agent"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.handle(
		request{Op: "v2.wallet.create", WalletID: "ready-agent", Request: createBody},
		signerConfig{},
		false,
	); err != nil {
		t.Fatalf("application create with signer-owned baseline: %v", err)
	}
	readiness, err := service.walletReadinessV2("ready-agent")
	if err != nil || !readiness.KeyReady || !readiness.PolicyReady || readiness.NetworkReady || readiness.Ready ||
		readiness.OperationLane != "agent-reviewed-and-autonomous" {
		t.Fatalf("unexpected pre-network readiness: %#v err=%v", readiness, err)
	}

	locked, _, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{
		WalletID: "locked-vault", ExpectedVersion: 0,
		Policy: signerPolicyV2{Role: "vault", Operations: []string{}, Programs: []string{}, Assets: []signerPolicyAssetV2{}},
	})
	if err != nil {
		t.Fatal(err)
	}
	activationBody, err := json.Marshal(signerRoleBaselineActivationRequestV1{
		ExpectedVersion: 1,
		Baseline:        signerRoleBaselineRequestV1{Version: 1, Role: "vault"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.handle(
		request{Op: "v2.policy.activateBaseline", WalletID: locked.WalletID, Request: activationBody},
		signerConfig{},
		false,
	); err == nil || !strings.Contains(err.Error(), "control socket") {
		t.Fatalf("application socket activated a role baseline: %v", err)
	}
	if _, err := service.handle(
		request{Op: "v2.policy.activateBaseline", WalletID: locked.WalletID, Request: activationBody},
		signerConfig{},
		true,
	); err != nil {
		t.Fatalf("control-socket deny-all migration: %v", err)
	}
	activated, err := store.getPolicy(locked.WalletID)
	if err != nil || activated.Version != 2 || activated.BaselineVersion != 1 || activated.Role != "vault" {
		t.Fatalf("unexpected activated policy: %#v err=%v", activated, err)
	}
	if _, err := service.handle(
		request{Op: "v2.policy.activateBaseline", WalletID: locked.WalletID, Request: activationBody},
		signerConfig{},
		true,
	); err == nil {
		t.Fatal("role baseline activation silently expanded an already activated wallet")
	}
}

func TestSignerRoleBaselineControlUIConfirmationBindsExactReviewedTransfer(t *testing.T) {
	store, keys := openTestSignerV2(t)
	wallet, policy, err := keys.CreateWithRoleBaseline(
		"reviewed-agent",
		0,
		signerRoleBaselineRequestV1{Version: 1, Role: "agent"},
		signerRoleBaselineRuntimeV1{},
	)
	if err != nil {
		t.Fatal(err)
	}
	intent, err := normalizeSignerIntentV2(signerIntentV2{
		Type: intentSolanaNativeTransfer, Destination: solana.NewWallet().PublicKey().String(), Lamports: "1",
	})
	if err != nil {
		t.Fatal(err)
	}
	requestID := "control-ui-reviewed-transfer"
	nonce := strings.Repeat("a", 64)
	review := signerReviewV2{
		RequestID: requestID, WalletID: wallet.WalletID, IntentType: intent.Intent.Type,
		IntentDigest: intent.Digest, PolicyHash: policy.Hash, Mode: jupiterReviewModeReviewedV2,
		Nonce: nonce, State: jupiterReviewPreparedV2,
	}
	encodedReview, err := json.Marshal(review)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketSignerReviewsV2).Put([]byte(requestID), encodedReview)
	}); err != nil {
		t.Fatal(err)
	}
	operation, _, err := store.reserveOperation(signerExecuteRequestV2{
		RequestID: requestID, PolicyHash: policy.Hash, Intent: intent.Intent,
		intentWalletID: wallet.WalletID, reviewed: true,
	}, intent)
	if err != nil {
		t.Fatalf("reserve reviewed role-baseline transfer: %v", err)
	}
	operation, attempt, claimed, err := store.claimReservedOperation(operation.RequestID)
	if err != nil || !claimed {
		t.Fatalf("claim reviewed role-baseline transfer: claimed=%v err=%v", claimed, err)
	}
	if err := store.authorizeControlUIReviewOperationV2(
		review, policy, intent, nonce, operation.RequestID, attempt,
	); err != nil {
		t.Fatalf("authorize exact Control UI confirmation: %v", err)
	}
	stored, err := store.getOperation(operation.RequestID)
	if err != nil || stored.AuthorizationProof != nonce || stored.AuthorizedAt == "" {
		t.Fatalf("Control UI confirmation was not durably bound: %#v err=%v", stored, err)
	}
	if err := store.authorizeControlUIReviewOperationV2(
		review, policy, intent, strings.Repeat("b", 64), operation.RequestID, attempt,
	); err == nil || !strings.Contains(err.Error(), "fresh signer review nonce") {
		t.Fatalf("mismatched Control UI nonce was accepted: %v", err)
	}
}
