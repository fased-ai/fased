package main

import (
	"context"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type wenStakingExecutionRPCV1 interface {
	wenStakingPrepareRPCV1
	signerWENBTCReconcileRPCV1
	SendRawTransactionWithOpts(context.Context, []byte, rpc.TransactionOpts) (solana.Signature, error)
}

// Internal only; public dispatch requires separate deployment/client acceptance.
// Return the durable identity on every post-reservation error; never replace it.
func (s *signerServiceV2) executeWENStakingWithRPCV1(ctx context.Context, c wenStakingExecutionRPCV1, request, walletID, policyHash string, v signerWENStakingIntentV1) (digest, outcome string, err error) {
	if s == nil || s.store == nil || s.keys == nil {
		return "", "", errors.New("staking execution unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	p, err := prepareReviewedWENStakingV1(ctx, c, s.store.db.Path(), walletID, v)
	if err != nil {
		return
	}
	digest, _, err = s.store.reservePreparedWENStakingV1(request, walletID, policyHash, v, p)
	if err != nil {
		return
	}
	outcome = "reserved"
	ix, err := buildWENStakingInstructionV1(v, p.wallet)
	if err != nil {
		return
	}
	tx, err := solana.NewTransaction([]solana.Instruction{ix}, p.blockhash, solana.TransactionPayer(p.wallet))
	if err != nil {
		return
	}
	tx.Message.SetVersion(solana.MessageVersionV0)
	all, err := tx.Message.GetAllKeys()
	if err != nil {
		return
	}
	keys := make([]string, len(all))
	for i, k := range all {
		keys[i] = k.String()
	}
	if err = s.store.beginWENSigningAccountsV1(request, digest, wenHashV1(p.message), keys, p.slot); err != nil {
		return
	}
	outcome = "signing"
	binding := wenStakingMessageBindingV1{Evidence: &wenStakingPreparedEvidenceV1{Pins: p.review.pins, Before: p.state.History}, Message: p.message, Blockhash: p.blockhash, ReviewSHA: p.review.reviewSHA, Slot: p.slot, Fee: p.fee, Rent: p.rent, LastValidHeight: p.lastValidHeight}
	if _, err = preparePinnedWENStakingV1(ctx, c, s.store.db.Path(), walletID, v, &binding); err != nil {
		return
	}
	if err = s.store.miningExecutionStateV1(request, digest, policyHash, "signing"); err != nil {
		return
	}
	key, record, err := s.keys.privateKey(walletID)
	if err != nil {
		return
	}
	if record.PublicKey != p.wallet.String() {
		zeroBytes(key)
		return digest, outcome, errors.New("staking key identity changed")
	}
	if err = ctx.Err(); err != nil {
		zeroBytes(key)
		return
	}
	signature, err := key.Sign(p.message)
	zeroBytes(key)
	if err != nil {
		return
	}
	if err = s.store.recordWENSignatureV1(request, digest, p.message, signature.String()); err != nil {
		return
	}
	outcome = "signed"
	wire, err := s.store.prepareWENStakingSubmissionV1(ctx, c, request, digest)
	if err != nil {
		return
	}
	outcome = "submission-uncertain"
	retries := uint(0)
	minimum := p.slot
	returned, sendErr := c.SendRawTransactionWithOpts(ctx, wire, rpc.TransactionOpts{Encoding: solana.EncodingBase64, SkipPreflight: false, PreflightCommitment: rpc.CommitmentFinalized, MaxRetries: &retries, MinContextSlot: &minimum})
	recovered, recoveryErr := s.store.recoverWENStakingExecutionV1(ctx, c, request, digest)
	if recovered != "" {
		outcome = recovered
	}
	if recoveryErr != nil {
		return digest, outcome, recoveryErr
	}
	if outcome == "finalized-success" || outcome == "finalized-failed" {
		return
	}
	if sendErr != nil {
		return digest, outcome, sendErr
	}
	if returned != signature {
		return digest, outcome, errors.New("staking send identity mismatch; recover journaled signature")
	}
	return
}

// Recovery never sends or obtains private keys. Historical observation is separate.
func (s *signerStoreV2) recoverWENStakingExecutionV1(ctx context.Context, c signerWENBTCReconcileRPCV1, request, digest string) (string, error) {
	outcome, e := s.reconcileWENTransactionV1(ctx, c, request, digest)
	if e != nil {
		return outcome, e
	}
	if outcome == "finalized-success" {
		return outcome, s.settleWENStakingSuccessV1(request, digest)
	}
	if outcome == "finalized-failed" {
		return outcome, s.settleWENFailedBudgetV1(request, digest)
	}
	return outcome, nil
}

// Joined recovery preserves the distinction between a finalized transaction and
// its later historical consistency observation. It never signs or resubmits.
func (s *signerStoreV2) recoverAndObserveWENStakingV1(ctx context.Context, c interface {
	signerWENBTCReconcileRPCV1
	signerWENBTCReadRPCV1
}, request, digest string, maxSlotLag uint64) (string, *wenStakingPoststateObservationV1, error) {
	outcome, e := s.recoverWENStakingExecutionV1(ctx, c, request, digest)
	if e != nil || outcome != "finalized-success" {
		return outcome, nil, e
	}
	observation, e := s.observeWENStakingPoststateV1(ctx, c, request, digest, maxSlotLag)
	if e != nil {
		return outcome, nil, e
	}
	return outcome, &observation, nil
}
