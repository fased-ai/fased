package main

import (
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"math/big"
)

// Owner-control-only, exact-review budget initialization. Existing limits and
// reservations are immutable: conflicting shared limits reject atomically.
// This neither admits an artifact nor authorizes or signs a transaction.
func (s *signerServiceV2) installWENMarketBudgetV1(cfg signerConfig, wallet, request, expected string, control bool) error {
	if e := requireControlSocketV2(control); e != nil {
		return e
	}
	bad := errors.New("market budget installation rejected")
	if s == nil || s.store == nil || s.keys == nil || cfg.readOnly || cfg.stateDBPath != s.store.db.Path() || !wenReservationHashV1(expected) {
		return bad
	}
	if e := cfg.ensureChainAllowed("solana"); e != nil {
		return e
	}
	if _, e := validateRequestIDV2(request); e != nil {
		return e
	}
	public, e := s.keys.PublicRecord(wallet)
	if e != nil {
		return e
	}
	network, e := s.keys.SolanaNetworkV2(wallet)
	if e != nil {
		return e
	}
	return s.store.db.Update(func(tx *bolt.Tx) error {
		review, policy, _, e := loadReviewAndPolicyForAuthorizationV2(tx, wallet, request, s.store.now().UTC())
		if e != nil {
			return e
		}
		if review.ArtifactKind != wenMarketArtifactKindV1 || review.ArtifactDigest != "sha256:"+expected {
			return bad
		}
		var a wenMarketReviewArtifactV1
		if decodeSignerAdminStrictJSON(review.SemanticIntent, &a) != nil {
			return bad
		}
		digest, e := a.digest()
		if e != nil || digest != expected || a.WalletID != wallet || a.RequestID != request || a.WalletPublicKey != public.PublicKey || a.PolicyHash != policy.Hash || a.Policy.Successor.Genesis != network.GenesisHash || !containsStringV2(policy.Operations, wenMarketOperationV1) || !wenMarketProgramsAllowedV1(policy, a) {
			return bad
		}
		retired, e := signerWalletIsRetiredInTxV2(tx, wallet)
		if e != nil || retired {
			return bad
		}
		claims := map[string]uint64{"solana:native": a.Binding.MaxFee, a.cashAsset(): a.Binding.Snapshot.Quote.InputCash}
		for name, amount := range claims {
			asset, e := policyAssetByNameV2(policy, name)
			if e != nil {
				return e
			}
			perTx, ok := new(big.Int).SetString(asset.MaxPerTx, 10)
			daily, dailyOK := new(big.Int).SetString(asset.MaxDaily, 10)
			n := new(big.Int).SetUint64(amount)
			if amount == 0 || !ok || !dailyOK || n.Cmp(perTx) > 0 || n.Cmp(daily) > 0 || !containsStringV2(asset.Destinations, a.Pins.Pool.String()) {
				return bad
			}
		}
		bucket, e := tx.CreateBucketIfNotExists(wenBudgetBucketV1)
		if e != nil {
			return e
		}
		for scope, limit := range wenMarketReservationScopesV1(a) {
			key := []byte("limit:" + scope)
			if raw := bucket.Get(key); raw != nil {
				var old wenBudgetBalanceV1
				if json.Unmarshal(raw, &old) != nil || old.Limit != limit || old.Reserved > old.Limit {
					return errors.New("WEN budget already configured differently")
				}
				continue
			}
			raw, e := json.Marshal(wenBudgetBalanceV1{Limit: limit})
			if e != nil {
				return e
			}
			if e = bucket.Put(key, raw); e != nil {
				return e
			}
		}
		return nil
	})
}
