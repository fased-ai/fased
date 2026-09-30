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
func bondClaimBrowserSignerFixtureV2(t *testing.T, host, origin string) (*signerServiceV2, *bondClaimExecutionFakeV2, signerReviewV2, string) {
	store, keys := openTestSignerV2(t)
	record, old := createTestSignerWalletV2(t, store, keys, "miner", solana.PublicKey{1}.String(), 10000, 20000)
	store.now = time.Now
	f, p, policy := bondReadFixtureV2(t, solana.MustPublicKeyFromBase58(record.PublicKey))
	prepared, e := prepareWENBondClaimV2(context.Background(), f, p, policy, 10000, 1000, nil)
	if e != nil {
		t.Fatal(e)
	}
	a, e := newWENBondClaimReviewV2("review-request-001", "miner", old.Hash, prepared)
	if e != nil {
		t.Fatal(e)
	}
	native := strconv.FormatUint(a.MaxFee, 10)
	_, e = store.putPolicy(signerPolicyV2{WalletID: "miner", Role: old.Role, Operations: []string{wenBondClaimOperationV2}, Programs: a.requiredPrograms(), Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{p.Destination.String()}, MaxPerTx: native, MaxDaily: native}}}, old.Version)
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
	client := &bondClaimExecutionFakeV2{wenBondRPCFakeV2: f, store: store, mode: "ok"}
	factory := func(url string) wenBondClaimExecutionRPCV2 {
		if url != endpoint {
			t.Fatal("browser replaced RPC")
		}
		return client
	}
	cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
	draft := wenBondClaimDraftV2{Version: 2, WalletID: "miner", WalletPublicKey: record.PublicKey, Pins: p, Policy: policy, MaxFee: 10000, RetainedLamports: 1000}
	raw, _ := json.Marshal(draft)
	draftHash := wenHashV1(raw)
	if _, e = service.installWENBondClaimDraftV2(context.Background(), cfg, "miner", draft, draftHash, true, factory); e != nil {
		t.Fatal(e)
	}
	body, _ := json.Marshal(wenBondClaimReviewRequestV2{RequestID: a.RequestID, DraftSHA256: draftHash})
	wire, e := service.bondClaimApplicationWithFactoryV2(context.Background(), request{Op: "v2.wenBondClaim.review.prepare", WalletID: "miner", Request: body}, cfg, factory)
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
	for scope, n := range wenBondClaimReservationScopesV2(a) {
		if e = store.configureWENBudgetV1(scope, n); e != nil {
			t.Fatal(e)
		}
	}
	if e = service.installWENBondClaimAdmissionV2(context.Background(), cfg, "miner", a.RequestID, digest, true, factory); e != nil {
		t.Fatal(e)
	}
	return service, client, review, draftHash
}
