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
func (s *signerStoreV2) releaseWENMarketReviewV1(walletID, requestID, digest, reason string) error {
	return s.releaseWENMarketStateV1(walletID, requestID, digest, reason, "reserved", 0)
}

func (s *signerStoreV2) releaseWENMarketStateV1(walletID, requestID, digest, reason, expected string, height uint64) error {
	bad := errors.New("Buy reservation cannot be released")
	if s == nil || s.db == nil || (reason != "cancelled" && reason != "expired") {
		return bad
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(wenBudgetBucketV1)
		key := []byte("market-request:" + requestID)
		if bucket == nil || bucket.Get(key) == nil {
			reviews := tx.Bucket(bucketSignerReviewsV2)
			if reviews == nil {
				return bad
			}
			var review signerReviewV2
			var a wenMarketReviewArtifactV1
			if json.Unmarshal(reviews.Get([]byte(requestID)), &review) != nil || review.ArtifactKind != wenMarketArtifactKindV1 || review.WalletID != walletID || review.RequestID != requestID || review.ArtifactDigest != "sha256:"+digest || decodeSignerAdminStrictJSON(review.SemanticIntent, &a) != nil {
				return bad
			}
			d, e := a.digest()
			if e != nil || d != digest || a.WalletID != walletID || a.RequestID != requestID || a.WalletPublicKey != review.WalletPublicKey {
				return bad
			}
			if review.State == reason {
				return nil
			}
			if expected != "reserved" || review.State != jupiterReviewPreparedV2 {
				return bad
			}
			if reason == "expired" {
				expiry, e := time.Parse(time.RFC3339Nano, review.ExpiresAt)
				if e != nil || s.now().UTC().Before(expiry) {
					return bad
				}
			}
			review.State = reason
			review.UpdatedAt = timestampV2(s.now().UTC())
			raw, e := json.Marshal(review)
			if e != nil {
				return e
			}
			return reviews.Put([]byte(requestID), raw)
		}

		var r wenMarketReservationV1
		if json.Unmarshal(bucket.Get(key), &r) != nil || r.Version != 1 || r.Artifact.RequestID != requestID || r.Artifact.WalletID != walletID || r.Digest != digest {
			return bad
		}
		actual, e := r.Artifact.digest()
		if e != nil || actual != digest {
			return bad
		}
		debit := r.Artifact.Binding.MaxFee
		expectedScopes := wenMarketReservationScopesV1(r.Artifact)
		if !reflect.DeepEqual(expectedScopes, r.Scopes) || r.UsageDay == "" {
			return bad
		}

		reviews := tx.Bucket(bucketSignerReviewsV2)
		var review signerReviewV2
		if json.Unmarshal(reviews.Get([]byte(requestID)), &review) != nil || review.ArtifactDigest != "sha256:"+digest || review.WalletID != walletID || review.RequestID != requestID || review.ArtifactKind != wenMarketArtifactKindV1 || review.WalletPublicKey != r.Artifact.WalletPublicKey {
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
		native := map[string]uint64{wenMiningNativeScopeV1(walletID, r.Artifact.Policy.Successor.Genesis): debit, wenMarketLaunchScopeV1(r.Artifact): debit}
		if e = settleWENCampaignNativeV1(tx, walletID, r.UsageDay, native, debit, 0); e != nil {
			return e
		}
		if e = settleWENMarketCashV1(tx, r.Artifact, r.UsageDay, 0); e != nil {
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

type wenMarketExpiryRPCV1 interface {
	GetGenesisHash(context.Context) (solana.Hash, error)
	GetBlockHeight(context.Context, rpc.CommitmentType) (uint64, error)
}

// Only pre-broadcast journal states qualify: signed bytes cannot leave the
// executor before its atomic submission-uncertain transition. Missing receipts
// never authorize release of uncertain or submitted transactions.
func (s *signerStoreV2) expireWENMarketSigningV1(ctx context.Context, c wenMarketExpiryRPCV1, wallet, request, digest string) error {
	bad := errors.New("Buy signing expiry rejected")
	if s == nil || s.db == nil || c == nil {
		return bad
	}
	var r wenMarketReservationV1
	if e := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return bad
		}
		return json.Unmarshal(b.Get([]byte("market-request:"+request)), &r)
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
		if g.String() != r.Artifact.Policy.Successor.Genesis {
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
	return s.releaseWENMarketStateV1(wallet, request, digest, "expired", r.State, height)
}

func (s *signerStoreV2) expireWENMarketReviewV1(ctx context.Context, c wenMarketExpiryRPCV1, wallet, request, digest string) error {
	// Unsigned review/reservation expiry needs no chain claim. A state mismatch
	// cannot release funds; signing requires the separate finalized-height proof.
	if e := s.releaseWENMarketStateV1(wallet, request, digest, "expired", "reserved", 0); e == nil {
		return nil
	}
	return s.expireWENMarketSigningV1(ctx, c, wallet, request, digest)
}
