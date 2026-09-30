package main

import (
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"math/big"
	"reflect"
)

type wenCampaignClaimStakeReservationV1 struct {
	OutcomeDigest             string `json:",omitempty"`
	OutcomeDebit, OutcomeSlot uint64
	Authorization             *wenMiningClaimAuthorizationV1 `json:",omitempty"`
	Signature                 string                         `json:",omitempty"`
	Version                   int
	Digest, State, UsageDay   string
	Artifact                  wenCampaignClaimStakeReviewV1
	Scopes                    map[string]uint64
}

func wenCampaignClaimStakeLaunchScopeV1(a wenCampaignClaimStakeReviewV1) string {
	return wenMiningNativeScopeV1(a.WalletID, a.Pins.Genesis) + ":launch:" + wenHashV1([]byte(a.Claim.Program.String()+":"+a.Claim.Economy.String()))
}

// Typed direct-stake reservation. Shared wallet usage and launch limits commit
// atomically; the campaign journey dispatch selects the protected artifact kind.
func (s *signerStoreV2) reserveWENCampaignClaimStakeReviewV1(a wenCampaignClaimStakeReviewV1) (string, bool, error) {
	bad := errors.New("campaign review budget reservation rejected")
	if s == nil || s.db == nil {
		return "", false, bad
	}
	digest, err := a.digest()
	if err != nil {
		return "", false, err
	}
	debit := a.MaximumDebit
	scopes := map[string]uint64{wenMiningNativeScopeV1(a.WalletID, a.Pins.Genesis): debit, wenCampaignClaimStakeLaunchScopeV1(a): debit}
	existing := false
	err = s.db.Update(func(tx *bolt.Tx) error {
		now := s.now().UTC()
		review, policy, _, e := loadReviewAndPolicyForAuthorizationV2(tx, a.WalletID, a.RequestID, now)
		if e != nil {
			return e
		}
		if review.ArtifactKind != wenCampaignClaimStakeArtifactKindV1 || review.ArtifactDigest != "sha256:"+digest {
			return bad
		}
		retired, e := signerWalletIsRetiredInTxV2(tx, a.WalletID)
		if e != nil {
			return e
		}
		if retired {
			return bad
		}
		var wallet signerWalletRecordV2
		if json.Unmarshal(tx.Bucket(bucketSignerWalletsV2).Get([]byte(a.WalletID)), &wallet) != nil || wallet.PublicKey != a.WalletPublicKey {
			return bad
		}
		asset, e := policyAssetByNameV2(policy, "solana:native")
		if e != nil {
			return e
		}
		cap, ok := new(big.Int).SetString(asset.MaxPerTx, 10)
		if !ok || cap.Sign() <= 0 || new(big.Int).SetUint64(debit).Cmp(cap) > 0 || !containsStringV2(asset.Destinations, a.Claim.Economy.String()) {
			return bad
		}
		bucket := tx.Bucket(wenBudgetBucketV1)
		if bucket == nil {
			return bad
		}
		key := []byte("campaign-stake-request:" + a.RequestID)
		// One live reservation per exact transaction, even across request IDs.
		actionKey := []byte("campaign-message:" + wenHashV1(append([]byte(a.Pins.Genesis+":"), a.Message...)))
		day := currentDayBucket(now)
		if raw := bucket.Get(key); raw != nil {
			var saved wenCampaignClaimStakeReservationV1
			if json.Unmarshal(raw, &saved) != nil || saved.Version != 1 || saved.Digest != digest || saved.State != "reserved" || saved.UsageDay != day || !reflect.DeepEqual(saved.Artifact, a) || !reflect.DeepEqual(saved.Scopes, scopes) || string(bucket.Get(actionKey)) != a.RequestID {
				return bad
			}
			existing = true
			return nil
		}
		if bucket.Get(actionKey) != nil {
			return bad
		}
		if e = reserveWENPolicyUsageV1(tx, a.WalletID, map[string]uint64{"solana:native": debit}, day); e != nil {
			return e
		}
		for scope, amount := range scopes {
			key := []byte("limit:" + scope)
			var balance wenBudgetBalanceV1
			if json.Unmarshal(bucket.Get(key), &balance) != nil || balance.Limit == 0 || balance.Reserved > balance.Limit || amount > balance.Limit-balance.Reserved {
				return bad
			}
			balance.Reserved += amount
			raw, e := json.Marshal(balance)
			if e != nil {
				return e
			}
			if e = bucket.Put(key, raw); e != nil {
				return e
			}
		}
		raw, e := json.Marshal(wenCampaignClaimStakeReservationV1{Version: 1, Digest: digest, State: "reserved", UsageDay: day, Artifact: a, Scopes: scopes})
		if e != nil {
			return e
		}
		if e = bucket.Put(key, raw); e != nil {
			return e
		}
		return bucket.Put(actionKey, []byte(a.RequestID))
	})
	if err != nil {
		return "", false, err
	}
	return digest, existing, nil
}
