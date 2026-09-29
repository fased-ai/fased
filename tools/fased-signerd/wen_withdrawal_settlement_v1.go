package main

import (
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"math/big"
)

// Both SOL ceilings represent the same fee; returned tokens are not outgoing usage.
func wenWithdrawalSettlementScopesValidV1(r wenBudgetReservationV1) bool {
	if r.WithdrawalIntent == nil || r.MiningIntent != nil || r.StakingIntent != nil || validateWENWithdrawalIntentV1(*r.WithdrawalIntent) != nil || r.Genesis != r.WithdrawalIntent.Genesis || len(r.Scopes) != 2 {
		return false
	}
	v := *r.WithdrawalIntent
	amount := r.WalletClaims["solana:native"]
	if amount == 0 || r.Scopes[wenMiningNativeScopeV1(r.WalletID, r.Genesis)] != amount || r.Scopes[wenWithdrawalLaunchScopeV1(r.WalletID, v)] != amount {
		return false
	}
	return len(r.WalletClaims) == 1
}

// Keep only the proved network fee in consumed allowance.
func (s *signerStoreV2) settleWENWithdrawalSuccessV1(requestID, digest string) error {
	return s.changeWENReservationV1(requestID, digest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		if r.State != "finalized-success" || !wenReservationHashV1(r.WithdrawalEffectsSHA256) || r.WithdrawalIntent == nil || !wenWithdrawalSettlementScopesValidV1(*r) || !wenReservationHashV1(r.SuccessEffectsSHA256) {
			return errors.New("WEN withdrawal effects not reconciled")
		}
		if r.SuccessBudgetSettled {
			return nil
		}
		scope := "wallet:" + wenHashV1([]byte(r.WalletID)) + ":" + r.Genesis + ":sol"
		amount := r.WalletClaims["solana:native"]
		if amount == 0 || r.Scopes[scope] != amount || r.SuccessNativeDebit != r.OutcomeFee || r.SuccessNativeDebit > amount {
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
