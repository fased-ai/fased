package main

import (
	"encoding/json"
	"math/big"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

// Bind native-cost observations to the originally resolved account order. This
// is not success settlement: SAT/cash/BTC obligations still require role-aware
// token deltas, and later refundable rent cannot be assumed returned here.
func wenSuccessNativeEffectsV1(r wenBudgetReservationV1, result *rpc.GetTransactionResult) (string, uint64) {
	if result == nil || result.Meta == nil || result.Meta.Err != nil || result.Transaction == nil || len(r.AccountKeys) == 0 {
		return "", 0
	}
	tx, err := solana.TransactionFromBytes(result.Transaction.GetBinary())
	if err != nil {
		return "", 0
	}
	keys := append(solana.PublicKeySlice(nil), tx.Message.AccountKeys...)
	writable, readonly := 0, 0
	for _, lookup := range tx.Message.GetAddressTableLookups() {
		writable += len(lookup.WritableIndexes)
		readonly += len(lookup.ReadonlyIndexes)
	}
	m := result.Meta
	if len(m.LoadedAddresses.Writable) != writable || len(m.LoadedAddresses.ReadOnly) != readonly {
		return "", 0
	}
	keys = append(keys, m.LoadedAddresses.Writable...)
	keys = append(keys, m.LoadedAddresses.ReadOnly...)
	if len(keys) != len(r.AccountKeys) || len(m.PreBalances) != len(keys) || len(m.PostBalances) != len(keys) || len(keys) == 0 || keys[0].String() != r.WalletPublicKey {
		return "", 0
	}
	for i, key := range keys {
		if key.String() != r.AccountKeys[i] {
			return "", 0
		}
	}
	pre, post := new(big.Int), new(big.Int)
	for i := range keys {
		pre.Add(pre, new(big.Int).SetUint64(m.PreBalances[i]))
		post.Add(post, new(big.Int).SetUint64(m.PostBalances[i]))
	}
	pre.Sub(pre, post)
	if pre.Cmp(new(big.Int).SetUint64(m.Fee)) != 0 || m.PreBalances[0] < m.PostBalances[0] {
		return "", 0
	}
	debit := m.PreBalances[0] - m.PostBalances[0]
	if debit < m.Fee || debit > r.WalletClaims["solana:native"] {
		return "", 0
	}
	raw, err := json.Marshal(struct {
		Keys      []string
		Pre, Post []uint64
		Fee       uint64
	}{r.AccountKeys, m.PreBalances, m.PostBalances, m.Fee})
	if err != nil {
		return "", 0
	}
	return wenHashV1(raw), debit
}
