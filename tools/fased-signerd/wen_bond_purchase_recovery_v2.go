package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"math/big"
	"reflect"
)

// Recovery never signs or resubmits. Missing receipts retain the original hold.
func (s *signerStoreV2) recoverWENBondPurchaseV2(ctx context.Context, c wenBondPurchaseRecoveryRPCV2, request, digest string) (string, error) {
	bad := errors.New("Bond finalized recovery rejected")
	if s == nil || s.db == nil || c == nil {
		return "", bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	var saved wenBondPurchaseReservationV2
	e := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return bad
		}
		return json.Unmarshal(b.Get([]byte("bond-purchase-request:"+request)), &saved)
	})
	if e != nil {
		return "", e
	}
	if saved.Digest != digest || saved.Artifact.RequestID != request || (saved.State != "submission-uncertain" && saved.State != "finalized-success" && saved.State != "finalized-failed") {
		return "", bad
	}
	hash, e := saved.Artifact.digest()
	if e != nil || hash != digest {
		return "", bad
	}
	sig, e := solana.SignatureFromBase58(saved.Signature)
	if e != nil {
		return "", bad
	}
	var cash, gross uint64
	result, debit, effects, e := readWENCampaignFinalizedV1(ctx, c, saved.Artifact.Policy.Deployment.Genesis, sig, func(r *rpc.GetTransactionResult) (uint64, string, error) {
		fee, spent, received, hash, e := wenBondPurchaseOutcomeV2(saved, r)
		cash, gross = spent, received
		return fee, hash, e
	})
	if e != nil {
		return "", e
	}
	if result == nil {
		return saved.State, nil
	}
	state := "finalized-success"
	if result.Meta.Err != nil {
		state = "finalized-failed"
	}
	if state == "finalized-success" {
		if e = verifyWENBondPurchaseRightsRPCV2(ctx, c, saved.Artifact, result.Slot); e != nil {
			return "", e
		}
	}
	e = s.db.Update(func(tx *bolt.Tx) error {
		if e := ctx.Err(); e != nil {
			return e
		}
		b := tx.Bucket(wenBudgetBucketV1)
		key := []byte("bond-purchase-request:" + request)
		var r wenBondPurchaseReservationV2
		if json.Unmarshal(b.Get(key), &r) != nil || !reflect.DeepEqual(r.Artifact, saved.Artifact) || r.Digest != digest || r.Signature != saved.Signature {
			return bad
		}
		expectedRetained := uint64(0)
		if state == "finalized-success" {
			expectedRetained = r.Artifact.Limits.RecoveryBudget
		}
		if r.OutcomeDigest != "" {
			if r.State != state || r.OutcomeDigest != effects || r.OutcomeDebit != debit || r.OutcomeSlot != result.Slot || r.OutcomeCash != cash || r.OutcomeGross != gross || r.RetainedRecovery != expectedRetained {
				return bad
			}
			return nil
		}
		if r.State != "submission-uncertain" {
			return bad
		}
		maximum := r.Artifact.nativeDebit()
		scopes := wenBondPurchaseReservationScopesV2(r.Artifact)
		if !reflect.DeepEqual(scopes, r.Scopes) || r.UsageDay == "" {
			return bad
		}
		retainedRecovery := uint64(0)
		if state == "finalized-success" {
			retainedRecovery = r.Artifact.Limits.RecoveryBudget
		}
		if debit > maximum || retainedRecovery > maximum-debit {
			return bad
		}
		native := map[string]uint64{wenMiningNativeScopeV1(r.Artifact.WalletID, r.Artifact.Policy.Deployment.Genesis): maximum, wenBondPurchaseLaunchScopeV2(r.Artifact): maximum}
		if e = settleWENCampaignNativeV1(tx, r.Artifact.WalletID, r.UsageDay, native, maximum, debit+retainedRecovery); e != nil {
			return e
		}
		if e = settleWENBondPurchaseCashV2(tx, r.Artifact, r.UsageDay, cash); e != nil {
			return e
		}

		r.RetainedRecovery = retainedRecovery
		r.State = state
		r.OutcomeDigest = effects
		r.OutcomeDebit = debit
		r.OutcomeSlot = result.Slot
		r.OutcomeCash = cash
		r.OutcomeGross = gross
		raw, e := json.Marshal(r)
		if e != nil {
			return e
		}
		return b.Put(key, raw)
	})
	if e != nil {
		return "", e
	}
	return state, nil
}

func settleWENBondPurchaseCashV2(tx *bolt.Tx, a wenBondPurchaseReviewArtifactV2, day string, debit uint64) error {
	bad := errors.New("Bond cash settlement rejected")
	maximum := a.cashAmount()
	if debit > maximum || day == "" {
		return bad
	}
	release := maximum - debit
	bucket := tx.Bucket(wenBudgetBucketV1)
	key := []byte("limit:" + wenBondPurchaseCashScopeV2(a))
	var balance wenBudgetBalanceV1
	if json.Unmarshal(bucket.Get(key), &balance) != nil || balance.Reserved < maximum || balance.Reserved > balance.Limit {
		return bad
	}
	balance.Reserved -= release
	raw, e := json.Marshal(balance)
	if e != nil {
		return e
	}
	if e = bucket.Put(key, raw); e != nil {
		return e
	}
	usage := tx.Bucket(bucketSignerUsageV2)
	key = dailyUsageKeyV2(a.WalletID, a.cashAsset(), day)
	used, ok := new(big.Int).SetString(string(usage.Get(key)), 10)
	if !ok || used.Cmp(new(big.Int).SetUint64(maximum)) < 0 {
		return bad
	}
	used.Sub(used, new(big.Int).SetUint64(release))
	return usage.Put(key, []byte(used.String()))
}

type wenBondPurchaseRecoveryRPCV2 interface {
	signerWENBTCReconcileRPCV1
	signerWENBTCReadRPCV1
}

func verifyWENBondPurchaseRightsRPCV2(ctx context.Context, c wenBondPurchaseRecoveryRPCV2, a wenBondPurchaseReviewArtifactV2, min uint64) error {
	bad := errors.New("Bond accepted rights recovery rejected")
	q := a.Binding.Snapshot.Quote.Key
	r, _, e := wenBondKeyV2(a.Pins.Bond.Program, "wen-paid-primary-v1", a.Pins.Bond.Sale[:], q[:])
	if e != nil {
		return e
	}
	keys := []solana.PublicKey{q, r, solana.SysVarClockPubkey}
	page, e := c.GetMultipleAccountsWithOpts(ctx, keys, &rpc.GetMultipleAccountsOpts{Commitment: rpc.CommitmentFinalized, Encoding: solana.EncodingBase64, MinContextSlot: &min})
	if e != nil {
		return e
	}
	if page == nil || len(page.Value) != 3 || page.Context.Slot < min {
		return bad
	}
	records := make([]wenBondAccountV2, 2)
	for i := range records {
		v := page.Value[i]
		if v == nil || v.Data == nil {
			return bad
		}
		records[i] = wenBondAccountV2{keys[i], v.Owner, v.Executable, v.Data.GetBinary()}
	}
	clock := page.Value[2]
	if clock == nil || clock.Data == nil || clock.Owner != solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111") || clock.Executable {
		return bad
	}
	d := clock.Data.GetBinary()
	if len(d) != 40 || binary.LittleEndian.Uint64(d) != page.Context.Slot {
		return bad
	}
	now := binary.LittleEndian.Uint64(d[32:])
	if now > uint64(1<<63-1) || wenHashV1(records[0].Data) != a.Policy.QuoteSHA256 {
		return bad
	}
	rights, e := inspectWENBondRightsV2(a.Pins.Bond, records[0], records[1], a.Policy.Nonce, now)
	if e != nil {
		return e
	}
	quote, e := inspectWENBondQuoteV2(a.Pins.Bond, records[0], a.Policy.Nonce)
	if e != nil || rights.Gross != quote.Gross || rights.Cash != quote.Cash {
		return bad
	}
	slot, e := c.GetSlot(ctx, rpc.CommitmentFinalized)
	if e != nil {
		return e
	}
	if slot < page.Context.Slot || slot-page.Context.Slot > 32 {
		return bad
	}
	genesis, e := c.GetGenesisHash(ctx)
	if e != nil {
		return e
	}
	if genesis.String() != a.Policy.Deployment.Genesis {
		return bad
	}
	return nil
}
