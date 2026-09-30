package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	bolt "go.etcd.io/bbolt"
)

type signerWENBTCReconcileRPCV1 interface {
	GetGenesisHash(context.Context) (solana.Hash, error)
	GetTransaction(context.Context, solana.Signature, *rpc.GetTransactionOpts) (*rpc.GetTransactionResult, error)
	GetSlot(context.Context, rpc.CommitmentType) (uint64, error)
}

// Record a finalized RPC observation of the exact journaled transaction. This
// does not settle cash/token accounting or release any reserved capacity.
func (s *signerStoreV2) reconcileWENTransactionV1(ctx context.Context, client signerWENBTCReconcileRPCV1, requestID, digest string) (string, error) {
	bad := errors.New("WEN finalized transaction reconciliation rejected")
	if s == nil || s.db == nil || !wenReservationHashV1(digest) {
		return "", bad
	}
	if _, err := validateRequestIDV2(requestID); err != nil {
		return "", err
	}
	var saved wenBudgetReservationV1
	if err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(wenBudgetBucketV1)
		if b == nil {
			return bad
		}
		if json.Unmarshal(b.Get([]byte("request:"+requestID)), &saved) != nil || saved.Digest != digest {
			return bad
		}
		return nil
	}); err != nil {
		return "", err
	}
	switch saved.State {
	case "signed", "submission-uncertain", "finalized-success", "finalized-failed":
	default:
		return "", bad
	}
	wire, err := wenSignedWireV1(saved, saved.SignedMessage)
	if err != nil {
		return "", err
	}
	chain, err := solana.HashFromBase58(saved.Genesis)
	if err != nil || chain == (solana.Hash{}) {
		return "", bad
	}
	min, err := strconv.ParseUint(saved.MinFinalizedSlot, 10, 64)
	if err != nil || min == 0 {
		return "", bad
	}
	if saved.MinExecutionSlot > min {
		min = saved.MinExecutionSlot
	}
	sig, err := solana.SignatureFromBase58(saved.Signature)
	if err != nil {
		return "", bad
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	checkChain := func() error {
		got, err := client.GetGenesisHash(ctx)
		if err != nil {
			return err
		}
		if got != chain {
			return bad
		}
		return nil
	}
	if err := checkChain(); err != nil {
		return "", err
	}
	version := uint64(0)
	result, err := client.GetTransaction(ctx, sig, &rpc.GetTransactionOpts{Encoding: solana.EncodingBase64, Commitment: rpc.CommitmentFinalized, MaxSupportedTransactionVersion: &version})
	if errors.Is(err, rpc.ErrNotFound) || err == nil && result == nil {
		return saved.State, nil
	}
	if err != nil {
		return "", err
	}
	if result.Meta == nil || result.Transaction == nil || result.Slot < min || !bytes.Equal(result.Transaction.GetBinary(), wire) {
		return "", bad
	}
	finalized, err := client.GetSlot(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return "", err
	}
	if finalized < result.Slot {
		return "", bad
	}
	if err := checkChain(); err != nil {
		return "", err
	}
	outcome := "finalized-success"
	detail := ""
	if result.Meta.Err != nil {
		outcome = "finalized-failed"
		raw, err := json.Marshal(result.Meta.Err)
		if err != nil || len(raw) > 4096 {
			return "", bad
		}
		detail = string(raw)
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	claimProof := ""
	if saved.BTCClaimIntent != nil && outcome == "finalized-success" {
		reader, ok := client.(signerWENBTCReadRPCV1)
		if !ok {
			return "", bad
		}
		ix, e := buildWENBTCClaimInstructionV1(*saved.BTCClaimIntent, solana.MustPublicKeyFromBase58(saved.WalletPublicKey))
		if e != nil {
			return "", e
		}
		key := ix.Accounts()[8].PublicKey
		page, e := reader.GetMultipleAccountsWithOpts(ctx, []solana.PublicKey{key}, &rpc.GetMultipleAccountsOpts{Encoding: solana.EncodingBase64, Commitment: rpc.CommitmentFinalized, MinContextSlot: &result.Slot})
		if e != nil {
			return "", e
		}
		if page == nil || page.Context.Slot < result.Slot || len(page.Value) != 1 || page.Value[0] == nil || page.Value[0].Data == nil {
			return "", bad
		}
		ref, e := client.GetSlot(ctx, rpc.CommitmentFinalized)
		if e != nil {
			return "", e
		}
		if ref < page.Context.Slot {
			return "", bad
		}
		if e = checkChain(); e != nil {
			return "", e
		}
		a := page.Value[0]
		claimProof = wenBTCClaimSuccessEffectsV1(saved, result, &signerWENBTCAccountV1{Address: key, Owner: a.Owner, Executable: a.Executable, Slot: page.Context.Slot, Data: append([]byte(nil), a.Data.GetBinary()...)})
		if claimProof == "" {
			return "", bad
		}
	}
	miningClaimProof := ""
	if saved.MiningClaimIntent != nil && outcome == "finalized-success" {
		reader, ok := client.(signerWENBTCReadRPCV1)
		if !ok {
			return "", bad
		}
		ix, e := buildWENMiningClaimInstructionV1(*saved.MiningClaimIntent, solana.MustPublicKeyFromBase58(saved.WalletPublicKey))
		if e != nil {
			return "", e
		}
		key := ix.Accounts()[6].PublicKey
		page, e := reader.GetMultipleAccountsWithOpts(ctx, []solana.PublicKey{key}, &rpc.GetMultipleAccountsOpts{Encoding: solana.EncodingBase64, Commitment: rpc.CommitmentFinalized, MinContextSlot: &result.Slot})
		if e != nil {
			return "", e
		}
		if page == nil || page.Context.Slot < result.Slot || len(page.Value) != 1 || page.Value[0] == nil || page.Value[0].Data == nil {
			return "", bad
		}
		ref, e := client.GetSlot(ctx, rpc.CommitmentFinalized)
		if e != nil {
			return "", e
		}
		if ref < page.Context.Slot {
			return "", bad
		}
		if e = checkChain(); e != nil {
			return "", e
		}
		a := page.Value[0]
		miningClaimProof = wenMiningClaimSuccessEffectsV1(saved, result, &signerWENBTCAccountV1{Address: key, Owner: a.Owner, Executable: a.Executable, Slot: page.Context.Slot, Data: append([]byte(nil), a.Data.GetBinary()...)})
		if miningClaimProof == "" {
			return "", bad
		}
	}
	miningFundingProof := ""
	if saved.MiningFundingIntent != nil && outcome == "finalized-success" {
		reader, ok := client.(signerWENBTCReadRPCV1)
		if !ok {
			return "", bad
		}
		ix, e := buildWENMiningFundingInstructionV1(*saved.MiningFundingIntent, solana.MustPublicKeyFromBase58(saved.WalletPublicKey))
		if e != nil {
			return "", e
		}
		key := ix.Accounts()[1].PublicKey
		page, e := reader.GetMultipleAccountsWithOpts(ctx, []solana.PublicKey{key}, &rpc.GetMultipleAccountsOpts{Encoding: solana.EncodingBase64, Commitment: rpc.CommitmentFinalized, MinContextSlot: &result.Slot})
		if e != nil {
			return "", e
		}
		if page == nil || page.Context.Slot < result.Slot || len(page.Value) != 1 || page.Value[0] == nil || page.Value[0].Data == nil {
			return "", bad
		}
		ref, e := client.GetSlot(ctx, rpc.CommitmentFinalized)
		if e != nil {
			return "", e
		}
		if ref < page.Context.Slot {
			return "", bad
		}
		if e = checkChain(); e != nil {
			return "", e
		}
		a := page.Value[0]
		miningFundingProof = wenMiningFundingSuccessEffectsV1(saved, result, &signerWENBTCAccountV1{Address: key, Owner: a.Owner, Executable: a.Executable, Slot: page.Context.Slot, Data: append([]byte(nil), a.Data.GetBinary()...)})
		if miningFundingProof == "" {
			return "", bad
		}
	}
	nativeClaimProof := ""
	if saved.NativeClaimIntent != nil && outcome == "finalized-success" {
		reader, ok := client.(signerWENBTCReadRPCV1)
		if !ok {
			return "", bad
		}
		ix, e := buildWENNativeClaimInstructionV1(*saved.NativeClaimIntent, solana.MustPublicKeyFromBase58(saved.WalletPublicKey))
		if e != nil {
			return "", e
		}
		key := ix.Accounts()[7].PublicKey
		page, e := reader.GetMultipleAccountsWithOpts(ctx, []solana.PublicKey{key}, &rpc.GetMultipleAccountsOpts{Encoding: solana.EncodingBase64, Commitment: rpc.CommitmentFinalized, MinContextSlot: &result.Slot})
		if e != nil {
			return "", e
		}
		if page == nil || page.Context.Slot < result.Slot || len(page.Value) != 1 || page.Value[0] == nil || page.Value[0].Data == nil {
			return "", bad
		}
		ref, e := client.GetSlot(ctx, rpc.CommitmentFinalized)
		if e != nil {
			return "", e
		}
		if ref < page.Context.Slot {
			return "", bad
		}
		if e = checkChain(); e != nil {
			return "", e
		}
		a := page.Value[0]
		nativeClaimProof = wenNativeClaimSuccessEffectsV1(saved, result, &signerWENBTCAccountV1{Address: key, Owner: a.Owner, Executable: a.Executable, Slot: page.Context.Slot, Data: append([]byte(nil), a.Data.GetBinary()...)})
		if nativeClaimProof == "" {
			return "", bad
		}
	}
	withdrawalProof := wenWithdrawalSuccessEffectsV1(saved, result)
	stakingProof := wenStakingSuccessEffectsV1(saved, result)
	miningProof := wenMiningSuccessEffectsV1(saved, result)
	failedProof := wenFailedEffectsV1(saved, result)
	successProof, nativeDebit := wenSuccessNativeEffectsV1(saved, result)
	if saved.MiningClaimIntent != nil && outcome == "finalized-success" {
		successProof = miningClaimProof
		nativeDebit = result.Meta.Fee
	}
	tokenProof, tokenEffects := wenSuccessTokenEffectsV1(saved, result)
	fundingProof := wenSuccessFundingEffectsV1(saved, result)
	err = s.changeWENReservationV1(requestID, digest, func(tx *bolt.Tx, r *wenBudgetReservationV1) error {
		if (saved.MiningClaimIntent != nil || r.MiningClaimIntent != nil) && (!reflect.DeepEqual(r.MiningClaimIntent, saved.MiningClaimIntent) || !reflect.DeepEqual(r.MiningClaimPrepared, saved.MiningClaimPrepared) || !reflect.DeepEqual(r.Scopes, saved.Scopes) || !reflect.DeepEqual(r.WalletClaims, saved.WalletClaims)) {
			return bad
		}
		if r.Signature != saved.Signature || r.Genesis != saved.Genesis || r.MinFinalizedSlot != saved.MinFinalizedSlot || r.MinExecutionSlot != saved.MinExecutionSlot || !bytes.Equal(r.SignedMessage, saved.SignedMessage) {
			return bad
		}
		if r.State == "finalized-success" || r.State == "finalized-failed" {
			if r.MiningClaimEffectsSHA256 != miningClaimProof || r.MiningFundingEffectsSHA256 != miningFundingProof || r.NativeClaimEffectsSHA256 != nativeClaimProof || r.BTCClaimEffectsSHA256 != claimProof || r.WithdrawalEffectsSHA256 != withdrawalProof || r.StakingEffectsSHA256 != stakingProof || r.MiningEffectsSHA256 != miningProof || r.State != outcome || r.OutcomeSlot != result.Slot || r.OutcomeFee != result.Meta.Fee || r.OutcomeError != detail || r.FailedEffectsSHA256 != failedProof || r.SuccessEffectsSHA256 != successProof || r.SuccessNativeDebit != nativeDebit || r.SuccessTokenEffectsSHA256 != tokenProof || r.SuccessFundingEffectsSHA256 != fundingProof {
				return bad
			}
			return nil
		}
		if r.State != "signed" && r.State != "submission-uncertain" {
			return bad
		}
		r.MiningClaimEffectsSHA256 = miningClaimProof
		r.MiningFundingEffectsSHA256 = miningFundingProof
		r.NativeClaimEffectsSHA256 = nativeClaimProof
		r.BTCClaimEffectsSHA256 = claimProof
		r.WithdrawalEffectsSHA256 = withdrawalProof
		r.StakingEffectsSHA256 = stakingProof
		r.MiningEffectsSHA256 = miningProof
		r.SuccessFundingEffectsSHA256 = fundingProof
		r.SuccessTokenEffectsSHA256 = tokenProof
		r.SuccessTokenEffects = tokenEffects
		r.SuccessEffectsSHA256 = successProof
		r.SuccessNativeDebit = nativeDebit
		r.FailedEffectsSHA256 = failedProof
		r.State = outcome
		r.OutcomeSlot = result.Slot
		r.OutcomeFee = result.Meta.Fee
		r.OutcomeError = detail
		return nil
	})
	if err != nil {
		return "", err
	}
	return outcome, nil
}
