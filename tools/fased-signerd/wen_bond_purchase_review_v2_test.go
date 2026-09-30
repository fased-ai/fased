package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"strconv"
	"testing"
	"time"
)

func bondPurchaseReviewFixtureV2(t *testing.T, owners ...solana.PublicKey) (*signerStoreV2, wenBondPurchaseReviewArtifactV2, signerPolicyV2) {
	t.Helper()
	f, p, policy, l := bondPurchaseReadFixtureV2(t, owners...)
	prepared, e := prepareWENBondPurchaseCostsV2(context.Background(), f, p, policy, l, nil)
	if e != nil {
		t.Fatal(e)
	}
	store, keys := openTestSignerV2(t)
	record, old := createTestSignerWalletV2(t, store, keys, "miner", p.Bond.Sale.String(), 10000, 20000)
	store.now = time.Now
	record.PublicKey = p.Bond.Owner.String()
	if e = store.db.Update(func(tx *bolt.Tx) error {
		raw, e := json.Marshal(record)
		if e != nil {
			return e
		}
		return tx.Bucket(bucketSignerWalletsV2).Put([]byte("miner"), raw)
	}); e != nil {
		t.Fatal(e)
	}
	a, e := newWENBondPurchaseReviewV2("review-request-001", "miner", old.Hash, prepared)
	if e != nil {
		t.Fatal(e)
	}
	native, cash := strconv.FormatUint(a.nativeDebit(), 10), strconv.FormatUint(a.cashAmount(), 10)
	updated, e := store.putPolicy(signerPolicyV2{WalletID: "miner", Role: old.Role, Operations: []string{wenBondPurchaseOperationV2}, Programs: a.requiredPrograms(), Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{p.Bond.Sale.String()}, MaxPerTx: native, MaxDaily: native}, {Asset: a.cashAsset(), Destinations: []string{p.Bond.Sale.String()}, MaxPerTx: cash, MaxDaily: cash}}}, old.Version)
	if e != nil {
		t.Fatal(e)
	}
	a.PolicyHash = updated.Hash
	return store, a, updated
}
func TestWENBondPurchaseV2StoredReviewReservationAndApproval(t *testing.T) {
	store, a, policy := bondPurchaseReviewFixtureV2(t)
	review, e := store.storeWENBondPurchaseReviewV2(a)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = reviewBindingFromStoredReviewV2(review, policy); e != nil {
		t.Fatal(e)
	}
	if _, e = store.storeWENBondPurchaseReviewV2(a); e == nil {
		t.Fatal("review overwritten")
	}
	// Exported lookup admission survives durable JSON; no empty private-key fields.
	var round wenBondPurchaseReviewArtifactV2
	if e = json.Unmarshal(review.SemanticIntent, &round); e != nil {
		t.Fatal(e)
	}
	if round.Policy.LookupPins[0].Key != a.Policy.LookupPins[0].Key || round.Policy.LookupPins[0].Digest != a.Policy.LookupPins[0].Digest {
		t.Fatal("lookup admission lost")
	}
	for _, change := range []func(*signerReviewV2){func(r *signerReviewV2) { r.Amount = "0" }, func(r *signerReviewV2) { r.StateSlot++ }, func(r *signerReviewV2) { r.TransactionDigest = "wrong" }, func(r *signerReviewV2) { r.MessageBase64 = "caller message" }} {
		r := review
		change(&r)
		if _, e = reviewBindingFromStoredReviewV2(r, policy); e == nil {
			t.Fatal("changed review accepted")
		}
	}
	for scope, n := range wenBondPurchaseReservationScopesV2(a) {
		if scope == wenBondPurchaseCashScopeV2(a) {
			continue
		}
		if e = store.configureWENBudgetV1(scope, n); e != nil {
			t.Fatal(e)
		}
	}
	if _, _, e = store.reserveWENBondPurchaseReviewV2(a); e == nil {
		t.Fatal("missing cash ceiling admitted")
	}
	if e = store.db.View(func(tx *bolt.Tx) error {
		for _, asset := range []string{"solana:native", a.cashAsset()} {
			if tx.Bucket(bucketSignerUsageV2).Get(dailyUsageKeyV2(a.WalletID, asset, currentDayBucket(store.now()))) != nil {
				t.Fatal("partial policy usage committed")
			}
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	if e = store.configureWENBudgetV1(wenBondPurchaseCashScopeV2(a), a.cashAmount()); e != nil {
		t.Fatal(e)
	}
	digest, existing, e := store.reserveWENBondPurchaseReviewV2(a)
	if e != nil || existing {
		t.Fatal(e)
	}
	if _, existing, e = store.reserveWENBondPurchaseReviewV2(a); e != nil || !existing {
		t.Fatal("reservation not idempotent", e)
	}
	other := a
	other.RequestID = "review-request-002"
	if _, e = store.storeWENBondPurchaseReviewV2(other); e != nil {
		t.Fatal(e)
	}
	if _, _, e = store.reserveWENBondPurchaseReviewV2(other); e == nil {
		t.Fatal("same packet reserved twice")
	}
	buy := wenMarketReviewArtifactV1{WalletID: a.WalletID, Pins: wenMarketBuyPinsV1{Profile: a.Pins.Bond.Profile}, Policy: wenMarketReadPolicyV1{Successor: a.Policy.Deployment}}
	if wenMarketCashScopeV1(buy) != wenBondPurchaseCashScopeV2(a) {
		t.Fatal("Buy and Bonds cash scopes diverged")
	}
	service, e := newSignerWebAuthnServiceV2(store, testWebAuthnRPID, testWebAuthnOrigin)
	if e != nil {
		t.Fatal(e)
	}
	auth := newTestWebAuthnAuthenticatorV2(t)
	fixture := &testSignerWebAuthnFixtureV2{store: store, service: service, walletID: a.WalletID}
	fixture.enroll(t, auth)
	finish, e := fixture.finishReview(t, fixture.beginReview(t), auth, 2)
	if e != nil {
		t.Fatal(e)
	}
	if finish.Binding.ArtifactDigest != review.ArtifactDigest || finish.Binding.TransactionDigest != review.TransactionDigest {
		t.Fatal("approval changed packet")
	}
	proof := &signerWebAuthnProofReferenceV2{ProofID: finish.Authorization.Proof.ProofID}
	if e = service.authorizeWENBondPurchaseV2(a.WalletID, a.RequestID, digest, proof); e != nil {
		t.Fatal(e)
	}
	if e = service.authorizeWENBondPurchaseV2(a.WalletID, a.RequestID, digest, proof); e != nil {
		t.Fatal("same proof not idempotent", e)
	}
	if e = service.authorizeWENBondPurchaseV2(a.WalletID, other.RequestID, digest, proof); e == nil {
		t.Fatal("approval replayed on another request")
	}
	if e = store.db.View(func(tx *bolt.Tx) error {
		var saved wenBondPurchaseReservationV2
		if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("bond-purchase-request:"+a.RequestID)), &saved); e != nil {
			return e
		}
		if saved.Authorization == nil || saved.Authorization.ProofID != finish.Authorization.Proof.ProofID || saved.Version != 2 || saved.Artifact.Policy.LookupPins[0].Digest != a.Policy.LookupPins[0].Digest {
			t.Fatal("durable approval missing")
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
}

func TestWENBondPurchaseV2DurableSubmissionFence(t *testing.T) {
	seed := make([]byte, 32)
	seed[0] = 42
	key := ed25519.NewKeyFromSeed(seed)
	owner := solana.PublicKeyFromBytes(key.Public().(ed25519.PublicKey))
	defer zeroBytes(key)
	store, a, _ := bondPurchaseReviewFixtureV2(t, owner)
	review, e := store.storeWENBondPurchaseReviewV2(a)
	if e != nil {
		t.Fatal(e)
	}
	for scope, n := range wenBondPurchaseReservationScopesV2(a) {
		if e = store.configureWENBudgetV1(scope, n); e != nil {
			t.Fatal(e)
		}
	}
	digest, _, e := store.reserveWENBondPurchaseReviewV2(a)
	if e != nil {
		t.Fatal(e)
	}
	service, e := newSignerWebAuthnServiceV2(store, testWebAuthnRPID, testWebAuthnOrigin)
	if e != nil {
		t.Fatal(e)
	}
	auth := newTestWebAuthnAuthenticatorV2(t)
	fixture := &testSignerWebAuthnFixtureV2{store: store, service: service, walletID: a.WalletID}
	fixture.enroll(t, auth)
	finish, e := fixture.finishReview(t, fixture.beginReview(t), auth, 2)
	if e != nil {
		t.Fatal(e)
	}
	if finish.Binding.TransactionDigest != review.TransactionDigest {
		t.Fatal("wrong approval")
	}
	if e = service.authorizeWENBondPurchaseV2(a.WalletID, a.RequestID, digest, &finish.Authorization.Proof); e != nil {
		t.Fatal(e)
	}
	f, p, policy, l := bondPurchaseReadFixtureV2(t, owner)
	prepared, e := prepareWENBondPurchaseCostsV2(context.Background(), f, p, policy, l, nil)
	if e != nil {
		t.Fatal(e)
	}
	if e = store.beginWENBondPurchaseSigningV2(a.WalletID, a.RequestID, digest, prepared); e != nil {
		t.Fatal(e)
	}
	if e = store.beginWENBondPurchaseSigningV2(a.WalletID, a.RequestID, digest, prepared); e == nil {
		t.Fatal("signing fence entered twice")
	}
	var sig solana.Signature
	copy(sig[:], ed25519.Sign(key, prepared.message))
	if e = store.recordWENBondPurchaseSignatureV2(a.WalletID, a.RequestID, digest, prepared, sig.String()); e != nil {
		t.Fatal(e)
	}
	wire, e := store.commitWENBondPurchaseSubmissionV2(a.WalletID, a.RequestID, digest, prepared)
	if e != nil {
		t.Fatal(e)
	}
	if len(wire) != 65+len(prepared.message) || wire[0] != 1 {
		t.Fatal("wrong signed packet")
	}
	if _, e = store.commitWENBondPurchaseSubmissionV2(a.WalletID, a.RequestID, digest, prepared); e == nil {
		t.Fatal("wire released twice")
	}
	result := bondPurchaseReceiptV2(t, a, wire, false)
	reservation := wenBondPurchaseReservationV2{Version: 2, Artifact: a, Digest: digest, State: "submission-uncertain", Signature: sig.String()}
	if _, cash, gross, _, e := wenBondPurchaseOutcomeV2(reservation, result); e != nil || cash != a.cashAmount() || gross == 0 {
		t.Fatal("outcome rejected", e)
	}
	failedResult := bondPurchaseReceiptV2(t, a, wire, true)
	if debit, cash, gross, _, e := wenBondPurchaseOutcomeV2(reservation, failedResult); e != nil || debit != a.Binding.Fee || cash != 0 || gross != 0 {
		t.Fatal("failed atomic purchase effects", e)
	}
	for _, mode := range []string{"fee", "cash", "loaded", "btc", "owner", "stale"} {
		bad := bondPurchaseReceiptV2(t, a, wire, false)
		switch mode {
		case "fee":
			bad.Meta.Fee++
		case "cash":
			bad.Meta.PostTokenBalances[0].UiTokenAmount.Amount = "0"
		case "loaded":
			bad.Meta.LoadedAddresses.Writable = nil
			bad.Meta.LoadedAddresses.ReadOnly = nil
		case "btc":
			for i := range bad.Meta.PostTokenBalances {
				if bad.Meta.PostTokenBalances[i].UiTokenAmount.Decimals == 8 {
					bad.Meta.PostTokenBalances[i].UiTokenAmount.Amount = "1000000000"
				}
			}
		case "owner":
			bad.Meta.PostBalances[0]++
		case "stale":
			bad.Slot = 0
		}
		if _, _, _, _, e := wenBondPurchaseOutcomeV2(reservation, bad); e == nil {
			t.Fatal("bad finalized outcome accepted", mode)
		}
	}
	recovery := &bondRecoveryFakeV2{wenBondPurchaseRPCFakeV2: f, signature: sig}
	if state, e := store.recoverWENBondPurchaseV2(context.Background(), recovery, a.RequestID, digest); e != nil || state != "submission-uncertain" {
		t.Fatal("missing outcome released hold", e)
	}
	path := store.db.Path()
	if e = store.Close(); e != nil {
		t.Fatal(e)
	}
	reopened, e := openSignerStoreV2(path)
	if e != nil {
		t.Fatal(e)
	}
	defer reopened.Close()
	if _, e = reopened.commitWENBondPurchaseSubmissionV2(a.WalletID, a.RequestID, digest, prepared); e == nil {
		t.Fatal("restart released wire again")
	}
	if e = reopened.db.View(func(tx *bolt.Tx) error {
		var r wenBondPurchaseReservationV2
		if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("bond-purchase-request:"+a.RequestID)), &r); e != nil {
			return e
		}
		if r.State != "submission-uncertain" || r.Signature != sig.String() || r.Authorization == nil {
			t.Fatal("uncertainty lost after restart")
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	recovery.result = result
	recovery.pageSlot = result.Slot
	if _, e = reopened.recoverWENBondPurchaseV2(context.Background(), recovery, a.RequestID, digest); e == nil {
		t.Fatal("missing accepted rights settled")
	}
	_, _, accepted, _, _ := bondClaimFixtureV2(t, a.Pins.Bond)
	recovery.records[accepted.Key] = &rpc.Account{Owner: accepted.Owner, Data: rpc.DataBytesOrJSONFromBytes(accepted.Data)}
	for i := 0; i < 2; i++ {
		if state, e := reopened.recoverWENBondPurchaseV2(context.Background(), recovery, a.RequestID, digest); e != nil || state != "finalized-success" {
			t.Fatal("restart recovery", state, e)
		}
	}
	if e := reopened.db.View(func(tx *bolt.Tx) error {
		var r wenBondPurchaseReservationV2
		if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("bond-purchase-request:"+a.RequestID)), &r); e != nil {
			return e
		}
		if r.RetainedRecovery != a.Limits.RecoveryBudget || r.OutcomeCash != a.cashAmount() {
			t.Fatal("funding reconciliation lost")
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}

	_, keys := openTestSignerV2(t)
	recoveryAuth, e := newSignerWebAuthnServiceV2(reopened, testWebAuthnRPID, testWebAuthnOrigin)
	if e != nil {
		t.Fatal(e)
	}
	runtime := &signerServiceV2{store: reopened, keys: keys}
	if got, state, e := runtime.executeWENBondPurchaseV2(context.Background(), recovery, recoveryAuth, a.WalletID, a.RequestID, nil); e != nil || got != digest || state != "finalized-success" {
		t.Fatal("execution did not recover without approval/send", state, e)
	}

}
