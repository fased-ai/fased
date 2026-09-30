package main

import (
	"context"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"reflect"
	"time"
)

// Internal pre-signing release. The future execution path must durably leave
// reserved before accessing a key. Signing/submitted/uncertain records cannot
// use this path, even after their review expires. No on-chain funds move here.
func (s *signerStoreV2) releaseWENCampaignReviewV1(walletID, requestID, digest, reason string) error {
	return s.releaseWENCampaignStateV1(walletID, requestID, digest, reason, "reserved", 0)
}

func (s *signerStoreV2) releaseWENCampaignStateV1(walletID, requestID, digest, reason, expected string, height uint64) error {
	bad := errors.New("campaign reservation cannot be released")
	if s == nil || s.db == nil || (reason != "cancelled" && reason != "expired") {
		return bad
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(wenBudgetBucketV1)
		if bucket == nil {
			return bad
		}
		key := []byte("campaign-request:" + requestID)
		var r wenCampaignReservationV1
		if json.Unmarshal(bucket.Get(key), &r) != nil || r.Version != 1 || r.Artifact.RequestID != requestID || r.Artifact.WalletID != walletID || r.Digest != digest {
			return bad
		}
		actual, e := r.Artifact.digest()
		if e != nil || actual != digest {
			return bad
		}
		debit, e := r.Artifact.debit()
		if e != nil {
			return e
		}
		expectedScopes := map[string]uint64{wenMiningNativeScopeV1(walletID, r.Artifact.Pins.Genesis): debit, wenCampaignLaunchScopeV1(r.Artifact): debit}
		if !reflect.DeepEqual(expectedScopes, r.Scopes) || r.UsageDay == "" {
			return bad
		}
		reviews := tx.Bucket(bucketSignerReviewsV2)
		var review signerReviewV2
		if json.Unmarshal(reviews.Get([]byte(requestID)), &review) != nil || review.ArtifactDigest != "sha256:"+digest || review.WalletID != walletID {
			return bad
		}
		if r.State == reason {
			if review.State != reason {
				return bad
			}
			return nil
		}
		if r.State != expected || review.State != jupiterReviewPreparedV2 {
			return bad
		}
		if expected != "reserved" && (reason != "expired" || (expected != "signing" && expected != "signed") || height <= r.Artifact.Binding.LastValidHeight) {
			return bad
		}
		if reason == "expired" {
			expiry, e := time.Parse(time.RFC3339Nano, review.ExpiresAt)
			if e != nil || s.now().UTC().Before(expiry) {
				return bad
			}
		}
		if e = settleWENCampaignNativeV1(tx, walletID, r.UsageDay, r.Scopes, debit, 0); e != nil {
			return e
		}
		r.State = reason
		review.State = reason
		review.UpdatedAt = timestampV2(s.now().UTC())
		raw, e := json.Marshal(r)
		if e != nil {
			return e
		}
		if e = bucket.Put(key, raw); e != nil {
			return e
		}
		raw, e = json.Marshal(review)
		if e != nil {
			return e
		}
		// Keep the request and message tombstones; cancellation must not revive old approval.
		return reviews.Put([]byte(requestID), raw)
	})
}

type wenCampaignExpiryRPCV1 interface {
	GetGenesisHash(context.Context) (solana.Hash, error)
	GetBlockHeight(context.Context, rpc.CommitmentType) (uint64, error)
}

// Only pre-broadcast journal states qualify: signed bytes cannot leave the
// executor before its atomic submission-uncertain transition. Missing receipts
// never authorize release of uncertain or submitted transactions.
func (s *signerStoreV2) expireWENCampaignSigningV1(ctx context.Context, c wenCampaignExpiryRPCV1, wallet, request, digest string) error {
	bad := errors.New("campaign signing expiry rejected")
	if s == nil || s.db == nil || c == nil {
		return bad
	}
	var r wenCampaignReservationV1
	if e := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return bad
		}
		return json.Unmarshal(b.Get([]byte("campaign-request:"+request)), &r)
	}); e != nil {
		return e
	}
	if r.Digest != digest || r.Artifact.WalletID != wallet || (r.State != "signing" && r.State != "signed") {
		return bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	chain := func() error {
		g, e := c.GetGenesisHash(ctx)
		if e != nil {
			return e
		}
		if g.String() != r.Artifact.Pins.Genesis {
			return bad
		}
		return nil
	}
	if e := chain(); e != nil {
		return e
	}
	height, e := c.GetBlockHeight(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return e
	}
	if height <= r.Artifact.Binding.LastValidHeight {
		return bad
	}
	if e = chain(); e != nil {
		return e
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	return s.releaseWENCampaignStateV1(wallet, request, digest, "expired", r.State, height)
}
