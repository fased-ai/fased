package main

import (
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"math/big"
)

// Keep the proved network fee and paid-receipt rent in consumed allowance.
func (s *signerStoreV2) settleWENNativeClaimSuccessV1(requestID, digest string) error {
	return s.changeWENReservationV1(requestID, digest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		if r.State != "finalized-success" || !wenReservationHashV1(r.NativeClaimEffectsSHA256) || r.NativeClaimIntent == nil || !wenNativeClaimSettlementScopesValidV1(*r) || !wenReservationHashV1(r.SuccessEffectsSHA256) {
			return errors.New("WEN native SAT claim effects not reconciled")
		}
		if r.SuccessBudgetSettled {
			return nil
		}
		scope := "wallet:" + wenHashV1([]byte(r.WalletID)) + ":" + r.Genesis + ":sol"
		amount := r.WalletClaims["solana:native"]
		if amount == 0 || r.Scopes[scope] != amount || r.NativeClaimPrepared == nil || r.SuccessNativeDebit < r.OutcomeFee || r.SuccessNativeDebit-r.OutcomeFee == 0 || r.SuccessNativeDebit-r.OutcomeFee > r.NativeClaimPrepared.Rent || r.SuccessNativeDebit > amount {
			return errors.New("WEN native settlement differs from reservation")
		}
		b := tx.Bucket(wenBudgetBucketV1)
		release := amount - r.SuccessNativeDebit
		for scope := range r.Scopes {
			var balance wenBudgetBalanceV1
			if json.Unmarshal(b.Get([]byte("limit:"+scope)), &balance) != nil || balance.Reserved < amount || balance.Reserved > balance.Limit {
				return errors.New("WEN native settlement underflow")
			}
			balance.Reserved -= release
			raw, _ := json.Marshal(balance)
			if err := b.Put([]byte("limit:"+scope), raw); err != nil {
				return err
			}
		}
		usage := tx.Bucket(bucketSignerUsageV2)
		key := dailyUsageKeyV2(r.WalletID, "solana:native", r.UsageDay)
		current, ok := new(big.Int).SetString(string(usage.Get(key)), 10)
		if !ok || current.Cmp(new(big.Int).SetUint64(amount)) < 0 {
			return errors.New("WEN daily settlement underflow")
		}
		current.Sub(current, new(big.Int).SetUint64(release))
		if err := usage.Put(key, []byte(current.String())); err != nil {
			return err
		}
		r.SuccessBudgetSettled = true
		return nil
	})
}
