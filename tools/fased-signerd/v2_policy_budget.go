package main

import (
	"encoding/json"
	"errors"
	"math/big"

	bolt "go.etcd.io/bbolt"
)

type signerPolicyBudgetAssetV2 struct {
	Asset     string `json:"asset"`
	MaxPerTx  string `json:"maxPerTx"`
	MaxDaily  string `json:"maxDaily"`
	Used      string `json:"used"`
	Remaining string `json:"remaining"`
}
type signerPolicyBudgetV2 struct {
	WalletID      string                      `json:"walletId"`
	PolicyVersion uint64                      `json:"policyVersion"`
	PolicyHash    string                      `json:"policyHash"`
	UsageDay      string                      `json:"usageDayUTC"`
	Assets        []signerPolicyBudgetAssetV2 `json:"assets"`
}

// policyBudgetV2 is a snapshot, never an authorization or reservation. Execution
// must recheck policy and usage atomically; pending reservations count as used.
func (s *signerStoreV2) policyBudgetV2(walletID string) (signerPolicyBudgetV2, error) {
	var result signerPolicyBudgetV2
	if s == nil || s.db == nil {
		return result, errors.New("signer state database is unavailable")
	}
	walletID = normalizeWalletID(walletID)
	err := s.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(bucketSignerPoliciesV2).Get([]byte(walletID))
		if raw == nil {
			return errors.New("explicit signer policy required")
		}
		var policy signerPolicyV2
		if err := json.Unmarshal(raw, &policy); err != nil {
			return err
		}
		result = signerPolicyBudgetV2{WalletID: walletID, PolicyVersion: policy.Version, PolicyHash: policy.Hash, UsageDay: currentDayBucket(s.now()), Assets: []signerPolicyBudgetAssetV2{}}
		for _, asset := range policy.Assets {
			cap, ok := new(big.Int).SetString(asset.MaxDaily, 10)
			if !ok || cap.Sign() <= 0 {
				return errors.New("invalid policy daily cap")
			}
			used := new(big.Int)
			if raw := tx.Bucket(bucketSignerUsageV2).Get(dailyUsageKeyV2(walletID, asset.Asset, result.UsageDay)); raw != nil {
				if _, ok := used.SetString(string(raw), 10); !ok || used.Sign() < 0 {
					return errors.New("invalid durable signer usage counter")
				}
			}
			remaining := new(big.Int).Sub(cap, used)
			if remaining.Sign() < 0 {
				remaining.SetInt64(0)
			}
			result.Assets = append(result.Assets, signerPolicyBudgetAssetV2{Asset: asset.Asset, MaxPerTx: asset.MaxPerTx, MaxDaily: asset.MaxDaily, Used: used.String(), Remaining: remaining.String()})
		}
		return nil
	})
	return result, err
}
