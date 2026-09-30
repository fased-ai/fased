package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
	"reflect"
)

// Recovery never signs or resubmits. Missing receipts retain the original hold.
func (s *signerStoreV2) recoverWENBondClaimV2(ctx context.Context, c wenBondClaimRecoveryRPCV2, request, digest string) (string, error) {
	bad := errors.New("Bond finalized recovery rejected")
	if s == nil || s.db == nil || c == nil {
		return "", bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	var saved wenBondClaimReservationV2
	e := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return bad
		}
		return json.Unmarshal(b.Get([]byte("bond-claim-request:"+request)), &saved)
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
	var gross, net, tokenFee uint64
	result, debit, effects, e := readWENCampaignFinalizedV1(ctx, c, saved.Artifact.Policy.Deployment.Genesis, sig, func(r *rpc.GetTransactionResult) (uint64, string, error) {
		fee, received, delivered, withheld, hash, e := wenBondClaimOutcomeV2(saved, r)
		gross, net, tokenFee = received, delivered, withheld
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
	// An already reconciled attempt retains its authenticated outcome even
	// when later legitimate claims advance the live receipt.
	if state == "finalized-success" && saved.OutcomeDigest == "" {
		if e = verifyWENBondClaimRightsRPCV2(ctx, c, saved.Artifact, result.Slot, gross, net, tokenFee); e != nil {
			return "", e
		}
	}
	e = s.db.Update(func(tx *bolt.Tx) error {
		if e := ctx.Err(); e != nil {
			return e
		}
		b := tx.Bucket(wenBudgetBucketV1)
		key := []byte("bond-claim-request:" + request)
		var r wenBondClaimReservationV2
		if json.Unmarshal(b.Get(key), &r) != nil || !reflect.DeepEqual(r.Artifact, saved.Artifact) || r.Digest != digest || r.Signature != saved.Signature {
			return bad
		}
		if r.OutcomeDigest != "" {
			if r.State != state || r.OutcomeDigest != effects || r.OutcomeDebit != debit || r.OutcomeSlot != result.Slot || r.OutcomeGross != gross || r.OutcomeNet != net || r.OutcomeFee != tokenFee {
				return bad
			}
			return nil
		}
		if r.State != "submission-uncertain" {
			return bad
		}
		maximum := r.Artifact.nativeDebit()
		scopes := wenBondClaimReservationScopesV2(r.Artifact)
		if !reflect.DeepEqual(scopes, r.Scopes) || r.UsageDay == "" {
			return bad
		}
		if debit > maximum {
			return bad
		}
		native := map[string]uint64{wenMiningNativeScopeV1(r.Artifact.WalletID, r.Artifact.Policy.Deployment.Genesis): maximum, wenBondClaimLaunchScopeV2(r.Artifact): maximum}
		if e = settleWENCampaignNativeV1(tx, r.Artifact.WalletID, r.UsageDay, native, maximum, debit); e != nil {
			return e
		}
		r.State = state
		r.OutcomeDigest = effects
		r.OutcomeDebit = debit
		r.OutcomeSlot = result.Slot
		r.OutcomeNet = net
		r.OutcomeFee = tokenFee
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

type wenBondClaimRecoveryRPCV2 interface {
	signerWENBTCReconcileRPCV1
	signerWENBTCReadRPCV1
}

func verifyWENBondClaimRightsRPCV2(ctx context.Context, c wenBondClaimRecoveryRPCV2, a wenBondClaimReviewArtifactV2, min, gross, net, fee uint64) error {
	bad := errors.New("Bond accepted rights recovery rejected")
	q := a.Binding.Snapshot.Claim.Quote
	r, _, e := wenBondKeyV2(a.Pins.Program, "wen-paid-primary-v1", a.Pins.Sale[:], q[:])
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
	if now > uint64(1<<63-1) || sha256.Sum256(records[0].Data) != a.Binding.Snapshot.Claim.QuoteSHA256 {
		return bad
	}
	rights, e := inspectWENBondRightsV2(a.Pins, records[0], records[1], a.Policy.Nonce, now)
	if e != nil {
		return e
	}
	quote, e := inspectWENBondQuoteV2(a.Pins, records[0], a.Policy.Nonce)
	if e != nil || rights.Gross != quote.Gross || rights.Cash != quote.Cash || !wenBondClaimReceiptProgressV2(a.Binding.Snapshot.Claim, rights, gross, net, fee) {
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

// Later unrelated claims cannot be attributed to this attempt. An advanced
// receipt keeps recovery unavailable until exact historical proof is supplied.
func wenBondClaimReceiptProgressV2(old, fresh wenBondClaimV2, gross, net, fee uint64) bool {
	if gross > old.Gross-old.ClaimedGross || net > ^uint64(0)-old.ClaimedNet || fee > ^uint64(0)-old.ClaimedFee || fresh.ClaimedGross != old.ClaimedGross+gross || fresh.ClaimedNet != old.ClaimedNet+net || fresh.ClaimedFee != old.ClaimedFee+fee {
		return false
	}
	old.ClaimedGross, old.ClaimedNet, old.ClaimedFee = 0, 0, 0
	fresh.ClaimedGross, fresh.ClaimedNet, fresh.ClaimedFee = 0, 0, 0
	old.AvailableGross, old.AvailableNet, old.TransferFee = 0, 0, 0
	fresh.AvailableGross, fresh.AvailableNet, fresh.TransferFee = 0, 0, 0
	return old == fresh
}
