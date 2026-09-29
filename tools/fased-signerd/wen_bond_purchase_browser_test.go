package main

import (
	"context"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
	"testing"
	"time"
)

// Test-only protected profile with actual signer keys, draft/admission installation
// and typed application preparation. Only the Solana RPC is a local fixture.
func bondPurchaseBrowserSignerFixtureV2(t *testing.T, host, origin string) (*signerServiceV2, *bondExecutionFakeV2, signerReviewV2, string) {
	store, keys := openTestSignerV2(t)
	record, old := createTestSignerWalletV2(t, store, keys, "miner", solana.PublicKey{1}.String(), 10000, 20000)
	store.now = time.Now
	f, p, policy, limits := bondPurchaseReadFixtureV2(t, solana.MustPublicKeyFromBase58(record.PublicKey))
	prepared, e := prepareWENBondPurchaseCostsV2(context.Background(), f, p, policy, limits, nil)
	if e != nil {
		t.Fatal(e)
	}
	a, e := newWENBondPurchaseReviewV2("review-request-001", "miner", old.Hash, prepared)
	if e != nil {
		t.Fatal(e)
	}
	native := strconv.FormatUint(a.nativeDebit(), 10)
	_, e = store.putPolicy(signerPolicyV2{WalletID: "miner", Role: old.Role, Operations: []string{wenBondPurchaseOperationV2}, Programs: a.requiredPrograms(), Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{p.Bond.Sale.String()}, MaxPerTx: native, MaxDaily: native}, {Asset: a.cashAsset(), Destinations: []string{p.Bond.Sale.String()}, MaxPerTx: strconv.FormatUint(a.cashAmount(), 10), MaxDaily: strconv.FormatUint(a.cashAmount(), 10)}}}, old.Version)
	if e != nil {
		t.Fatal(e)
	}
	keys.genesisHash = func(string) (string, error) { return policy.Deployment.Genesis, nil }
	endpoint := "https://market-browser-fixture.invalid"
	if _, e = keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
		t.Fatal(e)
	}
	auth, e := newSignerWebAuthnServiceV2(store, host, origin)
	if e != nil {
		t.Fatal(e)
	}
	service := &signerServiceV2{store: store, keys: keys, webauthn: auth}
	client := &bondExecutionFakeV2{bondRecoveryFakeV2: &bondRecoveryFakeV2{wenBondPurchaseRPCFakeV2: f}, store: store, mode: "ok"}
	factory := func(url string) wenBondPurchaseExecutionRPCV2 {
		if url != endpoint {
			t.Fatal("browser replaced RPC")
		}
		return client
	}
	cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
	draft := wenBondPurchaseDraftV2{Version: 2, WalletID: "miner", WalletPublicKey: record.PublicKey, Pins: p, Policy: policy, Limits: limits}
	raw, _ := json.Marshal(draft)
	draftHash := wenHashV1(raw)
	if _, e = service.installWENBondPurchaseDraftV2(context.Background(), cfg, "miner", draft, draftHash, true, factory); e != nil {
		t.Fatal(e)
	}
	body, _ := json.Marshal(wenBondPurchaseReviewRequestV2{RequestID: a.RequestID, DraftSHA256: draftHash})
	wire, e := service.bondPurchaseApplicationWithFactoryV2(context.Background(), request{Op: "v2.wenBondPurchase.review.prepare", WalletID: "miner", Request: body}, cfg, factory)
	if e != nil {
		t.Fatal(e)
	}
	var envelope struct {
		Result signerReviewV2 `json:"result"`
	}
	if e = json.Unmarshal(wire, &envelope); e != nil {
		t.Fatal(e)
	}
	review := envelope.Result
	if e = json.Unmarshal(review.SemanticIntent, &a); e != nil {
		t.Fatal(e)
	}
	client.artifact = a
	digest, e := a.digest()
	if e != nil {
		t.Fatal(e)
	}
	for scope, n := range wenBondPurchaseReservationScopesV2(a) {
		if e = store.configureWENBudgetV1(scope, n); e != nil {
			t.Fatal(e)
		}
	}
	if e = service.installWENBondPurchaseAdmissionV2(context.Background(), cfg, "miner", a.RequestID, digest, true, factory); e != nil {
		t.Fatal(e)
	}
	return service, client, review, draftHash
}
