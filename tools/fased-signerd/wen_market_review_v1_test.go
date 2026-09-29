package main

import (
	"context"
	"encoding/json"
	bolt "go.etcd.io/bbolt"
	"strconv"
	"testing"
	"time"
)

func marketReviewFixtureV1(t *testing.T) (*signerStoreV2, wenMarketReviewArtifactV1, signerPolicyV2) {
	t.Helper()
	f, p, policy, l := marketReadFixtureV1(t)
	prepared, e := prepareWENMarketBuyV1(context.Background(), &wenMarketPrepareFakeV1{wenMarketReadFakeV1: f, owner: p.Owner}, p, policy, l, 5000, 114762240, nil)
	if e != nil {
		t.Fatal(e)
	}
	store, keys := openTestSignerV2(t)
	record, old := createTestSignerWalletV2(t, store, keys, "miner", p.Pool.String(), 10000, 20000)
	store.now = time.Now
	// This fixture never signs: register the authenticated reader's test owner.
	record.PublicKey = p.Owner.String()
	if e = store.db.Update(func(tx *bolt.Tx) error {
		raw, e := json.Marshal(record)
		if e != nil {
			return e
		}
		return tx.Bucket(bucketSignerWalletsV2).Put([]byte("miner"), raw)
	}); e != nil {
		t.Fatal(e)
	}
	a, e := newWENMarketReviewV1("review-request-001", "miner", old.Hash, prepared)
	if e != nil {
		t.Fatal(e)
	}
	cash := strconv.FormatUint(a.Binding.Snapshot.Quote.InputCash, 10)
	updated, e := store.putPolicy(signerPolicyV2{WalletID: "miner", Role: old.Role, Operations: []string{wenMarketOperationV1}, Programs: a.requiredPrograms(), Assets: []signerPolicyAssetV2{
		{Asset: "solana:native", Destinations: []string{p.Pool.String()}, MaxPerTx: "5000", MaxDaily: "5000"},
		{Asset: a.cashAsset(), Destinations: []string{p.Pool.String()}, MaxPerTx: cash, MaxDaily: cash},
	}}, old.Version)
	if e != nil {
		t.Fatal(e)
	}
	a.PolicyHash = updated.Hash
	return store, a, updated
}

func TestWENMarketStoredReviewAndReservation(t *testing.T) {
	store, a, policy := marketReviewFixtureV1(t)
	review, e := store.storeWENMarketReviewV1(a)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = store.storeWENMarketReviewV1(a); e == nil {
		t.Fatal("review overwritten")
	}
	if _, e = reviewBindingFromStoredReviewV2(review, policy); e != nil {
		t.Fatal(e)
	}
	for _, change := range []func(*signerReviewV2){
		func(r *signerReviewV2) { r.Amount = "0" }, func(r *signerReviewV2) { r.StateSlot++ }, func(r *signerReviewV2) { r.TransactionDigest = "wrong" }, func(r *signerReviewV2) { r.PolicyHash = "wrong" }, func(r *signerReviewV2) { r.MessageBase64 = "caller transaction" },
	} {
		r := review
		change(&r)
		if _, e = reviewBindingFromStoredReviewV2(r, policy); e == nil {
			t.Fatal("changed stored authority accepted")
		}
	}
	for _, change := range []func(*wenMarketReviewArtifactV1){
		func(a *wenMarketReviewArtifactV1) { a.Binding.MaxFee++ }, func(a *wenMarketReviewArtifactV1) { a.Binding.RetainedLamports++ }, func(a *wenMarketReviewArtifactV1) { a.Binding.Snapshot.StateSHA256 = wenHashV1([]byte("changed")) }, func(a *wenMarketReviewArtifactV1) { a.Limits.MaxCash++ }, func(a *wenMarketReviewArtifactV1) { a.Policy.Successor.DeploymentSlot++ }, func(a *wenMarketReviewArtifactV1) {
			a.Binding.Message = append([]byte(nil), a.Binding.Message...)
			a.Binding.Message[5] ^= 1
		},
	} {
		changed := a
		change(&changed)
		if _, _, e = store.reserveWENMarketReviewV1(changed); e == nil {
			t.Fatal("replacement review reserved")
		}
	}
	native := wenMiningNativeScopeV1(a.WalletID, a.Policy.Successor.Genesis)
	for scope, n := range map[string]uint64{native: a.Binding.MaxFee, wenMarketLaunchScopeV1(a): a.Binding.MaxFee} {
		if e = store.configureWENBudgetV1(scope, n); e != nil {
			t.Fatal(e)
		}
	}
	// Missing cash funding must roll back native reservations and both usage rows.
	if _, _, e = store.reserveWENMarketReviewV1(a); e == nil {
		t.Fatal("missing cash ceiling accepted")
	}
	if e = store.db.View(func(tx *bolt.Tx) error {
		for _, asset := range []string{"solana:native", a.cashAsset()} {
			if tx.Bucket(bucketSignerUsageV2).Get(dailyUsageKeyV2(a.WalletID, asset, currentDayBucket(store.now()))) != nil {
				t.Fatal("partial usage committed")
			}
		}
		var balance wenBudgetBalanceV1
		if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+native)), &balance); e != nil {
			return e
		}
		if balance.Reserved != 0 {
			t.Fatal("partial native reservation committed")
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	if e = store.configureWENBudgetV1(wenMarketCashScopeV1(a), a.Binding.Snapshot.Quote.InputCash); e != nil {
		t.Fatal(e)
	}
	digest, exists, e := store.reserveWENMarketReviewV1(a)
	if e != nil || exists || digest == "" {
		t.Fatal("reserve", e)
	}
	if _, exists, e = store.reserveWENMarketReviewV1(a); e != nil || !exists {
		t.Fatal("idempotent reserve", e)
	}
	another := a
	another.RequestID = "review-request-002"
	if _, e = store.storeWENMarketReviewV1(another); e != nil {
		t.Fatal(e)
	}
	if _, _, e = store.reserveWENMarketReviewV1(another); e == nil {
		t.Fatal("message reserved twice")
	}
	// A distinct message still competes for the same cash/native daily budgets.
	another.RequestID = "review-request-003"
	another.Binding.Blockhash[0]++
	another.Binding.Message, e = compileWENMarketBuyV1(another.Pins, another.Binding.Snapshot.Quote, another.Limits, another.Binding.Blockhash, another.Binding.CurrentHeight, another.Binding.LastValidHeight, nil)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = store.storeWENMarketReviewV1(another); e != nil {
		t.Fatal(e)
	}
	if _, _, e = store.reserveWENMarketReviewV1(another); e == nil {
		t.Fatal("shared usage overspent")
	}
}

func TestWENMarketOwnerApprovalPersistsAndCannotReplay(t *testing.T) {
	store, a, _ := marketReviewFixtureV1(t)
	review, e := store.storeWENMarketReviewV1(a)
	if e != nil {
		t.Fatal(e)
	}
	for scope, n := range map[string]uint64{wenMiningNativeScopeV1(a.WalletID, a.Policy.Successor.Genesis): a.Binding.MaxFee, wenMarketLaunchScopeV1(a): a.Binding.MaxFee, wenMarketCashScopeV1(a): a.Binding.Snapshot.Quote.InputCash} {
		if e = store.configureWENBudgetV1(scope, n); e != nil {
			t.Fatal(e)
		}
	}
	digest, _, e := store.reserveWENMarketReviewV1(a)
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
	if finish.Binding.ArtifactDigest != review.ArtifactDigest || finish.Binding.TransactionDigest != review.TransactionDigest || finish.Binding.Amount != review.Amount {
		t.Fatal("approval not bound")
	}
	if e = service.authorizeWENMarketV1(a.WalletID, a.RequestID, "wrong", &finish.Authorization.Proof); e == nil {
		t.Fatal("wrong reservation approved")
	}
	if e = service.authorizeWENCampaignV1(a.WalletID, a.RequestID, digest, &finish.Authorization.Proof); e == nil {
		t.Fatal("Buy approved as campaign")
	}
	if e = service.authorizeWENMarketV1(a.WalletID, a.RequestID, digest, &finish.Authorization.Proof); e != nil {
		t.Fatal(e)
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
	recovered, e := newSignerWebAuthnServiceV2(reopened, testWebAuthnRPID, testWebAuthnOrigin)
	if e != nil {
		t.Fatal(e)
	}
	if e = recovered.authorizeWENMarketV1(a.WalletID, a.RequestID, digest, &finish.Authorization.Proof); e != nil {
		t.Fatal("approval lost after restart", e)
	}
	if e = recovered.verifyAndConsumeReviewProofV2(finish.Binding, &finish.Authorization.Proof); e == nil {
		t.Fatal("consumed proof replayed")
	}
	if e = reopened.db.Update(func(tx *bolt.Tx) error {
		var saved wenMarketReservationV1
		bucket := tx.Bucket(wenBudgetBucketV1)
		key := []byte("market-request:" + a.RequestID)
		if e := json.Unmarshal(bucket.Get(key), &saved); e != nil {
			return e
		}
		saved.Artifact.Binding.MaxFee++
		raw, e := json.Marshal(saved)
		if e != nil {
			return e
		}
		return bucket.Put(key, raw)
	}); e != nil {
		t.Fatal(e)
	}
	if e = recovered.authorizeWENMarketV1(a.WalletID, a.RequestID, digest, &finish.Authorization.Proof); e == nil {
		t.Fatal("altered durable reservation approved")
	}
}
