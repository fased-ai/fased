package main

import (
	"encoding/json"
	"errors"
	"math/big"
	"reflect"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
)

// Conservative proof from the already exact-wire/finalized observation: every
// lamport balance is unchanged except the payer's fee, and token metadata agrees.
// Missing/changed balances leave the outcome recorded but capacity held.
func wenFailedEffectsV1(r wenBudgetReservationV1, result *rpc.GetTransactionResult) string {
	if result == nil || result.Meta == nil || result.Meta.Err == nil || result.Transaction == nil {
		return ""
	}
	tx, err := solana.TransactionFromBytes(result.Transaction.GetBinary())
	if err != nil || len(tx.Message.AccountKeys) == 0 || tx.Message.AccountKeys[0].String() != r.WalletPublicKey || tx.Message.Header.NumRequiredSignatures != 1 {
		return ""
	}
	count := len(tx.Message.AccountKeys)
	for _, lookup := range tx.Message.GetAddressTableLookups() {
		count += len(lookup.WritableIndexes) + len(lookup.ReadonlyIndexes)
	}
	m := result.Meta
	if len(m.PreBalances) != count || len(m.PostBalances) != count || m.PreBalances[0] < m.Fee || m.PreBalances[0]-m.Fee != m.PostBalances[0] || !reflect.DeepEqual(m.PreTokenBalances, m.PostTokenBalances) {
		return ""
	}
	for i := 1; i < count; i++ {
		if m.PreBalances[i] != m.PostBalances[i] {
			return ""
		}
	}
	raw, err := json.Marshal(struct {
		Slot, Fee uint64
		Pre, Post []uint64
		Tokens    []rpc.TokenBalance
	}{result.Slot, m.Fee, m.PreBalances, m.PostBalances, m.PreTokenBalances})
	if err != nil {
		return ""
	}
	return wenHashV1(raw)
}

// Settle only proved failed effects. Keep the charged network fee in consumed
// allowance; release unused SOL/rent and cash in the same original-day transaction.
// No success settlement, rent refund assumption, or offer replay is introduced.
func (s *signerStoreV2) settleWENFailedBudgetV1(requestID, digest string) error {
	return s.changeWENReservationV1(requestID, digest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		if r.State != "finalized-failed" || !wenReservationHashV1(r.FailedEffectsSHA256) {
			return errors.New("WEN failed effects not reconciled")
		}
		if r.FailedBudgetSettled {
			return nil
		}
		nativeScope := "wallet:" + wenHashV1([]byte(r.WalletID)) + ":" + r.Genesis + ":sol"
		if r.WalletClaims["solana:native"] < r.OutcomeFee || r.Scopes[nativeScope] < r.OutcomeFee || r.WalletClaims["solana:native"] == 0 || r.Scopes[nativeScope] != r.WalletClaims["solana:native"] {
			return errors.New("WEN fee exceeds native reservation")
		}
		if r.MiningIntent != nil && !wenMiningSettlementScopesValidV1(*r) {
			return errors.New("invalid mining settlement scopes")
		}
		launchScope := ""
		if r.MiningIntent != nil {
			launchScope = wenMiningLaunchScopeV1(r.WalletID, *r.MiningIntent)
		}
		if r.StakingIntent != nil {
			if !wenStakingSettlementScopesValidV1(*r) {
				return errors.New("invalid staking settlement scopes")
			}
			launchScope = wenStakingLaunchScopeV1(r.WalletID, *r.StakingIntent)
		}
		if r.WithdrawalIntent != nil {
			if !wenWithdrawalSettlementScopesValidV1(*r) {
				return errors.New("invalid withdrawal settlement scopes")
			}
			launchScope = wenWithdrawalLaunchScopeV1(r.WalletID, *r.WithdrawalIntent)
		}
		if r.BTCClaimIntent != nil || r.BTCClaimPrepared != nil {
			if !wenBTCClaimSettlementScopesValidV1(*r) {
				return errors.New("invalid BTC claim settlement scopes")
			}
			launchScope = wenBTCClaimLaunchScopeV1(r.WalletID, *r.BTCClaimIntent)
		}
		if r.MiningClaimIntent != nil || r.MiningClaimPrepared != nil {
			if !wenMiningClaimSettlementScopesValidV1(*r) {
				return errors.New("invalid mining claim settlement scopes")
			}
			launchScope = wenMiningClaimLaunchScopeV1(r.WalletID, *r.MiningClaimIntent)
		}
		if r.MiningFundingIntent != nil || r.MiningFundingPrepared != nil {
			if !wenMiningFundingSettlementScopesValidV1(*r) {
				return errors.New("invalid mining funding settlement scopes")
			}
			launchScope = wenMiningFundingLaunchScopeV1(r.WalletID, *r.MiningFundingIntent)
		}
		if r.NativeClaimIntent != nil || r.NativeClaimPrepared != nil {
			if !wenNativeClaimSettlementScopesValidV1(*r) {
				return errors.New("invalid native SAT claim settlement scopes")
			}
			launchScope = wenNativeClaimLaunchScopeV1(r.WalletID, *r.NativeClaimIntent)
		}
		b := tx.Bucket(wenBudgetBucketV1)
		for scope, amount := range r.Scopes {
			var balance wenBudgetBalanceV1
			if amount == 0 || json.Unmarshal(b.Get([]byte("limit:"+scope)), &balance) != nil || balance.Reserved < amount || balance.Reserved > balance.Limit {
				return errors.New("WEN scope settlement underflow")
			}
			release := amount
			if scope == nativeScope || scope == launchScope {
				release -= r.OutcomeFee
			}
			balance.Reserved -= release
			raw, _ := json.Marshal(balance)
			if err := b.Put([]byte("limit:"+scope), raw); err != nil {
				return err
			}
		}
		usage := tx.Bucket(bucketSignerUsageV2)
		for asset, amount := range r.WalletClaims {
			key := dailyUsageKeyV2(r.WalletID, asset, r.UsageDay)
			current, ok := new(big.Int).SetString(string(usage.Get(key)), 10)
			if !ok || current.Cmp(new(big.Int).SetUint64(amount)) < 0 {
				return errors.New("WEN usage settlement underflow")
			}
			release := amount
			if asset == "solana:native" {
				release -= r.OutcomeFee
			}
			current.Sub(current, new(big.Int).SetUint64(release))
			if err := usage.Put(key, []byte(current.String())); err != nil {
				return err
			}
		}
		r.FailedBudgetSettled = true
		return nil
	})
}
