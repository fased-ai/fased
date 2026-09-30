package main

import (
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"math/big"
)

// Proves fee-only effects of the exact canonical mining transaction. This does
// not assert an account snapshot is transaction-time post-state or award payment.
func wenMiningSuccessEffectsV1(r wenBudgetReservationV1, result *rpc.GetTransactionResult) string {
	if r.MiningIntent == nil || r.MiningEntry == nil || result == nil || result.Meta == nil || result.Meta.Err != nil || result.Transaction == nil {
		return ""
	}
	m := result.Meta
	if len(m.InnerInstructions) != 0 || len(m.PreTokenBalances) != 0 || len(m.PostTokenBalances) != 0 || len(m.PreBalances) != 3 || len(m.PostBalances) != 3 || m.PreBalances[0] < m.Fee || m.PreBalances[0]-m.Fee != m.PostBalances[0] {
		return ""
	}
	for i := 1; i < 3; i++ {
		if m.PreBalances[i] != m.PostBalances[i] {
			return ""
		}
	}
	tx, e := solana.TransactionFromBytes(result.Transaction.GetBinary())
	if e != nil || len(tx.Message.Instructions) != 1 {
		return ""
	}
	wallet, e := solana.PublicKeyFromBase58(r.WalletPublicKey)
	if e != nil {
		return ""
	}
	var reveal []byte
	if r.MiningIntent.Operation == "reveal" {
		d := tx.Message.Instructions[0].Data
		if len(d) != 41 {
			return ""
		}
		reveal = d[1:]
	}
	if verifyWENMiningMessageV1(*r.MiningIntent, wallet, *r.MiningEntry, reveal, r.SignedMessage, tx.Message.RecentBlockhash, 0, 1, m.Fee) != nil {
		return ""
	}
	proof, debit := wenSuccessNativeEffectsV1(r, result)
	if proof == "" || debit != m.Fee {
		return ""
	}
	raw, e := json.Marshal(struct {
		Native  string
		Slot    uint64
		Message string
	}{proof, result.Slot, r.MessageSHA256})
	if e != nil {
		return ""
	}
	return wenHashV1(raw)
}

func wenMiningSettlementScopesValidV1(r wenBudgetReservationV1) bool {
	if r.MiningIntent == nil || r.Genesis != r.MiningIntent.Genesis || len(r.WalletClaims) != 1 || len(r.Scopes) < 1 || len(r.Scopes) > 2 {
		return false
	}
	amount := r.WalletClaims["solana:native"]
	native := wenMiningNativeScopeV1(r.WalletID, r.Genesis)
	if amount == 0 || r.Scopes[native] != amount {
		return false
	}
	launch := wenMiningLaunchScopeV1(r.WalletID, *r.MiningIntent)
	for scope, n := range r.Scopes {
		if (scope != native && scope != launch) || n != amount {
			return false
		}
	}
	return true
}

func (s *signerStoreV2) settleWENMiningSuccessV1(requestID, digest string) error {
	return s.changeWENReservationV1(requestID, digest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		if r.State != "finalized-success" || !wenReservationHashV1(r.MiningEffectsSHA256) || r.MiningIntent == nil || r.MiningEntry == nil || !wenMiningSettlementScopesValidV1(*r) || r.SuccessNativeDebit != r.OutcomeFee || !wenReservationHashV1(r.SuccessEffectsSHA256) {
			return errors.New("WEN mining effects not reconciled")
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
