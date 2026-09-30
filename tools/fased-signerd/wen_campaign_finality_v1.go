package main

import (
	"context"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"math/big"
)

// Shared finalized-receipt authentication. A missing receipt is uncertainty.
func readWENCampaignFinalizedV1(ctx context.Context, c signerWENBTCReconcileRPCV1, genesis string, sig solana.Signature, validate func(*rpc.GetTransactionResult) (uint64, string, error)) (*rpc.GetTransactionResult, uint64, string, error) {
	bad := errors.New("campaign finalized recovery rejected")
	var e error
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	chain := func() error {
		g, e := c.GetGenesisHash(ctx)
		if e != nil {
			return e
		}
		if g.String() != genesis {
			return bad
		}
		return nil
	}
	if e = chain(); e != nil {
		return nil, 0, "", e
	}
	version := uint64(0)
	result, e := c.GetTransaction(ctx, sig, &rpc.GetTransactionOpts{Encoding: solana.EncodingBase64, Commitment: rpc.CommitmentFinalized, MaxSupportedTransactionVersion: &version})
	if errors.Is(e, rpc.ErrNotFound) || (e == nil && result == nil) {
		return nil, 0, "", nil
	}
	if e != nil {
		return nil, 0, "", e
	}
	debit, effects, e := validate(result)
	if e != nil {
		return nil, 0, "", e
	}
	slot, e := c.GetSlot(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return nil, 0, "", e
	}
	if slot < result.Slot {
		return nil, 0, "", bad
	}
	if e = chain(); e != nil {
		return nil, 0, "", e
	}
	if e = ctx.Err(); e != nil {
		return nil, 0, "", e
	}
	return result, debit, effects, nil
}

// Release only unused native capacity, in the same transaction as terminal state.
func settleWENCampaignNativeV1(tx *bolt.Tx, wallet, day string, scopes map[string]uint64, maximum, debit uint64) error {
	bad := errors.New("campaign budget settlement rejected")
	if debit > maximum || day == "" {
		return bad
	}
	b := tx.Bucket(wenBudgetBucketV1)
	release := maximum - debit
	for scope, n := range scopes {
		key := []byte("limit:" + scope)
		var balance wenBudgetBalanceV1
		if json.Unmarshal(b.Get(key), &balance) != nil || balance.Reserved < n || balance.Reserved > balance.Limit {
			return bad
		}
		balance.Reserved -= release
		raw, e := json.Marshal(balance)
		if e != nil {
			return e
		}
		if e = b.Put(key, raw); e != nil {
			return e
		}
	}
	usage := tx.Bucket(bucketSignerUsageV2)
	usageKey := dailyUsageKeyV2(wallet, "solana:native", day)
	used, ok := new(big.Int).SetString(string(usage.Get(usageKey)), 10)
	if !ok || used.Cmp(new(big.Int).SetUint64(maximum)) < 0 {
		return bad
	}
	used.Sub(used, new(big.Int).SetUint64(release))
	if e := usage.Put(usageKey, []byte(used.String())); e != nil {
		return e
	}
	return nil
}
