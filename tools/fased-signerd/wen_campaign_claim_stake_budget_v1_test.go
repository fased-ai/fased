package main

import (
	"encoding/json"
	bolt "go.etcd.io/bbolt"
	"strconv"
	"testing"
)

func checkDirectStakeReservation(t *testing.T, s *signerStoreV2, a wenCampaignClaimStakeReviewV1) {
	scope := wenMiningNativeScopeV1(a.WalletID, a.Pins.Genesis)
	if e := s.configureWENBudgetV1(scope, a.MaximumDebit); e != nil {
		t.Fatal(e)
	}
	if _, _, e := s.reserveWENCampaignClaimStakeReviewV1(a); e == nil {
		t.Fatal("unmatched stored wallet accepted")
	}
	// This fixture exercises authorization without using a wallet signing key.
	if e := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketSignerWalletsV2)
		var w signerWalletRecordV2
		if e := json.Unmarshal(b.Get([]byte(a.WalletID)), &w); e != nil {
			return e
		}
		w.PublicKey = a.WalletPublicKey
		raw, e := json.Marshal(w)
		if e != nil {
			return e
		}
		return b.Put([]byte(a.WalletID), raw)
	}); e != nil {
		t.Fatal(e)
	}
	if _, _, e := s.reserveWENCampaignClaimStakeReviewV1(a); e == nil {
		t.Fatal("missing launch budget accepted")
	}
	if e := s.configureWENBudgetV1(wenCampaignClaimStakeLaunchScopeV1(a), a.MaximumDebit); e != nil {
		t.Fatal(e)
	}
	digest, exists, e := s.reserveWENCampaignClaimStakeReviewV1(a)
	if e != nil || exists {
		t.Fatal("reserve", e)
	}
	if _, exists, e = s.reserveWENCampaignClaimStakeReviewV1(a); e != nil || !exists {
		t.Fatal("idempotent reservation", e)
	}
	second := a
	second.RequestID = "another-direct-request"
	if _, e = s.storeWENCampaignClaimStakeReviewV1(second); e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.reserveWENCampaignClaimStakeReviewV1(second); e == nil {
		t.Fatal("duplicate message reservation")
	}
	if e = s.db.View(func(tx *bolt.Tx) error {
		var b wenBudgetBalanceV1
		if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("limit:"+scope)), &b); e != nil {
			return e
		}
		if b.Reserved != a.MaximumDebit {
			t.Fatal("reservation leak")
		}
		used := string(tx.Bucket(bucketSignerUsageV2).Get(dailyUsageKeyV2(a.WalletID, "solana:native", currentDayBucket(s.now()))))
		if used != strconv.FormatUint(a.MaximumDebit, 10) {
			t.Fatal("usage leak", used)
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	service, e := newSignerWebAuthnServiceV2(s, testWebAuthnRPID, testWebAuthnOrigin)
	if e != nil {
		t.Fatal(e)
	}
	auth := newTestWebAuthnAuthenticatorV2(t)
	fixture := &testSignerWebAuthnFixtureV2{store: s, service: service, walletID: a.WalletID}
	fixture.enroll(t, auth)
	begin, e := service.beginReviewAuthorization(a.WalletID, signerReviewAuthorizationBeginRequestV2{RequestID: a.RequestID})
	if e != nil {
		t.Fatal(e)
	}
	finish, e := fixture.finishReview(t, begin, auth, 2)
	if e != nil {
		t.Fatal(e)
	}
	if e = service.authorizeWENCampaignClaimStakeV1(a.WalletID, a.RequestID, "wrong", &finish.Authorization.Proof); e == nil {
		t.Fatal("wrong digest consumed approval")
	}
	for i := 0; i < 2; i++ {
		if e = service.authorizeWENCampaignClaimStakeV1(a.WalletID, a.RequestID, digest, &finish.Authorization.Proof); e != nil {
			t.Fatal("atomic authorization/retry", e)
		}
	}
	if e = s.db.View(func(tx *bolt.Tx) error {
		var r wenCampaignClaimStakeReservationV1
		if e := json.Unmarshal(tx.Bucket(wenBudgetBucketV1).Get([]byte("campaign-stake-request:"+a.RequestID)), &r); e != nil {
			return e
		}
		if r.Authorization == nil || r.Authorization.ProofID != finish.Authorization.Proof.ProofID {
			t.Fatal("authorization not saved")
		}
		var proof signerReviewProofRecordV2
		if e := json.Unmarshal(tx.Bucket(bucketSignerReviewProofsV2).Get([]byte(r.Authorization.ProofID)), &proof); e != nil {
			return e
		}
		if proof.State != signerReviewProofConsumed || proof.ConsumedAt != r.Authorization.AuthorizedAt {
			t.Fatal("consumption not atomic")
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	if e = s.db.Update(func(tx *bolt.Tx) error {
		var proof signerReviewProofRecordV2
		if e := json.Unmarshal(tx.Bucket(bucketSignerReviewProofsV2).Get([]byte(finish.Authorization.Proof.ProofID)), &proof); e != nil {
			return e
		}
		_, id, e := normalizeSignerWebAuthnCredentialIDV2(proof.CredentialID)
		if e != nil {
			return e
		}
		return tx.Bucket(bucketSignerWebAuthnCredentialsV2).Delete(signerWebAuthnCredentialKeyV2(id))
	}); e != nil {
		t.Fatal(e)
	}
	if e = service.authorizeWENCampaignClaimStakeV1(a.WalletID, a.RequestID, digest, &finish.Authorization.Proof); e == nil {
		t.Fatal("revoked credential reused")
	}

}
