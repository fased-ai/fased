package main

import (
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"math/big"
	"strconv"
)

// Both SOL ceilings represent the same native debit; token usage is gross principal.
func wenStakingSettlementScopesValidV1(r wenBudgetReservationV1) bool {
	if r.StakingIntent == nil || r.MiningIntent != nil || validateWENStakingIntentV1(*r.StakingIntent) != nil || r.Genesis != r.StakingIntent.Genesis || len(r.Scopes) != 2 {
		return false
	}
	v := *r.StakingIntent
	amount := r.WalletClaims["solana:native"]
	if amount == 0 || r.Scopes[wenMiningNativeScopeV1(r.WalletID, r.Genesis)] != amount || r.Scopes[wenStakingLaunchScopeV1(r.WalletID, v)] != amount {
		return false
	}
	if v.Operation == "requestExit" {
		return len(r.WalletClaims) == 1
	}
	principal, e := strconv.ParseUint(v.Amount, 10, 64)
	return e == nil && len(r.WalletClaims) == 2 && r.WalletClaims["solana:spl:"+v.Mint] == principal
}

// Retain gross SAT principal usage; only unused SOL capacity is released.
func (s *signerStoreV2) settleWENStakingSuccessV1(requestID, digest string) error {
	return s.changeWENReservationV1(requestID, digest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		if r.State != "finalized-success" || !wenReservationHashV1(r.StakingEffectsSHA256) || r.StakingIntent == nil || !wenStakingSettlementScopesValidV1(*r) || !wenReservationHashV1(r.SuccessEffectsSHA256) {
			return errors.New("WEN staking effects not reconciled")
		}
		if r.SuccessBudgetSettled {
			return nil
		}
		scope := "wallet:" + wenHashV1([]byte(r.WalletID)) + ":" + r.Genesis + ":sol"
		amount := r.WalletClaims["solana:native"]
		if amount == 0 || r.Scopes[scope] != amount || r.SuccessNativeDebit < r.OutcomeFee || r.SuccessNativeDebit > amount {
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
