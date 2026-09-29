package main

import (
	"context"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"strconv"
	"testing"
	"time"
)

// Test-only protected profile with actual signer keys, draft/admission installation
// and typed application preparation. Only the Solana RPC is a local fixture.
func marketBrowserSignerFixtureV1(t *testing.T, host, origin string) (*signerServiceV2, *marketExecutionFakeV1, signerReviewV2, string) {
	f, p, policy, l := marketReadFixtureV1(t)
	store, keys := openTestSignerV2(t)
	record, old := createTestSignerWalletV2(t, store, keys, "miner", p.Pool.String(), 10000, 20000)
	store.now = time.Now
	p.Owner = solana.MustPublicKeyFromBase58(record.PublicKey)
	for _, i := range []int{7, 8} {
		data := append([]byte(nil), f.page.Value[i].Data.GetBinary()...)
		copy(data[32:64], p.Owner[:])
		f.page.Value[i].Data = rpc.DataBytesOrJSONFromBytes(data)
	}
	prepare := &wenMarketPrepareFakeV1{wenMarketReadFakeV1: f, owner: p.Owner, mode: "execution balance"}
	prepared, e := prepareWENMarketBuyV1(context.Background(), prepare, p, policy, l, 6000, 114762240, nil)
	if e != nil {
		t.Fatal(e)
	}
	a, e := newWENMarketReviewV1("review-request-001", "miner", old.Hash, prepared)
	if e != nil {
		t.Fatal(e)
	}
	cash := strconv.FormatUint(a.Binding.Snapshot.Quote.InputCash, 10)
	_, e = store.putPolicy(signerPolicyV2{WalletID: "miner", Role: old.Role, Operations: []string{wenMarketOperationV1}, Programs: a.requiredPrograms(), Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{p.Pool.String()}, MaxPerTx: "6000", MaxDaily: "6000"}, {Asset: a.cashAsset(), Destinations: []string{p.Pool.String()}, MaxPerTx: cash, MaxDaily: cash}}}, old.Version)
	if e != nil {
		t.Fatal(e)
	}
	keys.genesisHash = func(string) (string, error) { return policy.Successor.Genesis, nil }
	endpoint := "https://market-browser-fixture.invalid"
	if _, e = keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
		t.Fatal(e)
	}
	auth, e := newSignerWebAuthnServiceV2(store, host, origin)
	if e != nil {
		t.Fatal(e)
	}
	service := &signerServiceV2{store: store, keys: keys, webauthn: auth}
	client := &marketExecutionFakeV1{wenMarketPrepareFakeV1: prepare, store: store, outcome: "ok"}
	factory := func(url string) wenMarketExecutionRPCV1 {
		if url != endpoint {
			t.Fatal("browser replaced RPC")
		}
		return client
	}
	cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
	draft := wenMarketDraftV1{Version: 1, WalletID: "miner", WalletPublicKey: record.PublicKey, Pins: p, Policy: policy, Limits: l, MaxFee: 6000, RetainedLamports: 114762240}
	raw, _ := json.Marshal(draft)
	draftHash := wenHashV1(raw)
	if _, e = service.installWENMarketDraftV1(context.Background(), cfg, "miner", draft, draftHash, true, factory); e != nil {
		t.Fatal(e)
	}
	body, _ := json.Marshal(wenMarketReviewRequestV1{RequestID: a.RequestID, DraftSHA256: draftHash})
	wire, e := service.marketApplicationWithFactoryV1(context.Background(), request{Op: "v2.wenMarket.review.prepare", WalletID: "miner", Request: body}, cfg, factory)
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
	for scope, n := range wenMarketReservationScopesV1(a) {
		if e = store.configureWENBudgetV1(scope, n); e != nil {
			t.Fatal(e)
		}
	}
	if e = service.installWENMarketAdmissionV1(context.Background(), cfg, "miner", a.RequestID, digest, true, factory); e != nil {
		t.Fatal(e)
	}
	return service, client, review, draftHash
}
