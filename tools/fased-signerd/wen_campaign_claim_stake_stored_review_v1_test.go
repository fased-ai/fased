package main

import (
	"testing"
	"time"
)

func checkDirectStakeStoredReview(t *testing.T, a wenCampaignClaimStakeReviewV1) {
	store, keys := openTestSignerV2(t)
	store.now = time.Now
	_, old := createTestSignerWalletV2(t, store, keys, "miner", a.Claim.Economy.String(), 10000, 20000)
	policy, e := store.putPolicy(signerPolicyV2{WalletID: "miner", Role: old.Role, Operations: []string{wenCampaignClaimStakeOperationV1}, Programs: []string{a.Claim.Program.String()}, Assets: []signerPolicyAssetV2{{Asset: "solana:native", Destinations: []string{a.Claim.Economy.String()}, MaxPerTx: "10000", MaxDaily: "20000"}}}, old.Version)
	if e != nil {
		t.Fatal(e)
	}
	a.PolicyHash = policy.Hash
	review, e := store.storeWENCampaignClaimStakeReviewV1(a)
	if e != nil {
		t.Fatal("store direct review", e)
	}
	binding, e := reviewBindingFromStoredReviewV2(review, policy)
	if e != nil || binding.TransactionDigest != review.TransactionDigest || binding.Amount != review.Amount {
		t.Fatal("WebAuthn binding", e)
	}
	if _, e = store.storeWENCampaignClaimStakeReviewV1(a); e == nil {
		t.Fatal("duplicate overwrote review")
	}
	for name, change := range map[string]func(*signerReviewV2){
		"amount":      func(r *signerReviewV2) { r.Amount = "0" },
		"transaction": func(r *signerReviewV2) { r.TransactionDigest = "wrong" },
		"state":       func(r *signerReviewV2) { r.StateDigest = "wrong" },
		"identity":    func(r *signerReviewV2) { r.WalletPublicKey = a.Claim.Program.String() },
		"operation":   func(r *signerReviewV2) { r.PolicyOperation = "wen.campaign.claim.v1" },
		"semantic":    func(r *signerReviewV2) { r.SemanticIntent = []byte("{}") },
	} {
		t.Run("stored-"+name, func(t *testing.T) {
			bad := review
			change(&bad)
			if _, e = reviewBindingFromStoredReviewV2(bad, policy); e == nil {
				t.Fatal("altered review accepted")
			}
		})
	}
	for _, change := range []func(*signerPolicyV2){func(p *signerPolicyV2) { p.Operations = nil }, func(p *signerPolicyV2) { p.Programs = nil }, func(p *signerPolicyV2) { p.Hash = "wrong" }} {
		bad := policy
		change(&bad)
		if _, e = reviewBindingFromStoredReviewV2(review, bad); e == nil {
			t.Fatal("changed policy accepted")
		}
	}
	checkDirectStakeReservation(t, store, a)
}
