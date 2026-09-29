package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	bolt "go.etcd.io/bbolt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Test-only setup crosses protected draft install, application preparation and
// control admission with generated keys. RPC/deployment remain local fixtures.
func directStakeSignerFixture(t *testing.T, host, origin string) (*signerServiceV2, *directStakeExecutionFake, signerReviewV2, string) {
	base, pins, v, q, w, key, minimum := directStakeRPCFixture(t, "ok")
	v.ExpiresSlot = "172"
	v.MaxFeeLamports = "5000"
	store, keys := openTestSignerV2(t)
	record, old := createTestSignerWalletV2(t, store, keys, "miner", q.Economy.String(), 10000, 20000)
	store.now = time.Now
	record.PublicKey = w.String()
	if e := keys.encryptRecord(&record, key); e != nil {
		t.Fatal(e)
	}
	if e := store.db.Update(func(tx *bolt.Tx) error {
		raw, e := json.Marshal(record)
		if e != nil {
			return e
		}
		return tx.Bucket(bucketSignerWalletsV2).Put([]byte("miner"), raw)
	}); e != nil {
		t.Fatal(e)
	}
	_, e := store.putPolicy(signerPolicyV2{WalletID: "miner", Role: old.Role, Operations: []string{wenCampaignClaimStakeOperationV1}, Programs: []string{q.Program.String()}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{q.Economy.String()}, MaxPerTx: "10000", MaxDaily: "20000"}}}, old.Version)
	if e != nil {
		t.Fatal(e)
	}
	auth, e := newSignerWebAuthnServiceV2(store, host, origin)
	if e != nil {
		t.Fatal(e)
	}
	service := &signerServiceV2{store: store, keys: keys, webauthn: auth}
	keys.genesisHash = func(string) (string, error) { return pins.Genesis, nil }
	endpoint := "https://direct-stake-fixture.invalid"
	if _, e = keys.PutNetworkV2("miner", signerNetworkPutRequestV2{ExpectedVersion: signerUint64PointerV2(0), PrimaryRPCURL: endpoint}); e != nil {
		t.Fatal(e)
	}
	f := &directStakeExecutionFake{directStakePrepareFake: &directStakePrepareFake{campaignPrepareFake: &campaignPrepareFake{campaignReadFake: &campaignReadFake{wenReadRPCFake: base}, next: 159}}, mode: "ok", available: true}
	factory := func(url string) wenCampaignExecutionRPCV1 {
		if url != endpoint {
			t.Fatal("wrong draft endpoint")
		}
		return f
	}
	cfg := signerConfig{stateDBPath: store.db.Path(), chains: []string{"solana"}}
	draft := wenCampaignDraftV1{Version: 1, WalletID: "miner", WalletPublicKey: w.String(), ClaimStake: &wenCampaignClaimStakeDraftV1{Pins: pins, Intent: v, Claim: q, MinimumNet: minimum, MaxTotal: 6000}}
	raw, _ := json.Marshal(draft)
	draftHash := wenHashV1(raw)
	if _, e = service.installWENCampaignDraftV1(context.Background(), cfg, "miner", draft, draftHash, false, factory); e == nil {
		t.Fatal("noncontrol draft accepted")
	}
	mixed := draft
	mixed.MaxFee = 5000
	if mixed.validate("miner") == nil {
		t.Fatal("mixed draft accepted")
	}
	if _, e = service.installWENCampaignDraftV1(context.Background(), cfg, "miner", draft, wenHashV1([]byte("wrong")), true, factory); e == nil {
		t.Fatal("wrong draft hash accepted")
	}
	if _, e = service.installWENCampaignDraftV1(context.Background(), cfg, "miner", draft, draftHash, true, factory); e != nil {
		t.Fatal("draft install", e)
	}
	body, _ := json.Marshal(wenCampaignReviewRequestV1{RequestID: "review-request-001", DraftSHA256: draftHash})
	wire, e := service.campaignApplicationWithFactoryV1(context.Background(), request{Op: "v2.wenCampaign.review.prepare", WalletID: "miner", Request: body}, cfg, factory)
	if e != nil {
		t.Fatal("configured preparation", e)
	}
	var envelope struct {
		Result signerReviewV2 `json:"result"`
	}
	if e = json.Unmarshal(wire, &envelope); e != nil {
		t.Fatal(e)
	}
	review := envelope.Result
	var a wenCampaignClaimStakeReviewV1
	if e = json.Unmarshal(review.SemanticIntent, &a); e != nil {
		t.Fatal(e)
	}
	digest, e := a.digest()
	if e != nil {
		t.Fatal(e)
	}
	if review.ArtifactDigest != "sha256:"+digest || review.ArtifactKind != wenCampaignClaimStakeArtifactKindV1 {
		t.Fatal("wrong prepared direct artifact")
	}
	for _, scope := range []string{wenMiningNativeScopeV1(a.WalletID, a.Pins.Genesis), wenCampaignClaimStakeLaunchScopeV1(a)} {
		if e = store.configureWENBudgetV1(scope, a.MaximumDebit); e != nil {
			t.Fatal(e)
		}
	}
	if e = service.installWENCampaignAdmissionV1(context.Background(), cfg, "miner", a.RequestID, digest, false, factory); e == nil {
		t.Fatal("noncontrol admission accepted")
	}
	if e = service.installWENCampaignAdmissionV1(context.Background(), cfg, "miner", a.RequestID, digest, true, factory); e != nil {
		t.Fatal("direct admission", e)
	}
	f.artifact = a
	f.result, _, _ = directStakeOutcomeFixture(t, a, key, false)
	f.after = directStakePostAccounts(t, base, a)
	return service, f, review, draftHash
}

func TestWENCampaignClaimStakeConfiguredJourneyV1(t *testing.T) {
	service, f, review, _ := directStakeSignerFixture(t, testWebAuthnRPID, testWebAuthnOrigin)
	fixture := &testSignerWebAuthnFixtureV2{store: service.store, service: service.webauthn, walletID: "miner"}
	auth := newTestWebAuthnAuthenticatorV2(t)
	fixture.enroll(t, auth)
	begin, e := service.webauthn.beginReviewAuthorization("miner", signerReviewAuthorizationBeginRequestV2{RequestID: review.RequestID})
	if e != nil {
		t.Fatal(e)
	}
	finish, e := fixture.finishReview(t, begin, auth, 2)
	if e != nil {
		t.Fatal(e)
	}
	cfg := signerConfig{stateDBPath: service.store.db.Path(), chains: []string{"solana"}}
	f.available = false
	f.mode = "timeout"
	for _, action := range []string{"execute", "recover"} {
		body := wenMiningClaimJourneyRequestV1{Action: action, RequestID: review.RequestID}
		want := "finalized-success"
		if action == "execute" {
			body.Proof = &finish.Authorization.Proof
			want = "submission-uncertain"
		} else {
			f.available = true
			f.mode = "ok"
			service.store.now = func() time.Time { return time.Now().Add(24 * time.Hour) }
		}
		raw, _ := json.Marshal(body)
		wire, e := service.campaignApplicationWithFactoryV1(context.Background(), request{Op: "v2.wenCampaign.journey", WalletID: "miner", Request: raw}, cfg, func(string) wenCampaignExecutionRPCV1 { return f })
		if e != nil {
			t.Fatal(e)
		}
		var out struct {
			Result wenMiningClaimJourneyResultV1 `json:"result"`
		}
		if e = json.Unmarshal(wire, &out); e != nil || out.Result.Outcome != want || f.sends != 1 {
			t.Fatal("configured journey", string(wire), e, f.sends)
		}
	}
}

// Explicit export contains generated public fixture identities only, never keys.
func TestWENCampaignClaimStakeClientFixture(t *testing.T) {
	dir := os.Getenv("WEN_DIRECT_CLIENT_FIXTURE_DIR")
	if dir == "" {
		t.Skip("explicit client fixture export only")
	}
	_, _, review, draftHash := directStakeSignerFixture(t, testWebAuthnRPID, testWebAuthnOrigin)
	raw, e := json.MarshalIndent(review, "", "  ")
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(dir, "claim-stake-review-fixture.json"), raw, 0600); e != nil {
		t.Fatal(e)
	}
	hashes := map[string]string{}
	for _, name := range []string{"wen_campaign_claim_stake_review_v1.go", "wen_campaign_claim_stake_stored_review_v1.go", "wen_campaign_claim_stake_rpc_v1_test.go", "wen_campaign_claim_stake_browser_test.go"} {
		b, e := os.ReadFile(name)
		if e != nil {
			t.Fatal(e)
		}
		h := sha256.Sum256(b)
		hashes[name] = hex.EncodeToString(h[:])
	}
	identity, _ := json.MarshalIndent(map[string]any{"evidenceClass": "generated-local-fixture", "draftSha256": draftHash, "artifactDigest": review.ArtifactDigest, "sources": hashes}, "", "  ")
	if e = os.WriteFile(filepath.Join(dir, "claim-stake-review-fixture-identity.json"), identity, 0600); e != nil {
		t.Fatal(e)
	}
}
