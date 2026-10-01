package main

import (
	"encoding/json"
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	bolt "go.etcd.io/bbolt"
)

func TestSignerRoleBaselineV1CompilesUsefulImmutableRoles(t *testing.T) {
	wallet := solana.NewWallet().PublicKey().String()
	for _, role := range []string{"agent"} {
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
		if role == "agent" {
			intent, err := normalizeSignerIntentV2(signerIntentV2{
				Type: intentSolanaNativeTransfer, Destination: solana.NewWallet().PublicKey().String(), Lamports: "1",
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := validateReviewPolicyV2(policy, intent, jupiterReviewModeReviewedV2); err != nil {
				t.Fatalf("Ordinary wallet baseline did not authorize an exact reviewed destination: %v", err)
			}
			if _, err := policyAssetForIntentV2(policy, intent); err == nil || !strings.Contains(err.Error(), "denies destination") {
				t.Fatalf("Ordinary wallet baseline allowed the reviewed destination through direct policy: %v", err)
			}
		}
	}
}

func TestRetiredWalletRolesRejected(t *testing.T) {
	for _, role := range []string{"mining", "vault", "profile", "strategy", "keeper"} {
		if _, err := compileSignerRoleBaselineV1("wallet", solana.NewWallet().PublicKey().String(), signerRoleBaselineRequestV1{Version: 1, Role: role}, signerRoleBaselineRuntimeV1{}); err == nil {
			t.Fatalf("retired role accepted: %s", role)
		}
	}
}

func TestSignerOrdinaryBaselineRequiresNetworkAndReviewedTransfers(t *testing.T) {
	store, keys := openTestSignerV2(t)
	wallet, policy, err := keys.CreateWithRoleBaseline(
		"ordinary-reviewed",
		0,
		signerRoleBaselineRequestV1{Version: 1, Role: "agent"},
		signerRoleBaselineRuntimeV1{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !containsStringV2(policy.Operations, intentSolanaNativeTransfer) || !containsStringV2(policy.Operations, intentSolanaSPLTransferChecked) {
		t.Fatalf("Ordinary wallet baseline lacks reviewed transfer operations: %#v", policy)
	}
	readiness, err := (&signerServiceV2{store: store, keys: keys}).walletReadinessV2(wallet.WalletID)
	if err != nil || !readiness.PolicyReady || readiness.NetworkReady || readiness.Ready ||
		readiness.OperationLane != "reviewed-and-autonomous" {
		t.Fatalf("Ordinary wallet did not expose its operation lane: %#v err=%v", readiness, err)
	}
}

func TestSignerApplicationCreatesOrdinaryWalletBaselineV1(t *testing.T) {
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
		readiness.OperationLane != "reviewed-and-autonomous" {
		t.Fatalf("unexpected pre-network readiness: %#v err=%v", readiness, err)
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

func TestStandardReadOnlyWalletBaseline(t *testing.T) {
	policy, err := compileSignerRoleBaselineV1("wallet_1", "11111111111111111111111111111111", signerRoleBaselineRequestV1{Version: 1, Role: "agent", ApprovalMode: "read-only"}, signerRoleBaselineRuntimeV1{})
	if err != nil {
		t.Fatal(err)
	}
	if policy.ApprovalMode != "read-only" || policy.BaselineVersion != 1 || len(policy.Operations) != 0 || len(policy.Programs) != 0 || len(policy.Assets) != 0 {
		t.Fatal("read-only creation granted authority")
	}
	for _, mode := range []string{"manual", "automatic"} {
		if _, err := compileSignerRoleBaselineV1("wallet_1", "11111111111111111111111111111111", signerRoleBaselineRequestV1{Version: 1, Role: "agent", ApprovalMode: mode}, signerRoleBaselineRuntimeV1{}); err == nil {
			t.Fatal("creation accepted granting approval mode")
		}
	}
}
