package main

import (
	"context"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type wenNativeClaimExecutionRPCV1 interface {
	wenStakingPrepareRPCV1
	signerWENBTCReconcileRPCV1
	SendRawTransactionWithOpts(context.Context, []byte, rpc.TransactionOpts) (solana.Signature, error)
}

// Internal only; public dispatch requires separate deployment/client acceptance.
// Return the durable identity on every post-reservation error; never replace it.
func (s *signerServiceV2) executeWENNativeClaimWithRPCV1(ctx context.Context, c wenNativeClaimExecutionRPCV1, request, walletID, policyHash string, v signerWENNativeClaimIntentV1) (digest, outcome string, err error) {
	return s.executeGuardedWENNativeClaimV1(ctx, c, request, walletID, policyHash, v, nil)
}
func (s *signerServiceV2) executeGuardedWENNativeClaimV1(ctx context.Context, c wenNativeClaimExecutionRPCV1, request, walletID, policyHash string, v signerWENNativeClaimIntentV1, guard func() error) (digest, outcome string, err error) {
	if s == nil || s.store == nil || s.keys == nil {
		return "", "", errors.New("native SAT claim execution unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	p, err := prepareReviewedWENNativeClaimV1(ctx, c, s.store.db.Path(), walletID, v)
	if err != nil {
		return
	}
	if guard != nil {
		if err = guard(); err != nil {
			return
		}
	}
	digest, _, err = s.store.reservePreparedWENNativeClaimV1(request, walletID, policyHash, v, p)
	if err != nil {
		return
	}
	outcome = "reserved"
	ix, err := buildWENNativeClaimInstructionV1(v, p.wallet)
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
	if guard != nil {
		if err = guard(); err != nil {
			return
		}
	}
	if err = s.store.beginWENSigningAccountsV1(request, digest, wenHashV1(p.message), keys, p.slot); err != nil {
		return
	}
	outcome = "signing"
	binding := wenNativeClaimMessageBindingV1{Gross: p.state.Allocation.Gross, TransferFee: p.state.Allocation.Fee, Net: p.state.Allocation.Net, Weight: p.state.Allocation.Weight, Message: p.message, Blockhash: p.blockhash, ReviewSHA: p.review.reviewSHA, StateHash: p.state.StateHash, Slot: p.slot, Fee: p.fee, Rent: p.rent, LastValidHeight: p.lastValidHeight}
	if _, err = preparePinnedWENNativeClaimV1(ctx, c, s.store.db.Path(), walletID, v, &binding); err != nil {
		return
	}
	if err = s.store.miningExecutionStateV1(request, digest, policyHash, "signing"); err != nil {
		return
	}
	if guard != nil {
		if err = guard(); err != nil {
			return
		}
	}
	key, record, err := s.keys.privateKey(walletID)
	if err != nil {
		return
	}
	if record.PublicKey != p.wallet.String() {
		zeroBytes(key)
		return digest, outcome, errors.New("native SAT claim key identity changed")
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
	wire, err := s.store.prepareWENNativeClaimSubmissionV1(ctx, c, request, digest)
	if err != nil {
		return
	}
	outcome = "submission-uncertain"
	if guard != nil {
		if err = guard(); err != nil {
			return
		}
	}
	retries := uint(0)
	minimum := p.slot
	returned, sendErr := c.SendRawTransactionWithOpts(ctx, wire, rpc.TransactionOpts{Encoding: solana.EncodingBase64, SkipPreflight: false, PreflightCommitment: rpc.CommitmentFinalized, MaxRetries: &retries, MinContextSlot: &minimum})
	recovered, recoveryErr := s.store.recoverWENNativeClaimExecutionV1(ctx, c, request, digest)
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
		return digest, outcome, errors.New("native SAT claim send identity mismatch; recover journaled signature")
	}
	return
}
