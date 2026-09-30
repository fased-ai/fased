package main

import (
	"encoding/json"
	"errors"
	"math/big"

	bolt "go.etcd.io/bbolt"
)

// Cash actually spent stays charged. Only unused native fee/rent allowance is
// returned; payer net debit already includes any same-transaction rent return.
func (s *signerStoreV2) settleWENSuccessBudgetV1(requestID, digest string) error {
	return s.changeWENReservationV1(requestID, digest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		if r.State != "finalized-success" || !wenReservationHashV1(r.SuccessFundingEffectsSHA256) || !wenReservationHashV1(r.SuccessEffectsSHA256) {
			return errors.New("WEN success funding not reconciled")
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
		var balance wenBudgetBalanceV1
		if json.Unmarshal(b.Get([]byte("limit:"+scope)), &balance) != nil || balance.Reserved < amount || balance.Reserved > balance.Limit {
			return errors.New("WEN native settlement underflow")
		}
		release := amount - r.SuccessNativeDebit
		balance.Reserved -= release
		raw, _ := json.Marshal(balance)
		if err := b.Put([]byte("limit:"+scope), raw); err != nil {
			return err
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
