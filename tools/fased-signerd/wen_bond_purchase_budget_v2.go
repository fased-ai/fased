package main

import (
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"math/big"
	"reflect"
)

type wenBondPurchaseReservationV2 struct {
	RetainedRecovery                                     uint64
	OutcomeDigest                                        string `json:",omitempty"`
	OutcomeDebit, OutcomeCash, OutcomeGross, OutcomeSlot uint64
	Authorization                                        *wenMiningClaimAuthorizationV1 `json:",omitempty"`
	Signature                                            string                         `json:",omitempty"`
	Version                                              int
	Digest, State, UsageDay                              string
	Artifact                                             wenBondPurchaseReviewArtifactV2
	Scopes                                               map[string]uint64
}

func wenBondPurchaseLaunchScopeV2(a wenBondPurchaseReviewArtifactV2) string {
	return wenMiningNativeScopeV1(a.WalletID, a.Policy.Deployment.Genesis) + ":launch:" + wenHashV1([]byte(a.Pins.Bond.Program.String()+":"+a.Pins.Bond.Sale.String()))
}

// Internal reservation only. This record is deliberately not accepted by legacy
// execution dispatch. Both shared wallet usage and launch limits commit atomically.
func (s *signerStoreV2) reserveWENBondPurchaseReviewV2(a wenBondPurchaseReviewArtifactV2) (string, bool, error) {
	bad := errors.New("Bond purchase review budget reservation rejected")
	if s == nil || s.db == nil {
		return "", false, bad
	}
	digest, err := a.digest()
	if err != nil {
		return "", false, err
	}
	debit := a.nativeDebit()
	scopes := wenBondPurchaseReservationScopesV2(a)
	claims := map[string]uint64{"solana:native": debit, a.cashAsset(): a.cashAmount()}
	existing := false
	err = s.db.Update(func(tx *bolt.Tx) error {
		now := s.now().UTC()
		review, policy, _, e := loadReviewAndPolicyForAuthorizationV2(tx, a.WalletID, a.RequestID, now)
		if e != nil {
			return e
		}
		if review.ArtifactKind != wenBondPurchaseArtifactKindV2 || review.ArtifactDigest != "sha256:"+digest {
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
		for name, amount := range claims {
			asset, e := policyAssetByNameV2(policy, name)
			if e != nil {
				return e
			}
			cap, ok := new(big.Int).SetString(asset.MaxPerTx, 10)
			if !ok || cap.Sign() <= 0 || new(big.Int).SetUint64(amount).Cmp(cap) > 0 || !containsStringV2(asset.Destinations, a.Pins.Bond.Sale.String()) {
				return bad
			}
		}
		bucket := tx.Bucket(wenBudgetBucketV1)
		if bucket == nil {
			return bad
		}
		key := []byte("bond-purchase-request:" + a.RequestID)
		// One live reservation per exact transaction, even across request IDs.
		actionKey := []byte("bond-purchase-message:" + wenHashV1(append([]byte(a.Policy.Deployment.Genesis+":"), a.Binding.Message...)))
		day := currentDayBucket(now)
		if raw := bucket.Get(key); raw != nil {
			var saved wenBondPurchaseReservationV2
			if json.Unmarshal(raw, &saved) != nil || saved.Version != 2 || saved.Digest != digest || saved.State != "reserved" || saved.UsageDay != day || !reflect.DeepEqual(saved.Artifact, a) || !reflect.DeepEqual(saved.Scopes, scopes) || string(bucket.Get(actionKey)) != a.RequestID {
				return bad
			}
			existing = true
			return nil
		}
		if bucket.Get(actionKey) != nil {
			return bad
		}
		if e = reserveWENPolicyUsageV1(tx, a.WalletID, claims, day); e != nil {
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
		raw, e := json.Marshal(wenBondPurchaseReservationV2{Version: 2, Digest: digest, State: "reserved", UsageDay: day, Artifact: a, Scopes: scopes})
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

// Shared cash scope couples Buy with future cash-consuming adapters. Explicit
// protected limits are required; a missing scope never becomes unlimited.
func wenBondPurchaseCashScopeV2(a wenBondPurchaseReviewArtifactV2) string {
	return "wallet:" + wenHashV1([]byte(a.WalletID)) + ":" + a.Policy.Deployment.Genesis + ":" + a.cashAsset()
}

func wenBondPurchaseReservationScopesV2(a wenBondPurchaseReviewArtifactV2) map[string]uint64 {
	return map[string]uint64{wenMiningNativeScopeV1(a.WalletID, a.Policy.Deployment.Genesis): a.nativeDebit(), wenBondPurchaseLaunchScopeV2(a): a.nativeDebit(), wenBondPurchaseCashScopeV2(a): a.cashAmount()}
}
