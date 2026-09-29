package main

import (
	"context"
	"errors"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type signerWENBTCExecutionRPCV1 interface {
	signerWENBTCSimulationRPCV1
	signerWENBTCReconcileRPCV1
	SendRawTransactionWithOpts(context.Context, []byte, rpc.TransactionOpts) (solana.Signature, error)
}

// Internal controller, not an RPC handler. Callers must already own configured
// execution authority. The public WEN signing gate remains disabled until the
// installed/runtime release predicates pass. Never retry by generating a new tx.
func (s *signerServiceV2) executeWENBTCWithRPCV1(ctx context.Context, client signerWENBTCExecutionRPCV1, requestID, walletID, policyHash string, intent signerWENBTCIntentV1, wallet solana.PublicKey, nowHint uint64) (string, error) {
	if s == nil || s.store == nil || s.keys == nil {
		return "", errors.New("WEN execution service unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	admission, err := s.store.admitWENBTCExecutionV1(ctx, client, requestID, walletID, policyHash, intent, wallet, nowHint)
	if err != nil {
		return "", err
	}
	message, err := s.store.revalidateWENExecutionV1(ctx, client, admission, nowHint)
	if err != nil {
		return "", err
	}
	key, record, err := s.keys.privateKey(walletID)
	if err != nil {
		return "", err
	}
	// The key copy never crosses the signer boundary and is zeroed before RPC work.
	if record.PublicKey != wallet.String() {
		zeroBytes(key)
		return "", errors.New("WEN execution key mismatch")
	}
	if err := ctx.Err(); err != nil {
		zeroBytes(key)
		return "", err
	}
	signature, err := key.Sign(message)
	zeroBytes(key)
	if err != nil {
		return "", err
	}
	if err := s.store.recordWENSignatureV1(requestID, admission.reservationDigest, message, signature.String()); err != nil {
		return "", err
	}
	wire, err := s.store.prepareWENSubmissionV1(ctx, client, admission, nowHint)
	if err != nil {
		return "", err
	}
	retries := uint(0)
	minimum := admission.simulation.slot
	returned, sendErr := client.SendRawTransactionWithOpts(ctx, wire, rpc.TransactionOpts{Encoding: solana.EncodingBase64, SkipPreflight: false, PreflightCommitment: rpc.CommitmentFinalized, MaxRetries: &retries, MinContextSlot: &minimum})
	// Even a transport error or mismatching response may follow a successful send.
	// Reconcile the locally verified signature; never trust a returned replacement.
	outcome, reconcileErr := s.store.recoverWENExecutionV1(ctx, client, requestID, admission.reservationDigest)
	if reconcileErr != nil {
		if outcome == "" {
			outcome = "submission-uncertain"
		}
		return outcome, reconcileErr
	}
	if outcome == "finalized-failed" || outcome == "finalized-success" {
		return outcome, nil
	}
	if sendErr != nil {
		return outcome, sendErr
	}
	if returned != signature {
		return outcome, errors.New("WEN send response signature mismatch; reconciliation required")
	}
	return outcome, nil
}

// Recovery deliberately requires neither a key store nor send capability. It uses
// the durable transaction identity, even after policy revocation or a restart.
// An absent receipt leaves capacity held; only proved finalized effects settle it.
func (s *signerStoreV2) recoverWENExecutionV1(ctx context.Context, client signerWENBTCReconcileRPCV1, requestID, digest string) (string, error) {
	outcome, err := s.reconcileWENTransactionV1(ctx, client, requestID, digest)
	if err != nil {
		return outcome, err
	}
	switch outcome {
	case "finalized-failed":
		return outcome, s.settleWENFailedBudgetV1(requestID, digest)
	case "finalized-success":
		return outcome, s.settleWENSuccessBudgetV1(requestID, digest)
	default:
		return outcome, nil
	}
}
