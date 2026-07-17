package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
)

const (
	testJupiterAPIKeyV2 = "api-key-secret-123456"
	testJupiterJWTV2    = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl"
)

func triggerCreateIntentForWalletV2(wallet solana.PublicKey) signerIntentV2 {
	return signerIntentV2{
		Type: intentSolanaTriggerCreate,
		Jupiter: &signerJupiterIntentV2{
			Owner: wallet.String(), InputMint: solanaNativeMintV2,
			OutputMint: solana.NewWallet().PublicKey().String(), InputAmount: "10",
			MaxInputAmount: "10", MaxFeeLamports: "5000",
			Programs: []string{solana.SystemProgramID.String()},
			Trigger: &signerJupiterTriggerIntentV2{
				Operation: "create", Program: solana.SystemProgramID.String(),
				TriggerMint: solanaNativeMintV2, Condition: "above", TargetPriceUSD: "200.00",
				SlippageBPS: 100, ExpiresAt: "2026-08-01T00:00:00.000Z", ExpectedOrderState: "new",
			},
		},
	}
}

func triggerCancelIntentForWalletV2(wallet solana.PublicKey, orderID string) signerIntentV2 {
	return signerIntentV2{
		Type: intentSolanaTriggerCancel,
		Jupiter: &signerJupiterIntentV2{
			Owner: wallet.String(), OutputMint: solanaNativeMintV2,
			MinimumOutputAmount: "10", MaxFeeLamports: "5000",
			DestinationTokenAccount: wallet.String(), Programs: []string{solana.SystemProgramID.String()},
			Trigger: &signerJupiterTriggerIntentV2{
				Operation: "cancel", Program: solana.SystemProgramID.String(),
				Order: orderID, ExpectedOrderState: "open",
			},
		},
	}
}

func installTriggerTestWalletV2(
	t *testing.T,
	store *signerStoreV2,
	keys *signerKeyManagerV2,
	walletID string,
	role string,
	intentForWallet func(solana.PublicKey) signerIntentV2,
) (signerWalletRecordV2, signerPolicyV2, normalizedIntentV2) {
	t.Helper()
	wallet, locked, err := keys.CreateWithPolicy(signerWalletCreateRequestV2{
		WalletID: walletID, ExpectedVersion: 0,
		Policy: signerPolicyV2{WalletID: walletID, Role: role},
	})
	if err != nil {
		t.Fatal(err)
	}
	publicKey := solana.MustPublicKeyFromBase58(wallet.PublicKey)
	intent, err := normalizeSignerIntentForWalletV2(intentForWallet(publicKey), &publicKey)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := store.putPolicy(signerPolicyV2{
		WalletID: walletID, Role: role,
		Operations: []string{intent.PolicyOperation}, Programs: intent.RequiredPrograms,
		Assets: []signerPolicyAssetV2{{
			Asset: "solana:native", Destinations: []string{wallet.PublicKey},
			MaxPerTx: "10000000", MaxDaily: "100000000",
		}},
	}, locked.Version)
	if err != nil {
		t.Fatal(err)
	}
	return wallet, policy, intent
}

type triggerHTTPFixtureV2 struct {
	t                  *testing.T
	wallet             solana.PublicKey
	apiKey             string
	token              string
	challenge          string
	history            func() []signerJupiterTriggerOrderV2
	createStatus       atomic.Int32
	createCalls        atomic.Int32
	cancelCalls        atomic.Int32
	confirmCalls       atomic.Int32
	confirmStatus      atomic.Int32
	lastCreate         map[string]any
	createTxSignature  string
	confirmTxSignature string
	mu                 sync.Mutex
}

func (f *triggerHTTPFixtureV2) handler(response http.ResponseWriter, request *http.Request) {
	if request.Header.Get("x-api-key") != f.apiKey {
		response.WriteHeader(http.StatusUnauthorized)
		return
	}
	response.Header().Set("content-type", "application/json")
	switch {
	case request.URL.Path == "/auth/challenge":
		_ = json.NewEncoder(response).Encode(map[string]string{"type": "message", "challenge": f.challenge})
	case request.URL.Path == "/auth/verify":
		var body struct {
			Type         string `json:"type"`
			WalletPublic string `json:"walletPubkey"`
			Signature    string `json:"signature"`
		}
		if json.NewDecoder(request.Body).Decode(&body) != nil || body.Type != "message" || body.WalletPublic != f.wallet.String() {
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		signature, err := solana.SignatureFromBase58(body.Signature)
		if err != nil || !signature.Verify(f.wallet, []byte(f.challenge)) {
			response.WriteHeader(http.StatusForbidden)
			return
		}
		_ = json.NewEncoder(response).Encode(map[string]string{"token": f.token})
	case request.Header.Get("authorization") != "Bearer "+f.token:
		response.WriteHeader(http.StatusUnauthorized)
	case request.URL.Path == "/orders/history":
		orders := []signerJupiterTriggerOrderV2{}
		if f.history != nil {
			orders = f.history()
		}
		_ = json.NewEncoder(response).Encode(map[string]any{
			"orders":     orders,
			"pagination": map[string]int{"total": len(orders), "limit": 100, "offset": 0},
		})
	case request.URL.Path == "/orders/price":
		f.createCalls.Add(1)
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body)
		f.mu.Lock()
		f.lastCreate = body
		signature := f.createTxSignature
		f.mu.Unlock()
		if status := f.createStatus.Load(); status >= 400 {
			response.WriteHeader(int(status))
			return
		}
		_ = json.NewEncoder(response).Encode(map[string]string{
			"id": "order-created", "txSignature": signature,
		})
	case strings.Contains(request.URL.Path, "/orders/price/cancel/"):
		f.cancelCalls.Add(1)
		response.WriteHeader(http.StatusTeapot)
	case strings.Contains(request.URL.Path, "/orders/price/confirm-cancel/"):
		f.confirmCalls.Add(1)
		if status := f.confirmStatus.Load(); status >= 400 {
			response.WriteHeader(int(status))
			return
		}
		f.mu.Lock()
		signature := f.confirmTxSignature
		f.mu.Unlock()
		orderID := request.URL.Path[strings.LastIndex(request.URL.Path, "/")+1:]
		_ = json.NewEncoder(response).Encode(map[string]string{"id": orderID, "txSignature": signature})
	default:
		response.WriteHeader(http.StatusNotFound)
	}
}

func stringValueForTestV2(value any, fallback string) string {
	if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
		return text
	}
	return fallback
}

func newTriggerHTTPTestClientV2(t *testing.T, fixture *triggerHTTPFixtureV2) (*httptest.Server, *signerJupiterTriggerClientV2) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(fixture.handler))
	t.Cleanup(server.Close)
	client, err := newSignerJupiterTriggerClientForTestV2(server.URL, []byte(fixture.apiKey), server.Client())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.close)
	return server, client
}

func TestJupiterTriggerAuthenticationRequiresDocumentedChallengeDomain(t *testing.T) {
	wallet := solana.NewWallet()
	fixture := &triggerHTTPFixtureV2{
		t: t, wallet: wallet.PublicKey(), apiKey: testJupiterAPIKeyV2, token: testJupiterJWTV2,
		challenge: "Jupiter wallet request for " + wallet.PublicKey().String(),
	}
	_, client := newTriggerHTTPTestClientV2(t, fixture)
	if _, err := client.authenticate("agent", wallet.PublicKey(), wallet.PrivateKey); err == nil ||
		!strings.Contains(err.Error(), "invalid wallet-bound message challenge") {
		t.Fatalf("non-domain-separated Jupiter challenge was accepted: %v", err)
	}

	fixture.challenge = jupiterTriggerMessagePrefixV2 + "nonce-1234567890"
	if _, err := client.authenticate("agent", wallet.PublicKey(), wallet.PrivateKey); err != nil {
		t.Fatalf("documented Jupiter Trigger challenge was rejected: %v", err)
	}
}

func TestJupiterTriggerSemanticContractCanonicalizesAndFailsClosed(t *testing.T) {
	wallet := solana.NewWallet().PublicKey()
	input := triggerCreateIntentForWalletV2(wallet)
	normalized, err := normalizeSignerIntentV2(input)
	if err != nil {
		t.Fatal(err)
	}
	if normalized.Intent.Jupiter.Trigger.TargetPriceUSD != "200" ||
		normalized.Intent.Jupiter.Trigger.ExpiresAt != "2026-08-01T00:00:00.000Z" ||
		normalized.Intent.Jupiter.Trigger.ExpectedOrderState != "new" {
		t.Fatalf("Trigger semantics were not canonical: %#v", normalized.Intent.Jupiter.Trigger)
	}

	for name, mutate := range map[string]func(*signerJupiterTriggerIntentV2){
		"exponent price":      func(trigger *signerJupiterTriggerIntentV2) { trigger.TargetPriceUSD = "2e2" },
		"noncanonical expiry": func(trigger *signerJupiterTriggerIntentV2) { trigger.ExpiresAt = "2026-08-01T00:00:00Z" },
		"state":               func(trigger *signerJupiterTriggerIntentV2) { trigger.ExpectedOrderState = "open" },
		"operation":           func(trigger *signerJupiterTriggerIntentV2) { trigger.Operation = "cancel" },
		"mint program mismatch": func(trigger *signerJupiterTriggerIntentV2) {
			trigger.Program = solana.TokenProgramID.String()
		},
	} {
		t.Run(name, func(t *testing.T) {
			candidate := input
			jupiter := *input.Jupiter
			trigger := *input.Jupiter.Trigger
			candidate.Jupiter, jupiter.Trigger = &jupiter, &trigger
			mutate(&trigger)
			if _, err := normalizeSignerIntentV2(candidate); err == nil {
				t.Fatal("mismatched Trigger semantics were accepted")
			}
		})
	}
}

func TestJupiterTriggerReviewedCancelPrepareIsReadOnlyAndBindsExactState(t *testing.T) {
	store, keys := openTestSignerV2(t)
	store.now = func() time.Time { return time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC) }
	wallet, policy, intent := installTriggerTestWalletV2(
		t, store, keys, "vault-trigger-cancel", "vault",
		func(publicKey solana.PublicKey) signerIntentV2 {
			return triggerCancelIntentForWalletV2(publicKey, "order-reviewed")
		},
	)
	walletPublic := solana.MustPublicKeyFromBase58(wallet.PublicKey)
	vault := solana.NewWallet().PublicKey()
	fixture := &triggerHTTPFixtureV2{
		t: t, wallet: walletPublic, apiKey: testJupiterAPIKeyV2, token: testJupiterJWTV2,
		challenge: jupiterTriggerMessagePrefixV2 + wallet.PublicKey,
		history: func() []signerJupiterTriggerOrderV2 {
			return []signerJupiterTriggerOrderV2{{
				ID: "order-reviewed", OrderType: "single", OrderState: "open", RawState: "open",
				UserPublicKey: wallet.PublicKey, VaultPublicKey: vault.String(),
				InputMint: solanaNativeMintV2, RemainingInputAmount: "10",
			}}
		},
	}
	_, client := newTriggerHTTPTestClientV2(t, fixture)
	client.now = store.now
	service := &signerServiceV2{store: store, keys: keys, trigger: client}
	review, err := service.prepareJupiterReviewV2(wallet.WalletID, signerReviewPrepareRequestV2{
		RequestID: "reviewed-cancel-no-side-effect", PolicyHash: policy.Hash,
		Mode: jupiterReviewModeReviewedV2, Intent: intent.Intent,
	})
	if err != nil {
		t.Fatal(err)
	}
	if review.ArtifactKind != signerReviewArtifactTriggerStateV2 || review.StateDigest == "" || review.Transaction != nil {
		t.Fatalf("review did not bind signer-owned Trigger state: %#v", review)
	}
	if fixture.cancelCalls.Load() != 0 || fixture.confirmCalls.Load() != 0 || fixture.createCalls.Load() != 0 {
		t.Fatalf("review.prepare changed Jupiter state: cancel=%d confirm=%d create=%d", fixture.cancelCalls.Load(), fixture.confirmCalls.Load(), fixture.createCalls.Load())
	}
	raw, err := marshalSignerResultV2(review)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{testJupiterAPIKeyV2, testJupiterJWTV2, "signedTxBase64"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("review response leaked %q: %s", secret, raw)
		}
	}
}

func TestJupiterTriggerPublicHistorySuppliesExactCancelIntentWithoutSecrets(t *testing.T) {
	store, keys := openTestSignerV2(t)
	store.now = func() time.Time { return time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC) }
	wallet, _, intent := installTriggerTestWalletV2(
		t, store, keys, "agent-trigger-history", "agent", triggerCreateIntentForWalletV2,
	)
	walletPublic := solana.MustPublicKeyFromBase58(wallet.PublicKey)
	vault := solana.NewWallet().PublicKey()
	expiresAt, _ := time.Parse(jupiterTriggerExpiryLayoutV2, intent.Intent.Jupiter.Trigger.ExpiresAt)
	fixture := &triggerHTTPFixtureV2{
		t: t, wallet: walletPublic, apiKey: testJupiterAPIKeyV2, token: testJupiterJWTV2,
		challenge: jupiterTriggerMessagePrefixV2 + wallet.PublicKey,
		history: func() []signerJupiterTriggerOrderV2 {
			return []signerJupiterTriggerOrderV2{{
				ID: "order-public-history", OrderType: "single", OrderState: "open", RawState: "open",
				UserPublicKey: wallet.PublicKey, VaultPublicKey: vault.String(),
				InputMint: solanaNativeMintV2, InitialInputAmount: "10", RemainingInputAmount: "7",
				OutputMint: intent.Intent.Jupiter.OutputMint, TriggerMint: intent.Intent.Jupiter.Trigger.TriggerMint,
				TriggerCondition: intent.Intent.Jupiter.Trigger.Condition,
				TriggerPriceUSD:  json.Number(intent.Intent.Jupiter.Trigger.TargetPriceUSD),
				SlippageBPS:      intent.Intent.Jupiter.Trigger.SlippageBPS, ExpiresAt: expiresAt.UnixMilli(),
			}}
		},
	}
	_, client := newTriggerHTTPTestClientV2(t, fixture)
	client.now = store.now
	service := &signerServiceV2{store: store, keys: keys, trigger: client}
	raw, err := service.handle(request{
		Op: "v2.jupiter.trigger.history", WalletID: wallet.WalletID,
	}, signerConfig{}, false)
	if err != nil {
		t.Fatal(err)
	}
	var response struct {
		OK     bool                                `json:"ok"`
		Result signerJupiterTriggerPublicHistoryV2 `json:"result"`
	}
	if err := json.Unmarshal(raw, &response); err != nil || !response.OK || len(response.Result.Orders) != 1 {
		t.Fatalf("decode public Trigger history: response=%#v err=%v raw=%s", response, err, raw)
	}
	order := response.Result.Orders[0]
	if order.OrderID != "order-public-history" || order.OrderState != triggerOrderStateOpenV2 ||
		order.InputMint != solanaNativeMintV2 || order.RemainingInputAmount != "7" || order.Cancel == nil ||
		order.Cancel.ExpectedOrderState != triggerOrderStateOpenV2 || order.Cancel.RefundMint != solanaNativeMintV2 ||
		order.Cancel.RefundAmount != "7" || order.Cancel.DestinationTokenAccount != wallet.PublicKey ||
		order.Cancel.Program != solana.SystemProgramID.String() {
		t.Fatalf("public history omitted exact cancel semantics: %#v", order)
	}
	for _, secret := range []string{
		testJupiterAPIKeyV2, testJupiterJWTV2, vault.String(), "signedTxBase64", "unsignedTxBase64",
		"requestId", "transaction", "privyWalletPubkey",
	} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("public Trigger history leaked private field %q: %s", secret, raw)
		}
	}
	if _, err := service.handle(request{
		Op: "v2.jupiter.trigger.history", WalletID: wallet.WalletID,
	}, signerConfig{readOnly: true}, false); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("read-only signer authenticated to Jupiter history: %v", err)
	}
}

func TestJupiterTriggerWorkflowIdempotencyCollisionAndConcurrency(t *testing.T) {
	store, keys := openTestSignerV2(t)
	store.now = func() time.Time { return time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC) }
	wallet, policy, intent := installTriggerTestWalletV2(
		t, store, keys, "agent-trigger-ledger", "agent", triggerCreateIntentForWalletV2,
	)
	service := &signerServiceV2{store: store, keys: keys}
	stateDigest, _, err := service.jupiterTriggerReviewStateV2(
		wallet.WalletID, solana.MustPublicKeyFromBase58(wallet.PublicKey), intent, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	req := signerExecuteRequestV2{
		RequestID: "trigger-workflow-stable", PolicyHash: policy.Hash,
		Intent: intent.Intent, intentWalletID: wallet.WalletID,
	}
	var created atomic.Int32
	var failed atomic.Int32
	var wg sync.WaitGroup
	for index := 0; index < 12; index++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, existing, reserveErr := store.reserveOperation(req, intent); reserveErr != nil {
				failed.Add(1)
			} else if !existing {
				created.Add(1)
			}
			if _, ensureErr := store.ensureJupiterTriggerWorkflowV2(req, intent, stateDigest); ensureErr != nil {
				failed.Add(1)
			}
		}()
	}
	wg.Wait()
	if failed.Load() != 0 || created.Load() != 1 {
		t.Fatalf("concurrent Trigger idempotency failed: created=%d failed=%d", created.Load(), failed.Load())
	}
	first, err := store.getJupiterTriggerWorkflowV2(req.RequestID)
	if err != nil || first.IntentDigest != intent.Digest || first.Phase != triggerPhaseReservedV2 {
		t.Fatalf("unexpected durable workflow: %#v err=%v", first, err)
	}

	changedInput := triggerCreateIntentForWalletV2(solana.MustPublicKeyFromBase58(wallet.PublicKey))
	changedInput.Jupiter.Trigger.TargetPriceUSD = "201"
	changed, err := normalizeSignerIntentV2(changedInput)
	if err != nil {
		t.Fatal(err)
	}
	changedReq := req
	changedReq.Intent = changed.Intent
	if _, err := store.ensureJupiterTriggerWorkflowV2(changedReq, changed, stateDigest); err == nil || !strings.Contains(err.Error(), "different immutable") {
		t.Fatalf("requestId collision was accepted: %v", err)
	}
}

func TestJupiterTriggerCrashAfterSigningSubmitsExactBytesOnceAndReplays(t *testing.T) {
	store, keys := openTestSignerV2(t)
	store.now = func() time.Time { return time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC) }
	wallet, policy, intent := installTriggerTestWalletV2(
		t, store, keys, "agent-trigger-crash", "agent", triggerCreateIntentForWalletV2,
	)
	walletPublic := solana.MustPublicKeyFromBase58(wallet.PublicKey)
	fixture := &triggerHTTPFixtureV2{
		t: t, wallet: walletPublic, apiKey: testJupiterAPIKeyV2, token: testJupiterJWTV2,
		challenge: jupiterTriggerMessagePrefixV2 + wallet.PublicKey,
	}
	_, client := newTriggerHTTPTestClientV2(t, fixture)
	client.now = store.now
	service := &signerServiceV2{store: store, keys: keys, trigger: client}
	stateDigest, _, err := service.jupiterTriggerReviewStateV2(wallet.WalletID, walletPublic, intent, nil)
	if err != nil {
		t.Fatal(err)
	}
	req := signerExecuteRequestV2{
		RequestID: "trigger-crash-after-sign", PolicyHash: policy.Hash,
		Intent: intent.Intent, intentWalletID: wallet.WalletID,
	}
	operation, _, err := store.reserveOperation(req, intent)
	if err != nil {
		t.Fatal(err)
	}
	workflow, err := store.ensureJupiterTriggerWorkflowV2(req, intent, stateDigest)
	if err != nil {
		t.Fatal(err)
	}
	operation, attempt, claimed, err := store.claimReservedOperation(req.RequestID)
	if err != nil || !claimed {
		t.Fatalf("claim operation: %#v claimed=%v err=%v", operation, claimed, err)
	}
	workflow, err = store.updateJupiterTriggerWorkflowV2(req.RequestID, []string{triggerPhaseReservedV2}, func(record *signerJupiterTriggerWorkflowV2) error {
		record.Phase = triggerPhasePreparedV2
		record.Vault = solana.NewWallet().PublicKey().String()
		record.ExternalRequestID = "deposit-request-crash"
		record.UnsignedTxBase64 = base64ForTestV2("unsigned-internal")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	operation, workflow, err = store.markJupiterTriggerSignedV2(
		req.RequestID, attempt, workflow.UnsignedTxBase64, []byte("signed-exact-once"), "deposit-signature-once", workflow.ExternalRequestID,
	)
	if err != nil || operation.State != operationBroadcast || workflow.Phase != triggerPhaseSignedV2 {
		t.Fatalf("persist crash phase: operation=%#v workflow=%#v err=%v", operation, workflow, err)
	}
	fixture.mu.Lock()
	fixture.createTxSignature = operation.Signature
	fixture.mu.Unlock()

	result, err := service.execute(req)
	if err != nil || result.State != operationConfirmed {
		t.Fatalf("resume signed Trigger workflow: %#v err=%v", result, err)
	}
	if fixture.createCalls.Load() != 1 {
		t.Fatalf("signed Trigger bytes were not submitted exactly once: %d", fixture.createCalls.Load())
	}
	fixture.mu.Lock()
	submitted := stringValueForTestV2(fixture.lastCreate["depositSignedTx"], "")
	fixture.mu.Unlock()
	if submitted != operation.SignedTxBase64 {
		t.Fatalf("resumed workflow changed signed bytes: got=%q want=%q", submitted, operation.SignedTxBase64)
	}
	replayed, err := service.execute(req)
	if err != nil || replayed.State != operationConfirmed || fixture.createCalls.Load() != 1 {
		t.Fatalf("terminal replay resubmitted Trigger order: %#v calls=%d err=%v", replayed, fixture.createCalls.Load(), err)
	}
}

func TestJupiterTriggerAmbiguousCreateReconcilesExactHistoryWithoutResubmit(t *testing.T) {
	store, keys := openTestSignerV2(t)
	store.now = func() time.Time { return time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC) }
	wallet, policy, intent := installTriggerTestWalletV2(
		t, store, keys, "agent-trigger-ambiguous", "agent", triggerCreateIntentForWalletV2,
	)
	walletPublic := solana.MustPublicKeyFromBase58(wallet.PublicKey)
	var submittedSignature atomic.Value
	submittedSignature.Store("")
	fixture := &triggerHTTPFixtureV2{
		t: t, wallet: walletPublic, apiKey: testJupiterAPIKeyV2, token: testJupiterJWTV2,
		challenge: jupiterTriggerMessagePrefixV2 + wallet.PublicKey,
		history: func() []signerJupiterTriggerOrderV2 {
			signature := submittedSignature.Load().(string)
			if signature == "" {
				return nil
			}
			expires, _ := time.Parse(jupiterTriggerExpiryLayoutV2, intent.Intent.Jupiter.Trigger.ExpiresAt)
			return []signerJupiterTriggerOrderV2{{
				ID: "order-reconciled", OrderType: "single", OrderState: "open", RawState: "open",
				UserPublicKey: wallet.PublicKey, InputMint: intent.Intent.Jupiter.InputMint,
				OutputMint: intent.Intent.Jupiter.OutputMint, InitialInputAmount: intent.Intent.Jupiter.InputAmount,
				TriggerMint:      intent.Intent.Jupiter.Trigger.TriggerMint,
				TriggerCondition: intent.Intent.Jupiter.Trigger.Condition,
				TriggerPriceUSD:  json.Number(intent.Intent.Jupiter.Trigger.TargetPriceUSD),
				SlippageBPS:      intent.Intent.Jupiter.Trigger.SlippageBPS, ExpiresAt: expires.UnixMilli(),
				Events: []signerJupiterTriggerEventV2{{Type: "deposit", TxSignature: signature}},
			}}
		},
	}
	fixture.createStatus.Store(http.StatusInternalServerError)
	_, client := newTriggerHTTPTestClientV2(t, fixture)
	client.now = store.now
	service := &signerServiceV2{store: store, keys: keys, trigger: client}
	stateDigest, _, err := service.jupiterTriggerReviewStateV2(wallet.WalletID, walletPublic, intent, nil)
	if err != nil {
		t.Fatal(err)
	}
	req := signerExecuteRequestV2{
		RequestID: "trigger-ambiguous-create", PolicyHash: policy.Hash,
		Intent: intent.Intent, intentWalletID: wallet.WalletID,
	}
	operation, _, err := store.reserveOperation(req, intent)
	if err != nil {
		t.Fatal(err)
	}
	workflow, err := store.ensureJupiterTriggerWorkflowV2(req, intent, stateDigest)
	if err != nil {
		t.Fatal(err)
	}
	operation, attempt, claimed, err := store.claimReservedOperation(req.RequestID)
	if err != nil || !claimed {
		t.Fatal("claim Trigger operation")
	}
	workflow, err = store.updateJupiterTriggerWorkflowV2(req.RequestID, []string{triggerPhaseReservedV2}, func(record *signerJupiterTriggerWorkflowV2) error {
		record.Phase = triggerPhasePreparedV2
		record.Vault = solana.NewWallet().PublicKey().String()
		record.ExternalRequestID = "deposit-request-ambiguous"
		record.UnsignedTxBase64 = base64ForTestV2("unsigned-internal")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	operation, workflow, err = store.markJupiterTriggerSignedV2(
		req.RequestID, attempt, workflow.UnsignedTxBase64, []byte("signed-ambiguous"), "deposit-signature-ambiguous", workflow.ExternalRequestID,
	)
	if err != nil {
		t.Fatal(err)
	}
	submittedSignature.Store(operation.Signature)
	first, err := service.execute(req)
	if err != nil || first.State != operationUnknown || fixture.createCalls.Load() != 1 {
		t.Fatalf("ambiguous create was not locked: %#v calls=%d err=%v", first, fixture.createCalls.Load(), err)
	}
	second, err := service.execute(req)
	if err != nil || second.State != operationConfirmed || second.ExternalResult == nil || second.ExternalResult.OrderID != "order-reconciled" {
		t.Fatalf("exact history did not reconcile ambiguous create: %#v err=%v", second, err)
	}
	if fixture.createCalls.Load() != 1 {
		t.Fatalf("ambiguous create was resubmitted: %d", fixture.createCalls.Load())
	}
}

func TestJupiterTriggerAmbiguousCancelReconcilesExactHistoryWithoutReinitOrResign(t *testing.T) {
	store, keys := openTestSignerV2(t)
	store.now = func() time.Time { return time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC) }
	wallet, policy, intent := installTriggerTestWalletV2(
		t, store, keys, "agent-trigger-cancel-ambiguous", "agent",
		func(publicKey solana.PublicKey) signerIntentV2 {
			return triggerCancelIntentForWalletV2(publicKey, "order-cancel-ambiguous")
		},
	)
	walletPublic := solana.MustPublicKeyFromBase58(wallet.PublicKey)
	vault := solana.NewWallet().PublicKey()
	var submittedSignature atomic.Value
	submittedSignature.Store("")
	fixture := &triggerHTTPFixtureV2{
		t: t, wallet: walletPublic, apiKey: testJupiterAPIKeyV2, token: testJupiterJWTV2,
		challenge: jupiterTriggerMessagePrefixV2 + wallet.PublicKey,
		history: func() []signerJupiterTriggerOrderV2 {
			signature := submittedSignature.Load().(string)
			if signature == "" {
				return nil
			}
			return []signerJupiterTriggerOrderV2{{
				ID: "order-cancel-ambiguous", OrderType: "single",
				OrderState: "cancelled", RawState: "cancelled",
				UserPublicKey: wallet.PublicKey, VaultPublicKey: vault.String(),
				InputMint: solanaNativeMintV2, RemainingInputAmount: "10",
				Events: []signerJupiterTriggerEventV2{{Type: "withdrawal", TxSignature: signature}},
			}}
		},
	}
	fixture.confirmStatus.Store(http.StatusInternalServerError)
	_, client := newTriggerHTTPTestClientV2(t, fixture)
	client.now = store.now
	service := &signerServiceV2{store: store, keys: keys, trigger: client}
	stateDigest, err := jupiterTriggerDigestV2(signerJupiterTriggerCancelSnapshotV2{
		OrderID: "order-cancel-ambiguous", Wallet: wallet.PublicKey, Vault: vault.String(),
		RefundMint: solanaNativeMintV2, RefundAmount: "10",
		RefundDestination: wallet.PublicKey, OrderState: triggerOrderStateOpenV2,
	})
	if err != nil {
		t.Fatal(err)
	}
	req := signerExecuteRequestV2{
		RequestID: "trigger-ambiguous-cancel", PolicyHash: policy.Hash,
		Intent: intent.Intent, intentWalletID: wallet.WalletID,
	}
	operation, _, err := store.reserveOperation(req, intent)
	if err != nil {
		t.Fatal(err)
	}
	workflow, err := store.ensureJupiterTriggerWorkflowV2(req, intent, stateDigest)
	if err != nil {
		t.Fatal(err)
	}
	operation, attempt, claimed, err := store.claimReservedOperation(req.RequestID)
	if err != nil || !claimed {
		t.Fatal("claim Trigger cancel operation")
	}
	workflow, err = store.updateJupiterTriggerWorkflowV2(req.RequestID, []string{triggerPhaseReservedV2}, func(record *signerJupiterTriggerWorkflowV2) error {
		record.Phase = triggerPhasePreparedV2
		record.Vault = vault.String()
		record.SourceTokenAccount = vault.String()
		record.DestinationTokenAccount = wallet.PublicKey
		record.ExternalRequestID = "cancel-request-ambiguous"
		record.UnsignedTxBase64 = base64ForTestV2("unsigned-cancel-internal")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	operation, workflow, err = store.markJupiterTriggerSignedV2(
		req.RequestID, attempt, workflow.UnsignedTxBase64, []byte("signed-cancel-ambiguous"),
		"withdrawal-signature-ambiguous", workflow.ExternalRequestID,
	)
	if err != nil {
		t.Fatal(err)
	}
	submittedSignature.Store(operation.Signature)
	fixture.mu.Lock()
	fixture.confirmTxSignature = operation.Signature
	fixture.mu.Unlock()
	first, err := service.execute(req)
	if err != nil || first.State != operationUnknown || fixture.confirmCalls.Load() != 1 || fixture.cancelCalls.Load() != 0 {
		t.Fatalf("ambiguous cancel was not locked: %#v confirm=%d cancel=%d err=%v", first, fixture.confirmCalls.Load(), fixture.cancelCalls.Load(), err)
	}
	second, err := service.execute(req)
	if err != nil || second.State != operationConfirmed || second.ExternalResult == nil || second.ExternalResult.OrderState != triggerOrderStateCancelledV2 {
		t.Fatalf("exact history did not reconcile ambiguous cancel: %#v err=%v", second, err)
	}
	if fixture.confirmCalls.Load() != 1 || fixture.cancelCalls.Load() != 0 {
		t.Fatalf("ambiguous cancel was repeated: confirm=%d cancel=%d", fixture.confirmCalls.Load(), fixture.cancelCalls.Load())
	}
}

func TestJupiterTriggerAmbiguousCancelInitiationIsDurablyUnknownAndNeverRepeated(t *testing.T) {
	store, keys := openTestSignerV2(t)
	store.now = func() time.Time { return time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC) }
	wallet, policy, intent := installTriggerTestWalletV2(
		t, store, keys, "agent-trigger-cancel-init-ambiguous", "agent",
		func(publicKey solana.PublicKey) signerIntentV2 {
			return triggerCancelIntentForWalletV2(publicKey, "order-cancel-init-ambiguous")
		},
	)
	walletPublic := solana.MustPublicKeyFromBase58(wallet.PublicKey)
	vault := solana.NewWallet().PublicKey()
	fixture := &triggerHTTPFixtureV2{
		t: t, wallet: walletPublic, apiKey: testJupiterAPIKeyV2, token: testJupiterJWTV2,
		challenge: jupiterTriggerMessagePrefixV2 + wallet.PublicKey,
		history: func() []signerJupiterTriggerOrderV2 {
			return []signerJupiterTriggerOrderV2{{
				ID: "order-cancel-init-ambiguous", OrderType: "single", OrderState: "open", RawState: "open",
				UserPublicKey: wallet.PublicKey, VaultPublicKey: vault.String(),
				InputMint: solanaNativeMintV2, RemainingInputAmount: "10",
			}}
		},
	}
	_, client := newTriggerHTTPTestClientV2(t, fixture)
	client.now = store.now
	service := &signerServiceV2{store: store, keys: keys, trigger: client}
	req := signerExecuteRequestV2{
		RequestID: "trigger-cancel-init-ambiguous", PolicyHash: policy.Hash,
		Intent: intent.Intent, intentWalletID: wallet.WalletID,
	}

	first, err := service.execute(req)
	if err == nil || first.State != operationUnknown || !first.ReservationActive || fixture.cancelCalls.Load() != 1 {
		t.Fatalf("ambiguous cancel initiation was not durably locked: operation=%#v calls=%d err=%v", first, fixture.cancelCalls.Load(), err)
	}
	workflow, workflowErr := store.getJupiterTriggerWorkflowV2(req.RequestID)
	if workflowErr != nil || workflow.Phase != triggerPhaseUnknownV2 || workflow.Signature != "" {
		t.Fatalf("ambiguous pre-sign workflow was not durable: workflow=%#v err=%v", workflow, workflowErr)
	}

	second, err := service.execute(req)
	if err == nil || second.State != operationUnknown || fixture.cancelCalls.Load() != 1 {
		t.Fatalf("ambiguous cancel initiation was repeated: operation=%#v calls=%d err=%v", second, fixture.cancelCalls.Load(), err)
	}
}

func TestJupiterTriggerAPIKeyFileAndProductionURLFailClosed(t *testing.T) {
	directory := t.TempDir()
	path := directory + "/jupiter.key"
	if err := writePrivateTestFileV2(path, testJupiterAPIKeyV2+"\n", 0o600); err != nil {
		t.Fatal(err)
	}
	key, err := readSignerJupiterAPIKeyFileV2(path)
	if err != nil || string(key) != testJupiterAPIKeyV2 {
		t.Fatalf("read private signer-owned API key: key=%q err=%v", key, err)
	}
	client, err := newSignerJupiterTriggerClientV2(key)
	zeroBytes(key)
	if err != nil {
		t.Fatal(err)
	}
	defer client.close()
	if client.baseURL != jupiterTriggerProductionBaseURLV2 {
		t.Fatalf("production Trigger base URL is not pinned: %s", client.baseURL)
	}
	if err := writePrivateTestFileV2(path+".public", testJupiterAPIKeyV2, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readSignerJupiterAPIKeyFileV2(path + ".public"); err == nil {
		t.Fatal("group/world-readable Jupiter API key file was accepted")
	}
}

func TestJupiterTriggerAPIKeyPathDefaultsBesideSignerState(t *testing.T) {
	if got := resolveSignerJupiterAPIKeyPathV2("", "/var/lib/fased-signerd/state.db"); got != "/var/lib/fased-signerd/jupiter-trigger-api.key" {
		t.Fatalf("Hosting signer key path did not follow signer state: %q", got)
	}
	if got := resolveSignerJupiterAPIKeyPathV2("", "/home/user/.fased/wallet/signerd-v2.db"); got != "/home/user/.fased/wallet/jupiter-trigger-api.key" {
		t.Fatalf("Local signer key path did not follow signer state: %q", got)
	}
	if got := resolveSignerJupiterAPIKeyPathV2(" /run/secrets/jupiter.key ", "/ignored/state.db"); got != "/run/secrets/jupiter.key" {
		t.Fatalf("explicit Docker signer key path was not preserved: %q", got)
	}
}

func TestJupiterTriggerHealthExposesOnlyConfigurationState(t *testing.T) {
	store, keys := openTestSignerV2(t)
	webauthn, err := newSignerWebAuthnServiceV2(store, "", "")
	if err != nil {
		t.Fatal(err)
	}
	service := &signerServiceV2{store: store, keys: keys, webauthn: webauthn}
	health, err := service.health(signerConfig{chains: []string{"solana"}})
	if err != nil || health.Jupiter.TriggerConfigured {
		t.Fatalf("unconfigured Trigger health is incorrect: health=%#v err=%v", health.Jupiter, err)
	}
	client, err := newSignerJupiterTriggerClientV2([]byte(testJupiterAPIKeyV2))
	if err != nil {
		t.Fatal(err)
	}
	defer client.close()
	service.trigger = client
	health, err = service.health(signerConfig{chains: []string{"solana"}})
	if err != nil || !health.Jupiter.TriggerConfigured {
		t.Fatalf("configured Trigger health is incorrect: health=%#v err=%v", health.Jupiter, err)
	}
	encoded, err := json.Marshal(health)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), testJupiterAPIKeyV2) || strings.Contains(strings.ToLower(string(encoded)), "jwt") {
		t.Fatalf("Trigger health leaked credential material: %s", encoded)
	}
}

func base64ForTestV2(value string) string {
	return base64.StdEncoding.EncodeToString([]byte(value))
}

func writePrivateTestFileV2(path, value string, mode os.FileMode) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(file, value); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}
